// ============================================================
// src/agent/tools/run_time_machine.ts
// TIME MACHINE (tool del agente) — odds honestas de un plan ANTES de
// ejecutarlo: Monte Carlo (10,000 replays barajando velas reales del
// activo a esa hora del día) + replay del MISMO plan sobre las últimas
// sesiones reales. Fail-closed: sin bridge o sin sesiones suficientes,
// devuelve motivo — nunca odds inventadas.
//
// Fuera del pipeline NO decide nada: el veredicto 🟢🟡🔴 es insumo para
// el comité de riesgo y para el usuario (SOP: 🟡 → 0.25% o confluencia
// extra; 🔴 → bloquear). La simulación NO es una predicción.
// ============================================================

import type { Tool } from "../types.js";
import { MT5Bridge } from "../../config/mt5bridge.js";
import {
  buildSessions,
  buildPool,
  simulate,
  replayHistory,
  timeMachineVerdict,
  type TMRawCandle,
} from "../../backtest/timemachine.js";

interface TimeMachineArgs {
  asset?: string;
  timeframe?: "M1" | "M5" | "M15";
  entry?: number;
  stopLoss?: number;
  takeProfit?: number;
  side?: "BUY" | "SELL";
  sessions?: number;
  replays?: number;
  seed?: number;
  horizonBars?: number;
}

const ASSETS = ["US30", "NAS100", "XAUUSD", "BTCUSD", "GBPJPY"];
const TF_MINUTES: Record<string, number> = { M1: 1, M5: 5, M15: 15 };

