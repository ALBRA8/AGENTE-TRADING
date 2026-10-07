import type { Tool } from "../types.js";
import { MT5Bridge } from "../../config/mt5bridge.js";
import { analyzeLiveStructure } from "../../smc/live.js";

/**
 * Task 8-a — Reescritura completa (auditoría 6-a / C2):
 *  - ANTES: macroTrend, BOS, ChoCh y "ChoCh Confirmado en M1" estaban
 *    HARDCODEADOS: el pipeline debatía sobre estructura inventada.
 *  - AHORA: toda la estructura sale del detector SMC real
 *    (src/backtest/smc_detector.ts) ejecutado sobre velas REALES del
 *    bridge (src/smc/live.ts). Sin datos → reporte honesto
 *    "DATOS NO DISPONIBLES" sin sugerir ejecución (fail-closed).
 *  - Killzone NY con timezone real America/New_York (DST-safe): misma
 *    técnica que check_market_hours.ts — se replica aquí porque ese
 *    archivo no exporta helpers y está fuera del alcance de esta tarea.
 * Task 10-a (§6 Market Data = Verdad):
 *  - Si el feed está rancio (analysis.dataStale de live.ts) se añade un
 *    bloque visible "⚠️ DATOS STALE" — el texto exacto lo reconoce el gate
 *    price_feed del pipeline y lo trata como UNKNOWN (fail-closed).
 *  - Cada afirmación del reporte lleva su fuente: [OBSERVED] para precios
 *    medidos, [INFERRED] para lo derivado por el detector.
 */

interface AnalyzeMarketArgs {
  timeframe: "H1" | "M15" | "M5" | "M1";
  asset?: string;
}

/** Hora y día de Nueva York con timezone real (corrige el offset fijo -5) */
function getNYClock(): { hour: number; weekday: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    hour12: false,
    weekday: "short",
  }).formatToParts(new Date());
  return {
    hour: parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10) % 24,
    weekday: parts.find((p) => p.type === "weekday")?.value ?? "",
  };
}

