import type { Tool } from "../types.js";

/**
 * Interface for Market Hours parameters
 */
interface CheckMarketHoursArgs {
  asset: string;
}

/**
 * Veredicto estructurado de horarios. Función PURA con `now` inyectable
 * (Task 10-a): el tool solo formatea; la lógica es testeable con fechas
 * fijas sin depender del reloj del sandbox.
 */
export interface MarketHoursVerdict {
  symbol: string;
  nyHour: number;
  nyWeekday: string;
  isWeekend: boolean;
  isLondon: boolean;
  isNY: boolean;
  isAsian: boolean;
  isLondonSession: boolean;
  isNYKillzone: boolean;
  status: string;
  recommendation: string;
  /** RED: bloqueado (fin de semana / fuera de killzone del SOP) */
  blocked: boolean;
  /** UNKNOWN: símbolo sin política de horarios → no evaluable (hallazgo 9-c P2) */
  unknown: boolean;
}

/**
 * Identifica la sesión activa y evalúa el activo contra las killzones del SOP.
 *
 * SOP v3.2 (auditorías 6-a/6-b + hallazgos 9-b/9-c/Task 10-a):
 *  - FIN DE SEMANA → RED explícito para activos con bolsa cerrada.
 *  - KILLZONES por activo EN CÓDIGO (antes solo vivían en el prompt):
 *      · US30/NAS100/SPX500 → killzone NY 8-12 (hora NY).
 *      · GBPJPY/EURJPY      → solo sesión de Londres 3-12 (hora NY).
 *      · XAUUSD             → Londres + NY (3-12 NY; instrucciones.txt §2.B:
 *        "XAU se opera en Londres y NY") — antes quedaba GREEN 24/5.
 *  - Hora Nueva York calculada con timezone real (America/New_York) —
 *    DST-safe, sin offset fijo EST=-5.
 *  - Símbolo SIN política de horarios → UNKNOWN honesto (antes caía en un
 *    else genérico GREEN → fail-open de horario, hallazgo 9-c P2).
 */
export function evaluateMarketHours(
  rawSymbol: string,
  now: Date = new Date()
): MarketHoursVerdict {
  // Hora de Nueva York con timezone real (DST-safe)
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    hour12: false,
    weekday: "short",
  }).formatToParts(now);
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

  const symbol = rawSymbol.trim().toUpperCase();
  const isCrypto = symbol.includes("BTC") || symbol.includes("ETH") || symbol === "BITCOIN";

  const base = {
    symbol,
    nyHour,
    nyWeekday,
    isWeekend,
    isLondon,
    isNY,
    isAsian,
    isLondonSession,
    isNYKillzone,
  };

  let status = "";
  let recommendation = "";
  let blocked = false;
  let unknown = false;

  if (isWeekend && !isCrypto) {
    blocked = true;
    status = "🔴 CIERRE DE MERCADO: FIN DE SEMANA";
    recommendation = `Bolsa cerrada (sábado/domingo en NY). ${symbol} NO se opera. Sin excepciones.`;
  } else if (symbol === "GBPJPY" || symbol === "EURJPY") {
    if (isLondonSession) {
      status = "✅ ÓPTIMO: Sesión de Londres activa (killzone del SOP).";
      recommendation = "Alta probabilidad para setups. Priorizar el análisis SMC ahora.";
    } else {
      blocked = true;
      status = isNY
        ? "❌ NO RECOMENDADO: sesión de NY fuera de la regla del SOP."
        : "❌ NO RECOMENDADO: Fuera de horas principales.";
      recommendation = "La regla del SOP para GBPJPY es SOLO Londres (3-12 NY). Sin overlap = sin trade.";
    }
  } else if (symbol === "US30" || symbol === "NAS100" || symbol === "SPX500") {
    if (isNYKillzone) {
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
    // Killzone del SOP para oro (hallazgo 9-c, caso 5): XAUUSD se opera en
    // Londres y NY (instrucciones.txt §2.B). Londres 3-12 NY ya cubre el
    // overlap con la killzone NY 8-12 — antes el oro quedaba GREEN 24/5.
    if (isWeekend) {
      blocked = true;
      status = "🔴 CIERRE DE MERCADO: FIN DE SEMANA";
      recommendation = "Oro no se opera fin de semana. Sin excepciones.";
    } else if (isLondonSession) {
      const kz = isNYKillzone ? "Londres + NY (overlap 8-12)" : "Londres (3-12 NY)";
      status = `✅ ÓPTIMO: Killzone de ${kz} activa para XAUUSD.`;
      recommendation = "El SOP opera oro en Londres y NY: alta probabilidad para setups. Exigir correlación con DXY verificada.";
    } else if (isNY) {
      status = "⚠️ PRECAUCIÓN: NY abierta pero FUERA de las killzones del SOP para oro (Londres 3-12 NY / NY 8-12 NY).";
      recommendation = "Setups de menor calidad: reducir riesgo o esperar la killzone.";
    } else {
      blocked = true;
      status = "❌ NO RECOMENDADO: fuera de las killzones del SOP para XAUUSD (Londres + NY).";
      recommendation = "El SOP opera XAUUSD solo en Londres (3-12 NY) y NY (8-12 NY). Esperar ventana.";
    }
  } else {
    // Hallazgo 9-c P2 (fail-open): un símbolo no listado (typo/nuevo) caía
    // aquí y el gate lo leía como "Sesión operable" GREEN sin política real.
    // Hoy: UNKNOWN honesto — sin política de horarios NO hay evaluación.
    // Nota: el texto incluye "no disponible" (minúsculas) porque el gate
    // market_hours del pipeline mapea ese marcador a UNKNOWN (fail-closed).
    unknown = true;
    status = "⚪ UNKNOWN — Símbolo sin política de horarios → no evaluable";
    recommendation =
      "Sin killzones definidas para este símbolo: la evaluación de sesión no disponible (fail-closed). " +
      "El pipeline debe tratar market_hours como UNKNOWN y bloquear EXECUTE hasta definir su política.";
  }

  return { ...base, status, recommendation, blocked, unknown };
}

