import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { TwilioConfig, MonitorTwilioOpts, TwilioEventStreamEvent } from "./types.js";
import { resolveTwilioCredentials } from "./credentials.js";
import { handleInboundMessage } from "./inbound.js";
import { handleStatusCallback } from "./status-callback.js";
import { initDatabase, closeDatabase, storeEventStreamRecipients } from "./db.js";

function getTwilioSection(cfg: unknown): TwilioConfig | undefined {
  return (cfg as any)?.channels?.twilio as TwilioConfig | undefined;
}

// ── Singleton server state ───────────────────────────────────────────────────
// OpenClaw calls startAccount once per DID, but we only want one Express
// server for all DIDs. The first account starts the server; subsequent
// accounts wait on the same promise so they stay alive until it stops.

let _serverPromise: Promise<void> | null = null;

/**
 * Start the Twilio webhook server.
 *
 * A single Express server handles all DIDs. Inbound routing uses the
 * `To` field to resolve the correct account.
 *
 * When called for subsequent accounts, returns the already-running server
 * promise rather than starting a second server on the same port.
 */
export async function monitorTwilioProvider(
  opts: MonitorTwilioOpts,
): Promise<void> {
  if (_serverPromise) {
    console.log(`[twilio:gateway] Server already running — ${opts.accountId} sharing existing instance`);
    return _serverPromise;
  }

  _serverPromise = _startServer(opts).finally(() => {
    _serverPromise = null;
  });

  return _serverPromise;
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

  // Initialize shared SQLite database (contacts + conversation history)
  await initDatabase(section);

  const webhookCfg = section?.shared?.webhook ?? section?.webhook;
  const webhookPort = webhookCfg?.port ?? 3100;
  const webhookPath = webhookCfg?.path ?? "/sms";
  const statusPath = webhookCfg?.statusPath ?? "/sms/status";
  const streamPath = webhookCfg?.streamPath ?? `${webhookPath}/stream`;

  // Dynamic import Express 5
  const express = await import("express");
  const app = express.default();

  // Parse URL-encoded bodies (Twilio sends application/x-www-form-urlencoded)
  app.use(express.urlencoded({ extended: false }));

  // Parse JSON bodies for the Event Streams sink endpoint.
  // Accept any content-type since Twilio Event Streams may send an unexpected
  // Content-Type header. The verify callback captures the raw body string for
  // both signature validation and manual fallback parsing.
  app.use(streamPath, express.json({
    type: "*/*",
    verify: (req: any, _res: any, buf: Buffer) => {
      req.rawBody = buf.toString("utf8");
    },
  }));

  // Twilio signature validation middleware
  const authToken = credentials.authToken;
  const baseUrl = webhookCfg?.baseUrl;

  if (baseUrl) {
    try {
      const twilio = await import("twilio");
      // validateRequest is on the default export (Twilio constructor)
      const validateRequest = twilio.default.validateRequest;
      // validateRequestWithBody is a named module export, not on the default export
      const validateRequestWithBody =
        (twilio as any).validateRequestWithBody ??
        (twilio as any).default?.validateRequestWithBody;
      console.log(`[twilio:webhook] validateRequestWithBody available: ${typeof validateRequestWithBody}`);

      app.use(webhookPath, (req: any, res: any, next: any) => {
        // app.use(path) matches sub-paths too — skip validation for sub-paths
        // (e.g. /sms2/stream) which have their own middleware below.
        if (req.path !== "/") return next();

        const twilioSignature = req.headers["x-twilio-signature"] as string;
        const url = `${baseUrl}${webhookPath}`;

        if (!twilioSignature) {
          console.warn("[twilio:webhook] Missing X-Twilio-Signature header");
          res.status(403).type("text/xml").send("<Response></Response>");
          return;
        }

        const isValid = validateRequest(authToken, twilioSignature, url, req.body ?? {});

        if (!isValid) {
          console.warn("[twilio:webhook] Invalid Twilio signature");
          res.status(403).type("text/xml").send("<Response></Response>");
          return;
        }

        next();
      });

      // Also validate status callback path
      app.use(statusPath, (req: any, res: any, next: any) => {
        if (req.path !== "/") return next();

        const twilioSignature = req.headers["x-twilio-signature"] as string;
        const url = `${baseUrl}${statusPath}`;

        if (!twilioSignature) {
          res.status(403).type("text/xml").send("<Response></Response>");
          return;
        }

        const isValid = validateRequest(authToken, twilioSignature, url, req.body ?? {});

        if (!isValid) {
          res.status(403).type("text/xml").send("<Response></Response>");
          return;
        }

        next();
      });

      // Validate Event Streams sink endpoint.
      // NOTE: Twilio Event Streams uses its own auth model (Basic Auth or none
      // at the sink level) — it does NOT use the standard X-Twilio-Signature
      // webhook signing mechanism. We attempt signature validation anyway and
      // log the result, but never block the request on a failed signature:
      // the endpoint only writes transient recipient data to SQLite (TTL 60s),
      // so the blast radius of a spoofed request is minimal.
      app.use(streamPath, (req: any, res: any, next: any) => {
        const twilioSignature = req.headers["x-twilio-signature"] as string | undefined;
        if (twilioSignature && validateRequestWithBody) {
          const url = `${baseUrl}${streamPath}`;
          const rawBody: string = req.rawBody ?? "";
          const isValid = validateRequestWithBody(authToken, twilioSignature, url, rawBody);
          if (!isValid) {
            console.debug(
              `[twilio:stream] signature mismatch (non-blocking) url="${url}" rawBody=${rawBody.length}b`,
            );
          }
        }
        next();
      });
    } catch {
      console.warn(
        "[twilio:webhook] Could not load twilio module for signature validation",
      );
    }
  }

  const log = {
    info: (...args: unknown[]) => console.log(...args),
    warn: (...args: unknown[]) => console.warn(...args),
    debug: (...args: unknown[]) => console.debug(...args),
  };

  // Mount inbound message handler
  app.post(webhookPath, async (req: any, res: any) => {
    await handleInboundMessage(req, res, { cfg: ocCfg, log });
  });

  // Mount status callback handler
  app.post(statusPath, (req: any, res: any) => {
    handleStatusCallback(req, res);
  });

  // Mount Event Streams sink — stores recipient list for group MMS detection
  app.post(streamPath, async (req: any, res: any) => {
    res.status(200).send("OK");
    try {
      // Fall back to parsing rawBody if express.json() didn't parse (content-type mismatch)
      const parsedBody =
        req.body && typeof req.body === "object" && Object.keys(req.body).length > 0
          ? req.body
          : (() => {
              try { return JSON.parse(req.rawBody ?? "{}"); } catch { return {}; }
            })();
      // Twilio sends a JSON array of CloudEvents envelopes; process each one
      const events: TwilioEventStreamEvent[] = Array.isArray(parsedBody)
        ? parsedBody
        : [parsedBody];
      for (const event of events) {
        const messageSid = event?.data?.messageSid;
        const recipients = event?.data?.recipients;
        log.info(
          `[twilio:stream] received type=${event?.type ?? "(unknown)"} messageSid=${messageSid ?? "(none)"} recipients=${JSON.stringify(recipients ?? null)}`,
        );
        if (messageSid && Array.isArray(recipients) && recipients.length > 0) {
          await storeEventStreamRecipients(messageSid, recipients);
          log.info(
            `[twilio:stream] stored ${messageSid} → ${recipients.length} recipients: ${recipients.join(", ")}`,
          );
        } else if (messageSid) {
          log.info(`[twilio:stream] ${messageSid} — no recipients (1:1 message)`);
        }
      }
    } catch (err: unknown) {
      log.warn(
        `[twilio:stream] Error processing event: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  // Health check endpoint
  app.get("/health", (_req: any, res: any) => {
    res.json({ status: "ok", channel: "twilio", accountId });
  });

  // Start listening
  return new Promise<void>((resolve, reject) => {
    const server = app.listen(webhookPort, "0.0.0.0", () => {
      log.info(
        `[twilio:gateway] Webhook server listening on 0.0.0.0:${webhookPort} (inbound: ${webhookPath}, status: ${statusPath}, stream: ${streamPath})`,
      );
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
