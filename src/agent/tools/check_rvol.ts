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

    // HONESTIDAD DE DATOS (SOP v3.2): en la ruta de decisión está PROHIBIDO
    // simular. Dato no disponible = UNKNOWN, y el pipeline bloquea EXECUTE.
    const unavailable = (reason: string) => `
### Análisis RVOL NO DISPONIBLE (${asset} | ${timeframe})
**Estado: UNKNOWN** — ${reason}
- **Validación BOS/ChoCh:** ⛔ NO VERIFICADA — trata como sin respaldo de volumen.
- **Regla del SOP:** sin RVOL real no hay confirmación institucional → el pipeline NO debe ejecutar (EXECUTE bloqueado).
  `.trim();

    const isAlive = await MT5Bridge.health();
    if (!isAlive) {
      return unavailable("MT5 Bridge no disponible (bridge.py apagado). No se simulan datos.");
    }

    try {
      const candles = await MT5Bridge.getCandles(asset, timeframe, 25);

      if (!candles || candles.length < 5) {
        return unavailable(`Datos insuficientes del bridge (${candles?.length ?? 0} velas < 5).`);
      }

      const volumes = candles.map(c => c.tickVolume);
      const avgVolume = volumes.slice(0, -1).reduce((a, b) => a + b, 0) / (volumes.length - 1);
      const currentVolume = volumes[volumes.length - 1];
      const rvol = avgVolume > 0 ? currentVolume / avgVolume : 1;

      // Aviso honesto: la vela en curso está incompleta → RVOL crece con el tiempo
      const rvolNote = rvol < 0.5
        ? "\n- ⚠️ RVOL muy bajo: la vela en curso está recién abierta (incompleta); re-evalúa cuando acumule tiempo."
        : "";

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
- **Validación BOS/ChoCh:** ${bosValid ? "✅ Movimiento respaldado institucionalmente" : "❌ RECHAZADO: Sin respaldo de volumen real. Posible trampa de liquidez."}${rvolNote}
      `.trim();

    } catch (err) {
      return unavailable(`Error del bridge: ${(err as Error).message}`);
    }
  }
};

