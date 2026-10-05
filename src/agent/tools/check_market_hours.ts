import type { Tool } from "../types.js";

/**
 * Interface for Market Hours parameters
 */
interface CheckMarketHoursArgs {
  asset: string;
}

/**
 * Identifica la sesión activa y devuelve recomendaciones basadas en el activo.
 *
 * SOP v3.2 (auditoría 6-a/6-b):
 *  - FIN DE SEMANA → RED explícito para activos con bolsa cerrada
 *    (antes dayOfWeek se calculaba y nunca se usaba).
 *  - KILLZONES por activo EN CÓDIGO (antes la regla del SOP "US30 solo NY
 *    8-12" y "GBPJPY solo Londres" existía solo en el prompt).
 *  - Hora Nueva York calculada con timezone real (America/New_York) —
 *    corrige el offset fijo EST=-5 que desplazaba killzones con DST.
 */
export const checkMarketHours: Tool = {
  definition: {
    type: "function",
    function: {
      name: "checkMarketHours",
      description: "Identifica la sesión de mercado activa y valida si es óptimo operar según el activo. Aplica killzones del SOP en código y bloquea fines de semana para activos con bolsa cerrada.",
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

    // Hora de Nueva York con timezone real (DST-safe)
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      hour12: false,
      weekday: "short",
    }).formatToParts(new Date());
    const nyHour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10) % 24;
    const nyWeekday = parts.find((p) => p.type === "weekday")?.value ?? "";
    const isWeekend = nyWeekday === "Sat" || nyWeekday === "Sun";

    // Definición de Sesiones (hora NY)
    const isLondon = nyHour >= 3 && nyHour <= 12;
    const isNY = nyHour >= 8 && nyHour <= 17;
    const isAsian = nyHour >= 19 || nyHour <= 4;

    // Killzones del SOP (en código, no solo en el prompt)
    const isNYKillzone = nyHour >= 8 && nyHour < 12; // US30: 8-12 NY
    const isLondonSession = nyHour >= 3 && nyHour < 12; // GBPJPY: solo Londres

    const symbol = asset.trim().toUpperCase();
    const isCrypto = symbol.includes("BTC") || symbol.includes("ETH") || symbol === "BITCOIN";

    let status = "";
    let recommendation = "";
    let blocked = false;

    if (isWeekend && !isCrypto) {
      blocked = true;
      status = "🔴 CIERRE DE MERCADO: FIN DE SEMANA";
      recommendation = `Bolsa cerrada (sábado/domingo en NY). ${symbol} NO se opera. Sin excepciones.`;
    } else if (symbol === "GBPJPY" || symbol === "EURJPY") {
      if (isLondonSession) {
        status = "✅ ÓPTIMO: Sesión de Londres activa (killzone del SOP).";
        recommendation = "Alta probabilidad para setups. Priorizar el análisis SMC ahora.";
      } else if (!isCrypto && isWeekend) {
        blocked = true;
        status = "🔴 CIERRE DE MERCADO: FIN DE SEMANA";
        recommendation = "Sin excepciones: no operar.";
      } else {
        blocked = true;
        status = isNY
          ? "❌ NO RECOMENDADO: sesión de NY fuera de la regla del SOP."
          : "❌ NO RECOMENDADO: Fuera de horas principales.";
        recommendation = "La regla del SOP para GBPJPY es SOLO Londres (3-12 NY). Sin overlap = sin trade.";
      }
    } else if (symbol === "US30" || symbol === "NAS100" || symbol === "SPX500") {
      if (isWeekend && !isCrypto) {
        blocked = true;
        status = "🔴 CIERRE DE MERCADO: FIN DE SEMANA";
      } else if (isNYKillzone) {
        status = "✅ ÓPTIMO: Killzone NY activa (8-12 NY).";
        recommendation = "Ventana principal del SOP. Exigir RVOL ≥ 1.5x para validar BOS.";
      } else if (isNY) {
        status = "⚠️ PRECAUCIÓN: NY abierta pero FUERA de la killzone (8-12).";
        recommendation = "Reducir riesgo o esperar la killzone del día siguiente. Setups de menor calidad.";
      } else {
        blocked = true;
        status = "❌ NO RECOMENDADO: fuera de la killzone NY del SOP.";
        recommendation = "El SOP de índices US opera en killzone NY (8-12 NY). Esperar ventana.";
      }
    } else if (isCrypto) {
      status = "🌐 Crypto opera 24/7.";
      if (isLondon || isNY) {
        recommendation = "Bolsas principales abiertas (Londres/NY). Mayor liquidez y volumen real. Proceder con análisis estándar.";
      } else if (isWeekend) {
        recommendation = "Fin de semana (bolsas cerradas). Exigir RIGOR EXTREMO (FVG H1 obligatorio + doble confirmación) para evitar fakeouts de baja liquidez.";
      } else {
        recommendation = "Fuera de bolsas principales. Exigir RIGOR EXTREMO (Confirmación H1 obligatoria) para evitar 'fakeouts' de baja liquidez.";
      }
    } else if (symbol.includes("XAU")) {
      if (isWeekend) {
        blocked = true;
        status = "🔴 CIERRE DE MERCADO: FIN DE SEMANA";
        recommendation = "Oro no se opera fin de semana. Sin excepciones.";
      } else {
        status = `Sesiones activas: ${[isLondon && "Londres", isNY && "NY", isAsian && "Asia"].filter(Boolean).join(", ") || "Cierre intermedio"}`;
        recommendation = "Oro: killzones de Londres y NY. Exigir correlación con DXY verificada.";
      }
    } else {
      status = `Sesiones activas: ${[isLondon && "Londres", isNY && "NY", isAsian && "Asia"].filter(Boolean).join(", ") || "Cierre de Mercado / Baja Liquidez"}`;
      recommendation = "Seguir protocolo estándar de Killzones.";
    }

    const sessionsStr = [isLondon && "Londres", isNY && "Nueva York", isAsian && "Asia/Australia"]
      .filter(Boolean)
      .join(", ") || "Cierre de Mercado / Baja Liquidez";

    return `
### Horario de Mercado
- **Hora NY:** ${nyHour}:00 (${nyWeekday})${isWeekend ? " · FIN DE SEMANA" : ""}
- **Sesiones Detectadas:** ${sessionsStr}
- **Estado para ${asset}:** ${status}
- **Recomendación:** ${recommendation}
- **Gate de código:** ${blocked ? "🔴 RED — pipeline debe ABORTAR" : "🟢/🟡 sesión evaluable"}
    `.trim();
  }
};
