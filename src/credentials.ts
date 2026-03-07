import type { TwilioCredentials, TwilioConfig } from "./types.js";

/**
 * Resolve Twilio API credentials from config with env-var fallback.
 *
 * Priority: config → environment variable.
 */
export function resolveTwilioCredentials(
  cfg?: TwilioConfig,
): TwilioCredentials | undefined {
  const accountSid =
    cfg?.accountSid?.trim() || process.env.TWILIO_ACCOUNT_SID?.trim();
  const authToken =
    cfg?.authToken?.trim() || process.env.TWILIO_AUTH_TOKEN?.trim();

  if (!accountSid || !authToken) {
    return undefined;
  }

  return { accountSid, authToken };
}

/**
 * Resolve the default fromNumber from config or env.
 * Only used for the default account.
 */
export function resolveDefaultFromNumber(cfg?: TwilioConfig): string | undefined {
  return cfg?.fromNumber?.trim() || process.env.TWILIO_FROM_NUMBER?.trim();
}

/**
 * Resolve the messaging service SID from config or env.
 * Only used for the default account.
 */
export function resolveDefaultMessagingServiceSid(
  cfg?: TwilioConfig,
): string | undefined {
  return (
    cfg?.messagingServiceSid?.trim() ||
    process.env.TWILIO_MESSAGING_SERVICE_SID?.trim()
  );
}
