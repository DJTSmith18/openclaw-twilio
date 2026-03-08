import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk";
import { getTwilioRuntime } from "./runtime.js";
import { sendTwilioMessage, sendTwilioGroupMessage } from "./send.js";
import { getGroupMembers } from "./db.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve send targets: if `to` is a group UUID, look up members from DB
 * and broadcast to all. Otherwise send directly to the phone number.
 */
async function resolveSend(params: {
  cfg: unknown;
  to: string;
  text?: string;
  mediaUrl?: string;
  accountId?: string | null;
}) {
  const { cfg, to, text, mediaUrl, accountId } = params;

  if (UUID_RE.test(to)) {
    // Group session — look up members and broadcast
    const members = await getGroupMembers(to);
    if (members && members.length > 0) {
      console.log(`[twilio:outbound] group send groupId=${to} members=${members.join(",")}`);
      return sendTwilioGroupMessage({ cfg, to: members[0], recipients: members, text, mediaUrl, accountId: accountId ?? undefined });
    }
    console.warn(`[twilio:outbound] group ${to} not found in DB — cannot send`);
    return { ok: false as const, error: `Group ${to} not found` };
  }

  return sendTwilioMessage({ cfg, to, text, mediaUrl, accountId: accountId ?? undefined });
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
