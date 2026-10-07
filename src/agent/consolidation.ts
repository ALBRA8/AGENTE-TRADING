// ============================================================
// src/agent/consolidation.ts
// Pipeline de memoria §3 (Task 10-c, diseño del auditor 9-i):
//
//   EVENT → EPISODIC → PATTERN → CONSOLIDATION → VALIDATION → PROMOTION
//
//   - saveLesson (self_improve/settlement) es el EVENT/EPISODIC.
//   - consolidateMemory() agrupa lecciones PENDING por pattern_key,
//     exige recurrencia (PATTERN), valida estadísticamente contra
//     decision_log settled del símbolo (VALIDATION, Wilson 95%) y
//     deja el resultado 'verified' ESPERANDO aprobación humana.
//   - promoteLessonGated() es la PROMOCIÓN: única puerta de entrada al
//     system prompt permanente, exige evidencia y queda AUDITADA en
//     policy_events. NUNCA es invocable por el LLM (no hay tool que la
//     exponga; el viejo promoteId del tool searchLessons fue retirado).
//
//   §27: cero lógica duplicada — solo SELECT/UPDATE propios sobre
//   agent_lessons/decision_log (sqlite.ts NO se toca; sus helpers de
//   escritura de lecciones se reutilizan tal cual).
// ============================================================

import db, {
  recordPolicyEvent,
  upsertMemory,
  type LessonRow,
} from "../database/sqlite.js";

// ── Umbral de consolidación (env overridable, defaults honestos) ──
function envPositiveInt(name: string, def: number): number {
  const v = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}

/** PATTERN: ocurrencias mínimas del patrón para convertirlo en hipótesis. */
export const MIN_PATTERN_SEEN = envPositiveInt("MIN_PATTERN_SEEN", 5);
/** VALIDATION: muestra mínima de trades settled del símbolo para validar. */
export const MIN_SAMPLE = envPositiveInt("MIN_SAMPLE", 10);
/** VALIDATION: cota inferior Wilson al 95% mínima para marcar 'verified'. */
export const MIN_WILSON_LB = 0.5;
/** Auto-promoción (doble llave): wilson_lb ≥ 0.6 Y n ≥ 30 Y env explícito. */
export const AUTO_PROMOTE_MIN_WILSON_LB = 0.6;
export const AUTO_PROMOTE_MIN_N = 30;

function autoPromoteEnabled(): boolean {
  return (process.env.AUTO_PROMOTE_LESSONS ?? "").trim().toLowerCase() === "true";
}

// ── Tipos: agent_lessons + columnas MemoryDV (sqlite.ts añade las columnas;
//    su interfaz LessonRow aún no las declara — extenderla aquí es el diseño
//    de 9-i "MEMORYDV por EXTENSIÓN, 0 churn en lectores") ──
export type LessonDVRow = LessonRow & {
  memory_type?: string | null;
  domain?: string | null;
  confidence?: number | null;
  truth_level?: string | null;
  evidence_json?: string | null;
  last_verified?: string | null;
  utility?: number | null;
  agent_id?: string | null;
};

// ── Estadística: cota inferior de Wilson (intervalo binomial al 95%) ──

/**
 * Wilson score LOWER BOUND para una proporción binomial.
 * Es la métrica honesta de "win_rate con muestra pequeña": 8/10 da ~0.49
 * (NO 0.8) — una tasa alta con pocos trades no se toma por buena.
 *
 *   LB = (p̂ + z²/2n − z·√(p̂(1−p̂)/n + z²/4n²)) / (1 + z²/n)
 *
 * z=1.96 → 95%. Degenerados: n=0 → 0; wins<0 o wins>n → clampeados.
 */
export function wilsonScore(wins: number, n: number, z = 1.96): number {
  if (!Number.isFinite(wins) || !Number.isFinite(n) || n <= 0) return 0;
  const w = Math.min(Math.max(wins, 0), n);
  const p = w / n;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const lb = (centre - margin) / (1 + z2 / n);
  return Math.round(Math.min(1, Math.max(0, lb)) * 10_000) / 10_000;
}

export interface PatternStats {
  n: number;
  wins: number;
  win_rate: number;
  wilson_lb: number;
}

/**
 * VALIDATION §3: stats del patrón sobre decision_log SETTLED del símbolo.
 * n = decisiones EXECUTE ya cerradas (outcome_settled=1, PnL presente);
 * wins = PnL > 0. Es la evidencia REAL del histórico del símbolo — no el
 * veredicto de un LLM ni la opinión de un trade.
 */
