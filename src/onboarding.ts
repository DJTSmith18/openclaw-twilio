import type { ChannelOnboardingAdapter, OpenClawConfig } from "openclaw/plugin-sdk";
import { resolveTwilioCredentials, resolveDefaultFromNumber } from "./credentials.js";
import type { TwilioConfig } from "./types.js";

function getTwilioSection(cfg: OpenClawConfig): TwilioConfig | undefined {
  return (cfg as any).channels?.twilio as TwilioConfig | undefined;
}

export const twilioOnboardingAdapter: ChannelOnboardingAdapter = {
  channel: "twilio",

  getStatus: async ({ cfg }) => {
    const section = getTwilioSection(cfg);
    const creds = resolveTwilioCredentials(section);
    const fromNumber = resolveDefaultFromNumber(section);

    if (!creds) {
      return {
        configured: false,
        summary: "Twilio credentials not configured",
      };
    }

    if (!fromNumber) {
      return {
        configured: false,
        summary: "Twilio phone number (fromNumber) not configured",
      };
    }

    return {
      configured: true,
      summary: `Configured: ${fromNumber}`,
    };
  },

  configure: async ({ cfg, prompter }) => {
    // Interactive configuration via openclaw setup
    const section = getTwilioSection(cfg) ?? {};
    let nextCfg = { ...cfg } as OpenClawConfig;

    // Step 1: Credentials
    const existingCreds = resolveTwilioCredentials(section);
    let accountSid = existingCreds?.accountSid ?? "";
    let authToken = existingCreds?.authToken ?? "";

    if (!accountSid) {
      const sidResult = await prompter.prompt({
        message: "Twilio Account SID:",
        validate: (v: string) =>
          v.startsWith("AC") ? true : "Must start with AC",
      });
      accountSid = sidResult;
    }

    if (!authToken) {
      const tokenResult = await prompter.prompt({
        message: "Twilio Auth Token:",
        secret: true,
      });
      authToken = tokenResult;
    }

    // Step 2: Phone number
    const existingFrom = resolveDefaultFromNumber(section);
    let fromNumber = existingFrom ?? "";

    if (!fromNumber) {
      const phoneResult = await prompter.prompt({
        message: "Twilio phone number (E.164, e.g. +12125551234):",
        validate: (v: string) =>
          /^\+\d{10,15}$/.test(v.trim()) ? true : "Must be E.164 format",
      });
      fromNumber = phoneResult.trim();
    }

    // Step 3: Optional Conversation Service SID
    const existingConvSid = section.shared?.conversationServiceSid ?? "";
    let conversationServiceSid = existingConvSid;
    if (!conversationServiceSid) {
      const convSidResult = await prompter.prompt({
        message:
          "Conversations Service SID (IS...) — press Enter to use default service:",
        validate: (v: string) =>
          v === "" || v.startsWith("IS")
            ? true
            : "Must start with IS or leave blank",
      });
      conversationServiceSid = convSidResult.trim();
    }

    // Apply config — credentials go into shared to avoid openclaw doctor warnings
    (nextCfg as any).channels = {
      ...(nextCfg as any).channels,
      twilio: {
        ...section,
        enabled: true,
        shared: {
          ...section.shared,
          accountSid,
          authToken,
          ...(conversationServiceSid ? { conversationServiceSid } : {}),
        },
        fromNumber,
      },
    };

    return { cfg: nextCfg, configured: true };
  },

  dmPolicy: {
    policyPath: "channels.twilio.dmPolicy",
    allowFromPath: "channels.twilio.",
    defaultPolicy: "pairing",
  } as any,

  disable: (cfg) => {
    const nextCfg = { ...cfg } as OpenClawConfig;
    const channels = { ...(nextCfg as any).channels };
    if (channels.twilio) {
      channels.twilio = { ...channels.twilio, enabled: false };
    }
    (nextCfg as any).channels = channels;
    return nextCfg;
  },
};