export const runTimeMachineTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "runTimeMachine",
      description:
        "TIME MACHINE: reproduce el plan 10,000 veces (Monte Carlo con velas REALES del activo a esa misma hora del día) y además re-ejecuta el MISMO entry/SL/TP sobre las últimas ~60 sesiones reales. Devuelve odds honestas (TP primero, SL primero, R medio, peor R, gaps) y un veredicto 🟢🟡🔴 para el comité de riesgo. Úsalo con el plan del pipeline (entry/SL/TP) ANTES de executeTradeMT5. Es simulación, no predicción: sin bridge MT5 no hay odds.",
      parameters: {
        type: "object",
        properties: {
          asset: {
            type: "string",
            enum: ASSETS,
            description: "Activo del plan (ej. US30, BTCUSD).",
          },
          timeframe: {
            type: "string",
            enum: ["M1", "M5", "M15"],
            description: "Temporalidad de la simulación. Default M5.",
          },
          entry: {
            type: "number",
            description: "Precio de entrada LIMIT del plan.",
          },
          stopLoss: {
            type: "number",
            description: "Stop Loss (precio) del plan.",
          },
          takeProfit: {
            type: "number",
            description: "Take Profit (precio) del plan.",
          },
          side: {
            type: "string",
            enum: ["BUY", "SELL"],
            description: "Dirección. Opcional: se infiere (TP>entry → BUY).",
          },
          sessions: {
            type: "number",
            description: "Sesiones históricas para el pool (10-120). Default 60.",
          },
          replays: {
            type: "number",
            description: "Replays Monte Carlo (1000-50000). Default 10000.",
          },
          seed: {
            type: "number",
            description: "Seed del PRNG (determinismo/reproducibilidad). Default 19.",
          },
          horizonBars: {
            type: "number",
            description:
              "Horizonte en velas por replay (5-500). Default: lo que queda de la sesión actual.",
          },
        },
        required: ["asset", "entry", "stopLoss", "takeProfit"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const a = args as unknown as TimeMachineArgs;

    // ── 1. Validación del plan (fail-closed, sin números inventados) ──
    const asset = String(a.asset ?? "").trim().toUpperCase();
    if (!ASSETS.includes(asset)) {
      return `❌ Activo no soportado: "${asset}". Válidos: ${ASSETS.join(", ")}.`;
    }
    const timeframe = a.timeframe ?? "M5";
    const tfMin = TF_MINUTES[timeframe] ?? 5;
    const entry = Number(a.entry);
    const stop = Number(a.stopLoss);
    const target = Number(a.takeProfit);
    for (const [name, v] of [
      ["entry", entry],
      ["stopLoss", stop],
      ["takeProfit", target],
    ] as const) {
      if (!Number.isFinite(v) || v <= 0) {
        return `❌ ${name} inválido (${v}): el Time Machine necesita un plan con precios reales, nada inventado.`;
      }
    }
    const risk = entry - stop;
    if (risk === 0) return "❌ entry y stopLoss no pueden ser iguales.";
    const side: "BUY" | "SELL" = a.side ?? (target > entry ? "BUY" : "SELL");
    // Coherencia del plan: SL y TP deben quedar en lados opuestos del entry
    if (side === "BUY" && !(stop < entry && target > entry)) {
      return `❌ Plan BUY incoherente: exige stop < entry < takeProfit (${stop} / ${entry} / ${target}).`;
    }
    if (side === "SELL" && !(stop > entry && target < entry)) {
      return `❌ Plan SELL incoherente: exige stop > entry > takeProfit (${stop} / ${entry} / ${target}).`;
    }

    const sessionsWanted = Math.max(10, Math.min(120, Math.round(a.sessions ?? 60)));
    const replays = Math.max(1000, Math.min(50000, Math.round(a.replays ?? 10000)));
    const seed = Math.max(0, Math.round(a.seed ?? 19)) >>> 0;

    // ── 2. Velas OBSERVED del bridge (fail-closed si no hay MT5) ──
    const fetchCount = Math.min(5000, sessionsWanted * 400);
    let raw;
    try {
      raw = await MT5Bridge.getCandles(asset, timeframe, fetchCount);
    } catch (err) {
      return [
        `🔴 **DATOS NO DISPONIBLES** — bridge MT5 no alcanzable: ${(err as Error).message}`,
        ``,
        `_Verifica que MT5 esté abierto y bridge.py corriendo en localhost:29413._`,
        `_Sin velas reales NO hay odds: no se simula nada con datos inventados._`,
      ].join("\n");
    }
    if (!raw || raw.length < 200) {
      return `🔴 **DATOS INSUFICIENTES** — el bridge devolvió ${raw?.length ?? 0} velas (${timeframe}). No se simula con una muestra tan corta.`;
    }

    const nowMs = Date.now();
    const data = buildSessions(raw as TMRawCandle[], tfMin, nowMs);
    const fullSessions = data.sessions;
    if (fullSessions.length < 10) {
      return [
        `🔴 **MUESTRA INSUFICIENTE** — solo ${fullSessions.length} sesiones completas de velas cerradas (mínimo 10).`,
        `Baja la temporalidad (M1/M5) o amplía el histórico del bridge; no invento odds con poca muestra.`,
      ].join("\n");
    }
    const medianBars = data.medianSessionBars;
    if (medianBars < 10) {
      return `🔴 **SESIONES DEMASIADO CORTAS** — mediana de ${medianBars} velas/sesión (${timeframe}). No se simula.`;
    }

    // ── 3. Pool + horizonte (lo que queda de la sesión actual) ──
    const pool = buildPool(fullSessions);
    const usedSessions = fullSessions.length;
    const horizon = Math.max(
      5,
      Math.min(
        500,
        Math.round(a.horizonBars ?? Math.max(5, medianBars - data.currentIndex))
      )
    );
    const fromIndex = Math.min(data.currentIndex + 1, pool.length - 1);

    // ── 4. Monte Carlo + replay histórico + veredicto ──
    const sim = simulate({
      pool,
      entry,
      stop,
      target,
      side,
      fromIndex,
      horizonBars: horizon,
      replays,
      seed,
    });
    const hist = replayHistory({ sessions: fullSessions, entry, stop, target, side });
    const verdict = timeMachineVerdict(sim, hist);

    // ── 5. Reporte ejecutivo (estilo SOP: bullets + semáforo) ──
    const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
    const rStr = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}R`;
    const riskStr = `${Math.abs(risk).toLocaleString("en-US", { maximumFractionDigits: 2 })} pts`;
    const emoji =
      verdict.level === "GREEN" ? "🟢" : verdict.level === "RED" ? "🔴" : "🟡";
    const dirEmoji = side === "BUY" ? "📈 BUY" : "📉 SELL";
    // Estadística condicional a las resueltas: si el horizonte deja la
    // mayoría sin resolver, los % brutos despistan — lo que informa es
    // cómo terminaron las que SÍ resolvieron.
    const resolved = sim.targetFirst + sim.stopFirst;
    const condLine =
      resolved > 0.005
        ? `   Resueltas antes del cierre: ${pct(resolved)} → 🎯 ${pct(sim.targetFirst / resolved)} / 🔻 ${pct(sim.stopFirst / resolved)}`
        : `   ⚠️ Casi nada resuelve en ${horizon} velas: plan muy lejos del precio u horizonte corto para este activo/timeframe.`;

    const lines = [
      `🕰️ **TIME MACHINE · ${asset} · ${timeframe}** · ${sim.replays.toLocaleString("en-US")} replays · seed ${seed} · pool ${usedSessions} sesiones (${medianBars} velas/sesión mediana)`,
      `💹 **Plan [OBSERVED del bridge]**: ${dirEmoji} entry ${entry} → SL ${stop} → TP ${target} (riesgo ${riskStr}, ${sim.rTarget}R) · horizonte ${horizon} velas${data.excludedInProgress ? " · vela en curso EXCLUIDA" : ""}`,
      `🎲 **Monte Carlo**: 🎯 TP primero ${pct(sim.targetFirst)} · 🔻 SL primero ${pct(sim.stopFirst)} · ⚪ sin resolver ${pct(sim.unresolved)}`,
      condLine,
      `   R medio ${rStr(sim.avgR)} · mediano ${rStr(sim.medianR)} · p5 ${rStr(sim.p5R)} / p95 ${rStr(sim.p95R)} · cierres a favor ${pct(sim.greenPct)}`,
      `📜 **Mismo plan, últimas ${hist.sessionsTested} sesiones reales**: disparó ${hist.fired} · 🎯 ${hist.target} · 🔻 ${hist.stop} · ⚪ ${hist.neither} · R medio ${rStr(hist.avgR)} · peor ${rStr(hist.worstR)}${hist.gapped ? ` · ⚠️ ${hist.gapped} gaps a través del SL` : ""}${hist.degenerate ? ` · (${hist.degenerate} sesiones descartadas: fill degenerado por gap, fuera del plan)` : ""}`,
      ``,
      `${emoji} **VEREDICTO: ${verdict.headline}**`,
      verdict.recommendation,
      ``,
      `_Simulación a partir de velas reales (fuente OBSERVED), NO una predicción. La decisión EXECUTE/WAIT la toma el pipeline con sus gates y el comité, NO este reporte._`,
    ];
    return lines.join("\n");
  },
};
