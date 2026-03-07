/**
 * Normalize a phone number to E.164 format.
 * Returns null if the input doesn't look like a phone number.
 */
export function normalizeE164(raw: string | undefined | null): string | null {
  if (!raw) return null;

  // Strip everything except digits and leading +
  let cleaned = raw.trim();

  // Remove common prefixes
  cleaned = cleaned
    .replace(/^(twilio|sms|phone|tel|mms|rcs):/i, "")
    .trim();

  // Strip formatting characters
  cleaned = cleaned.replace(/[\s\-().]/g, "");

  // Must start with + or be all digits
  if (!/^\+?\d+$/.test(cleaned)) return null;

  // Ensure + prefix
  if (!cleaned.startsWith("+")) {
    // Assume US number if 10 digits
    if (cleaned.length === 10) {
      cleaned = "+1" + cleaned;
    } else if (cleaned.length === 11 && cleaned.startsWith("1")) {
      cleaned = "+" + cleaned;
    } else {
      cleaned = "+" + cleaned;
    }
  }

  // Minimum E.164 length is +X (country code) + subscriber (at least a few digits)
  if (cleaned.length < 8 || cleaned.length > 16) return null;

  return cleaned;
}

/**
 * Normalize a messaging target that may include twilio:/sms: prefixes.
 */
export function normalizeTwilioTarget(
  raw: string | undefined | null,
): string | undefined {
  if (!raw) return undefined;
  const normalized = normalizeE164(raw);
  return normalized ?? undefined;
}

/**
 * Quick check whether a string looks like a phone number.
 */
export function looksLikePhoneNumber(raw: string): boolean {
  const cleaned = raw
    .replace(/^(twilio|sms|phone|tel|mms|rcs):/i, "")
    .trim()
    .replace(/[\s\-().]/g, "");
  return /^\+?\d{7,15}$/.test(cleaned);
}
