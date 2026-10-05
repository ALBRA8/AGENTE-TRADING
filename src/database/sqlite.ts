// ============================================================
// src/database/sqlite.ts
// SQLite singleton – conversations + memory_fragments
// ============================================================

import Database, { type Database as BetterDB } from "better-sqlite3";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config();

const DB_PATH = process.env.DB_PATH ?? "./data/opengravity.db";

// Ensure the data directory exists
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

// ── Singleton ──────────────────────────────────────────────
const db: BetterDB = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ── Schema migrations ──────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT    NOT NULL,
    role        TEXT    NOT NULL CHECK(role IN ('user', 'assistant', 'tool', 'system')),
    content     TEXT    NOT NULL,
    tool_name   TEXT,
    tool_call_id TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS memory_fragments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT    NOT NULL,
    key        TEXT    NOT NULL,
    value      TEXT    NOT NULL,
    updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, key)
  );

  CREATE INDEX IF NOT EXISTS idx_mem_user ON memory_fragments(user_id);

  CREATE TABLE IF NOT EXISTS users (
    telegram_id  TEXT PRIMARY KEY,
    username     TEXT,
    first_name   TEXT,
    last_name    TEXT,
    first_seen   TEXT NOT NULL DEFAULT (datetime('now')),
    last_active  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS trade_performance (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp        TEXT NOT NULL DEFAULT (datetime('now')),
    asset            TEXT,
    dxy_correlation  TEXT,
    setup_detected   TEXT NOT NULL,
    nemotron_thought TEXT NOT NULL,
    result_pl        REAL,
    error_made       TEXT
  );
`);

// ── Types ──────────────────────────────────────────────────
export interface ConversationRow {
  id: number;
  user_id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  tool_name?: string;
  tool_call_id?: string;
  created_at: string;
}

export interface MemoryFragment {
  id: number;
  user_id: string;
  key: string;
  value: string;
  updated_at: string;
}

// ── Conversation helpers ───────────────────────────────────
export function saveMessage(
  userId: string,
  role: ConversationRow["role"],
  content: string,
  toolName?: string,
  toolCallId?: string
): void {
  db.prepare(
    `INSERT INTO conversations (user_id, role, content, tool_name, tool_call_id)
     VALUES (?, ?, ?, ?, ?)`
  ).run(userId, role, content, toolName ?? null, toolCallId ?? null);
}

export function getRecentMessages(
  userId: string,
  limit = 10
): ConversationRow[] {
  return db
    .prepare(
      `SELECT * FROM conversations
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(userId, limit) as ConversationRow[];
}

// ── Memory helpers ─────────────────────────────────────────
export function upsertMemory(
  userId: string,
  key: string,
  value: string
): void {
  db.prepare(
    `INSERT INTO memory_fragments (user_id, key, value, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, key)
     DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(userId, key, value);
}

export function getMemoryFragments(userId: string): MemoryFragment[] {
  return db
    .prepare(
      `SELECT * FROM memory_fragments WHERE user_id = ? ORDER BY updated_at DESC`
    )
    .all(userId) as MemoryFragment[];
}

// ── User helpers ───────────────────────────────────────────
export function upsertUser(
  telegramId: string,
  username?: string,
  firstName?: string,
  lastName?: string
): void {
  db.prepare(
    `INSERT INTO users (telegram_id, username, first_name, last_name)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(telegram_id)
     DO UPDATE SET username = excluded.username,
                   first_name = excluded.first_name,
                   last_name = excluded.last_name,
                   last_active = datetime('now')`
  ).run(telegramId, username ?? null, firstName ?? null, lastName ?? null);
}

// ── Trade Performance helpers ──────────────────────────────
export function saveTradePerformance(
  setupDetected: string,
  nemotronThought: string,
  resultPl?: number,
  errorMade?: string,
  asset?: string,
  dxyCorrelation?: string
): void {
  db.prepare(
    `INSERT INTO trade_performance (setup_detected, nemotron_thought, result_pl, error_made, asset, dxy_correlation)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(setupDetected, nemotronThought, resultPl ?? null, errorMade ?? null, asset ?? null, dxyCorrelation ?? null);
}

export default db;
