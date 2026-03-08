import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { TwilioInboundMessage, ResolvedTwilioAccount } from "./types.js";
import { resolveTwilioAccountByDid } from "./accounts.js";
import { normalizeE164 } from "./normalize.js";
import { createTwilioConversationStore, lookupContact } from "./conversation-store.js";
import { getTwilioRuntime } from "./runtime.js";
import { sendTwilioMessage, sendTwilioGroupMessage } from "./send.js";
import { getEventStreamRecipients, deleteEventStreamRecipients, resolveOrCreateGroup } from "./db.js";
import type { Request, Response } from "express";
import type { TwilioConfig } from "./types.js";

/**
 * Poll SQLite for Event Streams recipient data for up to `maxMs` milliseconds.
 * Returns the recipients array once available, or null if not received in time.
 */
async function pollForRecipients(
  messageSid: string,
  maxMs: number,
): Promise<string[] | null> {
  const interval = 50;
  const attempts = Math.ceil(maxMs / interval);
  for (let i = 0; i < attempts; i++) {
    const recipients = await getEventStreamRecipients(messageSid);
    if (recipients !== null) return recipients;
    await new Promise((r) => setTimeout(r, interval));
  }
  return null;
}

type InboundDeps = {
  cfg: OpenClawConfig;
  log?: { info: (...args: any[]) => void; warn: (...args: any[]) => void; debug?: (...args: any[]) => void };
};

/**
 * Extract media attachments from Twilio inbound webhook body.
 */
