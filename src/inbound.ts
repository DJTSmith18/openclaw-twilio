import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { TwilioConversationsWebhookPayload } from "./types.js";
import { resolveTwilioAccountByDid } from "./accounts.js";
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
 * 3. Resolve account from MessagingBinding.ProxyAddress (our DID)
 * 4. Resolve conversation type from DB (or query Twilio API on first encounter)
 * 5. Apply access control
 * 6. Upsert conversation reference + log inbound
 * 7. Respond 200 immediately
 * 8. Async: build context, record session, dispatch reply
 */
export async function handleInboundMessage(
  req: Request,
  res: Response,
  deps: InboundDeps,
): Promise<void> {
  const body = req.body as TwilioConversationsWebhookPayload;
  const { cfg, log } = deps;

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

  // MessagingBinding.ProxyAddress = our Twilio DID (which account received this)
  const proxyAddress = body["MessagingBinding.ProxyAddress"] ?? "";

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

  // Resolve which account (DID) received this message
  const account = resolveTwilioAccountByDid(cfg, proxyAddress);
  if (!account) {
    log?.warn(`[twilio:inbound] No account found for proxy address: ${proxyAddress}`);
    res.status(200).send("OK");
    return;
  }

  const accountId = account.accountId;
  const ourDid = account.fromNumber ?? proxyAddress;

  log?.info(
    `[twilio:inbound] onMessageAdded conversation=${conversationSid} from=${normalizedFrom} → account=${accountId}`,
  );

  // Respond immediately — Conversations API doesn't need TwiML and has no timeout risk
  res.status(200).send("OK");

  // All processing is async from here — the HTTP response is already sent
  void (async () => {
    try {
      // ── Resolve conversation type ────────────────────────────────────
      const cachedConv = await getConversationBySid(conversationSid);
      let chatType: "direct" | "group";
      let groupParticipants: string[] | undefined;

      if (cachedConv) {
        chatType = cachedConv.chatType;
        groupParticipants = cachedConv.participants;
      } else {
        // First time seeing this conversation — query Twilio to classify it
        chatType = "direct";
        groupParticipants = undefined;

        try {
          const twilio = await import("twilio");
          const client = twilio.default(
            account.credentials.accountSid,
            account.credentials.authToken,
          );

          const participants = await client.conversations.v1
            .conversations(conversationSid)
            .participants.list();

          // Count SMS participants (those with a messagingBinding.address)
          const smsParticipants = participants.filter(
            (p: any) => p.messagingBinding?.address,
          );

          if (smsParticipants.length >= 2) {
            chatType = "group";
            const ourNormalized = normalizeE164(ourDid);
            groupParticipants = smsParticipants
              .map((p: any) => normalizeE164(p.messagingBinding?.address ?? "") ?? "")
              .filter((p) => p && p !== ourNormalized)
              .sort();
          }

          log?.info(
            `[twilio:inbound] conversation ${conversationSid} → ${chatType} (${smsParticipants.length} SMS participants)`,
          );
        } catch (apiErr) {
          log?.warn(
            `[twilio:inbound] Could not query participants for ${conversationSid}: ${apiErr instanceof Error ? apiErr.message : String(apiErr)}`,
          );
        }

        // Cache in DB
        await upsertConversationMap({
          conversationSid,
          accountId,
          chatType,
          peerId: chatType === "direct" ? normalizedFrom : undefined,
          participants: groupParticipants,
        }).catch((err) =>
          log?.warn?.(
            `[twilio:inbound] DB upsert failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }

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
        const twilioSection = (cfg as any).channels?.twilio as TwilioConfig | undefined;
        const contactLookupCfg =
          twilioSection?.shared?.contactLookup ?? twilioSection?.contactLookup;
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
