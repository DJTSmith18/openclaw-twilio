import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { SendTwilioMessageResult, TwilioConfig } from "./types.js";
import { resolveTwilioAccount } from "./accounts.js";
import { createTwilioConversationStore } from "./conversation-store.js";

type SendParams = {
  cfg: unknown;
  to: string;
  text?: string;
  mediaUrl?: string;
  accountId?: string | null;
};

function getTwilioSection(cfg: unknown): TwilioConfig | undefined {
  return (cfg as any)?.channels?.twilio as TwilioConfig | undefined;
}

/**
 * Send a Twilio message (SMS/MMS/RCS).
 *
 * Resolves the correct fromNumber based on accountId, then calls
 * the Twilio Messages API.
 */
export async function sendTwilioMessage(
  params: SendParams,
): Promise<SendTwilioMessageResult> {
  const { cfg, to, text, mediaUrl, accountId } = params;
  const ocCfg = cfg as OpenClawConfig;

  const account = resolveTwilioAccount({ cfg: ocCfg, accountId });
  const { accountSid, authToken } = account.credentials;

  if (!accountSid || !authToken) {
    return { ok: false, error: "Twilio credentials not configured" };
  }

  if (!account.fromNumber && !account.messagingServiceSid) {
    return {
      ok: false,
      error: "No fromNumber or messagingServiceSid configured for this account",
    };
  }

  try {
    const twilio = await import("twilio");
    const client = twilio.default(accountSid, authToken);

    const section = getTwilioSection(cfg);
    const statusCallbackUrl = buildStatusCallbackUrl(section);

    const createParams: Record<string, unknown> = {
      to,
      body: text ?? "",
    };

    // Use messagingServiceSid if available (enables RCS + smart routing)
    if (account.messagingServiceSid) {
      createParams.messagingServiceSid = account.messagingServiceSid;
    } else {
      createParams.from = account.fromNumber;
    }

    // MMS: include media
    if (mediaUrl) {
      createParams.mediaUrl = [mediaUrl];
    }

    // Status callback
    if (statusCallbackUrl) {
      createParams.statusCallback = statusCallbackUrl;
    }

    const message = await client.messages.create(createParams as any);

    // Log outbound message to conversation history
    try {
      const store = createTwilioConversationStore({ accountId: account.accountId, cfg });
      await store.logMessage({
        phoneNumber: to,
        did: account.fromNumber,
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
      conversationId: `twilio:${account.accountId}:direct:${to}`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

/**
 * Send a message to multiple recipients (group-style broadcast).
 */
export async function sendTwilioGroupMessage(
  params: SendParams & { recipients: string[] },
): Promise<SendTwilioMessageResult> {
  const results: SendTwilioMessageResult[] = [];

  for (const recipient of params.recipients) {
    const result = await sendTwilioMessage({
      ...params,
      to: recipient,
    });
    results.push(result);
  }

  const allOk = results.every((r) => r.ok);
  const messageIds = results
    .filter((r) => r.messageId)
    .map((r) => r.messageId!);

  return {
    ok: allOk,
    messageId: messageIds[0],
    error: allOk
      ? undefined
      : results
          .filter((r) => !r.ok)
          .map((r) => r.error)
          .join("; "),
  };
}

function buildStatusCallbackUrl(
  section: TwilioConfig | undefined,
): string | undefined {
  const webhook = section?.shared?.webhook ?? section?.webhook;
  if (!webhook?.baseUrl) return undefined;

  const base = webhook.baseUrl.replace(/\/+$/, "");
  const statusPath = webhook.statusPath ?? "/sms/status";
  return `${base}${statusPath}`;
}
