import * as path from "node:path";
import type { TwilioConfig } from "./types.js";

// ── Types ───────────────────────────────────────────────────────────────────

type Database = {
  run: (sql: string, params: unknown[], cb: (err: Error | null) => void) => void;
  get: (sql: string, params: unknown[], cb: (err: Error | null, row: unknown) => void) => void;
  all: (sql: string, params: unknown[], cb: (err: Error | null, rows: unknown[]) => void) => void;
  close: (cb?: (err: Error | null) => void) => void;
};

// ── State ───────────────────────────────────────────────────────────────────

let db: Database | null = null;
let dbReady: Promise<void> | null = null;

// ── Promisified helpers ─────────────────────────────────────────────────────

export function dbRun(sql: string, params: unknown[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!db) return reject(new Error("Database not initialized"));
    db.run(sql, params, (err) => (err ? reject(err) : resolve()));
  });
}

export function dbGet<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    if (!db) return reject(new Error("Database not initialized"));
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row as T | undefined)));
  });
}

export function dbAll<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    if (!db) return reject(new Error("Database not initialized"));
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve((rows ?? []) as T[])));
  });
}

// ── SQL identifier safety ───────────────────────────────────────────────────

export function isSafeSqlIdent(name: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

// ── Schema ──────────────────────────────────────────────────────────────────

/**
 * Contacts table — voipms-compatible schema.
 */
const CONTACTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS contacts (
  phone TEXT PRIMARY KEY,
  name  TEXT,
  email TEXT
);
`;

/**
 * Twilio conversation history table.
 * Stores every inbound and outbound message for audit / thread context.
 */
const TWILIO_CONVERSATIONS_SQL = `
CREATE TABLE IF NOT EXISTS twilio_conversations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  phone_number  TEXT    NOT NULL,
  did           TEXT    NOT NULL,
  account_id    TEXT    NOT NULL,
  agent         TEXT,
  direction     TEXT    NOT NULL,
  message       TEXT    NOT NULL,
  media_url     TEXT,
  message_sid   TEXT,
  chat_type     TEXT    DEFAULT 'direct',
  status        TEXT,
  context       TEXT,
  created_at    TEXT    DEFAULT (datetime('now'))
);
`;

const TWILIO_CONVERSATIONS_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_twilio_conv_did_phone
  ON twilio_conversations (did, phone_number);
`;

const TWILIO_CONVERSATIONS_CONV_SID_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_twilio_conv_conversation_sid
  ON twilio_conversations (conversation_sid)
  WHERE conversation_sid IS NOT NULL;
