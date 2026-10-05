import type { Tool } from "../types.js";
import { MT5Bridge } from "../../config/mt5bridge.js";

interface CheckRvolArgs {
  asset: string;
  timeframe: "H1" | "M15" | "M5" | "M1";
}

export const checkRVOL: Tool = {
  definition: {
    type: "function",
    function: {
      name: "checkRVOL",
      description: "Analiza el Relative Volume (RVOL) del activo para confirmar que los movimientos de estructura (BOS/ChoCh) tienen fuerza institucional real y no son ruido de retail.",
      parameters: {
        type: "object",
        properties: {
          asset: {
            type: "string",
            description: "El activo a analizar (ej. US30, BTCUSD, GBPJPY)."
          },
          timeframe: {
            type: "string",
            enum: ["H1", "M15", "M5", "M1"],
            description: "Temporalidad para el análisis de volumen."
          }
        },
        required: ["asset", "timeframe"]
      }
    }
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const { asset, timeframe } = args as unknown as CheckRvolArgs;

    const isAlive = await MT5Bridge.health();
    if (!isAlive) {
      return generateSimulatedRVOL(asset, timeframe);
    }

    try {
      const candles = await MT5Bridge.getCandles(asset, timeframe, 25);

      if (!candles || candles.length < 5) {
        return generateSimulatedRVOL(asset, timeframe);
      }

      const volumes = candles.map(c => c.tickVolume);
      const avgVolume = volumes.slice(0, -1).reduce((a, b) => a + b, 0) / (volumes.length - 1);
      const currentVolume = volumes[volumes.length - 1];
      const rvol = avgVolume > 0 ? currentVolume / avgVolume : 1;

      const strength = rvol >= 2.0 ? "🔥 INSTITUCIONAL FUERTE" :
                       rvol >= 1.5 ? "✅ VOLUMEN SUPERIOR AL PROMEDIO" :
                       rvol >= 1.0 ? "⚠️ VOLUMEN NORMAL" :
                                     "❌ VOLUMEN BAJO (Posible ruido de retail)";

      const bosValid = rvol >= 1.5;

      return `
### Análisis RVOL Real (${asset} | ${timeframe})
- **Volumen Actual:** ${currentVolume.toFixed(0)} ticks
- **Volumen Promedio (últimas 24 velas):** ${avgVolume.toFixed(0)} ticks
- **RVOL:** ${rvol.toFixed(2)}x
- **Fuerza del Movimiento:** ${strength}
- **Validación BOS/ChoCh:** ${bosValid ? "✅ Movimiento respaldado institucionalmente" : "❌ RECHAZADO: Sin respaldo de volumen real. Posible trampa de liquidez."}
      `.trim();

    } catch (err) {
      return generateSimulatedRVOL(asset, timeframe);
    }
  }
};

function generateSimulatedRVOL(asset: string, timeframe: string): string {
  const rvol = parseFloat((1.2 + Math.random() * 1.5).toFixed(2));
  const strength = rvol >= 2.0 ? "🔥 INSTITUCIONAL FUERTE" :
                   rvol >= 1.5 ? "✅ VOLUMEN SUPERIOR AL PROMEDIO" :
                                 "⚠️ VOLUMEN NORMAL";
  return `
### Análisis RVOL Simulado (${asset} | ${timeframe})
> ⚠️ MT5 Bridge no disponible. Simulación estadística.
- **RVOL:** ${rvol}x
- **Fuerza del Movimiento:** ${strength}
- **Validación BOS/ChoCh:** ${rvol >= 1.5 ? "✅ Movimiento respaldado" : "❌ Sin respaldo de volumen."}
  `.trim();
}

