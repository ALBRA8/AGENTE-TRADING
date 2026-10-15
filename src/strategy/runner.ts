// STRATEGY ENGINE V1.0 — runner de vivo (cableado del núcleo puro con la capa de datos).
//
// Responsabilidad (spec §6, docs/STRATEGY_ENGINE_V1.md):
//   1. Descargar velas H1/M15/M5/M1 CERRADAS y ALINEADAS vía CandleProvider
//      (fail-closed: sin datos limpios no hay evaluación).
//   2. Calcular la liquidez de sesión (Londres/Asia/PDH/PDL) y el extremo
//      estructural H1 — todo en velas cerradas (no-repaint §0.2).
//   3. Resolver la killzone con la ÚNICA fuente de verdad del repo
//      (evaluateMarketHours, DST-safe America/New_York — mapa de integración §3).
//   4. Alimentar evaluate() UNA vez por cierre de vela M1 (determinismo,
//      no-repaint) y mantener el EngineState por símbolo.
//
// El runner NO decide riesgo, NO ejecuta órdenes y NO habla con LLMs:
// la señal resultante atraviesa el mismo pipeline de riesgo/policy/hard-gate
// que cualquier decisión (mapa de integración §5).
import type { CandleProvider, MultiTF } from '../data/candle_provider.js';
import { createEngineState, evaluate } from './engine.js';
import { computeSessionHighLow, etDateKey, resolveSessionWindows } from './session-liquidity.js';
import { evaluateMarketHours } from '../agent/tools/check_market_hours.js';
import type {
  Candle, EngineEvent, EngineState, SessionLevels, SState,
  StrategyConfig, StrategySignal,
} from './types.js';
import { DEFAULT_STRATEGY_CONFIG } from './strategy.config.js';

/** Profundidad mínima por TF (60 velas: 2.5 días H1 para PDH/PDL,
 *  15 h M15 para la ventana de Londres, 5 h M5, 1 h M1). */
const MIN_COUNT_PER_TF = 60;

/** Resultado del fetch (nunca lanza: todo fallo es fail-closed con motivo). */
export type EngineFetchResult =
  | { ok: true; data: MultiTF }
  | { ok: false; reason: string };

/** Flags por-tick (los gates del pipeline / el tool manual los inyectan). */
export interface TickFlags {
  /** B16.4: blackout de noticias alto impacto (RED/YELLOW/UNKNOWN del gate). */
  newsBlackout?: boolean;
  /** B16.5: kill-switch de riesgo existente (gate account_risk RED/UNKNOWN). */
  riskBlocked?: string | null;
  /** Override de killzone (tests/backtest); default = evaluateMarketHours(symbol, now).isNYKillzone */
  inKillzone?: boolean;
  /** Override de niveles de sesión (tests/backtest); default = computeSessionLevels(...). */
  sessionLevels?: SessionLevels;
  /** Override del extremo estructural H1 (B13.1); default = extremos del H1 visible. */
  h1ExtremeHigh?: number | null;
  h1ExtremeLow?: number | null;
}

export interface StrategyTickResult {
  symbol: string;
  /** false = fail-closed por datos (el estado del engine NO se toca). */
  ok: boolean;
  /** true = no hubo cierre de vela M1 nuevo desde el último tick. */
  noop: boolean;
  /** Motivo legible (fail-closed, noop o vacío). */
  reason: string | null;
  alignedAt: number | null;
  stale: boolean;
  inKillzone: boolean;
  newsBlackout: boolean;
  riskBlocked: string | null;
  /** Señal NUEVA emitida en este tick (orden lista, fill, BE...). */
  signal: StrategySignal | null;
  /** Trade CERRADO en este tick (S9: TP_HIT/SL_HIT). */
  closed: StrategySignal | null;
  events: EngineEvent[];
  /** Estado actual de la máquina (S0_SCAN si no hay secuencia). */
  state: SState;
  /** Niveles de sesión usados en la evaluación. */
  sessionLevels: SessionLevels;
}

