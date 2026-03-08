import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { TwilioConversationsWebhookPayload } from "./types.js";
import { resolveTwilioAccount, listTwilioAccountIds } from "./accounts.js";
import { resolveTwilioCredentials } from "./credentials.js";
import { normalizeE164 } from "./normalize.js";
import { createTwilioConversationStore, lookupContact } from "./conversation-store.js";
import { getTwilioRuntime } from "./runtime.js";
import { sendConversationsMessage } from "./send.js";
import { upsertConversationMap, getConversationBySid } from "./db.js";
import type { Request, Response } from "express";
import type { TwilioConfig } from "./types.js";

// In-memory dedup set for onMessageAdded — prevents double-processing when
// both Address Configuration and Conversation Service webhooks fire for the same message.
const processedMessageSids = new Set<string>();
const DEDUP_MAX = 500;

type InboundDeps = {
  cfg: OpenClawConfig;
  log?: {
    info: (...args: any[]) => void;
    warn: (...args: any[]) => void;
    debug?: (...args: any[]) => void;
  };
};

function extractMedia(
  body: TwilioConversationsWebhookPayload,
): Array<{ url: string; contentType: string }> {
  const numMedia = parseInt(body.NumMedia ?? "0", 10);
  const media: Array<{ url: string; contentType: string }> = [];
  for (let i = 0; i < numMedia; i++) {
    const url = body[`MediaUrl${i}`];
    const contentType = body[`MediaContentType${i}`];
    if (url) {
      media.push({ url, contentType: contentType ?? "application/octet-stream" });
    }
  }
  return media;
}

/**
 * Resolve account by matching MessagingServiceSid from the webhook payload
 * against configured accounts. No API call required.
 */
function resolveAccountByMessagingServiceSid(
  cfg: OpenClawConfig,
  messagingServiceSid: string,
): ReturnType<typeof resolveTwilioAccount> | null {
  if (!messagingServiceSid) return null;

  const accountIds = listTwilioAccountIds(cfg);
  console.log(`[twilio:inbound] resolveAccountByMessagingServiceSid: looking for ${messagingServiceSid} among [${accountIds.join(", ")}]`);
  for (const id of accountIds) {
    const account = resolveTwilioAccount({ cfg, accountId: id });
    console.log(`[twilio:inbound]   account=${id} messagingServiceSid=${account.messagingServiceSid ?? "(none)"} fromNumber=${account.fromNumber}`);
    if (account.messagingServiceSid === messagingServiceSid) {
      return account;
    }
  }
  return null;
}

/**
 * Handle an inbound Twilio Conversations webhook (onMessageAdded).
 *
 * Account resolution: MessagingServiceSid in payload → matched against config
 *   (no API call required).
 *
 * Conversation classification:
 *   - DB cache hit → use cached chatType + participants
 *   - Cache miss → participants.list() → count SMS participants
 *     1 remote = direct, 2+ remote = group
 *   - Result cached in twilio_conversation_map for subsequent messages
 *
 * Group context: agent message prefixed with group warning so agent knows
 *   this is not a private 1:1 conversation. Full participant roster included
 *   in context for auditing.
 */
