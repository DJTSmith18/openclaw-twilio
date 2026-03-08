import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
} from "openclaw/plugin-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type {
  TwilioConfig,
  TwilioAccountConfig,
  ResolvedTwilioAccount,
} from "./types.js";
import {
  resolveTwilioCredentials,
  resolveDefaultFromNumber,
  resolveDefaultMessagingServiceSid,
} from "./credentials.js";
import { normalizeE164 } from "./normalize.js";

function getTwilioSection(cfg: OpenClawConfig): TwilioConfig | undefined {
  return (cfg as any).channels?.twilio as TwilioConfig | undefined;
}

/**
 * List all configured Twilio account IDs (DID-based).
 * Returns [DEFAULT_ACCOUNT_ID] when no explicit accounts exist.
 */
export function listTwilioAccountIds(cfg: OpenClawConfig): string[] {
  const section = getTwilioSection(cfg);
  if (!section) return [DEFAULT_ACCOUNT_ID];

  const accounts = section.accounts;
  if (accounts && typeof accounts === "object") {
    const ids = Object.keys(accounts).filter(Boolean);
    if (ids.length > 0) return ids.toSorted((a, b) => a.localeCompare(b));
  }

  return [DEFAULT_ACCOUNT_ID];
}

/**
 * Resolve the default account ID.
 */
export function resolveDefaultTwilioAccountId(cfg: OpenClawConfig): string {
  const ids = listTwilioAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

/**
 * Resolve a specific Twilio account by ID.
 * Merges account-specific config over top-level defaults.
 */
export function resolveTwilioAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedTwilioAccount {
  const section = getTwilioSection(params.cfg);
  const rawAccountId = params.accountId ?? undefined;
  const accountId = normalizeAccountId(rawAccountId) ?? DEFAULT_ACCOUNT_ID;

  // Get account-specific overrides (if any).
  // Try normalized key first, then raw key (normalizeAccountId may strip/alter
  // characters like '+' that appear in E.164 config keys).
  const accountCfg: TwilioAccountConfig =
    (accountId !== DEFAULT_ACCOUNT_ID
      ? (section?.accounts?.[accountId] ??
          (rawAccountId && rawAccountId !== accountId
            ? section?.accounts?.[rawAccountId]
            : undefined))
      : section?.accounts?.[DEFAULT_ACCOUNT_ID]) ?? {};

  // Merge: account-specific overrides top-level defaults
  const mergedConfig: TwilioAccountConfig = {
    name: accountCfg.name ?? section?.name,
    enabled: accountCfg.enabled ?? section?.enabled ?? true,
    fromNumber:
      accountCfg.fromNumber ??
      (accountId === DEFAULT_ACCOUNT_ID
        ? resolveDefaultFromNumber(section)
        : section?.fromNumber) ??
      "",
    messagingServiceSid:
      accountCfg.messagingServiceSid ??
      (accountId === DEFAULT_ACCOUNT_ID
        ? resolveDefaultMessagingServiceSid(section)
        : section?.messagingServiceSid),
    dmPolicy: accountCfg.dmPolicy ?? section?.dmPolicy ?? "pairing",
    allowFrom: accountCfg.allowFrom ?? section?.allowFrom,
    groupPolicy: accountCfg.groupPolicy ?? section?.groupPolicy ?? "allowlist",
    groupAllowFrom: accountCfg.groupAllowFrom ?? section?.groupAllowFrom,
    mediaMaxMb: accountCfg.mediaMaxMb ?? section?.mediaMaxMb ?? 5,
    defaultTo: accountCfg.defaultTo ?? section?.defaultTo,
    rcs: accountCfg.rcs ?? section?.rcs,
    textChunkLimit: accountCfg.textChunkLimit ?? section?.textChunkLimit,
  };

  // Shared credentials always from top-level
  const credentials = resolveTwilioCredentials(section) ?? {
    accountSid: "",
    authToken: "",
  };

  // For DID-based accounts, the accountId itself may be the fromNumber
  let fromNumber = mergedConfig.fromNumber ?? "";
  if (!fromNumber && accountId !== DEFAULT_ACCOUNT_ID) {
    // The accountId might be the normalized DID itself
    const normalized = normalizeE164(accountId);
    if (normalized) fromNumber = normalized;
  }

  return {
    accountId,
    enabled: mergedConfig.enabled !== false,
    name: mergedConfig.name,
    fromNumber,
    messagingServiceSid: mergedConfig.messagingServiceSid,
    credentials,
    config: mergedConfig,
  };
}

/**
 * Resolve a Twilio account by matching the inbound To DID.
 * Used for routing inbound messages to the correct account.
 */
export function resolveTwilioAccountByDid(
  cfg: OpenClawConfig,
  didNumber: string,
): ResolvedTwilioAccount | null {
  const normalized = normalizeE164(didNumber);
  if (!normalized) return null;

  const section = getTwilioSection(cfg);
  if (!section) return null;

  // Check if this DID is an explicit account key
  if (section.accounts?.[normalized]) {
    return resolveTwilioAccount({ cfg, accountId: normalized });
  }

  // Check accounts by matching fromNumber
  if (section.accounts) {
    for (const [id, acctCfg] of Object.entries(section.accounts)) {
      const acctFrom = normalizeE164(acctCfg?.fromNumber ?? "");
      if (acctFrom === normalized) {
        return resolveTwilioAccount({ cfg, accountId: id });
      }
    }
  }

  // Check top-level fromNumber (default account)
  const topFrom = normalizeE164(section.fromNumber ?? "");
  if (topFrom === normalized) {
    return resolveTwilioAccount({ cfg, accountId: DEFAULT_ACCOUNT_ID });
  }

  // Fallback: return default account if no match
  return resolveTwilioAccount({ cfg, accountId: DEFAULT_ACCOUNT_ID });
}
