export type TwilioCredentials = {
  accountSid: string;
  authToken: string;
};

/** Per-account config — each DID can override these. */
export type TwilioAccountConfig = {
  name?: string;
  enabled?: boolean;
  fromNumber?: string;
  messagingServiceSid?: string;
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom?: string[];
  groupPolicy?: "open" | "allowlist" | "disabled";
  groupAllowFrom?: string[];
  mediaMaxMb?: number;
  defaultTo?: string;
  rcs?: {
    enabled?: boolean;
    fallbackToSms?: boolean;
  };
  textChunkLimit?: number;
};

/** Shared infrastructure config — credentials, DB, webhook. Nested under `shared` to prevent openclaw doctor from treating them as single-account fields. */
export type TwilioSharedConfig = {
  accountSid?: string;
  authToken?: string;
  dbPath?: string;
  contactLookup?: {
    table?: string;
    phoneColumn?: string;
    phoneMatch?: "exact" | "like";
    selectColumns?: string[];
    displayName?: string;
  };
  webhook?: {
    port?: number;
    path?: string;
    statusPath?: string;
    streamPath?: string;
    baseUrl?: string;
  };
};

/** Top-level channel config: shared infrastructure + per-account overrides. */
export type TwilioConfig = {
  /** Shared credentials, DB, and webhook config (preferred location). */
  shared?: TwilioSharedConfig;
  accounts?: Record<string, TwilioAccountConfig>;
  /**
   * Legacy top-level fields — still read for backward compatibility and for
   * the env-var fallback mode (no explicit accounts configured).
   * New installs write these fields inside `shared` instead.
   */
  accountSid?: string;
  authToken?: string;
  dbPath?: string;
  contactLookup?: TwilioSharedConfig["contactLookup"];
  webhook?: TwilioSharedConfig["webhook"];
} & TwilioAccountConfig;

export type ResolvedTwilioAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  fromNumber: string;
  messagingServiceSid?: string;
  credentials: TwilioCredentials;
  config: TwilioAccountConfig;
};

export type TwilioInboundMessage = {
  MessageSid: string;
  AccountSid: string;
  MessagingServiceSid?: string;
  From: string;
  To: string;
  Body: string;
  NumMedia: string;
  NumSegments: string;
  SmsStatus: string;
  FromCity?: string;
  FromState?: string;
  FromZip?: string;
  FromCountry?: string;
  ToCity?: string;
  ToState?: string;
  ToZip?: string;
  ToCountry?: string;
  [key: string]: string | undefined;
};

export type StoredConversationReference = {
  from: string;
  to: string;
  accountId: string;
  lastMessageSid?: string;
  lastTimestamp?: number;
  isGroup?: boolean;
  groupParticipants?: string[];
};

export type SendTwilioMessageParams = {
  cfg: unknown;
  to: string;
  text?: string;
  mediaUrl?: string;
  accountId?: string | null;
};

export type SendTwilioMessageResult = {
  ok: boolean;
  messageId?: string;
  conversationId?: string;
  error?: string;
};

/**
 * Twilio Event Streams inbound message event (Messaging.InboundMessageV1/5).
 * Fields are flat at the root — no CloudEvents data envelope.
 * The `recipients` array contains all group MMS participants (group messages only).
 */
export type TwilioEventStreamEvent = {
  messageSid: string;
  timestamp: string;
  accountSid: string;
  eventName: string;
  from: string;
  to: string;
  body?: string;
  numMedia?: number;
  numSegments?: number;
  recipients?: string[];
  messagingServiceSid?: string;
  optOutType?: string;
  fromCity?: string;
  fromState?: string;
  fromZip?: string;
  fromCountry?: string;
  toCity?: string;
  toState?: string;
  toZip?: string;
  toCountry?: string;
};

export type MonitorTwilioOpts = {
  cfg: unknown;
  accountId: string;
  runtime: unknown;
  abortSignal: AbortSignal;
};
