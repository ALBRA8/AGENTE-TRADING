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

  -- ── Fase 0: trazabilidad de decisiones del pipeline ──
  CREATE TABLE IF NOT EXISTS decision_log (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    user_id          TEXT,
    symbol           TEXT NOT NULL,
    timeframe        TEXT,
    final_action     TEXT NOT NULL,
    direction        TEXT,
    entry_price      REAL,
    stop_loss_pips   REAL,
    risk_pct         REAL,
    confidence       REAL,
    gates_json       TEXT,
    reports_json     TEXT,
    debate_json      TEXT,
    reasoning        TEXT,
    tokens_used      INTEGER DEFAULT 0,
    latency_ms       INTEGER DEFAULT 0,
    outcome_pnl      REAL,
    outcome_settled  INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_decisions_symbol ON decision_log(symbol, created_at DESC);

  -- ── Auto-mejora: lecciones y errores (patrón self-improving-agent) ──
  CREATE TABLE IF NOT EXISTS agent_lessons (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
    kind               TEXT NOT NULL,
    source             TEXT NOT NULL,
    symbol             TEXT,
    pattern_key        TEXT NOT NULL,
    observation        TEXT NOT NULL,
    lesson             TEXT NOT NULL,
    scope              TEXT,
    decay_type         TEXT DEFAULT 'unknown',
    decay_rate         TEXT DEFAULT 'unknown',
    revalidate_trigger TEXT,
    validation_status  TEXT NOT NULL DEFAULT 'pending',
    times_seen         INTEGER NOT NULL DEFAULT 1,
    importance         INTEGER NOT NULL DEFAULT 2,
    promoted           INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_lessons_pattern ON agent_lessons(pattern_key);
  CREATE INDEX IF NOT EXISTS idx_lessons_symbol ON agent_lessons(symbol);

  CREATE TABLE IF NOT EXISTS agent_errors (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    tool_name    TEXT,
    error_type   TEXT,
    pattern_key  TEXT NOT NULL,
    message      TEXT NOT NULL,
    context_json TEXT,
    resolved     INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_errors_pattern ON agent_errors(pattern_key, resolved);

  -- ── Fase 2: órdenes reales vinculadas a decisiones ──
  CREATE TABLE IF NOT EXISTS trade_orders (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    decision_id     INTEGER,
    symbol          TEXT NOT NULL,
    direction       TEXT NOT NULL,
    order_type      TEXT,
    volume          REAL,
    entry_price     REAL,
    stop_loss       REAL,
    take_profit     REAL,
    ticket          INTEGER,
    risk_pct        REAL,
    status          TEXT NOT NULL DEFAULT 'placed'
  );

  CREATE INDEX IF NOT EXISTS idx_orders_decision ON trade_orders(decision_id);
  CREATE INDEX IF NOT EXISTS idx_orders_ticket ON trade_orders(ticket);

  -- ── Fase 4: snapshots de evaluación del cerebro ──
  CREATE TABLE IF NOT EXISTS brain_evaluations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    score       REAL NOT NULL,
    report_json TEXT NOT NULL
  );

  -- ── PROMPT 06 §6/§19: policy_events — auditoría append-only de gobernanza ──
  -- Cada cambio de modo/nivel/techo/kill-switch/aprobación queda registrado
  -- con actor y razón. El estado vigente = último evento de cada clave.
  CREATE TABLE IF NOT EXISTS policy_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    actor      TEXT NOT NULL,
    event      TEXT NOT NULL,
    old_value  TEXT,
    new_value  TEXT NOT NULL,
    reason     TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_policy_events_key ON policy_events(event, id DESC);

  -- ── PROMPT 06 §7: manifest de reproducibilidad de backtests ──
  -- Un run sin manifest completo (data_hash/params/code_version/seed) es
  -- INVALID / NOT REPRODUCIBLE y jamás alimenta decisiones ni lecciones.
  CREATE TABLE IF NOT EXISTS backtest_runs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    run_id       TEXT NOT NULL UNIQUE,
    engine       TEXT NOT NULL DEFAULT 'simulation',
    symbol       TEXT,
    data_hash    TEXT,
    params_json  TEXT,
    code_version TEXT,
    seed         INTEGER,
    verdict      TEXT NOT NULL DEFAULT 'INVALID_NOT_REPRODUCIBLE',
    metrics_json TEXT
  );
`);

// ── Migración ligera (idempotente): columnas de settlement ──
(function migrateDecisionLog() {
  const cols = (
    db.pragma("table_info(decision_log)") as Array<{ name: string }>
  ).map((c) => c.name);
  if (!cols.includes("settle_attempts")) {
    db.exec(`ALTER TABLE decision_log ADD COLUMN settle_attempts INTEGER NOT NULL DEFAULT 0`);
  }
  if (!cols.includes("outcome_source")) {
    db.exec(`ALTER TABLE decision_log ADD COLUMN outcome_source TEXT`);
  }
  if (!cols.includes("consumed_at")) {
    db.exec(`ALTER TABLE decision_log ADD COLUMN consumed_at TEXT`);
  }
  // Task 8-a: marca temporal del SETTLE (necesaria para el PnL del día —
  // sin ella no se puede distinguir un outcome cerrado HOY de uno histórico).
  if (!cols.includes("outcome_timestamp")) {
    db.exec(`ALTER TABLE decision_log ADD COLUMN outcome_timestamp TEXT`);
  }
  // ── PROMPT 06 §12: Approval Contract ──
  if (!cols.includes("approval_status")) {
    db.exec(`ALTER TABLE decision_log ADD COLUMN approval_status TEXT DEFAULT 'auto'`);
  }
  if (!cols.includes("policy_result")) {
    db.exec(`ALTER TABLE decision_log ADD COLUMN policy_result TEXT`);
  }
  if (!cols.includes("take_profit_pips")) {
    db.exec(`ALTER TABLE decision_log ADD COLUMN take_profit_pips REAL`);
  }
})();

// ── SE-DATA (se-data-2): strategy_context — registro OpenTrade (B11/R11.2) ──
// Contexto completo del Strategy Engine (STRATEGY_ENGINE_V1 §2.2
// openTradeContext: pilares, liquidez barrida, POI, trigger, retest, TFs)
// persistido como JSON junto a la decisión. Migración IDEMPOTENTE siguiendo
// el patrón exacto de migrateDecisionLog (pragma table_info + ALTER).
(function migrateStrategyContext() {
  const cols = (
    db.pragma("table_info(decision_log)") as Array<{ name: string }>
  ).map((c) => c.name);
  if (!cols.includes("strategy_context")) {
    db.exec(`ALTER TABLE decision_log ADD COLUMN strategy_context TEXT`);
  }
})();

// ── Migración trade_orders: verificación de ejecución + contrato §12 ──
(function migrateTradeOrders() {
  const cols = (
    db.pragma("table_info(trade_orders)") as Array<{ name: string }>
  ).map((c) => c.name);
  if (!cols.includes("risk_amount")) {
    db.exec(`ALTER TABLE trade_orders ADD COLUMN risk_amount REAL`);
  }
  if (!cols.includes("strategy")) {
    db.exec(`ALTER TABLE trade_orders ADD COLUMN strategy TEXT`);
  }
  if (!cols.includes("expiration")) {
    db.exec(`ALTER TABLE trade_orders ADD COLUMN expiration INTEGER`);
  }
  if (!cols.includes("verification_status")) {
    db.exec(`ALTER TABLE trade_orders ADD COLUMN verification_status TEXT`);
  }
  if (!cols.includes("slippage")) {
    db.exec(`ALTER TABLE trade_orders ADD COLUMN slippage REAL`);
  }
})();

// ── P0 EXECUTION TRUTH: identidad de ejecución broker-independent ──
// Genealogía: decision_id → execution_id → order_ticket → deal_tickets →
// position_ticket → close_deal_tickets → realized outcome (docs/EXECUTION_TRUTH.md).
// PRINCIPIOS (P0 §0-§6):
//   - execution_id NUNCA deriva de tickets MT5 (uuid v4 interno, estable).
//   - ORDER TICKET ≠ DEAL TICKET ≠ POSITION TICKET (columnas separadas;
//     trade_orders.ticket legacy = ORDER ticket, solo compatibilidad).
//   - Migración NO destructiva e idempotente (patrón pragma table_info).
//   - 1 decision → 1 execution → 1 order → N entry deals → 1 position →
//     N exit deals (NUNCA asumir 1:1:1:1).
//   - idempotencia estructural: UNIQUE(order_ticket) en executions,
//     UNIQUE(deal_ticket) en execution_deals → re-reconciliar no duplica.
(function migrateExecutionTruth() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS executions (
      execution_id           TEXT PRIMARY KEY,
      decision_id            INTEGER,
      correlation_id         TEXT,
      parent_execution_id    TEXT,
      symbol                 TEXT NOT NULL,
      direction              TEXT NOT NULL,
      order_type             TEXT,
      requested_volume       REAL,
      requested_price        REAL,
      stop_loss              REAL,
      take_profit            REAL,
      risk_amount            REAL,
      order_ticket           INTEGER,
      position_ticket        INTEGER,
      executed_volume        REAL,
      closed_volume          REAL,
      realized_pnl           REAL,
      gross_pnl              REAL,
      commission             REAL,
      swap                   REAL,
      fee                    REAL,
      execution_status       TEXT NOT NULL DEFAULT 'UNKNOWN',
      reconciliation_status  TEXT NOT NULL DEFAULT 'PENDING_RECONCILIATION',
      close_cause            TEXT,
      opened_at              TEXT,
      closed_at              TEXT,
      reconciled_at          TEXT,
      recon_attempts         INTEGER NOT NULL DEFAULT 0,
      last_recon_error       TEXT,
      created_at             TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Un order_ticket = una execution (anti-duplicado tras respuesta ambigua)
    CREATE UNIQUE INDEX IF NOT EXISTS idx_executions_order_ticket
      ON executions(order_ticket) WHERE order_ticket IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_executions_decision ON executions(decision_id);
    CREATE INDEX IF NOT EXISTS idx_executions_recon
      ON executions(reconciliation_status, recon_attempts);

    -- Evidencia de deals: UNA fila por deal real de MT5 (idempotente por UNIQUE)
    CREATE TABLE IF NOT EXISTS execution_deals (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      execution_id     TEXT NOT NULL,
      deal_ticket      INTEGER NOT NULL UNIQUE,
      order_ticket     INTEGER,
      position_ticket  INTEGER,
      role             TEXT NOT NULL,
      symbol           TEXT,
      direction        TEXT,
      volume           REAL,
      price            REAL,
      profit           REAL,
      commission       REAL,
      swap             REAL,
      fee              REAL,
      deal_entry       INTEGER,
      deal_reason      INTEGER,
      close_cause      TEXT,
      deal_time        TEXT,
      time_msc         INTEGER,
      raw_json         TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_exec_deals_exec ON execution_deals(execution_id);

    -- Observabilidad P0 §37: eventos de ejecución (append-only, sin secretos)
    CREATE TABLE IF NOT EXISTS execution_events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      execution_id  TEXT NOT NULL,
      event         TEXT NOT NULL,
      from_status   TEXT,
      to_status     TEXT,
      recon_status  TEXT,
      reason        TEXT,
      evidence_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_exec_events ON execution_events(execution_id, id DESC);
  `);

  // trade_orders.execution_id: vínculo legacy (columna nueva, no destructiva).
  // trade_orders.ticket sigue existiendo SOLO como compatibilidad y representa
  // el ORDER TICKET de MT5 (documentado en docs/EXECUTION_TRUTH.md §6).
  const cols = (
    db.pragma("table_info(trade_orders)") as Array<{ name: string }>
  ).map((c) => c.name);
  if (!cols.includes("execution_id")) {
    db.exec(`ALTER TABLE trade_orders ADD COLUMN execution_id TEXT`);
  }
})();

