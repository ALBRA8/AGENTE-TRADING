// ============================================================
// src/config/asset_risk_table.ts
// TABLA ÚNICA DE SL POR ACTIVO (Task 11-a — manual operativo).
// Antes los SL por activo vivían duplicados (tabla DEFAULT_SL_PIPS
// del executor + instrucción en el prompt del planner); esta tabla
// es la fuente única que el manual exige por activo:
//   US30: 80 puntos · NAS100: 20 pips · XAUUSD: 12 puntos ·
//   GBPJPY: 20 pips (JPY, pip = 0.01) · BTCUSD: 500 USD
//
// Matching por SUBCADENA case-insensitive para resolver las variantes
// de nomenclatura de los brokers (ej. 'US30Cash', 'XAUUSD.a', 'GOLD',
// 'BTCUSD.m' → mismo activo). Desconocido → null (fail-closed: el
// llamador decide, nunca se inventa un SL).
// ============================================================

/** Unidad del SL según el activo (documental: para reportes honestos) */
export type SlUnit = "puntos" | "pips" | "USD";

export interface AssetSlEntry {
  /** Distancia de SL del manual para este activo (en su unidad) */
  sl: number;
  unit: SlUnit;
  /** Alias/nombres de broker que resuelven a este activo (matching por subcadena, ya en mayúsculas) */
  aliases: string[];
}

/** Mapa tipado: clave = activo canónico de la tabla del manual */
export const ASSET_SL_TABLE: Record<string, AssetSlEntry> = {
  US30: {
    sl: 80,
    unit: "puntos",
    aliases: ["US30", "DJ30", "DJIA", "WALLSTREET30", "USINDEX30"],
  },
  NAS100: {
    sl: 20,
    unit: "pips",
    aliases: ["NAS100", "USTEC", "NDX", "NASDAQ"],
  },
  XAUUSD: {
    sl: 12,
    unit: "puntos",
    aliases: ["XAUUSD", "GOLD", "XAU"],
  },
  GBPJPY: {
    sl: 20,
    unit: "pips", // par JPY: pip = 0.01 (tercer decimal)
    aliases: ["GBPJPY", "GBP/JPY"],
  },
  BTCUSD: {
    sl: 500,
    unit: "USD",
    aliases: ["BTCUSD", "BTC", "BITCOIN"],
  },
};

/**
 * Resuelve el SL del manual para un símbolo cualquiera del broker.
 * Matching por subcadena case-insensitive: el símbolo normalizado
 * contiene la clave del activo o uno de sus alias ('US30Cash' →
 * 'US30', 'XAUUSD.a' → 'XAUUSD', 'GOLD' → alias 'GOLD', 'BTCUSD.m' →
 * 'BTCUSD'). Sin coincidencia → null (el llamador NO debe adivinar).
 */
export function getSlForSymbol(symbol: string): number | null {
  const s = String(symbol ?? "").trim().toUpperCase();
  if (!s) return null;
  for (const [asset, entry] of Object.entries(ASSET_SL_TABLE)) {
    const candidates = [asset, ...entry.aliases];
    if (candidates.some((c) => s.includes(c))) return entry.sl;
  }
  return null;
}
