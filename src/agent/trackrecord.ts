// ============================================================
// src/agent/trackrecord.ts
// Track Record — la vitrina pública del producto.
//
// Pitch: "el único bot que te demuestra por qué NO operó".
//   Cada WAIT/REVIEW del pipeline queda auditado con su motivo en
//   decision_log; este módulo lo convierte en un resumen honesto y
//   presentable: win rate, expectancy, rachas, serie temporal y el
//   top de razones de espera.
//
// Reglas:
//   - buildTrackRecord es PURA (sin DB, sin IO): testeable al 100%.
//   - getTrackRecord hace los SELECTs parameterizados y nunca lanza:
//     tablas vacías o DB rota → estructura válida con ceros.
//   - SIN PII: no se selecciona user_id, emails ni números de cuenta.
//   - NUNCA promete rentabilidad: es un historial descriptivo, no una
//     proyección (ver docs/COMPLIANCE.md).
// ============================================================

import db from "../database/sqlite.js";

// ── Tipos de entrada (filas crudas de decision_log / brain_evaluations) ──
export interface TrackRecordDecisionRow {
  created_at: string;
  symbol: string;
  final_action: string; // EXECUTE | WAIT | REVIEW | ABORTED
  reasoning?: string | null;
  gates_json?: string | null;
  outcome_pnl?: number | null;
  outcome_settled?: number | null; // 0=pending, 1=settled, 2=expirada
}

export interface TrackRecordBrainRow {
  created_at: string;
  score: number;
}

// ── Tipos de salida ─────────────────────────────────────────
export interface TrackRecordSymbolRow {
  symbol: string;
  decisiones: number;
  ejecutadas: number;
  settled: number;
  wins: number;
  losses: number;
  pnl: number;
  winRate: number | null;
}

export interface TrackRecord {
  /** true SOLO en datos de demostración (preview); false = DB real */
  demo: boolean;
  generatedAt: string;
  totalDecisiones: number;
  porAccion: { EXECUTE: number; WAIT: number; REVIEW: number; ABORTED: number };
  settledConPnl: number;
  wins: number;
  losses: number;
  /** 0..1 sobre decisiones SETTLED con PnL; null si no hay cerradas */
  winRate: number | null;
  /**
   * Media del PnL de decisiones SETTLED (outcome_pnl), en las unidades con
   * que se registró el cierre (típicamente % de cuenta o USD según quien
   * reportó el resultado en trade_performance).
   */
  expectancyPct: number | null;
  totalPnl: number;
  mejorSimbolo: { symbol: string; pnl: number } | null;
  peorSimbolo: { symbol: string; pnl: number } | null;
  /** Racha vigente: +N ganancias consecutivas, -N pérdidas, 0 si nada cerrado */
  rachaActual: number;
  serieTemporal: Array<{ fecha: string; pnlAcumulado: number }>;
  /** Top motivos de WAIT/REVIEW extraídos de reasoning/gates reales */
  topRazonesEspera: Array<{ razon: string; conteo: number }>;
  /** Mini tabla por símbolo (para la UI) */
  symbols: TrackRecordSymbolRow[];
  ultimoBrainScore: number | null;
}

// ── Utilidades defensivas ───────────────────────────────────
const MAX_RAZON_LEN = 140;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Normaliza un motivo: colapsa espacios, recorta y descarta ruido. */
function normalizeReason(raw: string): string | null {
  const s = raw
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[-*•\d.)\s]+/, "")
    .trim()
    .slice(0, MAX_RAZON_LEN);
  return s.length >= 6 ? s : null;
}

/**
 * Extrae el motivo de espera de una fila WAIT/REVIEW.
 * Fuente 1: `reasoning` (el abortReason real del pipeline).
 * Fuente 2 (fallback): primer gate no-GREEN de gates_json.
 */