// ── Migración agent_lessons: campos MemoryDV (PROMPT 06 §9) ──
// EPISODIC/SEMANTIC/PROCEDURAL/FACTUAL + evidencia + decay de utilidad.
(function migrateAgentLessons() {
  const cols = (
    db.pragma("table_info(agent_lessons)") as Array<{ name: string }>
  ).map((c) => c.name);
  const add = (col: string, ddl: string) => {
    if (!cols.includes(col)) db.exec(`ALTER TABLE agent_lessons ADD COLUMN ${ddl}`);
  };
  add("memory_type", "memory_type TEXT DEFAULT 'SEMANTIC'");
  add("domain", "domain TEXT");
  add("confidence", "confidence REAL");
  add("truth_level", "truth_level TEXT DEFAULT 'INFERRED'");
  add("evidence_json", "evidence_json TEXT");
  add("last_verified", "last_verified TEXT");
  add("utility", "utility REAL");
  add("agent_id", "agent_id TEXT DEFAULT 'AGENTE-TRADING'");
})();

// Índice único para dedupe real de lecciones (la dedupe por SELECT+INSERT
// no era atómica y podía duplicar bajo settlement concurrente)
try {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lessons_pattern_unique
    ON agent_lessons(pattern_key)
    WHERE validation_status != 'contradicted'
  `);
} catch {
  // Si ya existen duplicados históricos, el índice no se crea: saveLesson
  // sigue deduplicando por SELECT (mejor esfuerzo) hasta limpieza manual.
}

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

// ── Decision Log helpers (trazabilidad del pipeline) ────────
export interface DecisionRow {
  id: number;
  created_at: string;
  user_id?: string;
  symbol: string;
  timeframe?: string;
  final_action: "EXECUTE" | "WAIT" | "REVIEW" | "ABORTED";
  direction?: string;
  entry_price?: number | null;
  stop_loss_pips?: number | null;
  risk_pct?: number | null;
  confidence?: number | null;
  gates_json?: string | null;
  reports_json?: string | null;
  debate_json?: string | null;
  reasoning?: string | null;
  tokens_used?: number;
  latency_ms?: number;
  outcome_pnl?: number | null;
  outcome_settled?: number; // 0=pending, 1=settled, 2=expired/sin datos
  settle_attempts?: number;
  outcome_source?: string | null;
  /* PROMPT 06 §12: Approval Contract */
  consumed_at?: string | null;
  approval_status?: "auto" | "pending" | "approved" | "rejected" | null;
  policy_result?: string | null;
  outcome_timestamp?: string | null;
}

export function saveDecision(d: {
  userId?: string;
  symbol: string;
  timeframe?: string;
  finalAction: DecisionRow["final_action"];
  direction?: string;
  entryPrice?: number | null;
  stopLossPips?: number | null;
  riskPct?: number | null;
  confidence?: number | null;
  gatesJson?: string;
  reportsJson?: string;
  debateJson?: string;
  reasoning?: string;
  tokensUsed?: number;
  latencyMs?: number;
  approvalStatus?: string;
  policyResult?: string;
}): number {
  const res = db
    .prepare(
      `INSERT INTO decision_log
        (user_id, symbol, timeframe, final_action, direction, entry_price, stop_loss_pips,
         risk_pct, confidence, gates_json, reports_json, debate_json, reasoning, tokens_used, latency_ms,
         approval_status, policy_result)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      d.userId ?? null,
      d.symbol,
      d.timeframe ?? null,
      d.finalAction,
      d.direction ?? null,
      d.entryPrice ?? null,
      d.stopLossPips ?? null,
      d.riskPct ?? null,
      d.confidence ?? null,
      d.gatesJson ?? null,
      d.reportsJson ?? null,
      d.debateJson ?? null,
      d.reasoning ?? null,
      d.tokensUsed ?? 0,
      d.latencyMs ?? 0,
      d.approvalStatus ?? null,
      d.policyResult ?? null
    );
  return Number(res.lastInsertRowid);
}

