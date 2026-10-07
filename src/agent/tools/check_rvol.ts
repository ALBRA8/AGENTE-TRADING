import type { Tool } from "../types.js";
import { MT5Bridge, type MT5Candle } from "../../config/mt5bridge.js";

interface CheckRvolArgs {
  asset: string;
  timeframe: "H1" | "M15" | "M5" | "M1";
}

/** Mapa TF → minutos (idéntico a src/smc/live.ts; duplicado a propósito
 *  para no acoplar módulos pequeños). Base del umbral de frescura 3×TF. */
const TF_MINUTES: Record<string, number> = { M1: 1, M5: 5, M15: 15, H1: 60 };

/** Resultado del cálculo PURO de RVOL (§6: nunca fabricar números) */
export interface RvolComputation {
  status: "OK" | "UNKNOWN";
  reason?: string;
  rvol?: number;
  avgVolume?: number;
  currentVolume?: number;
}

/**
 * Cálculo PURO de RVOL (exportado para tests — Task 10-a).
 *
 * Hallazgo 9-b P1: antes la línea `rvol = avgVolume > 0 ? ... : 1`
 * FABRICABA un RVOL de 1.00x cuando no había volumen promedio, y un
 * tickVolume NaN comparaba false contra todos los umbrales → caía a
 * "RECHAZADO" (YELLOW falso) en vez de UNKNOWN. Ambos pozos violan §6.
 *
 * Regla §6: sin volumen real medible NO HAY RVOL → UNKNOWN honesto
 * ("Volumen insuficiente para calcular RVOL"), jamás un número inventado.
 */
export function computeRvol(candles: { tickVolume: number }[]): RvolComputation {
  if (!candles || candles.length < 5) {
    return {
      status: "UNKNOWN",
      reason: `Datos insuficientes para RVOL (${candles?.length ?? 0} velas < 5)`,
    };
  }

  const volumes = candles.map((c) => Number(c?.tickVolume));

  // tickVolume no finito (NaN/undefined) → no hay dato → UNKNOWN, no YELLOW falso
  if (volumes.some((v) => !Number.isFinite(v))) {
    return {
      status: "UNKNOWN",
      reason: "Volumen insuficiente para calcular RVOL: hay velas con tickVolume no finito",
    };
  }

  const currentVolume = volumes[volumes.length - 1];
  const prevVolumes = volumes.slice(0, -1);
  const avgVolume = prevVolumes.reduce((a, b) => a + b, 0) / prevVolumes.length;

  // FIX 9-b P1: aquí vivía el `: 1` que fabricaba RVOL 1.00x.
  // avgVolume <= 0 o no finito → UNKNOWN honesto.
  if (!Number.isFinite(avgVolume) || avgVolume <= 0) {
    return {
      status: "UNKNOWN",
      reason: "Volumen insuficiente para calcular RVOL (promedio de velas previas = 0 o no finito)",
    };
  }

  return {
    status: "OK",
    rvol: currentVolume / avgVolume,
    avgVolume,
    currentVolume,
  };
}

export const checkRVOL: Tool = {
  definition: {
    type: "function",
    function: {
      name: "checkRVOL",
      description: "Analiza el Relative Volume (RVOL) del activo para confirmar que los movimientos de estructura (BOS/ChoCh) tienen fuerza institucional real y no son ruido de retail. Sin datos de volumen reales devuelve UNKNOWN (nunca valores inventados).",
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

    let candles: MT5Candle[];
    try {
      candles = await MT5Bridge.getCandles(asset, timeframe, 25);
    } catch (err) {
      return unavailable(`Error del bridge: ${(err as Error).message}`);
    }

    if (!candles || candles.length < 5) {
      return unavailable(`Datos insuficientes del bridge (${candles?.length ?? 0} velas < 5).`);
    }

    // Frescura (hallazgo 9-b P2): 25 velas de un feed muerto NO sirven para
    // validar volumen. (now − última vela) > 3×TF → UNKNOWN "datos rancios".
    const tfMinutes = TF_MINUTES[timeframe] ?? 0;
    if (tfMinutes > 0 && candles.length > 0) {
      const lastMs = new Date(candles[candles.length - 1]?.time ?? "").getTime();
      if (Number.isFinite(lastMs)) {
        const ageMin = (Date.now() - lastMs) / 60_000;
        if (ageMin > tfMinutes * 3) {
          return unavailable(
            `Datos rancios: última vela de hace ${Math.round(ageMin)} min (TF ${timeframe}); mercado cerrado o feed muerto. No se calcula RVOL sobre un feed muerto.`
          );
        }
      }
    }

    // Cálculo puro: cualquier volumen no medible → UNKNOWN (nunca RVOL inventado)
    const comp = computeRvol(candles);
    if (
      comp.status !== "OK" ||
      comp.rvol === undefined ||
      !Number.isFinite(comp.rvol) ||
      comp.avgVolume === undefined ||
      comp.currentVolume === undefined
    ) {
      return unavailable(comp.reason ?? "Volumen insuficiente para calcular RVOL");
    }

    const rvol = comp.rvol;
    const avgVolume = comp.avgVolume;
    const currentVolume = comp.currentVolume;

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
- **Volumen Actual:** ${currentVolume.toFixed(0)} ticks (vela en curso, parcial)
- **Volumen Promedio (últimas ${Math.max(1, candles.length - 1)} velas cerradas):** ${avgVolume.toFixed(0)} ticks
- **RVOL:** ${rvol.toFixed(2)}x
- **Fuerza del Movimiento:** ${strength}
- **Validación BOS/ChoCh:** ${bosValid ? "✅ Movimiento respaldado institucionalmente" : "❌ RECHAZADO: Sin respaldo de volumen real. Posible trampa de liquidez."}${rvolNote}
      `.trim();
  }
};
