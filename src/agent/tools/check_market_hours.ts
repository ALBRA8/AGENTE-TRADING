import type { Tool } from "../types.js";

/**
 * Interface for Market Hours parameters
 */
interface CheckMarketHoursArgs {
  asset: string;
}

/**
 * Identifica la sesión activa y devuelve recomendaciones basadas en el activo
 */
export const checkMarketHours: Tool = {
  definition: {
    type: "function",
    function: {
      name: "checkMarketHours",
      description: "Identifica la sesión de mercado activa y valida si es óptimo operar según el activo.",
      parameters: {
        type: "object",
        properties: {
          asset: {
            type: "string",
            description: "El activo a validar (BTCUSD, GBPJPY, US30, etc.)"
          }
        },
        required: ["asset"]
      }
    }
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const { asset } = args as unknown as CheckMarketHoursArgs;
    
    const now = new Date();
    const estOffset = -5;
    const utcHour = now.getUTCHours();
    const estHour = (utcHour + estOffset + 24) % 24;
    const dayOfWeek = now.getUTCDay(); // 0 = Domingo, 6 = Sábado

    // Definición de Sedes (EST)
    const isLondon = estHour >= 3 && estHour <= 12;
    const isNY = estHour >= 8 && estHour <= 17;
    const isAsian = estHour >= 19 || estHour <= 4;

    let status = "";
    let recommendation = "";
    let activeSessions = [];

    if (isLondon) activeSessions.push("Londres");
    if (isNY) activeSessions.push("Nueva York");
    if (isAsian) activeSessions.push("Asia/Australia");

    const sessionsStr = activeSessions.length > 0 ? activeSessions.join(", ") : "Cierre de Mercado / Baja Liquidez";

    if (asset === "GBPJPY") {
      if (isLondon) {
        status = "✅ ÓPTIMO: Sesión de Londres activa.";
        recommendation = "Alta probabilidad para setups de GBPJPY. Priorizar el análisis SMC ahora.";
      } else if (isNY) {
        status = "⚠️ PRECAUCIÓN: Sesión de NY activa (Overlap).";
        recommendation = "GBPJPY suele moverse bien en el overlap, pero la prioridad es Londres.";
      } else {
        status = "❌ NO RECOMENDADO: Fuera de horas principales.";
        recommendation = "Esperar a la apertura de Londres para mejores configuraciones.";
      }
    } else if (asset.includes("BTC") || asset === "BITCOIN") {
      status = "🌐 BTC opera 24/7.";
      if (isLondon || isNY) {
        recommendation = "Bolsas principales abiertas (Londres/NY). Mayor liquidez y volumen real. Proceder con análisis estándar.";
      } else {
        recommendation = "Fuera de bolsas principales (Fin de semana o noche). Exigir RIGOR EXTREMO (Confirmación H1 obligatoria) para evitar 'fakeouts' de baja liquidez.";
      }
    } else {
      status = `Sesiones activas: ${sessionsStr}`;
      recommendation = "Seguir protocolo estándar de Killzones.";
    }

    return `
### Horario de Mercado
- **Hora EST:** ${estHour}:00
- **Sesiones Detectadas:** ${sessionsStr}
- **Estado para ${asset}:** ${status}
- **Recomendación:** ${recommendation}
    `.trim();
  }
};
