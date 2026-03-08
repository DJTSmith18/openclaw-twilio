import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk";
import { getTwilioRuntime } from "./runtime.js";
import { sendConversationsMessage, resolveOrCreateDirectConversation } from "./send.js";

// Twilio ConversationSid format: CH followed by 32 hex characters
const CONV_SID_RE = /^CH[0-9a-f]{32}$/i;

/**
 * Resolve send target and deliver via Twilio Conversations API.
 *
 * - `to` is a ConversationSid (CH...): send directly to that conversation.
 *   Twilio fans out to all SMS participants (group or direct).
 * - `to` is an E.164 phone number: resolve or create a 1:1 conversation
 *   for that number, then send.
 */
async function resolveSend(params: {
  cfg: unknown;
  to: string;
  text?: string;
  mediaUrl?: string;
  accountId?: string | null;
}) {
  const { cfg, to, text, mediaUrl, accountId } = params;

  if (CONV_SID_RE.test(to)) {
    // Group or known direct conversation — send to it directly
    console.log(`[twilio:outbound] conversations send conversationSid=${to}`);
    return sendConversationsMessage({ cfg, conversationSid: to, text, mediaUrl, accountId });
  }

  // Proactive direct send to a phone number — resolve or create conversation
  console.log(`[twilio:outbound] direct send to=${to}`);
  const conversationSid = await resolveOrCreateDirectConversation({
    cfg,
    accountId: accountId ?? "default",
    toPhone: to,
  });
  return sendConversationsMessage({ cfg, conversationSid, text, mediaUrl, accountId });
}

export const twilioOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",

  chunker: (text, limit) =>
    getTwilioRuntime().channel.text.chunkMarkdownText(text, limit),

  chunkerMode: "plain" as any,
  textChunkLimit: 1600,

  sendText: async ({ cfg, to, text, accountId }) => {
    const result = await resolveSend({ cfg, to, text, accountId });
    return { channel: "twilio", ...result };
  },

  sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
    const result = await resolveSend({ cfg, to, text, mediaUrl, accountId });
    return { channel: "twilio", ...result };
  },
};
