import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { TwilioConfig, MonitorTwilioOpts } from "./types.js";
import { resolveTwilioCredentials } from "./credentials.js";
import { handleInboundMessage } from "./inbound.js";
import { handleStatusCallback } from "./status-callback.js";
import { initDatabase, closeDatabase } from "./db.js";
import { resolveTwilioAccount, listTwilioAccountIds } from "./accounts.js";

function getTwilioSection(cfg: unknown): TwilioConfig | undefined {
  return (cfg as any)?.channels?.twilio as TwilioConfig | undefined;
}

// ── Singleton server state ───────────────────────────────────────────────────

let _serverPromise: Promise<void> | null = null;

/**
 * Start the Twilio Conversations webhook server.
 *
 * A single Express server handles all DIDs/accounts. Inbound routing uses
 * MessagingBinding.ProxyAddress to resolve the correct account.
 *
 * When called for subsequent accounts, returns the already-running server
 * promise rather than starting a second server on the same port.
 */
export async function monitorTwilioProvider(
  opts: MonitorTwilioOpts,
): Promise<void> {
  if (_serverPromise) {
    console.log(
      `[twilio:gateway] Server already running — ${opts.accountId} sharing existing instance`,
    );
    return _serverPromise;
  }

  _serverPromise = _startServer(opts).finally(() => {
    _serverPromise = null;
  });

  return _serverPromise;
}

/**
 * Configure Twilio Address Configuration for a DID so that inbound SMS
 * auto-creates a Conversation and fires onMessageAdded to our webhook.
 *
 * Idempotent — safe to call on every startup.
 */