export async function handleInboundMessage(
  req: Request,
  res: Response,
  deps: InboundDeps,
): Promise<void> {
  const body = req.body as TwilioConversationsWebhookPayload;
  const { cfg, log } = deps;

  log?.debug?.(`[twilio:inbound] RAW PAYLOAD: ${JSON.stringify(req.body)}`);

  // Only handle Conversations message events
  const eventType = body.EventType;
  if (eventType !== "onMessageAdded") {
    log?.debug?.(`[twilio:inbound] ignoring event: ${eventType}`);
    res.status(200).send("OK");
    return;
  }

  const conversationSid = body.ConversationSid;
  const messageSid = body.MessageSid;
  const messageText = body.Body ?? "";
  const author = body.Author ?? "";
  const messagingServiceSid = body.MessagingServiceSid ?? "";

  // Deduplicate: Twilio may fire onMessageAdded from both Address Configuration
  // and Conversation Service webhooks for the same message.
  if (messageSid && processedMessageSids.has(messageSid)) {
    log?.debug?.(`[twilio:inbound] duplicate onMessageAdded for ${messageSid}, ignoring`);
    res.status(200).send("OK");
    return;
  }
  if (messageSid) {
    if (processedMessageSids.size >= DEDUP_MAX) {
      const first = processedMessageSids.values().next().value;
      if (first) processedMessageSids.delete(first);
    }
    processedMessageSids.add(messageSid);
  }

  if (!conversationSid || !author) {
    log?.warn("[twilio:inbound] Missing ConversationSid or Author");
    res.status(400).send("Bad Request");
    return;
  }

  const normalizedFrom = normalizeE164(author);
  if (!normalizedFrom) {
    // System/SDK participant — not an inbound SMS from a real phone
    log?.debug?.(`[twilio:inbound] ignoring non-E.164 author: ${author}`);
    res.status(200).send("OK");
    return;
  }

  // Respond immediately — no timeout risk with Conversations API
  res.status(200).send("OK");

  void (async () => {
    try {
      const ocCfg = cfg as OpenClawConfig;
      const section = (cfg as any)?.channels?.twilio as TwilioConfig | undefined;

      // ── Resolve account via MessagingServiceSid (no API call) ────────
      let account = resolveAccountByMessagingServiceSid(ocCfg, messagingServiceSid);

      if (!account) {
        // Fallback: use default account (single-DID setups without messagingServiceSid configured)
        log?.warn(
          `[twilio:inbound] No account matched MessagingServiceSid ${messagingServiceSid} — using default`,
        );
        account = resolveTwilioAccount({ cfg: ocCfg, accountId: null });
      }

      const accountId = account.accountId;
      const ourDid = account.fromNumber ?? "";

      // ── Resolve conversation type (DB cache or participants API) ──────
      let chatType: "direct" | "group" = "direct";
      let groupParticipants: string[] | undefined;

      const cachedConv = await getConversationBySid(conversationSid);

      let newParticipants: string[] = []; // phones added since last cached state

      if (cachedConv) {
        chatType = cachedConv.chatType;
        groupParticipants = cachedConv.participants;
        log?.debug?.(`[twilio:inbound] DB cache hit: ${conversationSid} → ${chatType}`);
      }

      // Always query participants for group conversations so we can detect
      // new members joining. For new conversations, query to classify.
      const shouldQueryParticipants = !cachedConv || chatType === "group";
      if (shouldQueryParticipants) {
        const credentials = resolveTwilioCredentials(section);
        if (credentials) {
          try {
            const twilio = await import("twilio");
            const client = twilio.default(credentials.accountSid, credentials.authToken);

            const participants = await client.conversations.v1
              .conversations(conversationSid)
              .participants.list();

            const ourNormalized = normalizeE164(ourDid);
            const currentRemote = participants
              .filter((p: any) => p.messagingBinding?.address)
              .map((p: any) => normalizeE164(p.messagingBinding?.address ?? "") ?? "")
              .filter((p) => p && p !== ourNormalized)
              .sort();

            if (!cachedConv) {
              // First encounter — classify and cache
              if (currentRemote.length >= 2) {
                chatType = "group";
                groupParticipants = currentRemote;
              }
              log?.info(
                `[twilio:inbound] ${conversationSid} → ${chatType} (${currentRemote.length} remote participants)`,
              );

            } else if (chatType === "group") {
              // Known group — detect new participants
              const cached = new Set(groupParticipants ?? []);
              newParticipants = currentRemote.filter((p) => !cached.has(p));
              if (newParticipants.length > 0) {
                groupParticipants = currentRemote;
                log?.info(
                  `[twilio:inbound] New participant(s) in ${conversationSid}: ${newParticipants.join(", ")}`,
                );
              }
            }

            // For group conversations, ensure our DID is an identity participant
            // on every message so it can be used as author when sending replies.
            // Always attempt; Twilio returns 409 if already present (ignored).
            if (chatType === "group" && ourDid) {
              await client.conversations.v1
                .conversations(conversationSid)
                .participants.create({ identity: ourDid } as any)
                .catch(() => {/* already a participant or non-fatal */});
            }

            // Update DB cache
            await upsertConversationMap({
              conversationSid,
              accountId,
              chatType,
              peerId: chatType === "direct" ? normalizedFrom : undefined,
              participants: groupParticipants,
            }).catch((err) =>
              log?.warn?.(`[twilio:inbound] DB upsert failed: ${err instanceof Error ? err.message : String(err)}`),
            );
          } catch (apiErr) {
            log?.warn(
              `[twilio:inbound] participants.list() failed for ${conversationSid}: ${apiErr instanceof Error ? apiErr.message : String(apiErr)}`,
            );
          }
        }
      }

      log?.info(
        `[twilio:inbound] onMessageAdded ${chatType} conversation=${conversationSid} from=${normalizedFrom} account=${accountId}`,
      );

      // ── Access control ───────────────────────────────────────────────
      const dmPolicy = account.config.dmPolicy ?? "pairing";
      const allowFrom = account.config.allowFrom ?? [];

      if (chatType === "direct") {
        if (dmPolicy === "disabled") {
          log?.debug?.(`[twilio:inbound] DMs disabled for account ${accountId}`);
          return;
        }
        if (
          dmPolicy === "allowlist" &&
          !allowFrom.includes("*") &&
          !allowFrom.some((entry) => normalizeE164(entry) === normalizedFrom)
        ) {
          log?.debug?.(`[twilio:inbound] ${normalizedFrom} not in allowFrom for ${accountId}`);
          return;
        }
      }

      // ── Session key ──────────────────────────────────────────────────
      // Use ConversationSid as the stable peer ID for both direct and group.
      // For direct, also key on sender phone so each contact has its own session.
      const sessionKey =
        chatType === "group"
          ? `twilio:${accountId}:group:${conversationSid}`
          : `twilio:${accountId}:direct:${normalizedFrom}`;

      // ── Upsert conversation store + log inbound ──────────────────────
      const store = createTwilioConversationStore({
        accountId,
        cfg: { channels: { twilio: (cfg as any).channels?.twilio } } as any,
      });
      try {
        await store.upsert(sessionKey, {
          from: normalizedFrom,
          to: ourDid,
          accountId,
          lastMessageSid: messageSid,
          lastTimestamp: Date.now(),
          isGroup: chatType === "group",
          groupParticipants,
        });
        await store.logMessage({
          phoneNumber: normalizedFrom,
          did: ourDid,
          accountId,
          direction: "inbound",
          message: messageText,
          mediaUrl: extractMedia(body)[0]?.url,
          messageSid,
          chatType,
          context: "twilio-channel-inbound",
        });
      } catch {
        log?.debug?.("[twilio:inbound] Failed to write to conversation store");
      }

      // ── Contact lookup for current sender ────────────────────────────
      let contactInfo: Record<string, unknown> | undefined;
      try {
        const contactLookupCfg =
          section?.shared?.contactLookup ?? section?.contactLookup;
        contactInfo = await lookupContact(normalizedFrom, {
          table: contactLookupCfg?.table,
          phoneColumn: contactLookupCfg?.phoneColumn,
          phoneMatch: contactLookupCfg?.phoneMatch,
          selectColumns: contactLookupCfg?.selectColumns,
        });
      } catch {
        // Non-fatal
      }

      // ── Build message body for agent ─────────────────────────────────
      // For group conversations, prepend a clear warning so the agent
      // understands this is not a private 1:1 exchange. Each participant's
      // message arrives separately — the agent needs context to know who
      // is speaking and that others are in the thread.
      // ── Build sender block (shared by both direct and group) ────────
      const senderLines = [`Sender: ${normalizedFrom}`];
      if (contactInfo && typeof contactInfo === "object") {
        for (const [key, val] of Object.entries(contactInfo)) {
          if (val !== null && val !== undefined && val !== "") {
            senderLines.push(`  ${key}: ${val}`);
          }
        }
      } else {
        senderLines.push(`  (not in contacts)`);
      }

      const header =
        chatType === "group"
          ? `👥 GROUP CONVERSATION — NOT PRIVATE`
          : `🔒 PRIVATE CONVERSATION`;

      const lines = [header, ...senderLines];

      // ── Participants list for group conversations ────────────────────
      if (chatType === "group" && groupParticipants && groupParticipants.length > 0) {
        const contactLookupCfg = section?.shared?.contactLookup ?? section?.contactLookup;
        const participantLabels = await Promise.all(
          groupParticipants.map(async (p) => {
            try {
              const info = await lookupContact(p, {
                table: contactLookupCfg?.table,
                phoneColumn: contactLookupCfg?.phoneColumn,
                phoneMatch: contactLookupCfg?.phoneMatch,
                selectColumns: contactLookupCfg?.selectColumns,
              });
              const name = (info as any)?.name;
              return name ? String(name) : p;
            } catch {
              return p;
            }
          }),
        );
        lines.push(`Participants: ${participantLabels.join(", ")}`);
      }

      if (chatType === "group" && newParticipants.length > 0) {
        lines.push(`⚠️ NEW PARTICIPANT(S) JOINED: ${newParticipants.join(", ")}`);
      }
      lines.push(`Message: ${messageText}`);
      const agentMessageBody = lines.join("\n");

      // ── Media ────────────────────────────────────────────────────────
      const media = extractMedia(body);

      // ── Routing ──────────────────────────────────────────────────────
      const runtime = getTwilioRuntime();
      const peerId = chatType === "group" ? conversationSid : normalizedFrom;

      const route = runtime.channel.routing.resolveAgentRoute({
        cfg,
        channel: "twilio",
        accountId,
        peer: { kind: chatType === "group" ? "group" : "user", id: peerId },
      });

      log?.info(
        `[twilio:inbound] dispatch ${chatType} from=${normalizedFrom} → session=${route.sessionKey}`,
      );

      // ── Build inbound context ────────────────────────────────────────
      const inboundCtx: Record<string, unknown> = {
        Body: agentMessageBody,
        RawBody: messageText,
        CommandBody: agentMessageBody,
        From: chatType === "group" ? `twilio:group:${conversationSid}` : `twilio:${normalizedFrom}`,
        To: ourDid,
        SessionKey: route.sessionKey,
        AccountId: accountId,
        AgentId: route.agentId,
        ChatType: chatType,
        SenderName: (contactInfo as any)?.name ?? normalizedFrom,
        SenderId: normalizedFrom,
        ContactInfo: contactInfo ?? null,
        Provider: "twilio",
        Surface: media.length > 0 ? "mms" : "sms",
        MessageSid: messageSid,
        ConversationSid: conversationSid,
        Timestamp: Date.now(),
        OriginatingChannel: "twilio",
        OriginatingTo: ourDid,
        OriginatingAccountId: accountId,
        ...(chatType === "group" && {
          GroupId: conversationSid,
          GroupParticipants: groupParticipants ?? [],
        }),
      };

      if (media.length > 0) {
        inboundCtx.Media = media;
        inboundCtx.MediaUrl = media[0].url;
        inboundCtx.MediaContentType = media[0].contentType;
      }

      // ── Record session ───────────────────────────────────────────────
      try {
        const storePath = runtime.channel.session.resolveStorePath(undefined, {
          agentId: route.agentId,
        });
        await runtime.channel.session.recordInboundSession({
          storePath,
          sessionKey: route.sessionKey,
          ctx: inboundCtx as any,
          updateLastRoute: {
            sessionKey: route.sessionKey,
            channel: "twilio" as any,
            to: ourDid,
            accountId,
          },
          onRecordError: (err) => {
            log?.warn?.(
              `[twilio:inbound] Session record error: ${err instanceof Error ? err.message : String(err)}`,
            );
          },
        });
      } catch (sessionErr) {
        log?.warn?.(
          `[twilio:inbound] Session record failed: ${sessionErr instanceof Error ? sessionErr.message : String(sessionErr)}`,
        );
      }

      // ── Dispatch reply via Conversations API ─────────────────────────
      // Always reply to ConversationSid — Twilio fans out to all participants.
      await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: inboundCtx as any,
        cfg: cfg as any,
        dispatcherOptions: {
          deliver: async (payload) => {
            const text = (payload as any).text as string | undefined;
            if (!text?.trim()) return;
            const mediaUrl = (payload as any).mediaUrl as string | undefined;
            await sendConversationsMessage({
              cfg,
              conversationSid,
              text,
              mediaUrl,
              accountId,
            });
          },
          onError: (err) => {
            log?.warn?.(
              `[twilio:inbound] Reply dispatch error: ${err instanceof Error ? err.message : String(err)}`,
            );
          },
        },
      });
    } catch (err: unknown) {
      log?.warn?.(
        `[twilio:inbound] Error processing message: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  })();
}
