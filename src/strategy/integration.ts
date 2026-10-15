// STRATEGY ENGINE V1.0 — integración con el pipeline de decisión (spec §6-§7).
//
// Tres modos (env STRATEGY_ENGINE_MODE, default SHADOW):
//   · off    — el pipeline queda exactamente como antes (0 llamadas extra).
//   · shadow — el engine evalúa al cierre M1 y SOLO OBSERVA: log + contexto
//              persistido en decision_log.strategy_context (B11). Jamás
//              altera gates, plan ni acción. Validación en vivo §8.
//   · source — el engine es la FUENTE del plan: si hay orden viva (S7+),
//              fabrica el TradePlan determinista y el LLM queda fuera de la
//              decisión; el plan atraviesa el MISMO gate final, policy,
//              saveDecision y hard-gate one-shot (mapa de integración §4-A).
//
// El LLM NUNCA decide en source: no hay debate/manager/planner para setups
// del engine (mandato del proyecto: el LLM narra, el código decide).
import { MT5CandleProvider } from "../data/candle_provider.js";
import { MT5Bridge } from "../config/mt5bridge.js";
import { saveStrategyContext } from "../database/sqlite.js";
import { StrategyEngineRunner, type StrategyTickResult } from "./runner.js";
import type { Gate } from "../agent/pipeline.js";
import type { StrategySignal } from "./types.js";

export type { StrategyTickResult } from "./runner.js";

export type StrategyEngineMode = "off" | "shadow" | "source";

export function getStrategyEngineMode(): StrategyEngineMode {
  const raw = (process.env.STRATEGY_ENGINE_MODE ?? "shadow").toLowerCase().trim();
  return raw === "off" || raw === "source" ? (raw as StrategyEngineMode) : "shadow";
}

/** Runner compartido (una instancia por proceso: caché del provider y
 *  EngineState sobreviven entre llamadas del tool y del pipeline). */
let shared: StrategyEngineRunner | null = null;
export function getSharedRunner(): StrategyEngineRunner {
  if (!shared) {
    shared = new StrategyEngineRunner({
      // MT5Bridge satisface BridgeCandleClient estructuralmente (SE-DATA);
      // TTL 5s = timeout del bridge: evita martilleo sin envejecer la señal.
      provider: new MT5CandleProvider(MT5Bridge, { cacheTtlMs: 5000 }),
    });
  }
  return shared;
}

/** Gates del pipeline → flags del engine (fail-closed):
 *  - news RED/YELLOW/UNKNOWN ⇒ blackout (solo GREEN permite secuencia).
 *  - account_risk RED/UNKNOWN ⇒ kill-switch con el detalle del gate. */
export function gatesToEngineFlags(gates: Gate[]): { newsBlackout: boolean; riskBlocked: string | null } {
  const news = gates.find(g => g.name === "news");
  const newsBlackout = !!news && news.status !== "GREEN";
  const acc = gates.find(g => g.name === "account_risk");
  const riskBlocked =
    acc && (acc.status === "RED" || acc.status === "UNKNOWN")
      ? acc.detail.slice(0, 160)
      : null;
  return { newsBlackout, riskBlocked };
}

/** Plan determinista a partir de una señal con orden viva (modo source).
 *  Null si la señal aún no tiene entry+SL+TP completos (fail-closed). */
export function planFromSignal(signal: StrategySignal): {
  action: "EXECUTE";
  direction: "BUY" | "SELL";
  stopLossPips: number;
  riskPct: number;
  setup: string;
  reasoning: string;
} | null {
  if (!signal.entry || !signal.sl || !signal.tp) return null;
  const oc = signal.openTradeContext;
  return {
    action: "EXECUTE",
    direction: signal.direction === "long" ? "BUY" : "SELL",
    stopLossPips: Math.round(signal.sl.pips * 10) / 10,
    riskPct: signal.risk.riskPct,
    setup: `strategy_engine:${signal.poi?.kind ?? "sweep"}${signal.degraded ? ":degradado" : ""}`,
    reasoning: [
      `[STRATEGY ENGINE V1.0 · determinista · ${signal.state}]`,
      `Pilar H1: ${oc.pillars.h1}.`,
      `Pilar M15: ${oc.pillars.m15}.`,
      `Pilar M1: ${oc.pillars.m1}.`,
      `Liquidez: ${oc.liquiditySweep}.`,
      `Confirmación: ${oc.confirmation}.`,
      `Entrada LIMIT ${signal.entry.price} (retest 50% del bloque trigger, expira ${new Date(signal.entry.expiresAt).toISOString()}).`,
      `SL estructural ${signal.sl.price} (${signal.sl.structuralRef}, ${signal.sl.pips.toFixed(1)} pips).`,
      `TP = liquidez externa ${signal.tp.price} (${signal.tp.liquidityRef}), RR ${signal.tp.rr.toFixed(2)}.`,
    ].join("\n"),
  };
}

/** Persistencia del contexto OpenTrade (B11/R11.2) en decision_log.
 *  Best-effort: un fallo de persistencia JAMÁS rompe el pipeline. */
export function persistStrategyContext(
  decisionId: number,
  tick: StrategyTickResult,
  mode: StrategyEngineMode
): void {
  try {
    saveStrategyContext(decisionId, JSON.stringify({
      engine: "STRATEGY_ENGINE_V1.0",
      mode,
      capturedAt: new Date().toISOString(),
      tick: {
        ok: tick.ok, noop: tick.noop, reason: tick.reason,
        alignedAt: tick.alignedAt, stale: tick.stale,
        inKillzone: tick.inKillzone, newsBlackout: tick.newsBlackout,
        riskBlocked: tick.riskBlocked, state: tick.state,
      },
      sessionLevels: tick.sessionLevels,
      events: tick.events.slice(-100),
      signal: tick.signal,
      closed: tick.closed,
    }));
  } catch {
    // silencio deliberado: el contexto es enriquecimiento, no condición de operación
  }
}

/** Línea de progreso para el log del pipeline (shadow/source). */
export function describeTick(tick: StrategyTickResult, mode: StrategyEngineMode): string {
  if (!tick.ok) return `🧠 Strategy Engine [${mode}] · fail-closed: ${tick.reason}`;
  if (tick.noop) return `🧠 Strategy Engine [${mode}] · sin cierre M1 nuevo`;
  const head = tick.signal
    ? `señal ${tick.signal.direction.toUpperCase()} ${tick.signal.state}`
    : `estado ${tick.state}`;
  const extra = tick.closed ? ` · CERRADO ${tick.closed.direction.toUpperCase()} (${tick.closed.tp ? "TP" : "SL"})` : "";
  const stale = tick.stale ? " · datos stale" : "";
  return `🧠 Strategy Engine [${mode}] · ${head} · ${tick.events.length} evento(s)${extra}${stale}${tick.reason ? ` · ${tick.reason}` : ""}`;
}