/**
 * Identifica la sesión activa y devuelve recomendaciones basadas en el activo.
 * (Task 10-a: la lógica vive en evaluateMarketHours, pura e inyectable;
 * este tool solo la formatea para el LLM.)
 */
export const checkMarketHours: Tool = {
  definition: {
    type: "function",
    function: {
      name: "checkMarketHours",
      description: "Identifica la sesión de mercado activa y valida si es óptimo operar según el activo. Aplica killzones del SOP en código (US30: NY 8-12; GBPJPY: Londres; XAUUSD: Londres+NY) y bloquea fines de semana. Símbolos sin política de horarios devuelven UNKNOWN, no un veredicto inventado.",
      parameters: {
        type: "object",
        properties: {
          asset: {
            type: "string",
            description: "El activo a validar (BTCUSD, GBPJPY, US30, XAUUSD, etc.)"
          }
        },
        required: ["asset"]
      }
    }
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const { asset } = args as unknown as CheckMarketHoursArgs;
    const v = evaluateMarketHours(asset, new Date());

    // UNKNOWN honesto (hallazgo 9-c P2): sin política de horarios no hay
    // sesión evaluable. Sin strings RED ni "FIN DE SEMANA" aquí: el gate
    // debe caer en UNKNOWN (el texto lleva el marcador "no disponible").
    if (v.unknown) {
      return `
### Horario de Mercado
- **Hora NY:** ${v.nyHour}:00 (${v.nyWeekday})
- **Estado para ${asset}:** ${v.status}
- **Recomendación:** ${v.recommendation}
- **Gate de código:** ⚪ UNKNOWN — sin política de horarios el pipeline NO puede confirmar sesión operable (fail-closed)
      `.trim();
    }

    const sessionsStr = [v.isLondon && "Londres", v.isNY && "Nueva York", v.isAsian && "Asia/Australia"]
      .filter(Boolean)
      .join(", ") || "Cierre de Mercado / Baja Liquidez";

    const gateLine = v.blocked
      ? "🔴 RED — pipeline debe ABORTAR"
      : "🟢/🟡 sesión evaluable";

    return `
### Horario de Mercado
- **Hora NY:** ${v.nyHour}:00 (${v.nyWeekday})${v.isWeekend ? " · FIN DE SEMANA" : ""}
- **Sesiones Detectadas:** ${sessionsStr}
- **Estado para ${asset}:** ${v.status}
- **Recomendación:** ${v.recommendation}
- **Gate de código:** ${gateLine}
    `.trim();
  }
};
