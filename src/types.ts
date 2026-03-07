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

/** Top-level config: shared credentials + per-account overrides. */
export type TwilioConfig = {
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
    baseUrl?: string;
  };
  accounts?: Record<string, TwilioAccountConfig>;
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

export type MonitorTwilioOpts = {
  cfg: unknown;
  accountId: string;
  runtime: unknown;
  abortSignal: AbortSignal;
};