export function updateDecisionOutcome(decisionId: number, pnl: number): void {
  db.prepare(
    `UPDATE decision_log SET outcome_pnl = ?, outcome_settled = 1, outcome_timestamp = datetime('now') WHERE id = ?`
  ).run(pnl, decisionId);
}

// ── SE-DATA (se-data-2): strategy_context — B11/R11.2 (STRATEGY_ENGINE_V1) ──
/**
 * Guarda el contexto OpenTrade del Strategy Engine como JSON en
 * decision_log.strategy_context (R11.2). Fail-closed: exige JSON parseable
 * y decisión EXISTENTE. Re-save = upsert (contexto enriquecido en S7→S8).
 */
export function saveStrategyContext(decisionId: number, contextJson: string): void {
  try {
    JSON.parse(contextJson); // valida ANTES de persistir (fail-closed)
  } catch {
    throw new Error(
      `saveStrategyContext: contextJson no es JSON válido (decision ${decisionId})`
    );
  }
  const res = db
    .prepare(`UPDATE decision_log SET strategy_context = ? WHERE id = ?`)
    .run(contextJson, decisionId);
  if (res.changes === 0) {
    throw new Error(
      `saveStrategyContext: decision_log id=${decisionId} no existe`
    );
  }
}

/**
 * Recupera el JSON de contexto OpenTrade de una decisión (R11.2/R11.3:
 * al settlement se une al PnL para B18 y la memoria del agente).
 * Null si la decisión no existe o aún no tiene contexto.
 */
