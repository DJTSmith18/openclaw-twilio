import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { TwilioConversationsWebhookPayload } from "./types.js";
import { resolveTwilioAccountByDid, resolveTwilioAccount } from "./accounts.js";
import { resolveTwilioCredentials } from "./credentials.js";
import { normalizeE164 } from "./normalize.js";
import { createTwilioConversationStore, lookupContact } from "./conversation-store.js";
import { getTwilioRuntime } from "./runtime.js";
import { sendConversationsMessage } from "./send.js";
import { upsertConversationMap, getConversationBySid } from "./db.js";
import type { Request, Response } from "express";
import type { TwilioConfig } from "./types.js";

type InboundDeps = {
  cfg: OpenClawConfig;
  log?: {
    info: (...args: any[]) => void;
    warn: (...args: any[]) => void;
    debug?: (...args: any[]) => void;
  };
};

/**
 * Extract media attachments from a Conversations webhook payload.
 * NumMedia is present for MMS messages.
 */
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
 * Handle an inbound Twilio Conversations webhook (onMessageAdded).
 *
 * Flow:
 * 1. Parse Conversations webhook payload
 * 2. Ignore non-onMessageAdded events
 * 3. Respond 200 immediately
 * 4. Async: resolve account + conversation type via participants list
 *    - DB cache hit → skip API call for known conversations
 *    - Cache miss → query Twilio participants.list():
 *        • find our DID (MessagingBinding.ProxyAddress) → resolve account
 *        • count SMS participants → direct (1) vs group (≥2)
 * 5. Apply access control
 * 6. Upsert conversation reference + log inbound
 * 7. Build context, record session, dispatch reply
 *
 * Note: MessagingBinding.ProxyAddress is NOT present in the onMessageAdded
 * webhook body — it only exists on the participant resource. Account resolution
 * must come from the participants list or DB cache.
 */
