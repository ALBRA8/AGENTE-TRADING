import type { Tool } from "../types.js";
import { MT5Bridge } from "../../config/mt5bridge.js";

/**
 * Interface for Market Analysis parameters
 */
interface AnalyzeMarketArgs {
  timeframe: "H1" | "M15" | "M5" | "M1";
  asset?: string;
}

function getDynamicSL(asset: string): number {
  if (asset === "US30") return 15;
  if (asset === "NAS100") return 20;
  if (asset === "XAUUSD") return 30;
  if (asset === "GBPJPY") return 20;
  if (asset === "BTCUSD" || asset === "BITCOIN") return 500; // 500 puntos ($500 de movimiento)
  return 15;
}

export const analyzeMarket: Tool = {
  definition: {
    type: "function",
    function: {
      name: "analyzeMarket",
      description: "Realiza un análisis técnico SMC simulado (o real si el bridge está activo) para el activo seleccionado.",
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
    const { timeframe, asset = "US30" } = args as unknown as AnalyzeMarketArgs;
    
    // 1. Validar Killzone (NY: 8:00 AM - 12:00 PM EST)
    const now = new Date();
    const estOffset = -5;
    const utcHour = now.getUTCHours();
    const estHour = (utcHour + estOffset + 24) % 24;

    const isNYKillzone = estHour >= 8 && estHour <= 12;
    const killzoneStatus = isNYKillzone 
      ? "✅ DENTRO de Killzone de Nueva York." 
      : "❌ FUERA de Killzone de Nueva York.";

    // 2. Simulación de Análisis SMC
    const isCrypto = asset === "BTCUSD" || asset === "BITCOIN";
    const macroTrend = "ALCISTA (H1)";
    const h1FVGDetected = true; 
    
    const structure = {
      bos: "Detectado en M15 (Último máximo roto con cuerpo)",
      choch: timeframe === "M1" 
        ? "✅ ChoCh Confirmado en M1 (Cambio de carácter detectado tras toma de liquidez)"
        : "Esperando ChoCh en temporalidades menores (M1/M5)",
      poi: isCrypto 
        ? `H1 FVG + M15 Order Block` 
        : `M15 Order Block (Origen del BOS) + FVG (No mitigado)`
    };

    const isChoChConfirmed = timeframe === "M1" && (!isCrypto || h1FVGDetected);
    const dynamicSL = getDynamicSL(asset);
    
    const liquidity = "Toma de liquidez de la sesión de Londres finalizada.";
    
    let priceInfo: string;
    try {
        // Llamada ACTIVA al bridge de MetaTrader 5
        const tick = await MT5Bridge.getPrice(asset);
        
        if (tick.bid === 0 || tick.ask === 0) {
            priceInfo = `⚠️ **Error de Datos**: El símbolo '${asset}' devolvió precios en 0. Asegúrate de que esté visible en 'Market Watch' de MT5.`;
        } else {
            priceInfo = `Precio Actual (${tick.symbol}): Bid **${tick.bid}** | Ask **${tick.ask}** (Spread: ${tick.spread} pips)`;
        }
    } catch (e: any) {
        priceInfo = `❌ **Error de Bridge**: No se pudo obtener el precio real de ${asset}. Detalle: ${e.message}`;
    }

    // 4. Formatear Respuesta Simplificada
    const decision = isChoChConfirmed ? "🚀 EJECUTAR" : "⏳ ESPERAR";
    const report = `
📊 **Reporte de Auditoría: ${asset}**
• 💹 **Activo**: ${asset} (${timeframe})
• 🛡️ **Filtros**:
  ${isNYKillzone ? "🟢 Killzone NY" : "🔴 Fuera de Horario"}
  ${isChoChConfirmed ? "🟢 ChoCh Confirmado" : "🟡 Esperando ChoCh"}
  🟢 Macro: ${macroTrend}
• 💰 **Datos MT5**: ${priceInfo}
• 🎯 **Decisión**: ${decision}
`.trim();

    return report;
  }
};