export function getStrategyContext(decisionId: number): string | null {
  const row = db
    .prepare(`SELECT strategy_context FROM decision_log WHERE id = ?`)
    .get(decisionId) as { strategy_context: string | null } | undefined;
  return row?.strategy_context ?? null;
}

/**
 * Devuelve la decisión EXECUTE más reciente del símbolo dentro de la ventana
 * de validez (minutos). Es la base del hard-gate de ejecución.
 *
 * Reglas de invalidación (hard-gate one-shot):
 *  - Debe ser la decisión MÁS RECIENTE del símbolo: cualquier decisión
 *    posterior (WAIT/REVIEW/ABORTED o nuevo EXECUTE) la invalida.
 *  - No debe estar consumida por una orden previa (consumed_at NULL).
 */
export function getRecentExecuteDecision(
  symbol: string,
  validMinutes = 15
): DecisionRow | undefined {
  return db
    .prepare(
      `SELECT * FROM decision_log
       WHERE symbol = ? COLLATE NOCASE
         AND final_action = 'EXECUTE'
         AND consumed_at IS NULL
         AND created_at >= datetime('now', '-' || ? || ' minutes')
         AND id = (SELECT MAX(id) FROM decision_log d2
                   WHERE d2.symbol = decision_log.symbol COLLATE NOCASE)
       ORDER BY id DESC
       LIMIT 1`
    )
    .get(symbol, validMinutes) as DecisionRow | undefined;
}

/**
 * Reclama una decisión EXECUTE de forma atómica (one-shot).
 * Devuelve false si otra orden ya la consumió — solo UNA orden puede
 * apoyarse en una decisión. Si la orden luego falla, llama releaseDecision.
 */
export function claimDecision(decisionId: number): boolean {
  const res = db
    .prepare(
      `UPDATE decision_log SET consumed_at = datetime('now')
       WHERE id = ? AND consumed_at IS NULL`
    )
    .run(decisionId);
  return res.changes === 1;
}

/** Libera una decisión reclamada cuya orden finalmente no se colocó. */
export function releaseDecision(decisionId: number): void {
  db.prepare(
    `UPDATE decision_log SET consumed_at = NULL WHERE id = ?`
  ).run(decisionId);
}

export function getDecisionById(id: number): DecisionRow | undefined {
  return db.prepare(`SELECT * FROM decision_log WHERE id = ?`).get(id) as
    | DecisionRow
    | undefined;
}

// ── Agent Lessons helpers (auto-mejora) ─────────────────────
export interface LessonRow {
  id: number;
  created_at: string;
  updated_at: string;
  kind: "correction" | "insight" | "knowledge_gap" | "best_practice" | "error";
  source: "user" | "reflection" | "auto_error";
  symbol?: string | null;
  pattern_key: string;
  observation: string;
  lesson: string;
  scope?: string | null;
  decay_type?: string | null;
  decay_rate?: string | null;
  revalidate_trigger?: string | null;
  validation_status: "pending" | "verified" | "unresolved" | "contradicted";
  times_seen: number;
  importance: number;
  promoted: number;
}

/**
 * Guarda una lección con dedupe por pattern_key (regla del skill:
 * "similar a entrada existente → contar nueva ocurrencia, no duplicar").
 */
export function saveLesson(l: {
  kind: LessonRow["kind"];
  source: LessonRow["source"];
  symbol?: string | null;
  patternKey: string;
  observation: string;
  lesson: string;
  scope?: string | null;
  decayType?: string;
  decayRate?: string;
  revalidateTrigger?: string | null;
  importance?: number;
}): { id: number; deduped: boolean } {
  const existing = db
    .prepare(
      `SELECT id, times_seen, validation_status FROM agent_lessons
       WHERE pattern_key = ? AND validation_status != 'contradicted'
       ORDER BY id DESC LIMIT 1`
    )
    .get(l.patternKey) as { id: number; times_seen: number } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE agent_lessons
       SET times_seen = times_seen + 1, updated_at = datetime('now'),
           observation = ?, importance = ?
       WHERE id = ?`
    ).run(l.observation, l.importance ?? 2, existing.id);
    return { id: existing.id, deduped: true };
  }

  const baseSql =
    `INSERT INTO agent_lessons
      (kind, source, symbol, pattern_key, observation, lesson, scope,
       decay_type, decay_rate, revalidate_trigger, importance)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const params = [
    l.kind,
    l.source,
    l.symbol ?? null,
    l.patternKey,
    l.observation,
    l.lesson,
    l.scope ?? null,
    l.decayType ?? "unknown",
    l.decayRate ?? "unknown",
    l.revalidateTrigger ?? null,
    l.importance ?? 2,
  ] as unknown[];

  // Upsert atómico: si otro proceso insertó el mismo pattern_key en el
  // intervalo, ON CONFLICT incrementa times_seen en vez de duplicar.
  // El índice único es parcial → SQLite exige la cláusula WHERE en el target.
  // Si la DB histórica tiene duplicados (índice no creado), cae a INSERT plano.
  let res: ReturnType<ReturnType<typeof db.prepare>["run"]>;
  try {
    res = db
      .prepare(
        `${baseSql}
         ON CONFLICT(pattern_key) WHERE validation_status != 'contradicted' DO UPDATE SET
           times_seen = times_seen + 1,
           updated_at = datetime('now'),
           observation = excluded.observation`
      )
      .run(...params);
  } catch {
    res = db.prepare(baseSql).run(...params);
  }

  const insertId = Number(res.lastInsertRowid);
  if (insertId > 0) return { id: insertId, deduped: false };

  // lastInsertRowid === 0 → no hubo inserción nueva: el conflicto actualizó.
  const row = db
    .prepare(
      `SELECT id FROM agent_lessons WHERE pattern_key = ? ORDER BY id DESC LIMIT 1`
    )
    .get(l.patternKey) as { id: number } | undefined;
  return { id: row?.id ?? 0, deduped: true };
}