function extractMedia(
  body: TwilioInboundMessage,
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
 * Determine the chat type from the inbound message.
 * Standard 1:1 SMS/MMS = "direct", group MMS = "group".
 */
function determineChatType(body: TwilioInboundMessage): "direct" | "group" {
  // Twilio group MMS messages include multiple addresses or group identifiers
  // For now, we default to "direct" — group MMS detection can be extended
  // by checking for multiple recipients or Twilio Conversations API metadata
  return "direct";
}

/**
 * Build a session key for the inbound message.
 */
function buildSessionKey(
  accountId: string,
  chatType: "direct" | "group",
  senderId: string,
  groupId?: string,
): string {
  if (chatType === "group" && groupId) {
    return `twilio:${accountId}:group:${groupId}`;
  }
  return `twilio:${accountId}:direct:${senderId}`;
}

/**
 * Handle an inbound Twilio webhook request.
 *
 * Flow:
 * 1. Parse webhook body
 * 2. Resolve account by To DID
 * 3. Determine chat type (direct vs group)
 * 4. Resolve agent route
 * 5. Apply access control
 * 6. Upsert conversation reference
 * 7. Extract media
 * 8. Build inbound context + dispatch
 * 9. Respond with empty TwiML
 */
export async function handleInboundMessage(
  req: Request,
  res: Response,
  deps: InboundDeps,
): Promise<void> {
  const body = req.body as TwilioInboundMessage;
  const { cfg, log } = deps;

  const from = body.From;
  const to = body.To;
  const messageText = body.Body ?? "";
  const messageSid = body.MessageSid;

  if (!from || !to) {
    log?.warn("[twilio:inbound] Missing From or To in webhook body");
    res.status(400).type("text/xml").send("<Response></Response>");
    return;
  }

  const normalizedFrom = normalizeE164(from);
  const normalizedTo = normalizeE164(to);

  if (!normalizedFrom) {
    log?.warn(`[twilio:inbound] Invalid From number: ${from}`);
    res.status(400).type("text/xml").send("<Response></Response>");
    return;
  }

  // Resolve which account (DID) this message was sent to
  const account = resolveTwilioAccountByDid(cfg, to);
  if (!account) {
    log?.warn(`[twilio:inbound] No account found for DID: ${to}`);
    res.status(200).type("text/xml").send("<Response></Response>");
    return;
  }

  const accountId = account.accountId;
  const chatType = determineChatType(body);
  const sessionKey = buildSessionKey(accountId, chatType, normalizedFrom);

  log?.info?.(
    `[twilio:inbound] ${chatType} from ${normalizedFrom} → ${accountId} (${messageSid})`,
  );

  // Check access control
  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const allowFrom = account.config.allowFrom ?? [];

  if (dmPolicy === "disabled") {
    log?.debug?.(`[twilio:inbound] DMs disabled for account ${accountId}`);
    res.status(200).type("text/xml").send("<Response></Response>");
    return;
  }

  if (
    dmPolicy === "allowlist" &&
    !allowFrom.includes("*") &&
    !allowFrom.some((entry) => normalizeE164(entry) === normalizedFrom)
  ) {
    log?.debug?.(
      `[twilio:inbound] ${normalizedFrom} not in allowFrom for ${accountId}`,
    );
    res.status(200).type("text/xml").send("<Response></Response>");
    return;
  }

  // Upsert conversation reference + log inbound message
  const store = createTwilioConversationStore({ accountId, cfg: { channels: { twilio: (cfg as any).channels?.twilio } } as any });
  try {
    await store.upsert(sessionKey, {
      from: normalizedFrom,
      to: normalizedTo ?? to,
      accountId,
      lastMessageSid: messageSid,
      lastTimestamp: Date.now(),
      isGroup: chatType === "group",
    });
    await store.logMessage({
      phoneNumber: normalizedFrom,
      did: normalizedTo ?? to,
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

  // Contact enrichment from shared contacts table
  let contactInfo: Record<string, unknown> | undefined;
  try {
    const twilioSection = (cfg as any).channels?.twilio as TwilioConfig | undefined;
    const contactLookupCfg = twilioSection?.shared?.contactLookup ?? twilioSection?.contactLookup;
    contactInfo = await lookupContact(normalizedFrom, {
      table: contactLookupCfg?.table,
      phoneColumn: contactLookupCfg?.phoneColumn,
      phoneMatch: contactLookupCfg?.phoneMatch,
      selectColumns: contactLookupCfg?.selectColumns,
    });
  } catch {
    // Non-fatal
  }

  // Extract media attachments
  const media = extractMedia(body);

  // Respond immediately with empty TwiML so Twilio doesn't time out
  res.status(200).type("text/xml").send("<Response></Response>");

  // Process asynchronously — Twilio already has its 200 response, so we can
  // wait as long as needed for Event Streams without any webhook timeout risk.
  void (async () => {
    try {
      const ourNumber = normalizedTo ?? to;

      // Poll for Event Streams data (group participant list).
      // Event Streams typically arrives ~2s after the inbound webhook but can
      // take longer. 30s is safe since the HTTP response was already sent.
      const streamRecipients = await pollForRecipients(messageSid, 30_000);
      await deleteEventStreamRecipients(messageSid).catch(() => {});

      // Group detection: presence of a non-empty recipients array signals group MMS.
      // recipients contains the other participants (not sender, not our DID).
      // We rebuild the full member set by adding the sender back in.
      const isGroup = Array.isArray(streamRecipients) && streamRecipients.length > 0;

      // Full participant set: sender + stream recipients, excluding our own number, sorted.
      const groupMembers: string[] = isGroup
        ? [
            ...new Set(
              [normalizedFrom, ...streamRecipients!.map((r) => normalizeE164(r) ?? r)].filter(
                (r) => r !== normalizeE164(ourNumber),
              ),
            ),
          ].sort()
        : [];
      const resolvedChatType: "direct" | "group" = isGroup ? "group" : "direct";

      // Stable UUID-based group ID — resolved from DB via Jaccard matching so
      // the same session survives participant add/remove events.
      let groupId: string | undefined;
      if (isGroup) {
        const resolved = await resolveOrCreateGroup(accountId, groupMembers);
        groupId = resolved.groupId;
        log?.info?.(
          `[twilio:inbound] group ${resolved.isNew ? "created" : "matched"}: ${groupId} members=[${groupMembers.join(",")}]`,
        );
      }

      const peerId = groupId ?? normalizedFrom;

      // Other participants (everyone in the group except the sender and our number)
      const otherParticipants = groupMembers.filter((m) => m !== normalizedFrom);

      log?.info?.(
        `[twilio:inbound] dispatch ${resolvedChatType}${isGroup ? ` group=${groupId}` : ""} from ${normalizedFrom} → ${accountId}`,
      );

      const runtime = getTwilioRuntime();
      const fromAddress =
        resolvedChatType === "group"
          ? `twilio:group:${peerId}`
          : `twilio:${normalizedFrom}`;

      // Resolve agent route
      const route = runtime.channel.routing.resolveAgentRoute({
        cfg,
        channel: "twilio",
        accountId,
        peer: { kind: resolvedChatType === "group" ? "group" : "user", id: peerId },
      });

      // Build the inbound context
      const inboundCtx: Record<string, unknown> = {
        Body: messageText,
        RawBody: messageText,
        CommandBody: messageText,
        From: fromAddress,
        To: normalizedTo ?? to,
        SessionKey: route.sessionKey,
        AccountId: accountId,
        AgentId: route.agentId,
        ChatType: resolvedChatType,
        SenderName: (contactInfo as any)?.name ?? normalizedFrom,
        SenderId: normalizedFrom,
        ContactInfo: contactInfo ?? null,
        Provider: "twilio",
        Surface: media.length > 0 ? "mms" : "sms",
        MessageSid: messageSid,
        Timestamp: Date.now(),
        OriginatingChannel: "twilio",
        OriginatingTo: normalizedTo ?? to,
        OriginatingAccountId: accountId,
        ...(isGroup && {
          GroupId: groupId,
          GroupParticipants: groupMembers,
        }),
      };

      if (media.length > 0) {
        inboundCtx.Media = media;
        inboundCtx.MediaUrl = media[0].url;
        inboundCtx.MediaContentType = media[0].contentType;
      }

      // Record session
      try {
        const storePath = runtime.channel.session.resolveStorePath(undefined, { agentId: route.agentId });
        await runtime.channel.session.recordInboundSession({
          storePath,
          sessionKey: route.sessionKey,
          ctx: inboundCtx as any,
          updateLastRoute: {
            sessionKey: route.sessionKey,
            channel: "twilio" as any,
            to: normalizedTo ?? to,
            accountId,
          },
          onRecordError: (err) => {
            log?.warn?.(`[twilio:inbound] Session record error: ${err instanceof Error ? err.message : String(err)}`);
          },
        });
      } catch (sessionErr) {
        log?.warn?.(`[twilio:inbound] Session record failed: ${sessionErr instanceof Error ? sessionErr.message : String(sessionErr)}`);
      }

      // Reply to all group members (groupMembers already includes sender, excludes our number)
      const replyRecipients = isGroup ? groupMembers : [normalizedFrom];
      log?.info?.(
        `[twilio:inbound] replyRecipients=${JSON.stringify(replyRecipients)} isGroup=${isGroup}`,
      );

      await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: inboundCtx as any,
        cfg: cfg as any,
        dispatcherOptions: {
          deliver: async (payload) => {
            const text = (payload as any).text as string | undefined;
            if (!text?.trim()) return;
            const mediaUrl = (payload as any).mediaUrl as string | undefined;
            log?.info?.(
              `[twilio:inbound] deliver isGroup=${isGroup} replyRecipients=${JSON.stringify(replyRecipients)}`,
            );
            if (isGroup) {
              await sendTwilioGroupMessage({
                cfg,
                to: replyRecipients[0],
                recipients: replyRecipients,
                text,
                accountId,
                mediaUrl,
              });
            } else {
              await sendTwilioMessage({ cfg, to: normalizedFrom, text, accountId, mediaUrl });
            }
          },
          onError: (err) => {
            log?.warn?.(`[twilio:inbound] Reply dispatch error: ${err instanceof Error ? err.message : String(err)}`);
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