export function getPatternStats(symbol: string): PatternStats {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(CASE WHEN outcome_pnl > 0 THEN 1 ELSE 0 END), 0) AS wins
       FROM decision_log
       WHERE symbol = ? COLLATE NOCASE
         AND final_action = 'EXECUTE'
         AND outcome_settled = 1
         AND outcome_pnl IS NOT NULL`
    )
    .get(symbol) as { n: number; wins: number };
  const n = Number(row.n) || 0;
  const wins = Number(row.wins) || 0;
  return {
    n,
    wins,
    win_rate: n > 0 ? Math.round((wins / n) * 10_000) / 10_000 : 0,
    wilson_lb: wilsonScore(wins, n),
  };
}

// ── PROMOTION: la puerta con llave ──────────────────────────

export interface PromotionResult {
  ok: boolean;
  reason: string;
}

/**
 * Promueve una lección a memoria permanente (system prompt) SOLO si:
 *   1. validation_status === 'verified' (validación determinista previa), y
 *   2. tiene evidencia (evidence_json no vacío).
 * Toda promoción exitosa queda auditada en policy_events (append-only):
 *   actor, event=lesson_promotion:<id>, old='candidate', new='promoted'.
 *
 * NO existe tool que la exponga al LLM. Llamadores legítimos:
 *   - humano/operador (dashboard, Telegram, script, con su actor)
 *   - consolidateMemory() SOLO con la doble llave de auto-promoción.
 */
export function promoteLessonGated(
  lessonId: number,
  actor: string,
  reason: string
): PromotionResult {
  const row = db
    .prepare(`SELECT id, validation_status, promoted, evidence_json FROM agent_lessons WHERE id = ?`)
    .get(lessonId) as
    | { id: number; validation_status: string; promoted: number; evidence_json?: string | null }
    | undefined;

  if (!row) {
    return { ok: false, reason: `Lección #${lessonId} no existe` };
  }
  if (row.promoted === 1) {
    return { ok: false, reason: `Lección #${lessonId} ya estaba promovida (idempotente, sin evento)` };
  }
  if (row.validation_status !== "verified") {
    return {
      ok: false,
      reason: `Gate §3/§4: solo lecciones 'verified' se promueven (estado actual: '${row.validation_status}')`,
    };
  }
  const evidence = (row.evidence_json ?? "").trim();
  if (!evidence || evidence === "{}" || evidence === "[]" || evidence === "null") {
    return {
      ok: false,
      reason: `Gate §3/§4: lección #${lessonId} sin evidencia (evidence_json vacío) — no promovible`,
    };
  }

  db.prepare(`UPDATE agent_lessons SET promoted = 1, updated_at = datetime('now') WHERE id = ?`).run(lessonId);
  recordPolicyEvent(actor, `lesson_promotion:${lessonId}`, "candidate", "promoted", reason);
  return { ok: true, reason: `Lección #${lessonId} promovida y auditada en policy_events (actor=${actor})` };
}

// ── CONSOLIDATION: el job periódico (lo llama settlement en el mismo lock) ──

export interface ConsolidationSummary {
  /** PATTERN: lecciones pendientes que alcanzaron el umbral de recurrencia. */
  candidates: number;
  /** VALIDATION: lecciones marcadas 'verified' en esta pasada. */
  verified: number;
  /** PROMOTION: auto-promociones (deshabilitado por defecto — doble llave). */
  promoted: number;
  /** VALIDATION: candidatas que quedan 'pending' por muestra/Wilson insuficiente. */
  skipped: number;
  details: string[];
}

function isOpsLesson(l: LessonDVRow): boolean {
  return l.source === "auto_error" || l.pattern_key.startsWith("OPS|");
}

/** ¿La lección cita evidencia episódica de settlement (decision_id)? */
function hasDecisionEvidence(l: LessonDVRow): boolean {
  return !!l.evidence_json && l.evidence_json.includes("decision_id");
}

/**
 * EPISODIC/PROCEDURAL/SEMANTIC: clasificación MemoryDV de las lecciones.
 * Idempotente: solo escribe filas con memory_type NULL o mal clasificadas.
 */
function classifyMemoryTypes(lessons: LessonDVRow[]): { episodic: number; procedural: number; semantic: number } {
  let episodic = 0;
  let procedural = 0;
  let semantic = 0;
  for (const l of lessons) {
    let target: string | null = null;
    if (isOpsLesson(l)) {
      // Errores operativos de TOOL → SOP de dependencias (procedimental).
      if (l.memory_type !== "PROCEDURAL") target = "PROCEDURAL";
      procedural++;
    } else if (hasDecisionEvidence(l)) {
      // Lecciones nacidas del settlement (cite decision_id) → EPISODIC.
      if (l.memory_type !== "EPISODIC") target = "EPISODIC";
      episodic++;
    } else if (!l.memory_type) {
      target = "SEMANTIC";
      semantic++;
    }
    if (target) {
      db.prepare(`UPDATE agent_lessons SET memory_type = ? WHERE id = ?`).run(target, l.id);
    }
  }
  return { episodic, procedural, semantic };
}