function extractWaitReason(row: TrackRecordDecisionRow): string | null {
  const fromReasoning =
    typeof row.reasoning === "string" ? normalizeReason(row.reasoning) : null;
  if (fromReasoning) return fromReasoning;

  if (typeof row.gates_json === "string" && row.gates_json.trim()) {
    try {
      const gates = JSON.parse(row.gates_json) as Array<{
        name?: string;
        status?: string;
        detail?: string;
      }>;
      if (Array.isArray(gates)) {
        const blocking = gates.find(
          (g) => g && g.status && g.status !== "GREEN"
        );
        if (blocking) {
          const label = blocking.name ?? "filtro";
          const detail = normalizeReason(String(blocking.detail ?? ""));
          return detail ? `${label}: ${detail}` : `${label}: sin detalle`;
        }
      }
    } catch {
      // gates_json corrupto → sin motivo; nunca lanzar por telemetría rota
    }
  }
  return null;
}

function countBy(rows: TrackRecordDecisionRow[], action: string): number {
  return rows.filter((r) => r.final_action === action).length;
}

/** Estructura válida con ceros (DB vacía o rota). Nunca lanza. */
export function emptyTrackRecord(demo = false, generatedAt = new Date().toISOString()): TrackRecord {
  return {
    demo,
    generatedAt,
    totalDecisiones: 0,
    porAccion: { EXECUTE: 0, WAIT: 0, REVIEW: 0, ABORTED: 0 },
    settledConPnl: 0,
    wins: 0,
    losses: 0,
    winRate: null,
    expectancyPct: null,
    totalPnl: 0,
    mejorSimbolo: null,
    peorSimbolo: null,
    rachaActual: 0,
    serieTemporal: [],
    topRazonesEspera: [],
    symbols: [],
    ultimoBrainScore: null,
  };
}

