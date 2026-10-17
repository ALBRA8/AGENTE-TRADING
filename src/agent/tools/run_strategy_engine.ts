// Tool manual del STRATEGY ENGINE V1.0 — un tick determinista, 0 tokens LLM.
// Expuesto al bot (registry) y usable a mano: evalúa la máquina de estados
// S0-S9 al último cierre de vela M1 alineado y devuelve el veredicto + señal
// completa (POI, confirmación, trigger, LIMIT, SL estructural, TP externa).
import type { Tool } from "../types.js";
import { getSharedRunner, getStrategyEngineMode } from "../../strategy/integration.js";

interface RunEngineArgs {
  symbol?: string;
}

function fmtLevels(l: {
  londonHigh: number | null; londonLow: number | null;
  asiaHigh: number | null; asiaLow: number | null;
  pdh: number | null; pdl: number | null;
}): string {
  const f = (v: number | null) => (v === null ? "—" : String(v));
  return `PDH ${f(l.pdh)} / PDL ${f(l.pdl)} · Londres ${f(l.londonHigh)}-${f(l.londonLow)} · Asia ${f(l.asiaHigh)}-${f(l.asiaLow)}`;
}

export const runStrategyEngineTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "runStrategyEngine",
      description:
        "Ejecuta UN TICK del STRATEGY ENGINE V1.0 (SMC 3 pilares, 100% determinista, sin LLM): descarga velas H1/M15/M5/M1 cerradas y alineadas del bridge MT5, calcula liquidez de sesiones (High/Low de Londres, Asia, PDH/PDL) y evalúa la máquina de estados S0-S9 al cierre de vela M1. Devuelve el estado, los eventos y —si existe— la señal completa: POI, confirmación M5, trigger M1, entrada LIMIT, SL estructural y TP = liquidez externa. Fail-closed: sin datos limpios no hay señal. Útil para inspeccionar qué ve el engine ahora mismo (modo SHADOW) sin ejecutar el pipeline completo.",
      parameters: {
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description: "Activo a evaluar. Default y objetivo V1: US30.",
          },
        },
        required: [],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const a = args as unknown as RunEngineArgs;
    const symbol = (a.symbol ?? "US30").toUpperCase().trim();
    const runner = getSharedRunner();
    const fetched = await runner.fetchMultiTF(symbol);
    // Tool standalone SIN gates del pipeline: el blackout/kill-switch real lo
    // aplica el cableado del pipeline (gatesToEngineFlags); aquí solo se
    // observa el estado puro de la estrategia.
    const tick = runner.evaluateTick(symbol, fetched, { newsBlackout: false, riskBlocked: null });

    const lines: string[] = [`## 🧠 Strategy Engine V1.0 — ${symbol} (modo ${getStrategyEngineMode()})`, ""];

    if (!tick.ok) {
      lines.push(`⛔ **fail-closed**: ${tick.reason}`, "", "_Sin datos limpios no hay señal (spec §0)._");
      return lines.join("\n");
    }

    lines.push(
      `**Estado: ${tick.state}**${tick.noop ? " · (sin cierre M1 nuevo)" : ""}`,
      `Cierre alineado: ${tick.alignedAt ? new Date(tick.alignedAt).toISOString() : "—"}${tick.stale ? " · ⚠️ datos stale" : ""}`,
      `Killzone NY: ${tick.inKillzone ? "✅ activa" : "❌ inactiva"} · Noticias: ${tick.newsBlackout ? "🔴 blackout" : "✅ sin blackout"} · Riesgo: ${tick.riskBlocked ? `⛔ ${tick.riskBlocked}` : "✅ sin kill-switch"}`,
      `Sesiones: ${fmtLevels(tick.sessionLevels)}`,
      "",
    );

    if (tick.events.length) {
      lines.push("**Eventos del tick:**");
      for (const e of tick.events.slice(-15)) {
        lines.push(`- \`${e.type}\` ${new Date(e.time).toISOString()} — ${e.detail}`);
      }
      lines.push("");
    }

    if (tick.signal) {
      const s = tick.signal;
      lines.push(
        "**Señal:**",
        `- Dirección **${s.direction.toUpperCase()}** · estado ${s.state}${s.degraded ? " · ⚠️ MODO DEGRADADO (sin M1)" : ""}`,
        `- POI: ${s.poi ? `${s.poi.kind} [${s.poi.bottom}–${s.poi.top}]` : "—"}`,
        `- Confirmación M5: ${s.confirmation ? `CHOCH @ ${new Date(s.confirmation.m5ChochTime).toISOString()} rompió ${s.confirmation.brokenLevel}` : "—"}`,
        `- Trigger M1: ${s.trigger ? `CHOCH + bloque [${s.trigger.block.bottom}–${s.trigger.block.top}] → LIMIT ${s.trigger.retestLimitPrice}` : "—"}`,
        `- Entrada: ${s.entry ? `LIMIT ${s.entry.price} (expira ${new Date(s.entry.expiresAt).toISOString()})` : "—"}`,
        `- SL: ${s.sl ? `${s.sl.price} (${s.sl.structuralRef}, ${s.sl.pips.toFixed(1)} pips)` : "—"}`,
        `- TP: ${s.tp ? `${s.tp.price} (${s.tp.liquidityRef}, RR ${s.tp.rr.toFixed(2)})` : "—"}`,
        `- OpenTrade: H1=${s.openTradeContext.pillars.h1} | M15=${s.openTradeContext.pillars.m15} | M1=${s.openTradeContext.pillars.m1}`,
        "",
      );
    } else if (tick.state === "S0_SCAN") {
      lines.push("_Sin secuencia activa: esperando gates + sweep de liquidez (R16)._");
    }

    if (tick.closed) {
      const c = tick.closed;
      lines.push(`**Trade cerrado:** ${c.direction.toUpperCase()} — ${c.tp ? `TP alcanzado (${c.tp.liquidityRef})` : "SL alcanzado"} @ ${c.tp ? c.tp.price : c.sl?.price}`);
    }

    return lines.join("\n");
  },
};
