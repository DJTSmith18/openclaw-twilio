import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  PAIRING_APPROVED_MESSAGE,
  setAccountEnabledInConfigSection,
  deleteAccountFromConfigSection,
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  formatPairingApproveHint,
} from "openclaw/plugin-sdk";
import type { ResolvedTwilioAccount, TwilioConfig } from "./types.js";
import {
  listTwilioAccountIds,
  resolveDefaultTwilioAccountId,
  resolveTwilioAccount,
} from "./accounts.js";
import { normalizeE164, normalizeTwilioTarget, looksLikePhoneNumber } from "./normalize.js";
import { sendTwilioMessage } from "./send.js";
import { twilioOutbound } from "./outbound.js";
import { twilioOnboardingAdapter } from "./onboarding.js";
import { createTwilioConversationStore } from "./conversation-store.js";

function getTwilioSection(cfg: OpenClawConfig): TwilioConfig | undefined {
  return (cfg as any).channels?.twilio as TwilioConfig | undefined;
}

export const twilioPlugin: ChannelPlugin<ResolvedTwilioAccount> = {
  id: "twilio",

  meta: {
    id: "twilio",
    label: "Twilio SMS/MMS/RCS",
    selectionLabel: "Twilio (SMS/MMS/RCS/Group)",
    docsPath: "/channels/twilio",
    docsLabel: "twilio",
    blurb: "SMS, MMS, RCS, and Group messaging via Twilio.",
    aliases: ["sms", "mms", "rcs"],
    order: 50,
  },

  onboarding: twilioOnboardingAdapter,

  pairing: {
    idLabel: "phoneNumber",
    normalizeAllowEntry: (entry) =>
      normalizeE164(entry.replace(/^(twilio|sms|phone):/i, "")) ?? entry,
    notifyApproval: async ({ cfg, id, accountId }) => {
      await sendTwilioMessage({
        cfg,
        to: id,
        text: PAIRING_APPROVED_MESSAGE,
        accountId,
      });
    },
  },

  capabilities: {
    chatTypes: ["direct", "group"],
    polls: false,
    threads: false,
    media: true,
  },

  agentPrompt: {
    messageToolHints: () => [
      "- Twilio: targets are phone numbers in E.164 format (e.g., +12125551234).",
      "- MMS: include mediaUrl for image/video attachments.",
      "- RCS: automatically used when Messaging Service with RCS sender is configured.",
      "- Group SMS/MMS: multiple recipients supported.",
    ],
  },

  reload: { configPrefixes: ["channels.twilio"] },
  configSchema: buildChannelConfigSchema({} as any),

  // ── Multi-Account Config (like Telegram) ──────────────────────────

  config: {
    listAccountIds: (cfg) => listTwilioAccountIds(cfg),

    resolveAccount: (cfg, accountId) =>
      resolveTwilioAccount({ cfg, accountId }),

    defaultAccountId: (cfg) => resolveDefaultTwilioAccountId(cfg),

    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "twilio",
        accountId,
        enabled,
        allowTopLevel: true,
      }),

    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "twilio",
        accountId,
        clearBaseFields: ["fromNumber", "name"],
      }),

    isConfigured: (account) =>
      Boolean(
        account.fromNumber?.trim() && account.credentials.accountSid,
      ),

    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.fromNumber?.trim()),
      fromNumber: account.fromNumber,
    }),

    resolveAllowFrom: ({ cfg, accountId }) =>
      (
        resolveTwilioAccount({ cfg, accountId }).config.allowFrom ?? []
      ).map(String),

    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => normalizeE164(entry) ?? entry),

    resolveDefaultTo: ({ cfg, accountId }) => {
      const val = resolveTwilioAccount({ cfg, accountId }).config.defaultTo;
      return val != null ? String(val) : undefined;
    },
  },

  // ── Security ──────────────────────────────────────────────────────

  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId =
        accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(
        (cfg as any).channels?.twilio?.accounts?.[resolvedAccountId],
      );
      const basePath = useAccountPath
        ? `channels.twilio.accounts.${resolvedAccountId}.`
        : "channels.twilio.";

      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("twilio"),
        normalizeEntry: (raw: string) =>
          normalizeE164(raw.replace(/^(twilio|sms|phone):/i, "")) ?? raw,
      };
    },

    collectWarnings: ({ account }) => {
      if ((account.config.dmPolicy ?? "pairing") !== "open") return [];
      return [
        '- Twilio: dmPolicy="open" accepts messages from any phone number.',
      ];
    },
  },

  // ── Setup ─────────────────────────────────────────────────────────

  setup: {
    resolveAccountId: ({ accountId }) =>
      normalizeAccountId(accountId ?? undefined) ?? DEFAULT_ACCOUNT_ID,

    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "twilio",
        accountId,
        name,
      }),

    applyAccountConfig: ({ cfg, accountId, input }) => {
      const accountKey =
        normalizeAccountId(accountId ?? undefined) ?? DEFAULT_ACCOUNT_ID;

      const namedCfg = applyAccountNameToChannelSection({
        cfg,
        channelKey: "twilio",
        accountId: accountKey,
        name: (input as any)?.name,
      });

      if (accountKey === DEFAULT_ACCOUNT_ID) {
        return {
          ...namedCfg,
          channels: {
            ...(namedCfg as any).channels,
            twilio: {
              ...(namedCfg as any).channels?.twilio,
              enabled: true,
              ...((input as any)?.fromNumber
                ? { fromNumber: (input as any).fromNumber }
                : {}),
              ...((input as any)?.messagingServiceSid
                ? { messagingServiceSid: (input as any).messagingServiceSid }
                : {}),
            },
          },
        } as OpenClawConfig;
      }

      // Named account
      return {
        ...namedCfg,
        channels: {
          ...(namedCfg as any).channels,
          twilio: {
            ...(namedCfg as any).channels?.twilio,
            enabled: true,
            accounts: {
              ...(namedCfg as any).channels?.twilio?.accounts,
              [accountKey]: {
                ...(namedCfg as any).channels?.twilio?.accounts?.[accountKey],
                enabled: true,
                ...((input as any)?.fromNumber
                  ? { fromNumber: (input as any).fromNumber }
                  : {}),
                ...((input as any)?.messagingServiceSid
                  ? { messagingServiceSid: (input as any).messagingServiceSid }
                  : {}),
              },
            },
          },
        },
      } as OpenClawConfig;
    },
  },

  // ── Messaging ─────────────────────────────────────────────────────

  messaging: {
    normalizeTarget: normalizeTwilioTarget,
    targetResolver: {
      looksLikeId: (raw) => looksLikePhoneNumber(raw.trim()),
      hint: "<phone number in E.164 format, e.g. +12125551234>",
    },
  },

  // ── Directory ─────────────────────────────────────────────────────

  directory: {
    self: async () => null,

    listPeers: async ({ cfg, accountId, query, limit }) => {
      const account = resolveTwilioAccount({
        cfg: cfg as OpenClawConfig,
        accountId,
      });

      // Collect known peers from allowFrom + conversation store
      const peers: Array<{ id: string; name?: string }> = [];

      // From allowFrom list
      const allowFrom = account.config.allowFrom ?? [];
      for (const entry of allowFrom) {
        const normalized = normalizeE164(String(entry));
        if (normalized && normalized !== "*") {
          peers.push({ id: normalized, name: normalized });
        }
      }

      // From conversation store
      try {
        const store = createTwilioConversationStore({
          accountId: account.accountId,
        });
        const entries = await store.list();
        for (const entry of entries) {
          const phone = normalizeE164(entry.reference.from);
          if (phone && !peers.some((p) => p.id === phone)) {
            peers.push({ id: phone, name: phone });
          }
        }
      } catch {
        // Non-fatal
      }

      // Apply query filter
      let filtered = peers;
      if (query) {
        const q = query.toLowerCase();
        filtered = peers.filter(
          (p) =>
            p.id.toLowerCase().includes(q) ||
            (p.name?.toLowerCase().includes(q) ?? false),
        );
      }

      // Apply limit
      if (limit && limit > 0) {
        filtered = filtered.slice(0, limit);
      }

      return filtered;
    },

    listGroups: async ({ cfg, accountId, query, limit }) => {
      // Return known group conversations from store
      try {
        const store = createTwilioConversationStore({
          accountId: accountId ?? DEFAULT_ACCOUNT_ID,
        });
        const entries = await store.list();
        let groups = entries
          .filter((e) => e.reference.isGroup)
          .map((e) => ({
            id: e.key,
            name: e.key,
          }));

        if (query) {
          const q = query.toLowerCase();
          groups = groups.filter((g) => g.id.toLowerCase().includes(q));
        }
        if (limit && limit > 0) {
          groups = groups.slice(0, limit);
        }

        return groups;
      } catch {
        return [];
      }
    },
  },

  // ── Resolver ──────────────────────────────────────────────────────

  resolver: {
    resolveTargets: async ({ inputs }) => {
      return inputs.map((input: string) => {
        const normalized = normalizeE164(input.trim());
        return {
          input,
          resolved: Boolean(normalized),
          id: normalized ?? undefined,
        };
      });
    },
  },

  // ── Outbound ──────────────────────────────────────────────────────

  outbound: twilioOutbound,

  // ── Status ────────────────────────────────────────────────────────

  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },

    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured,
      running: snapshot.running,
      port: (snapshot as any).port,
    }),

    probeAccount: async ({ account }) => {
      const { accountSid, authToken } = account.credentials;
      if (!accountSid || !authToken) {
        return { ok: false, error: "Credentials not configured" };
      }
      try {
        const twilio = await import("twilio");
        const client = twilio.default(accountSid, authToken);
        const acct = await client.api.accounts(accountSid).fetch();
        return {
          ok: true,
          friendlyName: acct.friendlyName,
          status: acct.status,
        };
      } catch (err: unknown) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },

    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.fromNumber?.trim()),
      fromNumber: account.fromNumber,
      running: (runtime as any)?.running ?? false,
      lastStartAt: (runtime as any)?.lastStartAt ?? null,
      lastStopAt: (runtime as any)?.lastStopAt ?? null,
      lastError: (runtime as any)?.lastError ?? null,
      port: (runtime as any)?.port ?? null,
    }),
  },

  // ── Gateway ───────────────────────────────────────────────────────

  gateway: {
    startAccount: async (ctx) => {
      const port =
        (getTwilioSection(ctx.cfg as OpenClawConfig)?.shared?.webhook ??
          getTwilioSection(ctx.cfg as OpenClawConfig)?.webhook)?.port ?? 3100;

      (ctx as any).setStatus?.({
        accountId: ctx.accountId,
        port,
        running: true,
        lastStartAt: Date.now(),
      });

      (ctx as any).log?.info?.(
        `[${ctx.accountId}] starting Twilio provider (port ${port})`,
      );

      const { monitorTwilioProvider } = await import("./monitor.js");
      return monitorTwilioProvider({
        cfg: ctx.cfg,
        accountId: ctx.accountId,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
      });
    },
  },
};
