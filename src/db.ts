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
 *
 * The voipms-sms plugin creates a contacts table with a configurable
 * phone column as PRIMARY KEY and TEXT columns.  We use the same schema
 * so either plugin can read/write the shared table.
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
 *
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

/**
 * Temporary table for correlating Event Streams recipient data with inbound
 * webhook messages. Rows are keyed by MessageSid and cleaned up after dispatch
 * or after a 60-second TTL.
 */
const TWILIO_INBOUND_PENDING_SQL = `
CREATE TABLE IF NOT EXISTS twilio_inbound_pending (
  message_sid TEXT PRIMARY KEY,
  recipients  TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
`;

// ── Resolve DB path ─────────────────────────────────────────────────────────

function resolveDbPath(cfg?: TwilioConfig): string {
  // 1. Twilio plugin config (shared preferred, top-level for backward compat)
  if (cfg?.shared?.dbPath?.trim()) return cfg.shared.dbPath.trim();
  if (cfg?.dbPath?.trim()) return cfg.dbPath.trim();

  // 2. Environment variable
  if (process.env.TWILIO_DB_PATH?.trim()) return process.env.TWILIO_DB_PATH.trim();

  // 3. Check if voipms-sms shares its DB path via env
  if (process.env.VOIPMS_DB_PATH?.trim()) return process.env.VOIPMS_DB_PATH.trim();

  // 4. Default shared location
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  return path.join(home, ".openclaw", "shared", "sms.db");
}

// ── Init / Teardown ─────────────────────────────────────────────────────────

/**
 * Open (or reuse) the SQLite database and ensure the required tables exist.
 *
 * Safe to call multiple times — the second call returns the same promise.
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

    // PRAGMAs — match voipms-sms settings for compat
    await dbRun("PRAGMA journal_mode=WAL;");
    await dbRun("PRAGMA busy_timeout=10000;");
    await dbRun("PRAGMA foreign_keys=ON;");

    // Shared contacts table (voipms-compatible)
    await dbRun(CONTACTS_TABLE_SQL);

    // Twilio conversation history
    await dbRun(TWILIO_CONVERSATIONS_SQL);
    await dbRun(TWILIO_CONVERSATIONS_INDEX_SQL);

    // Event Streams correlation table
    await dbRun(TWILIO_INBOUND_PENDING_SQL);

    // Clean up stale pending rows (older than 60s) on every startup
    await dbRun("DELETE FROM twilio_inbound_pending WHERE created_at < ?;", [
      Date.now() - 60_000,
    ]);

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

// ── Event Streams pending correlation ───────────────────────────────────────

/**
 * Store the recipient list from an Event Streams event, keyed by MessageSid.
 * Used to enrich the regular webhook handler with group participant info.
 */
export async function storeEventStreamRecipients(
  messageSid: string,
  recipients: string[],
): Promise<void> {
  await dbRun(
    `INSERT OR REPLACE INTO twilio_inbound_pending (message_sid, recipients, created_at)
     VALUES (?, ?, ?);`,
    [messageSid, JSON.stringify(recipients), Date.now()],
  );
}

/**
 * Fetch stored recipients for a MessageSid, or null if not yet received.
 */
export async function getEventStreamRecipients(
  messageSid: string,
): Promise<string[] | null> {
  const row = await dbGet<{ recipients: string }>(
    "SELECT recipients FROM twilio_inbound_pending WHERE message_sid = ?;",
    [messageSid],
  );
  if (!row) return null;
  try {
    return JSON.parse(row.recipients) as string[];
  } catch {
    return null;
  }
}

/**
 * Remove the pending row after dispatch (cleanup).
 */
export async function deleteEventStreamRecipients(
  messageSid: string,
): Promise<void> {
  await dbRun(
    "DELETE FROM twilio_inbound_pending WHERE message_sid = ?;",
    [messageSid],
  );
}