export const analyzeMarket: Tool = {
  definition: {
    type: "function",
    function: {
      name: "analyzeMarket",
      description: "Análisis SMC EN VIVO del activo: detecta swings, BOS/ChoCh, FVGs y POIs con el detector real sobre las velas de MT5 (nada hardcodeado). Si el bridge no responde o faltan velas, devuelve DATOS NO DISPONIBLES sin sugerir ejecución.",
      parameters: {
        type: "object",
        properties: {
          timeframe: {
            type: "string",
            enum: ["H1", "M15", "M5", "M1"],
            description: "Temporalidad para el análisis."
          },
          asset: {
            type: "string",
            enum: ["US30", "NAS100", "XAUUSD", "BTCUSD", "GBPJPY"],
            description: "Activo a analizar."
          }
        },
        required: ["timeframe", "asset"]
      }
    }
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const { timeframe = "M5", asset = "US30" } = args as unknown as AnalyzeMarketArgs;
    const symbol = String(asset).trim().toUpperCase();

    // 1. Killzone NY — lógica DST-safe (idéntica criterio a check_market_hours)
    const { hour: nyHour, weekday: nyWeekday } = getNYClock();
    const isNYKillzone = nyHour >= 8 && nyHour < 12;
    const isWeekend = nyWeekday === "Sat" || nyWeekday === "Sun";

    // 2. Estructura SMC REAL (detector de backtest sobre velas del bridge)
    //    Cualquier fallo aquí es honesto: sin datos no hay análisis.
    const analysis = await analyzeLiveStructure(symbol, timeframe);

    if (!analysis.available) {
      const reason = analysis.unavailableReason ?? "motivo desconocido";
      // Marcadores "Error de Bridge" / "Error de Datos": el pipeline los
      // usa para poner el gate price_feed en UNKNOWN (fail-closed).
      const isBridgeIssue = reason.toLowerCase().includes("bridge") || reason.toLowerCase().includes("timeout");
      const header = isBridgeIssue ? "Error de Bridge" : "Error de Datos";
      return [
        `📊 **Reporte SMC — ${symbol} (${timeframe})**`,
        `❌ **${header}**: ${reason}`,
        ``,
        `## ⛔ DATOS NO DISPONIBLES`,
        `No se puede analizar la estructura de ${symbol} con datos reales, así que este reporte NO sugiere ejecución.`,
        `El pipeline tratará el precio/estructura como UNKNOWN y bloqueará EXECUTE (fail-closed).`,
        isBridgeIssue
          ? `_Verifica que MT5 esté abierto y bridge.py corriendo en localhost:5001._`
          : `_Datos insuficientes del feed: no se simulan ni se rellenan._`,
      ].join("\n");
    }

    // 3. Tick en vivo (complementario, no crítico: ya hay cierre real de vela)
    //    Task 10-a: precio marcado [OBSERVED] + edad del tick (hallazgo 9-b P2:
    //    antes se mostraba Bid/Ask sin edad — un tick viejo parecía "actual").
    let tickLine = `Último cierre [OBSERVED]: **${analysis.lastPrice}** (${analysis.candleCount} velas CERRADAS hasta ${analysis.asOf})`;
    if (!analysis.lastCandleClosed) {
      tickLine += ` · vela en curso EXCLUIDA del análisis`;
    }
    try {
      const tick = await MT5Bridge.getPrice(symbol);
      if (Number.isFinite(tick.bid) && Number.isFinite(tick.ask) && tick.bid > 0 && tick.ask > 0) {
        const tMs = new Date(tick.time ?? "").getTime();
        const ageStr = Number.isFinite(tMs)
          ? `, hace ${Math.max(0, Math.round((Date.now() - tMs) / 1000))}s`
          : "";
        tickLine += ` · Bid/Ask [OBSERVED]: **${tick.bid}** / **${tick.ask}** (spread ${tick.spread}${ageStr})`;
      }
    } catch {
      tickLine += ` · _tick en vivo no disponible (el análisis usa el cierre real de vela)_`;
    }

    // 4. Estado de sesión (informativo: el gate de horario decide en el pipeline)
    const killzoneStr = isNYKillzone
      ? "🟢 Killzone NY activa (8-12 NY, DST-safe)"
      : `🔴/⚪ Fuera de killzone NY (${nyHour}:00 NY, ${nyWeekday})${isWeekend ? " · FIN DE SEMANA" : ""}`;

    // 5. Reporte de estructura real (generado por smc/live con números reales)
    const decisionLine = analysis.setupValid
      ? "🟢 Setup válido según detector [INFERRED — derivado de velas OBSERVED] — la decisión (EXECUTE/WAIT) la toma el pipeline con sus gates y comité, NO este reporte."
      : "🟡 Sin setup válido ahora [INFERRED — ausencia de estructura confirmada] — no hay base estructural para sugerir ejecución.";

    // Task 10-a (§6): feed rancio → bloque visible. Textos exactos que el
    // gate price_feed reconoce: "DATOS STALE" y "no disponible" → UNKNOWN.
    const staleBlock = analysis.dataStale
      ? [
          `⚠️ **DATOS STALE** — ${analysis.staleReason ?? "frescura del feed no verificable"}`,
          `⛔ Fuente de precio/estructura tratada como no disponible para decisiones: los gates del pipeline marcan price_feed UNKNOWN (fail-closed).`,
        ]
      : [];

    return [
      analysis.reportText,
      ...(staleBlock.length ? ["", ...staleBlock] : []),
      "",
      `🛡️ **Filtros de sesión**: ${killzoneStr}`,
      `💰 **Precio**: ${tickLine}`,
      `🎯 **Estado**: ${decisionLine}`,
    ].join("\n");
  }
};
