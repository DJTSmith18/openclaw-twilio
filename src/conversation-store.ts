import { dbRun, dbGet, dbAll, initDatabase } from "./db.js";
import { normalizeE164 } from "./normalize.js";
import type { StoredConversationReference } from "./types.js";

export type TwilioConversationStoreEntry = {
  key: string;
  reference: StoredConversationReference;
  lastSeenAt: number;
};

export type TwilioConversationStore = {
  upsert: (key: string, reference: StoredConversationReference) => Promise<void>;
  get: (key: string) => Promise<StoredConversationReference | null>;
  list: () => Promise<TwilioConversationStoreEntry[]>;
  remove: (key: string) => Promise<boolean>;
  findByPhone: (phone: string) => Promise<TwilioConversationStoreEntry | null>;
  logMessage: (params: LogMessageParams) => Promise<void>;
  getThread: (params: GetThreadParams) => Promise<ConversationRow[]>;
};

export type LogMessageParams = {
  phoneNumber: string;
  did: string;
  accountId: string;
  agent?: string;
  direction: "inbound" | "outbound";
  message: string;
  mediaUrl?: string;
  messageSid?: string;
  chatType?: "direct" | "group";
  status?: string;
  context?: string;
  conversationSid?: string;
};

export type GetThreadParams = {
  did: string;
  phoneNumber?: string;
  limit?: number;
};

export type ConversationRow = {
  id: number;
  phone_number: string;
  did: string;
  account_id: string;
  agent: string | null;
  direction: string;
  message: string;
  media_url: string | null;
  message_sid: string | null;
  chat_type: string;
  status: string | null;
  context: string | null;
  created_at: string;
};

// ── Timezone-aware timestamp ────────────────────────────────────────────────

