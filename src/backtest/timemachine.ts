// ============================================================
// src/backtest/timemachine.ts
// TIME MACHINE — odds honestas de un plan ANTES de arriesgar un dólar.
// Port del concepto "trader-timemachine" (Jakeschincariol, MIT) al
// AGENTE-TRADING: en vez de Yahoo Finance, velas OBSERVED del bridge MT5;
// en vez de sesiones USA fijas, sesiones por día de broker (sirve para
// US30, BTCUSD 24/7, GBPJPY…).
//
// Qué hace:
//  1) buildSessions(): agrupa velas cerradas en sesiones por día.
//  2) buildPool(): por slot horario dentro de la sesión, el pool de barras
//     reales de todas las sesiones pasadas (normalizadas a ratios/open).
//  3) simulate(): Monte Carlo determinista (mulberry32 + seed) — baraja
//     barras reales a esa hora del día y reproduce la sesión N veces
//     contra el plan (entry/SL/TP). CONSERVADOR: si SL y TP caen dentro
//     de la MISMA barra sintética, cuenta PÉRDIDA (stop-first).
//  4) replayHistory(): el MISMO plan replayado sobre las últimas sesiones
//     REALES (limit-fill honesto: gaps abren peor/mejor, no R constante).
//  5) timeMachineVerdict(): semáforo 🟢🟡🔴 + recomendación para el comité.
//
// Fail-closed por diseño: nada inventa datos. Sin sesiones suficientes,
// el llamador recibe un motivo, no números fabricados.
// Es una SIMULACIÓN, no una predicción: el futuro puede hacer cosas que
// esos N días nunca hicieron (noticias, halts, gaps estructurales).
// ============================================================

import { mulberry32 } from "./engine.js";

// ── Tipos ───────────────────────────────────────────────────