async function setupAddressConfiguration(params: {
  client: any;
  fromNumber: string;
  webhookUrl: string;
  conversationServiceSid?: string;
  log: { info: (...a: any[]) => void; warn: (...a: any[]) => void };
}): Promise<void> {
  const { client, fromNumber, webhookUrl, conversationServiceSid, log } = params;
  try {
    const createParams: Record<string, unknown> = {
      type: "sms",
      address: fromNumber,
      friendlyName: `OpenClaw Conversations (${fromNumber})`,
      "autoCreation.enabled": true,
      "autoCreation.type": "webhook",
      "autoCreation.webhookUrl": webhookUrl,
      "autoCreation.webhookMethod": "POST",
      "autoCreation.webhookFilters": ["onMessageAdded"],
    };
    if (conversationServiceSid) {
      createParams["autoCreation.conversationServiceSid"] = conversationServiceSid;
    }

    await client.conversations.v1.configuration.addresses.create(createParams as any);
    log.info(
      `[twilio:gateway] Address configuration created for ${fromNumber} → ${webhookUrl}`,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // 409 / duplicate = already configured — not an error
    if (msg.includes("already exists") || msg.includes("409")) {
      log.info(
        `[twilio:gateway] Address configuration already exists for ${fromNumber}`,
      );
    } else {
      log.warn(
        `[twilio:gateway] Could not configure address ${fromNumber}: ${msg}`,
      );
    }
  }
}

async function _startServer(opts: MonitorTwilioOpts): Promise<void> {
  const { cfg, accountId, abortSignal } = opts;
  const ocCfg = cfg as OpenClawConfig;
  const section = getTwilioSection(cfg);

  // Resolve shared credentials
  const credentials = resolveTwilioCredentials(section);
  if (!credentials) {
    throw new Error(
      "Twilio credentials not configured. Set accountSid/authToken in config or TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN env vars.",
    );
  }

  // Initialize shared SQLite database
  await initDatabase(section);

  const webhookCfg = section?.shared?.webhook ?? section?.webhook;
  const webhookPort = webhookCfg?.port ?? 3100;
  const webhookPath = webhookCfg?.path ?? "/conversations/events";
  const statusPath = "/sms/status";
  const conversationServiceSid = section?.shared?.conversationServiceSid;

  // Dynamic import Express 5
  const express = await import("express");
  const app = express.default();

  // Parse URL-encoded bodies (Twilio Conversations webhooks send form-encoded)
  app.use(express.urlencoded({ extended: false }));

  // Twilio signature validation middleware
  const authToken = credentials.authToken;
  const baseUrl = webhookCfg?.baseUrl;

  const log = {
    info: (...args: unknown[]) => console.log(...args),
    warn: (...args: unknown[]) => console.warn(...args),
    debug: (...args: unknown[]) => console.debug(...args),
  };

  if (baseUrl) {
    try {
      const twilio = await import("twilio");
      const validateRequest = twilio.default.validateRequest;

      app.use(webhookPath, (req: any, res: any, next: any) => {
        const twilioSignature = req.headers["x-twilio-signature"] as string;
        const url = `${baseUrl}${webhookPath}`;

        if (!twilioSignature) {
          log.warn("[twilio:webhook] Missing X-Twilio-Signature header");
          res.status(403).send("Forbidden");
          return;
        }

        const isValid = validateRequest(authToken, twilioSignature, url, req.body ?? {});
        if (!isValid) {
          log.warn("[twilio:webhook] Invalid Twilio signature");
          res.status(403).send("Forbidden");
          return;
        }

        next();
      });

      // Status callback validation (keep for delivery receipt tracking)
      app.use(statusPath, (req: any, res: any, next: any) => {
        const twilioSignature = req.headers["x-twilio-signature"] as string;
        const url = `${baseUrl}${statusPath}`;

        if (!twilioSignature) {
          res.status(403).send("Forbidden");
          return;
        }

        const isValid = validateRequest(authToken, twilioSignature, url, req.body ?? {});
        if (!isValid) {
          res.status(403).send("Forbidden");
          return;
        }

        next();
      });
    } catch {
      log.warn("[twilio:webhook] Could not load twilio module for signature validation");
    }
  }

  // Mount Conversations webhook handler (onMessageAdded and other events)
  app.post(webhookPath, async (req: any, res: any) => {
    await handleInboundMessage(req, res, { cfg: ocCfg, log });
  });

  // Mount delivery status callback handler
  app.post(statusPath, (req: any, res: any) => {
    handleStatusCallback(req, res);
  });

  // Health check endpoint
  app.get("/health", (_req: any, res: any) => {
    res.json({ status: "ok", channel: "twilio", accountId });
  });

  // Start listening
  return new Promise<void>((resolve, reject) => {
    const server = app.listen(webhookPort, "0.0.0.0", async () => {
      log.info(
        `[twilio:gateway] Webhook server listening on 0.0.0.0:${webhookPort} (conversations: ${webhookPath}, status: ${statusPath})`,
      );

      // Configure Twilio Address Configuration for all accounts
      if (baseUrl) {
        try {
          const twilio = await import("twilio");
          const client = twilio.default(credentials.accountSid, credentials.authToken);
          const webhookUrl = `${baseUrl.replace(/\/+$/, "")}${webhookPath}`;

          const accountIds = listTwilioAccountIds(ocCfg);
          for (const acctId of accountIds) {
            try {
              const account = resolveTwilioAccount({ cfg: ocCfg, accountId: acctId });
              if (account.fromNumber) {
                await setupAddressConfiguration({
                  client,
                  fromNumber: account.fromNumber,
                  webhookUrl,
                  conversationServiceSid,
                  log,
                });
              }
            } catch (acctErr) {
              log.warn(
                `[twilio:gateway] Could not setup address config for ${acctId}: ${acctErr instanceof Error ? acctErr.message : String(acctErr)}`,
              );
            }
          }
        } catch (setupErr) {
          log.warn(
            `[twilio:gateway] Address configuration setup failed: ${setupErr instanceof Error ? setupErr.message : String(setupErr)}`,
          );
        }
      }
    });

    server.on("error", (err: Error) => {
      log.warn(`[twilio:gateway] Server error: ${err.message}`);
      reject(err);
    });

    // Graceful shutdown on abort
    const onAbort = () => {
      log.info("[twilio:gateway] Shutting down webhook server...");
      server.close(async () => {
        await closeDatabase();
        log.info("[twilio:gateway] Webhook server stopped");
        resolve();
      });
    };

    if (abortSignal.aborted) {
      server.close();
      resolve();
      return;
    }

    abortSignal.addEventListener("abort", onAbort, { once: true });
  });
}