export interface StrategyRunnerDeps {
  provider: CandleProvider;
  /** Config por símbolo; default DEFAULT_STRATEGY_CONFIG (US30-first V1). */
  cfg?: StrategyConfig;
  /** Reloj inyectable (epoch ms) para tests deterministas. */
  now?: () => number;
}

/**
 * Calcula los niveles de sesión D-12 en velas CERRADAS:
 *  - High/Low de Londres (LDN 03:00-12:00 ET) y Asia (19:00-04:00 ET) sobre
 *    la unión H1+M15+M5 (H1 da la profundidad que M5 no tiene temprano en NY).
 *  - PDH/PDL: extremos del ÚLTIMO día ET completo con velas H1 (B4/R4.2).
 *  - Extremo estructural H1 = max/min del histórico H1 visible (B13.1, último recurso).
 * Devuelve null en los campos sin datos suficientes (fail-closed, nunca inventa).
 */
export function computeSessionLevels(
  h1: Candle[], m15: Candle[], m5: Candle[], now: number
): { levels: SessionLevels; h1ExtremeHigh: number | null; h1ExtremeLow: number | null } {
  const windows = resolveSessionWindows(now);
  const ldn = windows.find(w => w.name === 'LDN')!;
  const asia = windows.find(w => w.name === 'ASIA')!;
  const merged = [...h1, ...m15, ...m5].sort((a, b) => a.time - b.time);

  const london = computeSessionHighLow(merged, ldn);
  const asiaRange = computeSessionHighLow(merged, asia);

  // PDH/PDL: último día ET completo ANTERIOR al día ET actual
  const todayKey = etDateKey(now);
  const byDay = new Map<string, Candle[]>();
  for (const c of h1) {
    const k = etDateKey(c.time);
    const arr = byDay.get(k) ?? [];
    arr.push(c);
    byDay.set(k, arr);
  }
  const prevDays = [...byDay.keys()].filter(k => k < todayKey).sort();
  const prevKey = prevDays[prevDays.length - 1] ?? null;
  const prev = prevKey ? byDay.get(prevKey)! : [];
  const pdh = prev.length ? Math.max(...prev.map(c => c.high)) : null;
  const pdl = prev.length ? Math.min(...prev.map(c => c.low)) : null;

  const h1ExtremeHigh = h1.length ? Math.max(...h1.map(c => c.high)) : null;
  const h1ExtremeLow = h1.length ? Math.min(...h1.map(c => c.low)) : null;

  return {
    levels: {
      londonHigh: london.high, londonLow: london.low,
      asiaHigh: asiaRange.high, asiaLow: asiaRange.low,
      pdh, pdl,
    },
    h1ExtremeHigh,
    h1ExtremeLow,
  };
}

/** Killzone V1 con la fuente única del repo: killzone NY del símbolo
 *  (US30/NAS100/SPX500 → NY 8-12 ET). Símbolo sin política (unknown) o fin
 *  de semana ⇒ false (fail-closed: no hay killzone confirmada, no hay setup). */
export function isKillzoneDefault(symbol: string, now: number): boolean {
  const v = evaluateMarketHours(symbol, new Date(now));
  return !v.unknown && !v.blocked && v.isNYKillzone;
}

/**
 * Runner con estado por símbolo. Thread-model: un solo loop por proceso
 * (el settlement/agente existentes); los métodos NO son reentrantes entre
 * procesos (el EngineState vive en memoria — en SHADOW un reinicio reinicia
 * la secuencia en curso, comportamiento aceptado V1 y documentado en §7).
 */
export class StrategyEngineRunner {
  private provider: CandleProvider;
  private cfg: StrategyConfig;
  private nowFn: () => number;
  private states = new Map<string, EngineState>();
  private lastAligned = new Map<string, number>();

  constructor(deps: StrategyRunnerDeps) {
    this.provider = deps.provider;
    this.cfg = deps.cfg ?? DEFAULT_STRATEGY_CONFIG;
    this.nowFn = deps.now ?? (() => Date.now());
  }

