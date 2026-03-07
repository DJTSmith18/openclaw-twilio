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

// ── Resolve DB path ─────────────────────────────────────────────────────────

function resolveDbPath(cfg?: TwilioConfig): string {
  // 1. Twilio plugin config
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