export async function handleInboundMessage(
  req: Request,
  res: Response,
  deps: InboundDeps,
): Promise<void> {
  const body = req.body as TwilioConversationsWebhookPayload;
  const { cfg, log } = deps;

  // Dump raw payload for debugging
  log?.info(`[twilio:inbound] RAW PAYLOAD: ${JSON.stringify(req.body)}`);

  // Only handle message events
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

  if (!conversationSid || !author) {
    log?.warn("[twilio:inbound] Missing ConversationSid or Author in webhook body");
    res.status(400).send("Bad Request");
    return;
  }

  const normalizedFrom = normalizeE164(author);
  if (!normalizedFrom) {
    // SDK identity participant (e.g. agent replying via SDK) — not an inbound SMS
    log?.debug?.(`[twilio:inbound] ignoring non-E.164 author: ${author}`);
    res.status(200).send("OK");
    return;
  }

  // Respond immediately — Conversations API has no timeout risk
  res.status(200).send("OK");

  // All processing is async from here — the HTTP response is already sent
  void (async () => {
    try {
      const ocCfg = cfg as OpenClawConfig;
      const section = (cfg as any)?.channels?.twilio as TwilioConfig | undefined;

      // ── Resolve account + conversation type ───────────────────────────
      // MessagingBinding.ProxyAddress is NOT in the webhook body — it only
      // exists on the participant resource. We get it from the DB cache or
      // from participants.list(), which we query anyway for conversation
      // classification. One API call serves both purposes.

      let account: ReturnType<typeof resolveTwilioAccountByDid> | null = null;
      let proxyAddress = "";
      let chatType: "direct" | "group" = "direct";
      let groupParticipants: string[] | undefined;

      const cachedConv = await getConversationBySid(conversationSid);

      if (cachedConv) {
        // Known conversation — resolve account from cached accountId
        account = resolveTwilioAccount({ cfg: ocCfg, accountId: cachedConv.accountId });
        proxyAddress = account.fromNumber ?? "";
        chatType = cachedConv.chatType;
        groupParticipants = cachedConv.participants;

        log?.debug?.(
          `[twilio:inbound] DB cache hit: conversation=${conversationSid} type=${chatType} account=${cachedConv.accountId}`,
        );
      } else {
        // New conversation — query Twilio for participants to get proxy address + classify
        const credentials = resolveTwilioCredentials(section);
        if (!credentials) {
          log?.warn("[twilio:inbound] No Twilio credentials configured");
          return;
        }

        try {
          const twilio = await import("twilio");
          const client = twilio.default(credentials.accountSid, credentials.authToken);

          const participants = await client.conversations.v1
            .conversations(conversationSid)
            .participants.list();

          // SMS participants have a messagingBinding with address/proxyAddress
          const smsParticipants = participants.filter(
            (p: any) => p.messagingBinding?.address,
          );

          // Find which SMS participant's proxyAddress matches one of our configured DIDs
          for (const p of smsParticipants) {
            const proxy: string = p.messagingBinding?.proxyAddress ?? "";
            if (!proxy) continue;
            const candidate = resolveTwilioAccountByDid(ocCfg, proxy);
            if (candidate) {
              account = candidate;
              proxyAddress = proxy;
              break;
            }
          }

          if (!account) {
            log?.warn(
              `[twilio:inbound] No configured DID matched any participant proxy address for ${conversationSid}`,
            );
            return;
          }

          // Classify: count SMS participants excluding our own DID
          const ourNormalized = normalizeE164(proxyAddress);
          const remoteParticipants = smsParticipants
            .map((p: any) => normalizeE164(p.messagingBinding?.address ?? "") ?? "")
            .filter((p) => p && p !== ourNormalized)
            .sort();

          if (remoteParticipants.length >= 2) {
            chatType = "group";
            groupParticipants = remoteParticipants;
          }

          log?.info(
            `[twilio:inbound] conversation ${conversationSid} → ${chatType} (${smsParticipants.length} SMS participants) account=${account.accountId}`,
          );

          // Cache in DB
          await upsertConversationMap({
            conversationSid,
            accountId: account.accountId,
            chatType,
            peerId: chatType === "direct" ? normalizedFrom : undefined,
            participants: groupParticipants,
          }).catch((err) =>
            log?.warn?.(
              `[twilio:inbound] DB upsert failed: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
        } catch (apiErr) {
          log?.warn(
            `[twilio:inbound] Could not query participants for ${conversationSid}: ${apiErr instanceof Error ? apiErr.message : String(apiErr)}`,
          );
          return;
        }
      }

      if (!account) {
        log?.warn(`[twilio:inbound] No account resolved for conversation ${conversationSid}`);
        return;
      }

      const accountId = account.accountId;
      const ourDid = account.fromNumber ?? proxyAddress;

      log?.info(
        `[twilio:inbound] onMessageAdded conversation=${conversationSid} from=${normalizedFrom} → account=${accountId}`,
      );

      const peerId = chatType === "group" ? conversationSid : normalizedFrom;

      // ── Access control ───────────────────────────────────────────────
      const dmPolicy = account.config.dmPolicy ?? "pairing";
      const allowFrom = account.config.allowFrom ?? [];

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

      // ── Build session key ────────────────────────────────────────────
      const sessionKey =
        chatType === "group"
          ? `twilio:${accountId}:group:${conversationSid}`
          : `twilio:${accountId}:direct:${normalizedFrom}`;

      // ── Upsert conversation reference + log inbound ──────────────────
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

      // ── Contact enrichment ───────────────────────────────────────────
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

      // ── Media ────────────────────────────────────────────────────────
      const media = extractMedia(body);

      // ── Routing ──────────────────────────────────────────────────────
      const runtime = getTwilioRuntime();
      const fromAddress =
        chatType === "group"
          ? `twilio:group:${conversationSid}`
          : `twilio:${normalizedFrom}`;

      const route = runtime.channel.routing.resolveAgentRoute({
        cfg,
        channel: "twilio",
        accountId,
        peer: { kind: chatType === "group" ? "group" : "user", id: peerId },
      });

      log?.info(
        `[twilio:inbound] dispatch ${chatType}${chatType === "group" ? ` conversation=${conversationSid}` : ""} from=${normalizedFrom} → session=${route.sessionKey}`,
      );

      // ── Build inbound context ────────────────────────────────────────
      const inboundCtx: Record<string, unknown> = {
        Body: messageText,
        RawBody: messageText,
        CommandBody: messageText,
        From: fromAddress,
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