/**
 * Lecciones relevantes para una decisión: promovidas primero, luego
 * verificadas, luego pendientes; mismo símbolo priorizado; más recientes
 * primero. Equivale a "review relevant saved guidance before major tasks".
 */
export function getLessonsForContext(
  symbol?: string,
  limit = 8
): LessonRow[] {
  return db
    .prepare(
      `SELECT * FROM agent_lessons
       WHERE validation_status != 'contradicted'
         AND (symbol IS NULL OR symbol = '' OR symbol = ? COLLATE NOCASE)
       ORDER BY promoted DESC,
                CASE validation_status
                  WHEN 'verified' THEN 0
                  WHEN 'pending' THEN 1
                  ELSE 2
                END,
                CASE WHEN symbol = ? COLLATE NOCASE THEN 0 ELSE 1 END,
                importance DESC,
                updated_at DESC
       LIMIT ?`
    )
    .all(symbol ?? "", symbol ?? "", limit) as LessonRow[];
}

/** Lecciones promovidas que siempre viajan en el system prompt. */
export function getPromotedLessons(limit = 12): LessonRow[] {
  return db
    .prepare(
      `SELECT * FROM agent_lessons
       WHERE promoted = 1 AND validation_status != 'contradicted'
       ORDER BY importance DESC, updated_at DESC
       LIMIT ?`
    )
    .all(limit) as LessonRow[];
}

export function promoteLesson(id: number, promoted = true): void {
  db.prepare(`UPDATE agent_lessons SET promoted = ? WHERE id = ?`).run(
    promoted ? 1 : 0,
    id
  );
}

export function setLessonValidation(
  id: number,
  status: LessonRow["validation_status"],
  revalidateTrigger?: string
): void {
  db.prepare(
    `UPDATE agent_lessons SET validation_status = ?,
     revalidate_trigger = COALESCE(?, revalidate_trigger),
     updated_at = datetime('now') WHERE id = ?`
  ).run(status, revalidateTrigger ?? null, id);
}

export function searchLessons(keyword?: string, symbol?: string, limit = 15): LessonRow[] {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (keyword) {
    conditions.push(`(lesson LIKE ? OR observation LIKE ? OR pattern_key LIKE ?)`);
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }
  if (symbol) {
    conditions.push(`symbol = ? COLLATE NOCASE`);
    params.push(symbol);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit);
  return db
    .prepare(
      `SELECT * FROM agent_lessons ${where} ORDER BY updated_at DESC LIMIT ?`
    )
    .all(...params) as LessonRow[];
}

// ── Agent Errors helpers (captura automática de fallos) ─────
export function saveAutoError(e: {
  toolName?: string;
  errorType: string;
  patternKey: string;
  message: string;
  contextJson?: string;
}): void {
  db.prepare(
    `INSERT INTO agent_errors (tool_name, error_type, pattern_key, message, context_json)
     VALUES (?, ?, ?, ?, ?)`
  ).run(e.toolName ?? null, e.errorType, e.patternKey, e.message.slice(0, 2_000), e.contextJson ?? null);
}

export function getUnresolvedErrors(limit = 50): Array<{
  id: number;
  tool_name?: string;
  error_type: string;
  pattern_key: string;
  message: string;
  times: number;
}> {
  return db
    .prepare(
      `SELECT pattern_key, MIN(id) as id, tool_name, error_type,
              MAX(message) as message, COUNT(*) as times
       FROM agent_errors WHERE resolved = 0
       GROUP BY pattern_key
       ORDER BY times DESC, MIN(created_at) DESC
       LIMIT ?`
    )
    .all(limit) as any;
}

export function markErrorsResolved(patternKey: string): void {
  db.prepare(`UPDATE agent_errors SET resolved = 1 WHERE pattern_key = ?`).run(
    patternKey
  );
}

// ── Trade Orders helpers (Fase 2: vínculo orden ↔ decisión) ─
export interface TradeOrderRow {
  id: number;
  created_at: string;
  decision_id: number | null;
  symbol: string;
  direction: string;
  order_type?: string | null;
  volume?: number | null;
  entry_price?: number | null;
  stop_loss?: number | null;
  take_profit?: number | null;
  ticket?: number | null;
  risk_pct?: number | null;
  status: string;
  risk_amount?: number | null;
  strategy?: string | null;
  expiration?: number | null;
  verification_status?: string | null;
  slippage?: number | null;
}