function torontoTimestamp(): string {
  return new Date().toLocaleString("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).replace(",", "") + " America/Toronto";
}

// ── Phone normalization (voipms-compatible: last 10 digits) ─────────────────

function normalizePhone10(phone: string): string {
  return String(phone || "").replace(/\D/g, "").slice(-10);
}

// ── Store factory ───────────────────────────────────────────────────────────

/**
 * Create a conversation store backed by the shared SQLite database.
 *
 * The store manages two concerns:
 *   1. Conversation references (session tracking for outbound replies)
 *   2. Message history (twilio_conversations table — full audit log)
 *
 * Conversation references are stored in `twilio_conversations` as well;
 * `upsert`/`get` operate on the most recent row matching a session key.
 */
export function createTwilioConversationStore(params: {
  accountId: string;
  cfg?: unknown;
}): TwilioConversationStore {
  const accountId = params.accountId;

  // Ensure DB is initialised (idempotent)
  const ready = initDatabase((params.cfg as any)?.channels?.twilio);

  return {
    // ── Session reference tracking ────────────────────────────────────

    async upsert(key, reference) {
      await ready;
      await dbRun(
        `INSERT INTO twilio_conversations
           (phone_number, did, account_id, direction, message, chat_type, context, created_at)
         VALUES (?, ?, ?, 'inbound', '', ?, ?, ?)`,
        [
          normalizePhone10(reference.from),
          reference.to,
          accountId,
          reference.isGroup ? "group" : "direct",
          `ref:${key}`,
          torontoTimestamp(),
        ],
      );
    },

    async get(key) {
      await ready;
      const row = await dbGet<{
        phone_number: string;
        did: string;
        account_id: string;
        chat_type: string;
        message_sid: string | null;
        created_at: string;
      }>(
        `SELECT phone_number, did, account_id, chat_type, message_sid, created_at
         FROM twilio_conversations
         WHERE account_id = ? AND context = ?
         ORDER BY created_at DESC LIMIT 1`,
        [accountId, `ref:${key}`],
      );
      if (!row) return null;
      return {
        from: row.phone_number,
        to: row.did,
        accountId: row.account_id,
        lastMessageSid: row.message_sid ?? undefined,
        lastTimestamp: new Date(row.created_at).getTime(),
        isGroup: row.chat_type === "group",
      };
    },

    async list() {
      await ready;
      const rows = await dbAll<{
        phone_number: string;
        did: string;
        account_id: string;
        chat_type: string;
        message_sid: string | null;
        context: string;
        created_at: string;
      }>(
        `SELECT phone_number, did, account_id, chat_type, message_sid, context, created_at
         FROM twilio_conversations
         WHERE account_id = ? AND context LIKE 'ref:%'
         GROUP BY context
         ORDER BY created_at DESC`,
        [accountId],
      );
      return rows.map((r) => ({
        key: r.context.replace(/^ref:/, ""),
        reference: {
          from: r.phone_number,
          to: r.did,
          accountId: r.account_id,
          lastMessageSid: r.message_sid ?? undefined,
          lastTimestamp: new Date(r.created_at).getTime(),
          isGroup: r.chat_type === "group",
        },
        lastSeenAt: new Date(r.created_at).getTime(),
      }));
    },

    async remove(key) {
      await ready;
      await dbRun(
        `DELETE FROM twilio_conversations WHERE account_id = ? AND context = ?`,
        [accountId, `ref:${key}`],
      );
      return true;
    },

    async findByPhone(phone) {
      await ready;
      const norm = normalizePhone10(phone);
      if (!norm) return null;
      const row = await dbGet<{
        phone_number: string;
        did: string;
        account_id: string;
        chat_type: string;
        message_sid: string | null;
        context: string;
        created_at: string;
      }>(
        `SELECT phone_number, did, account_id, chat_type, message_sid, context, created_at
         FROM twilio_conversations
         WHERE account_id = ? AND phone_number = ? AND context LIKE 'ref:%'
         ORDER BY created_at DESC LIMIT 1`,
        [accountId, norm],
      );
      if (!row) return null;
      return {
        key: row.context.replace(/^ref:/, ""),
        reference: {
          from: row.phone_number,
          to: row.did,
          accountId: row.account_id,
          lastMessageSid: row.message_sid ?? undefined,
          lastTimestamp: new Date(row.created_at).getTime(),
          isGroup: row.chat_type === "group",
        },
        lastSeenAt: new Date(row.created_at).getTime(),
      };
    },

    // ── Message history (twilio_conversations table) ──────────────────

    async logMessage(p) {
      await ready;
      await dbRun(
        `INSERT INTO twilio_conversations
           (phone_number, did, account_id, agent, direction, message, media_url, message_sid, chat_type, status, context, conversation_sid, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          normalizePhone10(p.phoneNumber),
          p.did,
          p.accountId,
          p.agent ?? null,
          p.direction,
          p.message,
          p.mediaUrl ?? null,
          p.messageSid ?? null,
          p.chatType ?? "direct",
          p.status ?? null,
          p.context ?? `twilio-channel-${p.direction}`,
          p.conversationSid ?? null,
          torontoTimestamp(),
        ],
      );
    },

    async getThread(p) {
      await ready;
      const limit = p.limit ?? 50;

      if (p.phoneNumber) {
        return dbAll<ConversationRow>(
          `SELECT id, phone_number, did, account_id, agent, direction,
                  message, media_url, message_sid, chat_type, status, context, created_at
           FROM twilio_conversations
           WHERE did = ? AND phone_number = ? AND context NOT LIKE 'ref:%'
           ORDER BY created_at DESC LIMIT ?`,
          [p.did, normalizePhone10(p.phoneNumber), limit],
        );
      }

      return dbAll<ConversationRow>(
        `SELECT id, phone_number, did, account_id, agent, direction,
                message, media_url, message_sid, chat_type, status, context, created_at
         FROM twilio_conversations
         WHERE did = ? AND context NOT LIKE 'ref:%'
         ORDER BY created_at DESC LIMIT ?`,
        [p.did, limit],
      );
    },
  };
}

// ── Shared contacts helpers ─────────────────────────────────────────────────

/**
 * Look up a contact from the shared contacts table.
 * Uses the same phone normalization as voipms-sms (last 10 digits).
 */
export async function lookupContact(
  phone: string,
  opts?: { table?: string; phoneColumn?: string; phoneMatch?: "exact" | "like"; selectColumns?: string[] },
): Promise<Record<string, unknown> | undefined> {
  await initDatabase();
  const table = opts?.table ?? "contacts";
  const phoneCol = opts?.phoneColumn ?? "phone";
  const matchMode = opts?.phoneMatch ?? "like";
  const phone10 = normalizePhone10(phone);

  const cols =
    opts?.selectColumns && opts.selectColumns.length > 0
      ? opts.selectColumns.join(", ")
      : "*";

  const where =
    matchMode === "exact"
      ? `${phoneCol} = ?`
      : `${phoneCol} LIKE ?`;
  const param = matchMode === "exact" ? phone10 : `%${phone10}%`;

  return dbGet<Record<string, unknown>>(
    `SELECT ${cols} FROM ${table} WHERE ${where} LIMIT 1`,
    [param],
  );
}

/**
 * Upsert a contact in the shared contacts table.
 * voipms-compatible: phone as PRIMARY KEY, upsert on conflict.
 */
export async function upsertContact(
  phone: string,
  fields: Record<string, string | null>,
  opts?: { table?: string; phoneColumn?: string },
): Promise<void> {
  await initDatabase();
  const table = opts?.table ?? "contacts";
  const phoneCol = opts?.phoneColumn ?? "phone";
  const phone10 = normalizePhone10(phone);

  const columns = [phoneCol, ...Object.keys(fields)];
  const values = [phone10, ...Object.values(fields)];
  const placeholders = columns.map(() => "?").join(", ");
  const updateParts = Object.keys(fields)
    .map((col) => `${col} = excluded.${col}`)
    .join(", ");

  const sql = updateParts
    ? `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})
       ON CONFLICT(${phoneCol}) DO UPDATE SET ${updateParts}`
    : `INSERT OR IGNORE INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`;

  await dbRun(sql, values);
}
