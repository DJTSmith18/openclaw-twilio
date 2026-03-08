import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { SendTwilioMessageResult, TwilioConfig } from "./types.js";
import { resolveTwilioAccount } from "./accounts.js";
import { createTwilioConversationStore } from "./conversation-store.js";
import { getConversationByPeer, upsertConversationMap } from "./db.js";
import { normalizeE164 } from "./normalize.js";

function getTwilioSection(cfg: unknown): TwilioConfig | undefined {
  return (cfg as any)?.channels?.twilio as TwilioConfig | undefined;
}

/**
 * Send a message to an existing Twilio Conversation.
 *
 * A single call delivers to all SMS participants in the conversation —
 * Twilio handles fan-out. Returns an IM... message SID.
 */
export async function sendConversationsMessage(params: {
  cfg: unknown;
  conversationSid: string;
  text?: string;
  mediaUrl?: string;
  accountId?: string | null;
  author?: string;
}): Promise<SendTwilioMessageResult> {
  const { cfg, conversationSid, text, mediaUrl, accountId, author } = params;
  const ocCfg = cfg as OpenClawConfig;

  const account = resolveTwilioAccount({ cfg: ocCfg, accountId });
  const { accountSid, authToken } = account.credentials;

  if (!accountSid || !authToken) {
    return { ok: false, error: "Twilio credentials not configured" };
  }

  try {
    const twilio = await import("twilio");
    const client = twilio.default(accountSid, authToken);

    const createParams: Record<string, unknown> = {
      body: text ?? "",
    };
    // Only set author when explicitly provided — for SMS/group MMS conversations
    // Twilio requires author to be an actual participant; omitting it lets Twilio
    // route the message via the proxy address automatically.
    if (author) {
      createParams.author = author;
    }

    if (mediaUrl) {
      createParams.mediaSid = mediaUrl; // Note: Conversations API uses mediaSid, not mediaUrl
    }

    console.log(
      `[twilio:send] conversations message to=${conversationSid} body="${(text ?? "").slice(0, 60)}"`,
    );

    const section = getTwilioSection(cfg);
    const conversationServiceSid = section?.shared?.conversationServiceSid ?? section?.conversationServiceSid;

    const message = await (conversationServiceSid
      ? client.conversations.v1
          .services(conversationServiceSid)
          .conversations(conversationSid)
          .messages.create(createParams as any)
      : client.conversations.v1
          .conversations(conversationSid)
          .messages.create(createParams as any));

    console.log(
      `[twilio:send] sent sid=${message.sid} conversation=${conversationSid}`,
    );

    // Log outbound message to conversation history
    try {
      const store = createTwilioConversationStore({ accountId: account.accountId, cfg });
      await store.logMessage({
        phoneNumber: conversationSid, // use conversationSid as phone placeholder for group/unknown
        did: account.fromNumber ?? account.accountId,
        accountId: account.accountId,
        direction: "outbound",
        message: text ?? "",
        mediaUrl: mediaUrl ?? undefined,
        messageSid: message.sid,
        context: "twilio-channel-outbound",
      });
    } catch {
      // Non-fatal
    }

    return {
      ok: true,
      messageId: message.sid,
      conversationId: conversationSid,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[twilio:send] FAILED conversation=${conversationSid}: ${msg}`);
    return { ok: false, error: msg };
  }
}

/**
 * Resolve or create a 1:1 direct Conversation for a phone number, then send.
 *
 * Used for proactive outbound sends where no inbound conversation exists yet.
 * Creates the conversation, adds the phone as an SMS participant, and returns
 * the ConversationSid for future use.
 */
export async function resolveOrCreateDirectConversation(params: {
  cfg: unknown;
  accountId: string;
  toPhone: string; // E.164
}): Promise<string> {
  const { cfg, accountId, toPhone } = params;
  const ocCfg = cfg as OpenClawConfig;

  // Check DB first
  const existing = await getConversationByPeer(accountId, toPhone);
  if (existing) return existing;

  const account = resolveTwilioAccount({ cfg: ocCfg, accountId });
  const { accountSid, authToken } = account.credentials;

  if (!accountSid || !authToken) {
    throw new Error("Twilio credentials not configured");
  }

  const section = getTwilioSection(cfg);
  const conversationServiceSid = section?.shared?.conversationServiceSid;

  const twilio = await import("twilio");
  const client = twilio.default(accountSid, authToken);

  // Create conversation
  const convParams: Record<string, unknown> = {
    friendlyName: `OpenClaw Direct: ${toPhone}`,
  };
  if (account.messagingServiceSid) {
    convParams.messagingServiceSid = account.messagingServiceSid;
  }
  if (conversationServiceSid) {
    convParams.chatServiceSid = conversationServiceSid;
  }

  const conversation = conversationServiceSid
    ? await client.conversations.v1
        .services(conversationServiceSid)
        .conversations.create(convParams as any)
    : await client.conversations.v1.conversations.create(convParams as any);

  const conversationSid: string = (conversation as any).sid;

  // Add the remote party as an SMS participant
  const fromNumber = account.fromNumber;
  if (!fromNumber) {
    throw new Error(`No fromNumber configured for account ${accountId}`);
  }

  await client.conversations.v1
    .conversations(conversationSid)
    .participants.create({
      "messagingBinding.address": toPhone,
      "messagingBinding.proxyAddress": fromNumber,
    } as any);

  // Cache in DB
  await upsertConversationMap({
    conversationSid,
    accountId,
    chatType: "direct",
    peerId: toPhone,
  });

  console.log(
    `[twilio:send] created conversation ${conversationSid} for ${toPhone} via ${fromNumber}`,
  );

  return conversationSid;
}