`;

/**
 * Add `conversation_sid` column to existing databases (idempotent ALTER TABLE).
 */
async function migrateAddConversationSid(): Promise<void> {
  try {
    await dbRun(
      `ALTER TABLE twilio_conversations ADD COLUMN conversation_sid TEXT;`,
    );
  } catch (err: unknown) {
    // "duplicate column name" = already migrated — ignore
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("duplicate column")) throw err;
  }
}

/**
 * Conversation map — tracks Twilio ConversationSid (CH...) to account/peer/type.
 *
 * Replaces the old twilio_groups + twilio_inbound_pending tables. With the
 * Conversations API, Twilio manages stable conversation IDs natively — no
 * Jaccard matching or Event Streams polling is required.
 *
 * chat_type = 'direct': peer_id = E.164 phone of the remote party
 * chat_type = 'group':  peer_id = NULL (conversationSid IS the peer ID)
 */
const TWILIO_CONVERSATION_MAP_SQL = `
CREATE TABLE IF NOT EXISTS twilio_conversation_map (
  conversation_sid TEXT    PRIMARY KEY,
  account_id       TEXT    NOT NULL,
  chat_type        TEXT    NOT NULL,
  peer_id          TEXT,
  participants     TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
`;

const TWILIO_CONVERSATION_MAP_INDEX_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_tcm_account_peer
  ON twilio_conversation_map (account_id, peer_id)
  WHERE peer_id IS NOT NULL;
`;

// ── Resolve DB path ─────────────────────────────────────────────────────────

function resolveDbPath(cfg?: TwilioConfig): string {
  if (cfg?.shared?.dbPath?.trim()) return cfg.shared.dbPath.trim();
  if (cfg?.dbPath?.trim()) return cfg.dbPath.trim();
  if (process.env.TWILIO_DB_PATH?.trim()) return process.env.TWILIO_DB_PATH.trim();
  if (process.env.VOIPMS_DB_PATH?.trim()) return process.env.VOIPMS_DB_PATH.trim();
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  return path.join(home, ".openclaw", "shared", "sms.db");
}

// ── Init / Teardown ─────────────────────────────────────────────────────────

/**
 * Open (or reuse) the SQLite database and ensure the required tables exist.
 * Safe to call multiple times — subsequent calls return the same promise.
 */
export function initDatabase(cfg?: TwilioConfig): Promise<void> {
  if (dbReady) return dbReady;

  dbReady = (async () => {
    const dbPath = resolveDbPath(cfg);
    const sqlite3 = await import("sqlite3");
    const sqlite = sqlite3.default ?? sqlite3;

    await new Promise<void>((resolve, reject) => {
      db = new (sqlite.Database as any)(dbPath, (err: Error | null) => {
        if (err) return reject(new Error(`Cannot open DB at ${dbPath}: ${err.message}`));
        resolve();
      });
    });

    await dbRun("PRAGMA journal_mode=WAL;");
    await dbRun("PRAGMA busy_timeout=10000;");
    await dbRun("PRAGMA foreign_keys=ON;");

    await dbRun(CONTACTS_TABLE_SQL);
    await dbRun(TWILIO_CONVERSATIONS_SQL);
    await dbRun(TWILIO_CONVERSATIONS_INDEX_SQL);
    await migrateAddConversationSid();
    await dbRun(TWILIO_CONVERSATIONS_CONV_SID_INDEX_SQL);
    await dbRun(TWILIO_CONVERSATION_MAP_SQL);
    await dbRun(TWILIO_CONVERSATION_MAP_INDEX_SQL);

    console.log(`[twilio:db] Database ready: ${dbPath}`);
  })();

  return dbReady;
}

/**
 * Close the database connection.
 */
export function closeDatabase(): Promise<void> {
  return new Promise((resolve) => {
    if (!db) return resolve();
    db.close(() => {
      db = null;
      dbReady = null;
      resolve();
    });
  });
}

/**
 * Check whether the database is open and healthy.
 */
export async function pingDatabase(): Promise<boolean> {
  try {
    await dbGet("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

/**
 * Return the resolved database file path (for status displays).
 */
export function getDbPath(cfg?: TwilioConfig): string {
  return resolveDbPath(cfg);
}

// ── Conversation map ─────────────────────────────────────────────────────────

type ConversationMapRow = {
  conversation_sid: string;
  account_id: string;
  chat_type: string;
  peer_id: string | null;
  participants: string | null;
  created_at: number;
  updated_at: number;
};

/**
 * Insert or update a conversation mapping.
 *
 * For direct conversations: peerId = E.164 phone of the remote party.
 * For group conversations: peerId = undefined (conversationSid is the peer).
 */
export async function upsertConversationMap(params: {
  conversationSid: string;
  accountId: string;
  chatType: "direct" | "group";
  peerId?: string;
  participants?: string[];
}): Promise<void> {
  const { conversationSid, accountId, chatType, peerId, participants } = params;
  const now = Date.now();
  await dbRun(
    `INSERT INTO twilio_conversation_map
       (conversation_sid, account_id, chat_type, peer_id, participants, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(conversation_sid) DO UPDATE SET
       chat_type    = excluded.chat_type,
       peer_id      = excluded.peer_id,
       participants = excluded.participants,
       updated_at   = excluded.updated_at;`,
    [
      conversationSid,
      accountId,
      chatType,
      peerId ?? null,
      participants ? JSON.stringify(participants) : null,
      now,
      now,
    ],
  );
}

/**
 * Look up a ConversationSid by account + peer phone number (direct conversations).
 * Returns the ConversationSid or null if not found.
 */
export async function getConversationByPeer(
  accountId: string,
  peerId: string,
): Promise<string | null> {
  const row = await dbGet<{ conversation_sid: string }>(
    `SELECT conversation_sid FROM twilio_conversation_map
     WHERE account_id = ? AND peer_id = ? LIMIT 1;`,
    [accountId, peerId],
  );
  return row?.conversation_sid ?? null;
}

/**
 * Look up conversation metadata by ConversationSid.
 * Returns null for unknown / first-ever message in this conversation.
 */
export async function getConversationBySid(conversationSid: string): Promise<{
  accountId: string;
  chatType: "direct" | "group";
  peerId?: string;
  participants?: string[];
} | null> {
  const row = await dbGet<ConversationMapRow>(
    `SELECT account_id, chat_type, peer_id, participants
     FROM twilio_conversation_map WHERE conversation_sid = ? LIMIT 1;`,
    [conversationSid],
  );
  if (!row) return null;
  let participants: string[] | undefined;
  if (row.participants) {
    try { participants = JSON.parse(row.participants) as string[]; } catch { /* ignore */ }
  }
  return {
    accountId: row.account_id,
    chatType: row.chat_type as "direct" | "group",
    peerId: row.peer_id ?? undefined,
    participants,
  };
}

/**
 * List all group conversations for an account (for directory.listGroups).
 */
export async function listGroupConversations(accountId: string): Promise<
  Array<{ conversationSid: string; participants?: string[] }>
> {
  const rows = await dbAll<ConversationMapRow>(
    `SELECT conversation_sid, participants FROM twilio_conversation_map
     WHERE account_id = ? AND chat_type = 'group'
     ORDER BY updated_at DESC;`,
    [accountId],
  );
  return rows.map((r) => {
    let participants: string[] | undefined;
    if (r.participants) {
      try { participants = JSON.parse(r.participants) as string[]; } catch { /* ignore */ }
    }
    return { conversationSid: r.conversation_sid, participants };
  });
}

/**
 * Retrieve message thread by ConversationSid.
 * Returns messages in descending order (newest first).
 */
export async function getThreadByConversationSid(
  conversationSid: string,
  limit: number = 20,
): Promise<Array<{
  id: number;
  phone_number: string;
  did: string;
  account_id: string;
  direction: string;
  message: string;
  media_url: string | null;
  message_sid: string | null;
  chat_type: string;
  conversation_sid: string | null;
  created_at: string;
}>> {
  await initDatabase();
  return dbAll(
    `SELECT id, phone_number, did, account_id, direction,
            message, media_url, message_sid, chat_type, conversation_sid, created_at
     FROM twilio_conversations
     WHERE conversation_sid = ? AND context NOT LIKE 'ref:%'
     ORDER BY created_at DESC LIMIT ?`,
    [conversationSid, Math.min(Math.max(limit, 1), 50)],
  );
}