export function saveOrder(o: {
  decisionId?: number | null;
  symbol: string;
  direction: string;
  orderType?: string;
  volume?: number;
  entryPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  ticket?: number;
  riskPct?: number;
  status?: string;
  riskAmount?: number | null;
  strategy?: string | null;
  expiration?: number | null;
  verificationStatus?: string | null;
  /** P0 Execution Truth: identidad interna de ejecución (uuid, no ticket) */
  executionId?: string | null;
}): number {
  const res = db
    .prepare(
      `INSERT INTO trade_orders
        (decision_id, symbol, direction, order_type, volume, entry_price, stop_loss, take_profit, ticket, risk_pct, status,
         risk_amount, strategy, expiration, verification_status, execution_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      o.decisionId ?? null,
      o.symbol,
      o.direction,
      o.orderType ?? null,
      o.volume ?? null,
      o.entryPrice ?? null,
      o.stopLoss ?? null,
      o.takeProfit ?? null,
      o.ticket ?? null,
      o.riskPct ?? null,
      o.status ?? "placed",
      o.riskAmount ?? null,
      o.strategy ?? null,
      o.expiration ?? null,
      o.verificationStatus ?? null,
      o.executionId ?? null
    );
  return Number(res.lastInsertRowid);
}

export function getOrderByDecisionId(decisionId: number): TradeOrderRow | undefined {
  return db
    .prepare(`SELECT * FROM trade_orders WHERE decision_id = ? ORDER BY id DESC LIMIT 1`)
    .get(decisionId) as TradeOrderRow | undefined;
}

// ══ P0 EXECUTION TRUTH: helpers de identidad + evidencia + reconciliación ══
// TODAS las escrituras son idempotentes por diseño:
//   - createExecutionRow → INSERT OR IGNORE (execution_id PK)
//   - insertExecutionDeal → INSERT OR IGNORE (deal_ticket UNIQUE)
//   - updateExecutionRow → UPDATE por whitelist de columnas (recomputa, no acumula)

export interface ExecutionRow {
  execution_id: string;
  decision_id: number | null;
  correlation_id: string | null;
  parent_execution_id: string | null;
  symbol: string;
  direction: string;
  order_type: string | null;
  requested_volume: number | null;
  requested_price: number | null;
  stop_loss: number | null;
  take_profit: number | null;
  risk_amount: number | null;
  order_ticket: number | null;
  position_ticket: number | null;
  executed_volume: number | null;
  closed_volume: number | null;
  realized_pnl: number | null;
  gross_pnl: number | null;
  commission: number | null;
  swap: number | null;
  fee: number | null;
  execution_status: string;
  reconciliation_status: string;
  close_cause: string | null;
  opened_at: string | null;
  closed_at: string | null;
  reconciled_at: string | null;
  recon_attempts: number;
  last_recon_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExecutionDealRow {
  id: number;
  execution_id: string;
  deal_ticket: number;
  order_ticket: number | null;
  position_ticket: number | null;
  role: "entry" | "exit";
  symbol: string | null;
  direction: string | null;
  volume: number | null;
  price: number | null;
  profit: number | null;
  commission: number | null;
  swap: number | null;
  fee: number | null;
  deal_entry: number | null;
  deal_reason: number | null;
  close_cause: string | null;
  deal_time: string | null;
  time_msc: number | null;
  raw_json: string | null;
  created_at: string;
}

const EXECUTION_PATCH_COLUMNS = new Set([
  "decision_id", "correlation_id", "parent_execution_id", "symbol", "direction",
  "order_type", "requested_volume", "requested_price", "stop_loss", "take_profit",
  "risk_amount", "order_ticket", "position_ticket", "executed_volume", "closed_volume",
  "realized_pnl", "gross_pnl", "commission", "swap", "fee", "execution_status",
  "reconciliation_status", "close_cause", "opened_at", "closed_at", "reconciled_at",
  "recon_attempts", "last_recon_error",
]);

/** Crea la execution (idempotente: INSERT OR IGNORE por PK execution_id). */
export function createExecutionRow(e: {
  executionId: string;
  decisionId?: number | null;
  correlationId?: string | null;
  parentExecutionId?: string | null;
  symbol: string;
  direction: string;
  orderType?: string | null;
  requestedVolume?: number | null;
  requestedPrice?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  riskAmount?: number | null;
  executionStatus?: string;
  reconciliationStatus?: string;
}): string {
  db.prepare(
    `INSERT OR IGNORE INTO executions
      (execution_id, decision_id, correlation_id, parent_execution_id, symbol, direction,
       order_type, requested_volume, requested_price, stop_loss, take_profit, risk_amount,
       execution_status, reconciliation_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    e.executionId,
    e.decisionId ?? null,
    e.correlationId ?? null,
    e.parentExecutionId ?? null,
    e.symbol,
    e.direction,
    e.orderType ?? null,
    e.requestedVolume ?? null,
    e.requestedPrice ?? null,
    e.stopLoss ?? null,
    e.takeProfit ?? null,
    e.riskAmount ?? null,
    e.executionStatus ?? "UNKNOWN",
    e.reconciliationStatus ?? "PENDING_RECONCILIATION"
  );
  return e.executionId;
}

export function getExecutionRow(executionId: string): ExecutionRow | undefined {
  return db.prepare(`SELECT * FROM executions WHERE execution_id = ?`).get(executionId) as
    | ExecutionRow
    | undefined;
}

export function getExecutionByOrderTicket(orderTicket: number): ExecutionRow | undefined {
  return db.prepare(`SELECT * FROM executions WHERE order_ticket = ?`).get(orderTicket) as
    | ExecutionRow
    | undefined;
}

export function getExecutionByDecisionId(decisionId: number): ExecutionRow | undefined {
  return db
    .prepare(`SELECT * FROM executions WHERE decision_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1`)
    .get(decisionId) as ExecutionRow | undefined;
}

/**
 * UPDATE por whitelist (P0 §19: re-ejecutar produce el mismo estado —
 * los campos se RECOMPUTAN desde evidencia, nunca se acumulan).
 */
export function updateExecutionRow(
  executionId: string,
  patch: Partial<Record<(typeof EXECUTION_PATCH_COLUMNS extends Set<infer K> ? K : never), unknown>>
): void {
  const entries = Object.entries(patch).filter(
    ([k, v]) => EXECUTION_PATCH_COLUMNS.has(k) && v !== undefined
  );
  if (entries.length === 0) return;
  const setSql = entries.map(([k]) => `${k} = ?`).join(", ");
  db.prepare(
    `UPDATE executions SET ${setSql}, updated_at = datetime('now') WHERE execution_id = ?`
  ).run(...entries.map(([, v]) => v as unknown), executionId);
}

/**
 * Inserta un deal de MT5 como evidencia (idempotente: UNIQUE deal_ticket).
 * Devuelve true SOLO si la fila es nueva — permite detectar deals duplicados.
 */
export function insertExecutionDeal(d: {
  executionId: string;
  dealTicket: number;
  orderTicket?: number | null;
  positionTicket?: number | null;
  role: "entry" | "exit";
  symbol?: string | null;
  direction?: string | null;
  volume?: number | null;
  price?: number | null;
  profit?: number | null;
  commission?: number | null;
  swap?: number | null;
  fee?: number | null;
  dealEntry?: number | null;
  dealReason?: number | null;
  closeCause?: string | null;
  dealTime?: string | null;
  timeMsc?: number | null;
  rawJson?: string | null;
}): boolean {
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO execution_deals
        (execution_id, deal_ticket, order_ticket, position_ticket, role, symbol, direction,
         volume, price, profit, commission, swap, fee, deal_entry, deal_reason, close_cause,
         deal_time, time_msc, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      d.executionId, d.dealTicket, d.orderTicket ?? null, d.positionTicket ?? null,
      d.role, d.symbol ?? null, d.direction ?? null, d.volume ?? null, d.price ?? null,
      d.profit ?? null, d.commission ?? null, d.swap ?? null, d.fee ?? null,
      d.dealEntry ?? null, d.dealReason ?? null, d.closeCause ?? null,
      d.dealTime ?? null, d.timeMsc ?? null, d.rawJson ?? null
    );
  return res.changes === 1;
}

export function getExecutionDeals(executionId: string): ExecutionDealRow[] {
  return db
    .prepare(`SELECT * FROM execution_deals WHERE execution_id = ? ORDER BY time_msc ASC, deal_ticket ASC`)
    .all(executionId) as ExecutionDealRow[];
}

/** Evento de observabilidad append-only (P0 §37). Sin secretos por contrato. */
export function appendExecutionEvent(
  executionId: string,
  event: string,
  opts?: {
    fromStatus?: string | null;
    toStatus?: string | null;
    reconStatus?: string | null;
    reason?: string | null;
    evidenceJson?: string | null;
  }
): void {
  db.prepare(
    `INSERT INTO execution_events (execution_id, event, from_status, to_status, recon_status, reason, evidence_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    executionId, event,
    opts?.fromStatus ?? null, opts?.toStatus ?? null, opts?.reconStatus ?? null,
    opts?.reason ?? null, opts?.evidenceJson ?? null
  );
}

export function getExecutionEvents(executionId: string): Array<{
  id: number; created_at: string; execution_id: string; event: string;
  from_status: string | null; to_status: string | null; recon_status: string | null;
  reason: string | null; evidence_json: string | null;
}> {
  return db
    .prepare(`SELECT * FROM execution_events WHERE execution_id = ? ORDER BY id ASC`)
    .all(executionId) as Array<{
      id: number; created_at: string; execution_id: string; event: string;
      from_status: string | null; to_status: string | null; recon_status: string | null;
      reason: string | null; evidence_json: string | null;
    }>;
}

/**
 * P1 — TP LADDER: ejecuciones con posición viva gestionables por la
 * escalera (abiertas o parcialmente cerradas, con ticket de posición).
 * Sin position_ticket no hay acción posible (fail-closed).
 */
export function getExecutionsForLadder(limit = 25): ExecutionRow[] {
  return db
    .prepare(
      `SELECT * FROM executions
       WHERE position_ticket IS NOT NULL
         AND execution_status IN ('FILLED', 'OPEN', 'PARTIALLY_CLOSED', 'PARTIALLY_FILLED')
       ORDER BY updated_at ASC
       LIMIT ?`
    )
    .all(limit) as ExecutionRow[];
}

/**
 * Ejecuciones que exigen reconciliación: PENDING_RECONCILIATION (incluye
 * UNKNOWN) con techo de intentos para no martillar un bridge muerto.
 */
export function getExecutionsPendingReconciliation(limit = 10): ExecutionRow[] {
  return db
    .prepare(
      `SELECT * FROM executions
       WHERE reconciliation_status = 'PENDING_RECONCILIATION'
         AND recon_attempts < 12
       ORDER BY recon_attempts ASC, updated_at ASC
       LIMIT ?`
    )
    .all(limit) as ExecutionRow[];
}

export function bumpReconAttempts(executionId: string, error: string): void {
  db.prepare(
    `UPDATE executions
     SET recon_attempts = recon_attempts + 1, last_recon_error = ?, updated_at = datetime('now')
     WHERE execution_id = ?`
  ).run(error.slice(0, 500), executionId);
}

export interface SettleableExecutionRow extends ExecutionRow {
  d_id: number;
  d_symbol: string;
  d_direction: string | null;
  d_confidence: number | null;
}

/**
 * Decisiones EXECUTE sin cerrar cuya ejecución ya es CLOSED + COMPLETE con
 * PnL realizado — ÚNICO camino hacia el aprendizaje (P0 §21/§22/§35).
 */
export function getSettleableReconciledExecutions(limit = 10): SettleableExecutionRow[] {
  return db
    .prepare(
      `SELECT e.*, d.id AS d_id, d.symbol AS d_symbol, d.direction AS d_direction, d.confidence AS d_confidence
       FROM executions e
       JOIN decision_log d ON d.id = e.decision_id
       WHERE d.final_action = 'EXECUTE'
         AND d.outcome_settled = 0
         AND e.execution_status = 'CLOSED'
         AND e.reconciliation_status = 'COMPLETE'
         AND e.realized_pnl IS NOT NULL
       ORDER BY d.id ASC
       LIMIT ?`
    )
    .all(limit) as SettleableExecutionRow[];
}

// ── Settlement helpers (Fase 2: cierre de decisiones) ───────
// P0 §21: la autoridad de ejecución ya NO es trade_performance+symbol+timestamp;
// es executions + execution_deals reconstruidos por ExecutionReconciler.
// trade_performance se conserva para otras funciones (trackrecord, log manual)
// pero settlement jamás derivará de ahí un outcome de ejecución MT5.

/**
 * Decisiones EXECUTE cuyo horizonte ya venció y siguen sin outcome.
 * settle_attempts limita los reintentos para no martillar el bridge.
 */
export function getUnsettledExecuteDecisions(
  horizonHours: number,
  limit = 10
): DecisionRow[] {
  return db
    .prepare(
      `SELECT * FROM decision_log
       WHERE final_action = 'EXECUTE'
         AND outcome_settled = 0
         AND settle_attempts < 8
         AND created_at <= datetime('now', '-' || ? || ' hours')
       ORDER BY id ASC
       LIMIT ?`
    )
    .all(horizonHours, limit) as DecisionRow[];
}

export function bumpSettleAttempts(decisionId: number): void {
  db.prepare(
    `UPDATE decision_log SET settle_attempts = settle_attempts + 1 WHERE id = ?`
  ).run(decisionId);
}

/**
 * Marca una decisión como expirada sin datos (outcome_settled = 2).
 * No es una pérdida ni una ganancia: es un hueco de telemetría que el
 * reporte del cerebro contabiliza como falta de seguimiento.
 */
export function markDecisionExpired(decisionId: number, source: string): void {
  db.prepare(
    `UPDATE decision_log SET outcome_settled = 2, outcome_source = ? WHERE id = ?`
  ).run(source, decisionId);
}

// ── Kill-switches de cuenta (Task 8-a) ─────────────────────
// Fuentes deterministas para el gate account_risk de risk_controls.ts.
// Convención temporal: UTC (datetime('now') de SQLite), igual que el
// resto de la tabla (created_at).

/**
 * PnL REALIZADO de HOY: suma de outcome_pnl de decisiones SETTLED
 * (outcome_settled = 1) cuyo outcome_timestamp cae en el día UTC actual.
 * Los outcomes históricos sin timestamp (filas legacy previas a Task 8-a)
 * NO se cuentan como hoy: atribuirlos al día actual sería inventar datos.
 */
export function getTodayRealizedPnl(): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(outcome_pnl), 0) AS pnl
       FROM decision_log
       WHERE outcome_settled = 1
         AND outcome_pnl IS NOT NULL
         AND outcome_timestamp IS NOT NULL
         AND date(outcome_timestamp) = date('now')`
    )
    .get() as { pnl: number | null };
  return Number(row.pnl) || 0;
}

/**
 * Racha ACTUAL de pérdidas: recorre las decisiones SETTLED más recientes
 * (por outcome_timestamp, tiebreak por id) contando pérdidas consecutivas;
 * la primera decisión no-pérdida (pnl >= 0) corta la racha.
 * Devuelve 0 si no hay historial settled.
 */
export function getConsecutiveLosses(): number {
  const rows = db
    .prepare(
      `SELECT outcome_pnl
       FROM decision_log
       WHERE outcome_settled = 1
         AND outcome_pnl IS NOT NULL
       ORDER BY COALESCE(outcome_timestamp, created_at) DESC, id DESC`
    )
    .all() as Array<{ outcome_pnl: number }>;
  let streak = 0;
  for (const r of rows) {
    if (r.outcome_pnl < 0) streak++;
    else break;
  }
  return streak;
}

// ── Policy Engine (PROMPT 06 §6/§9/§12/§19) ────────────────
// Eventos append-only de gobernanza. El estado vigente es el ÚLTIMO
// evento de cada clave. Nada de UPDATE sobre historia.

export function recordPolicyEvent(
  actor: string,
  event: string,
  oldValue: string | null | undefined,
  newValue: string,
  reason?: string
): void {
  db.prepare(
    `INSERT INTO policy_events (actor, event, old_value, new_value, reason)
     VALUES (?, ?, ?, ?, ?)`
  ).run(actor, event, oldValue ?? null, newValue, reason ?? null);
}

/** Último evento de cada clave solicitada: { clave: {value, reason, created_at} } */
export function getLatestPolicyValues(
  keys: string[]
): Record<string, { value: string; reason?: string; created_at: string }> {
  const out: Record<string, { value: string; reason?: string; created_at: string }> = {};
  for (const key of keys) {
    const row = db
      .prepare(
        `SELECT new_value, reason, created_at FROM policy_events
         WHERE event = ? ORDER BY id DESC LIMIT 1`
      )
      .get(key) as { new_value: string; reason: string | null; created_at: string } | undefined;
    if (row) out[key] = { value: row.new_value, reason: row.reason ?? undefined, created_at: row.created_at };
  }
  return out;
}

export function getPolicyEventsHistory(limit = 50): Array<{
  id: number; created_at: string; actor: string; event: string;
  old_value: string | null; new_value: string; reason: string | null;
}> {
  return db
    .prepare(`SELECT * FROM policy_events ORDER BY id DESC LIMIT ?`)
    .all(limit) as any[];
}

/** ¿La decisión ya produjo una orden REAL (no demo)? — dedup del guard. */
export function hasPlacedOrderForDecision(decisionId: number): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM trade_orders
       WHERE decision_id = ? AND status IN ('placed', 'verified', 'divergence')`
    )
    .get(decisionId) as { n: number };
  return row.n > 0;
}

// ── Manifest de reproducibilidad de backtests (PROMPT 06 §7) ──

export function saveBacktestRunManifest(m: {
  runId: string;
  engine?: string;
  symbol?: string;
  dataHash?: string;
  paramsJson?: string;
  codeVersion?: string;
  seed?: number;
  verdict?: string;
  metricsJson?: string;
}): void {
  db.prepare(
    `INSERT INTO backtest_runs (run_id, engine, symbol, data_hash, params_json, code_version, seed, verdict, metrics_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id) DO UPDATE SET
       verdict = excluded.verdict, metrics_json = excluded.metrics_json`
  ).run(
    m.runId,
    m.engine ?? "simulation",
    m.symbol ?? null,
    m.dataHash ?? null,
    m.paramsJson ?? null,
    m.codeVersion ?? null,
    m.seed ?? null,
    m.verdict ?? "INVALID_NOT_REPRODUCIBLE",
    m.metricsJson ?? null
  );
}

export default db;