/** Vela cruda mínima (compatible con MT5Candle del bridge). */
export interface TMRawCandle {
  time: string; // "YYYY-MM-DD HH:MM:SS" (hora de broker)
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface TMBar {
  t: number; // epoch ms
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface TMSession {
  date: string; // "YYYY-MM-DD" (UTC del tiempo de broker)
  bars: TMBar[];
}

/** Barra de pool normalizada: ratios respecto a su propia apertura. */
interface TMRatioBar {
  hr: number; // high / open
  lr: number; // low  / open
  cr: number; // close/ open
}

export interface TMSessionData {
  sessions: TMSession[]; // sesiones COMPLETAS pasadas (cronológicas)
  currentSession: TMSession | null; // sesión en curso (solo velas cerradas)
  currentIndex: number; // posición de la última vela cerrada en su sesión
  excludedInProgress: boolean; // se excluyó la vela sin cerrar
  medianSessionBars: number;
}

export interface TMSimResult {
  replays: number;
  horizonBars: number;
  targetFirst: number; // 0..1
  stopFirst: number; // 0..1
  unresolved: number; // 0..1 (cierra la sesión sin tocar nada)
  greenPct: number; // cerró a favor (target o close>entry para BUY)
  avgR: number;
  medianR: number;
  p5R: number;
  p95R: number;
  rTarget: number; // R del plan (|target-entry| / |entry-stop|)
}

export interface TMHistoryResult {
  sessionsTested: number;
  fired: number;
  target: number;
  stop: number;
  neither: number;
  /** Sesiones descartadas: el gap del fill rompió la geometría del plan
   *  (p.ej. BUY fill por DEBAJO del stop) — contarlas con R inventado
   *  ensuciaría el promedio (R absurdos tipo +14R). */
  degenerate: number;
  avgR: number;
  worstR: number;
  gapped: number; // fills con gap desfavorable a través del SL
}

export type TMLevel = "GREEN" | "YELLOW" | "RED";

export interface TMVerdict {
  level: TMLevel;
  headline: string;
  recommendation: string;
}

// ── 1. Agrupar velas cerradas en sesiones por día ──────────

function parseCandleMs(timeStr: string): number {
  if (!timeStr) return NaN;
  const normalized = timeStr.includes("T") ? timeStr : timeStr.replace(" ", "T");
  const withZ = /Z|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : normalized + "Z";
  const ms = new Date(withZ).getTime();
  return Number.isFinite(ms) ? ms : new Date(timeStr).getTime();
}

export function buildSessions(
  raw: TMRawCandle[],
  tfMinutes: number,
  nowMs: number
): TMSessionData {
  // Sanidad: descartar filas corruptas (mismo criterio que src/smc/live.ts)
  const clean = (raw ?? []).filter(
    (c) =>
      c &&
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close) &&
      c.high >= c.low &&
      c.open > 0
  );

  // Excluir la vela EN CURSO (regla Task 10-a: T cierra en T+TF)
  let excluded = false;
  let series = clean;
  if (tfMinutes > 0 && series.length > 0) {
    const lastOpenMs = parseCandleMs(series[series.length - 1].time);
    const inProgress =
      Number.isFinite(lastOpenMs) &&
      nowMs >= lastOpenMs &&
      nowMs < lastOpenMs + tfMinutes * 60_000;
    if (inProgress) {
      series = series.slice(0, -1);
      excluded = true;
    }
  }

  // Agrupar por fecha (UTC del tiempo de broker — frontera estable)
  const byDate = new Map<string, TMBar[]>();
  for (const c of series) {
    const t = parseCandleMs(c.time);
    if (!Number.isFinite(t)) continue;
    const date = new Date(t).toISOString().slice(0, 10);
    let arr = byDate.get(date);
    if (!arr) {
      arr = [];
      byDate.set(date, arr);
    }
    arr.push({ t, o: c.open, h: c.high, l: c.low, c: c.close });
  }

  const dates = [...byDate.keys()].sort();
  if (dates.length === 0) {
    return {
      sessions: [],
      currentSession: null,
      currentIndex: 0,
      excludedInProgress: excluded,
      medianSessionBars: 0,
    };
  }

  const today = dates[dates.length - 1];
  const currentBars = byDate.get(today)!;
  const sessions: TMSession[] = dates
    .slice(0, -1)
    .filter((d) => byDate.get(d)!.length > 0)
    .map((d) => ({ date: d, bars: byDate.get(d)! }));

  const lengths = sessions.map((s) => s.bars.length).sort((a, b) => a - b);
  const median =
    lengths.length === 0
      ? currentBars.length
      : lengths[Math.floor(lengths.length / 2)];

  return {
    sessions,
    currentSession: { date: today, bars: currentBars },
    currentIndex: Math.max(0, currentBars.length - 1),
    excludedInProgress: excluded,
    medianSessionBars: median,
  };
}

// ── 2. Pool de barras por slot horario (ratios/open) ───────

export function buildPool(sessions: TMSession[]): TMRatioBar[][] {
  const maxLen = sessions.reduce((m, s) => Math.max(m, s.bars.length), 0);
  const pool: TMRatioBar[][] = [];
  for (let i = 0; i < maxLen; i++) {
    const slot: TMRatioBar[] = [];
    for (const s of sessions) {
      const b = s.bars[i];
      if (!b || b.o <= 0) continue;
      slot.push({ hr: b.h / b.o, lr: b.l / b.o, cr: b.c / b.o });
    }
    pool.push(slot);
  }
  return pool;
}

// ── 3. Monte Carlo determinista ────────────────────────────

function nearestNonEmpty(pool: TMRatioBar[][], idx: number): number {
  if (pool[idx] && pool[idx].length > 0) return idx;
  for (let d = 1; d < pool.length; d++) {
    if (idx - d >= 0 && pool[idx - d].length > 0) return idx - d;
    if (idx + d < pool.length && pool[idx + d].length > 0) return idx + d;
  }
  return -1;
}

export function simulate(input: {
  pool: TMRatioBar[][];
  entry: number;
  stop: number;
  target: number;
  side: "BUY" | "SELL";
  fromIndex: number; // slot donde empieza la simulación
  horizonBars: number;
  replays: number;
  seed: number;
  jitter?: number; // ± slots (default 2, como el original)
}): TMSimResult {
  const { pool, entry, stop, target, side, fromIndex, horizonBars, replays, seed } =
    input;
  const jitter = input.jitter ?? 2;
  const long = side === "BUY";
  const risk = long ? entry - stop : stop - entry;
  const rTarget = Math.abs(target - entry) / Math.abs(risk || 1);

  const rng = mulberry32(seed >>> 0);
  const outcomes: ("target" | "stop" | "close")[] = [];
  const closes: number[] = [];
  const Rs: number[] = [];
  let green = 0;

  for (let n = 0; n < replays; n++) {
    let p = entry;
    let outcome: "target" | "stop" | "close" | null = null;
    for (let step = 0; step < horizonBars; step++) {
      // jitter determinista del slot (misma hora del día ± ventana)
      let idx = fromIndex + step + (Math.floor(rng() * (2 * jitter + 1)) - jitter);
      idx = Math.max(0, Math.min(pool.length - 1, idx));
      const realIdx = nearestNonEmpty(pool, idx);
      if (realIdx < 0) break; // pool vacío (no debería ocurrir tras validación)
      const slotBars = pool[realIdx];
      const bar = slotBars[Math.floor(rng() * slotBars.length)];
      const hi = p * bar.hr;
      const lo = p * bar.lr;
      const cl = p * bar.cr;
      if (outcome === null) {
        if (long) {
          // CONSERVADOR: dentro de una misma barra, el stop manda
          if (lo <= stop) outcome = "stop";
          else if (hi >= target) outcome = "target";
        } else {
          if (hi >= stop) outcome = "stop";
          else if (lo <= target) outcome = "target";
        }
      }
      p = cl;
    }
    const finalOutcome: "target" | "stop" | "close" = outcome ?? "close";
    outcomes.push(finalOutcome);
    closes.push(p);
    const r =
      finalOutcome === "target"
        ? rTarget
        : finalOutcome === "stop"
          ? -1.0
          : (long ? p - entry : entry - p) / (risk || 1);
    Rs.push(r);
    if (finalOutcome === "target" || (finalOutcome === "close" && r > 0)) green++;
  }

  const count = (x: "target" | "stop" | "close") =>
    outcomes.filter((o) => o === x).length;
  const sortedR = [...Rs].sort((a, b) => a - b);
  const q = (p: number) =>
    sortedR[Math.min(sortedR.length - 1, Math.max(0, Math.floor(p * sortedR.length)))];

  return {
    replays,
    horizonBars,
    targetFirst: count("target") / replays,
    stopFirst: count("stop") / replays,
    unresolved: count("close") / replays,
    greenPct: green / replays,
    avgR: Rs.reduce((a, b) => a + b, 0) / replays,
    medianR: q(0.5),
    p5R: q(0.05),
    p95R: q(0.95),
    rTarget: Math.round(rTarget * 100) / 100,
  };
}

// ── 4. Replay histórico: el MISMO plan en sesiones reales ──

export function replayHistory(input: {
  sessions: TMSession[];
  entry: number;
  stop: number;
  target: number;
  side: "BUY" | "SELL";
  maxSessions?: number; // default 60 (las más recientes)
}): TMHistoryResult {
  const { sessions, entry, stop, target, side } = input;
  const maxSessions = Math.min(input.maxSessions ?? 60, sessions.length);
  const long = side === "BUY";
  const risk = long ? entry - stop : stop - entry;
  const recent = sessions.slice(-maxSessions);

  let fired = 0,
    hitTarget = 0,
    hitStop = 0,
    neither = 0,
    degenerate = 0,
    gapped = 0;
  const Rs: number[] = [];

  for (const s of recent) {
    const bars = s.bars;
    // Disparo: primera vela cuyo rango toca el entry (orden LIMIT)
    let j = bars.findIndex((b) => (long ? b.l <= entry : b.h >= entry));
    if (j < 0) continue; // esa sesión nunca llegó al entry

    // Fill honesto del LIMIT: si la vela ABRE atravesando el nivel,
    // el fill es en apertura (gap favorable en la dirección del fill)
    const trigger = bars[j];
    let fill = entry;
    if (long && trigger.o <= entry) fill = trigger.o;
    if (!long && trigger.o >= entry) fill = trigger.o;

    // Coherencia geométrica: un gap EXTREMO puede dejar el fill más allá
    // del propio SL (o del TP) — ahí el plan ya no significa nada (el
    // bróker rechazaría ese bracket) y contar un R fabricado envenena el
    // promedio. Se descarta y se reporta.
    const coherent = long ? fill > stop && fill < target : fill < stop && fill > target;
    if (!coherent) {
      degenerate++;
      continue;
    }
    fired++; // solo disparos con geometría válida cuentan como fired

    // Walk REAL desde la vela del disparo (inclusive: el resto de esa
    // vela puede tocar SL/TP — regla conservadora: stop manda)
    let exit: number | null = null;
    let outcome: "target" | "stop" | "neither" = "neither";
    for (let k = j; k < bars.length; k++) {
      const b = bars[k];
      if (long) {
        if (b.o < stop) {
          exit = b.o; // gap de apertura a través del SL → peor precio real
          gapped++;
          outcome = "stop";
          break;
        }
        if (b.l <= stop) {
          exit = stop;
          outcome = "stop";
          break;
        }
        if (b.h >= target) {
          exit = b.o > target ? b.o : target; // gap favorable al TP
          outcome = "target";
          break;
        }
      } else {
        if (b.o > stop) {
          exit = b.o;
          gapped++;
          outcome = "stop";
          break;
        }
        if (b.h >= stop) {
          exit = stop;
          outcome = "stop";
          break;
        }
        if (b.l <= target) {
          exit = b.o < target ? b.o : target;
          outcome = "target";
          break;
        }
      }
    }
    if (exit === null) exit = bars[bars.length - 1].c; // cerró la sesión sin tocar nada

    const r = (long ? exit - fill : fill - exit) / (risk || 1);
    Rs.push(r);
    if (outcome === "target") hitTarget++;
    else if (outcome === "stop") hitStop++;
    else neither++;
  }

  return {
    sessionsTested: recent.length,
    fired,
    target: hitTarget,
    stop: hitStop,
    neither,
    degenerate,
    avgR: Rs.length ? Rs.reduce((a, b) => a + b, 0) / Rs.length : 0,
    worstR: Rs.length ? Math.min(...Rs) : 0,
    gapped,
  };
}

// ── 5. Veredicto (semáforo para el comité) ─────────────────

export function timeMachineVerdict(sim: TMSimResult, hist: TMHistoryResult): TMVerdict {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

  // Señal combinada: Monte Carlo (prospectivo) + historial (realizado).
  // El historial solo puede vetar si disparó suficiente veces como para significar algo.
  const histSignificativo = hist.fired >= 10;
  const blended =
    histSignificativo ? sim.avgR * 0.5 + hist.avgR * 0.5 : sim.avgR;

  if (blended >= 0.35 && sim.targetFirst > sim.stopFirst) {
    return {
      level: "GREEN",
      headline: `SESGO FAVORABLE — TP primero ${pct(sim.targetFirst)} vs SL primero ${pct(sim.stopFirst)}, R medio ${sim.avgR >= 0 ? "+" : ""}${sim.avgR.toFixed(2)}${histSignificativo ? ` (combinado con historial real: ${hist.avgR >= 0 ? "+" : ""}${hist.avgR.toFixed(2)})` : ""}`,
      recommendation:
        "🟢 Odds a favor. El plan puede ir al comité de riesgo con esta evidencia; igualmente respeta SL y tamaño máximo del SOP.",
    };
  }
  if (blended <= -0.2 || (histSignificativo && hist.avgR <= -0.3)) {
    return {
      level: "RED",
      headline: `DESFAVORABLE — R medio ${sim.avgR >= 0 ? "+" : ""}${sim.avgR.toFixed(2)}${histSignificativo ? `, historial real ${hist.avgR >= 0 ? "+" : ""}${hist.avgR.toFixed(2)} en ${hist.fired} disparos` : ""}`,
      recommendation:
        "🔴 Odds en contra. El comité debería BLOQUEAR este plan o exigir confluencia estructural extra antes de considerar EXECUTE.",
    };
  }
  return {
    level: "YELLOW",
    headline: `MONEDA AL AIRE — TP primero ${pct(sim.targetFirst)}, SL primero ${pct(sim.stopFirst)}, sin resolver ${pct(sim.unresolved)}${histSignificativo ? ` · historial real: ${hist.target}🎯/${hist.stop}🔻/${hist.neither}⚪ de ${hist.fired}` : ""}`,
    recommendation:
      "🟡 Sin ventaja estadística demostrable. Según SOP: reduce tamaño a 0.25% o exige confluencia extra (RVOL, killzone, DXY) antes de ejecutar.",
  };
}