/**
 * Pipeline §3 completo. SÍNCRONO y determinista (sin LLM): seguro de correr
 * dentro del lock de mantenimiento de settlement.ts.
 *
 *   a. Lee lecciones PENDING (no contradichas) agrupadas por pattern_key
 *      (el dedupe de saveLesson garantiza 1 fila por patrón).
 *   b. PATTERN: times_seen ≥ MIN_PATTERN_SEEN → hipótesis candidata.
 *   c. VALIDATION (solo lecciones de trading, con símbolo): stats reales
 *      sobre decision_log settled del símbolo → si n ≥ MIN_SAMPLE y
 *      wilson_lb ≥ 0.5 y no está contradicha → 'verified' con confidence
 *      = wilson_lb y evidence_json {n, wins, wilson_lb, computed_at}.
 *      Sin muestra suficiente → queda 'pending' (NUNCA promover).
 *   d. EPISODIC/PROCEDURAL: clasificación MemoryDV (ver classifyMemoryTypes).
 *   e. Auto-promoción PROHIBIDA por defecto: solo si env
 *      AUTO_PROMOTE_LESSONS==='true' Y wilson_lb ≥ 0.6 Y n ≥ 30.
 */
export function consolidateMemory(): ConsolidationSummary {
  const summary: ConsolidationSummary = {
    candidates: 0,
    verified: 0,
    promoted: 0,
    skipped: 0,
    details: [],
  };

  const lessons = db
    .prepare(
      `SELECT * FROM agent_lessons
       WHERE validation_status = 'pending'
       ORDER BY times_seen DESC, id ASC`
    )
    .all() as LessonDVRow[];

  // (d) EPISODIC / PROCEDURAL / SEMANTIC — clasificación idempotente.
  const typed = classifyMemoryTypes(lessons);

  for (const l of lessons) {
    // Lecciones operativas OPS|: su gate es el triage ≥3 existente, NO la
    // estadística de trading (no tienen símbolo ni trades asociados).
    if (isOpsLesson(l)) continue;

    // (b) PATTERN: recurrencia mínima para considerarlo hipótesis.
    if (l.times_seen < MIN_PATTERN_SEEN) continue;
    if (!l.symbol) {
      summary.skipped++;
      summary.details.push(`#${l.id} ${l.pattern_key}: sin símbolo → no validable estadísticamente`);
      continue;
    }

    summary.candidates++;

    // (c) VALIDATION contra el histórico real del símbolo.
    const stats = getPatternStats(l.symbol);
    if (stats.n >= MIN_SAMPLE && stats.wilson_lb >= MIN_WILSON_LB) {
      const evidence = JSON.stringify({
        n: stats.n,
        wins: stats.wins,
        win_rate: stats.win_rate,
        wilson_lb: stats.wilson_lb,
        computed_at: new Date().toISOString(),
      });
      db.prepare(
        `UPDATE agent_lessons
         SET validation_status = 'verified',
             confidence = ?,
             evidence_json = ?,
             last_verified = datetime('now'),
             updated_at = datetime('now')
         WHERE id = ?`
      ).run(stats.wilson_lb, evidence, l.id);
      summary.verified++;
      summary.details.push(
        `#${l.id} ${l.pattern_key}: VERIFICADA (n=${stats.n}, wins=${stats.wins}, wilson_lb=${stats.wilson_lb})`
      );

      // (e) Auto-promoción: doble llave, apagada por defecto. Si ocurre,
      //     va por el MISMO gate auditado que un humano.
      if (
        autoPromoteEnabled() &&
        stats.wilson_lb >= AUTO_PROMOTE_MIN_WILSON_LB &&
        stats.n >= AUTO_PROMOTE_MIN_N
      ) {
        const res = promoteLessonGated(
          l.id,
          "consolidation:auto",
          `Auto-promoción §4: n=${stats.n} ≥ 30 y wilson_lb=${stats.wilson_lb} ≥ 0.6 (AUTO_PROMOTE_LESSONS=true)`
        );
        if (res.ok) summary.promoted++;
        else summary.details.push(`#${l.id}: auto-promoción rechazada: ${res.reason}`);
      }
    } else {
      // Sin muestra suficiente → 'pending' honesto. Jamás promover.
      summary.skipped++;
      summary.details.push(
        `#${l.id} ${l.pattern_key}: pendiente (n=${stats.n}/${MIN_SAMPLE}, wilson_lb=${stats.wilson_lb})`
      );
    }
  }

  // Marca de la última consolidación (la lee el Doctor §20, sección MEMORY).
  try {
    upsertMemory("system", "last_consolidation", new Date().toISOString());
  } catch {
    /* best-effort: nunca tumba el bucle de mantenimiento */
  }

  if (summary.candidates > 0 || summary.verified > 0) {
    console.log(
      `[Consolidation] 🧩 candidatas=${summary.candidates} · verificadas=${summary.verified} · promovidas=${summary.promoted} · pendientes=${summary.skipped} (EPISODIC=${typed.episodic}, PROCEDURAL=${typed.procedural}, SEMANTIC=${typed.semantic})`
    );
  }
  return summary;
}
