import type { Request, Response } from "express";

/**
 * Handle Twilio delivery status webhook callbacks.
 *
 * Twilio POSTs status updates (queued → sending → sent → delivered / failed)
 * to the configured statusCallback URL.
 */
export function handleStatusCallback(req: Request, res: Response): void {
  const body = req.body as Record<string, string>;

  const messageSid = body.MessageSid;
  const messageStatus = body.MessageStatus;
  const errorCode = body.ErrorCode;
  const errorMessage = body.ErrorMessage;

  if (messageSid && messageStatus) {
    const level =
      messageStatus === "failed" || messageStatus === "undelivered"
        ? "warn"
        : "debug";

    const logLine = [
      `[twilio:status] ${messageSid}: ${messageStatus}`,
      errorCode ? `error=${errorCode}` : null,
      errorMessage ? `msg=${errorMessage}` : null,
    ]
      .filter(Boolean)
      .join(" ");

    if (level === "warn") {
      console.warn(logLine);
    } else {
      console.debug(logLine);
    }
  }

  // Always respond 200 to acknowledge
  res.status(200).type("text/xml").send("<Response></Response>");
}
