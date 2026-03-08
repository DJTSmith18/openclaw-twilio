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
  /** Optional Conversations Service SID (IS...). Defaults to the account's default service. */
  conversationServiceSid?: string;
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

/**
 * Twilio Conversations API webhook payload (form-encoded POST).
 * Fired for onMessageAdded and other conversation events.
 */
export type TwilioConversationsWebhookPayload = {
  EventType: string;
  ConversationSid: string;
  MessageSid?: string;
  AccountSid: string;
  Body?: string;
  Author?: string;              // sender's E.164 phone (SMS participants) or identity (chat)
  ParticipantSid?: string;
  Index?: string;
  DateCreated?: string;
  Attributes?: string;
  // Messaging binding fields (flat form-encoded from Twilio)
  "MessagingBinding.Address"?: string;    // sender's phone number
  "MessagingBinding.ProxyAddress"?: string; // our Twilio DID
  "MessagingBinding.Type"?: string;         // "sms", "whatsapp", etc.
  // Media (MMS)
  NumMedia?: string;
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

export type MonitorTwilioOpts = {
  cfg: unknown;
  accountId: string;
  runtime: unknown;
  abortSignal: AbortSignal;
};