// ── Función PURA: todo el cálculo vive aquí (testeable sin DB) ──
export function buildTrackRecord(
  decisionRows: TrackRecordDecisionRow[],
  brainRows: TrackRecordBrainRow[] = [],
  opts: { demo?: boolean; generatedAt?: string } = {}
): TrackRecord {
  const out = emptyTrackRecord(opts.demo ?? false, opts.generatedAt ?? new Date().toISOString());

  if (!Array.isArray(decisionRows)) return out;
  const rows = decisionRows.filter(
    (r) => r && typeof r === "object" && typeof r.symbol === "string"
  );

  out.totalDecisiones = rows.length;
  out.porAccion = {
    EXECUTE: countBy(rows, "EXECUTE"),
    WAIT: countBy(rows, "WAIT"),
    REVIEW: countBy(rows, "REVIEW"),
    ABORTED: countBy(rows, "ABORTED"),
  };

  // ── Resultados cerrados (SETTLED con PnL) ──
  const settledRows = rows.filter(
    (r) => r.outcome_settled === 1 && typeof r.outcome_pnl === "number" && Number.isFinite(r.outcome_pnl)
  );
  out.settledConPnl = settledRows.length;
  const wins = settledRows.filter((r) => (r.outcome_pnl as number) > 0).length;
  const losses = settledRows.length - wins;
  out.wins = wins;
  out.losses = losses;
  out.winRate = settledRows.length ? Math.round((wins / settledRows.length) * 10000) / 10000 : null;
  out.totalPnl = round2(settledRows.reduce((acc, r) => acc + (r.outcome_pnl as number), 0));
  out.expectancyPct = settledRows.length
    ? round2(out.totalPnl / settledRows.length)
    : null;

  // ── Racha actual (orden por created_at asc; la última manda el signo) ──
  const chrono = [...settledRows].sort((a, b) =>
    String(a.created_at).localeCompare(String(b.created_at))
  );
  let streak = 0;
  let lastSign = 0;
  for (const r of chrono) {
    const sign = (r.outcome_pnl as number) > 0 ? 1 : -1;
    if (sign === lastSign) streak += sign;
    else streak = sign;
    lastSign = sign;
  }
  out.rachaActual = chrono.length ? streak : 0;

  // ── Serie temporal: PnL acumulado por fecha (para gráfico simple) ──
  const byDate = new Map<string, number>();
  for (const r of chrono) {
    const fecha = String(r.created_at).slice(0, 10);
    byDate.set(fecha, (byDate.get(fecha) ?? 0) + (r.outcome_pnl as number));
  }
  let cum = 0;
  out.serieTemporal = [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([fecha, pnl]) => {
      cum = round2(cum + pnl);
      return { fecha, pnlAcumulado: cum };
    });

  // ── Mejor / peor símbolo por PnL acumulado (solo cerrados) ──
  const pnlBySymbol = new Map<string, number>();
  for (const r of settledRows) {
    const sym = String(r.symbol).toUpperCase();
    pnlBySymbol.set(sym, (pnlBySymbol.get(sym) ?? 0) + (r.outcome_pnl as number));
  }
  if (pnlBySymbol.size) {
    const entries = [...pnlBySymbol.entries()].map(([symbol, pnl]) => ({ symbol, pnl: round2(pnl) }));
    entries.sort((a, b) => b.pnl - a.pnl || a.symbol.localeCompare(b.symbol));
    out.mejorSimbolo = entries[0];
    out.peorSimbolo = entries[entries.length - 1];
  }

  // ── Top 5 "por qué NO operó" (motivos reales de WAIT/REVIEW) ──
  const reasonCount = new Map<string, number>();
  for (const r of rows) {
    if (r.final_action !== "WAIT" && r.final_action !== "REVIEW") continue;
    const reason = extractWaitReason(r);
    if (!reason) continue;
    reasonCount.set(reason, (reasonCount.get(reason) ?? 0) + 1);
  }
  out.topRazonesEspera = [...reasonCount.entries()]
    .map(([razon, conteo]) => ({ razon, conteo }))
    .sort((a, b) => b.conteo - a.conteo || a.razon.localeCompare(b.razon))
    .slice(0, 5);

  // ── Mini tabla por símbolo ──
  const bySymbol = new Map<string, TrackRecordDecisionRow[]>();
  for (const r of rows) {
    const sym = String(r.symbol).toUpperCase();
    const list = bySymbol.get(sym) ?? [];
    list.push(r);
    bySymbol.set(sym, list);
  }
  out.symbols = [...bySymbol.entries()]
    .map(([symbol, list]) => {
      const settled = list.filter(
        (r) => r.outcome_settled === 1 && typeof r.outcome_pnl === "number" && Number.isFinite(r.outcome_pnl)
      );
      const w = settled.filter((r) => (r.outcome_pnl as number) > 0).length;
      return {
        symbol,
        decisiones: list.length,
        ejecutadas: list.filter((r) => r.final_action === "EXECUTE").length,
        settled: settled.length,
        wins: w,
        losses: settled.length - w,
        pnl: round2(settled.reduce((acc, r) => acc + (r.outcome_pnl as number), 0)),
        winRate: settled.length ? Math.round((w / settled.length) * 10000) / 10000 : null,
      };
    })
    .sort((a, b) => b.decisiones - a.decisiones || a.symbol.localeCompare(b.symbol));

  // ── Brain Score más reciente (si hay snapshots) ──
  if (Array.isArray(brainRows) && brainRows.length) {
    const sorted = [...brainRows]
      .filter((b) => b && typeof b.score === "number" && Number.isFinite(b.score))
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    if (sorted.length) out.ultimoBrainScore = round2(sorted[sorted.length - 1].score);
  }

  return out;
}

// ── Vía oficial: SELECTs parameterizados sobre la DB real ──
// Sin PII: no se selecciona user_id ni ningún dato identificable.
export function getTrackRecord(): TrackRecord {
  try {
    const decisions = db
      .prepare(
        `SELECT created_at, symbol, final_action, reasoning, gates_json,
                outcome_pnl, outcome_settled
         FROM decision_log
         ORDER BY id ASC`
      )
      .all() as TrackRecordDecisionRow[];

    let brains: TrackRecordBrainRow[] = [];
    try {
      brains = db
        .prepare(`SELECT created_at, score FROM brain_evaluations ORDER BY id ASC`)
        .all() as TrackRecordBrainRow[];
    } catch {
      // snapshots inexistentes → Brain Score ausente, el resto sigue
    }

    return buildTrackRecord(decisions, brains, { demo: false });
  } catch (err) {
    // Defensivo: la vitrina pública NUNCA debe caer por telemetría rota.
    console.error("[TrackRecord] No se pudo leer decision_log:", (err as Error).message);
    return emptyTrackRecord(false);
  }
}