  /** Fetch multi-TF alineado al último cierre común. NUNCA lanza. */
  async fetchMultiTF(symbol: string): Promise<EngineFetchResult> {
    try {
      const data = await this.provider.getAligned(
        symbol, ['H1', 'M15', 'M5', 'M1'], MIN_COUNT_PER_TF, { fresh: true }
      );
      if (!data) {
        return { ok: false, reason: this.provider.lastRejectReason ?? 'datos multi-TF no disponibles (fail-closed)' };
      }
      return { ok: true, data };
    } catch (err) {
      return { ok: false, reason: `fallo del proveedor de velas: ${(err as Error).message}` };
    }
  }

  /** Evalúa el engine con datos ya descargados. Sincrónico y puro salvo el estado interno. */
  evaluateTick(symbol: string, fetched: EngineFetchResult, flags: TickFlags = {}): StrategyTickResult {
    const base: StrategyTickResult = {
      symbol, ok: false, noop: false, reason: null, alignedAt: null,
      stale: false, inKillzone: false, newsBlackout: flags.newsBlackout ?? false,
      riskBlocked: flags.riskBlocked ?? null,
      signal: null, closed: null, events: [], state: 'S0_SCAN',
      sessionLevels: { londonHigh: null, londonLow: null, asiaHigh: null, asiaLow: null, pdh: null, pdl: null },
    };
    if (!fetched.ok) {
      return { ...base, reason: fetched.reason };
    }
    const data = fetched.data;
    const computed = computeSessionLevels(data.h1, data.m15, data.m5, data.alignedAt);
    const levels = flags.sessionLevels ?? computed.levels;
    const h1ExtremeHigh = flags.h1ExtremeHigh !== undefined ? flags.h1ExtremeHigh : computed.h1ExtremeHigh;
    const h1ExtremeLow = flags.h1ExtremeLow !== undefined ? flags.h1ExtremeLow : computed.h1ExtremeLow;

    // No-repaint: UNA evaluación por cierre de vela M1 (alignedAt = cierre común)
    if (this.lastAligned.get(symbol) === data.alignedAt) {
      const st = this.states.get(symbol);
      return {
        ...base, ok: true, noop: true,
        reason: 'sin cierre de vela M1 nuevo (tick deduplicado)',
        alignedAt: data.alignedAt, stale: data.stale,
        sessionLevels: levels,
        state: st?.seq?.stage ?? 'S0_SCAN',
      };
    }

    const prev = this.states.get(symbol) ?? createEngineState(symbol);
    const inKillzone = flags.inKillzone ?? isKillzoneDefault(symbol, data.alignedAt);
    const out = evaluate(prev, {
      now: data.alignedAt,
      candlesH1: data.h1,
      candlesM15: data.m15,
      candlesM5: data.m5,
      candlesM1: data.m1,
      sessionLevels: levels,
      inKillzone,
      newsBlackout: flags.newsBlackout ?? false,
      riskBlocked: flags.riskBlocked ?? null,
      h1ExtremeHigh,
      h1ExtremeLow,
    }, this.cfg);

    this.states.set(symbol, out.state);
    this.lastAligned.set(symbol, data.alignedAt);
    return {
      symbol, ok: true, noop: false, reason: null,
      alignedAt: data.alignedAt, stale: data.stale,
      inKillzone, newsBlackout: flags.newsBlackout ?? false,
      riskBlocked: flags.riskBlocked ?? null,
      signal: out.signal, closed: out.closed, events: out.state.events,
      state: out.state.seq?.stage ?? 'S0_SCAN',
      sessionLevels: levels,
    };
  }

  /** Estado vivo (para el tool manual / diagnósticos). */
  getEngineState(symbol: string): EngineState | null {
    return this.states.get(symbol) ?? null;
  }

  /** Reinicio manual (kill-switch operativo / tests). */
  reset(symbol?: string): void {
    if (symbol) { this.states.delete(symbol); this.lastAligned.delete(symbol); }
    else { this.states.clear(); this.lastAligned.clear(); }
  }
}
