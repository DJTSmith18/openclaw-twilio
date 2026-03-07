import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk";
import { getTwilioRuntime } from "./runtime.js";
import { sendTwilioMessage } from "./send.js";

export const twilioOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",

  chunker: (text, limit) =>
    getTwilioRuntime().channel.text.chunkMarkdownText(text, limit),

  chunkerMode: "plain" as any,
  textChunkLimit: 1600,

  sendText: async ({ cfg, to, text, accountId }) => {
    const result = await sendTwilioMessage({
      cfg,
      to,
      text,
      accountId: accountId ?? undefined,
    });
    return { channel: "twilio", ...result };
  },

  sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
    const result = await sendTwilioMessage({
      cfg,
      to,
      text,
      mediaUrl,
      accountId: accountId ?? undefined,
    });
    return { channel: "twilio", ...result };
  },
};
