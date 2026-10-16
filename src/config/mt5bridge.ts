// ============================================================
// src/config/mt5bridge.ts
// Cliente HTTP para el bridge local de MetaTrader 5
//
// Task 8-a: TODAS las llamadas llevan timeout con AbortController
// (BRIDGE_TIMEOUT_MS, default 5000) — antes un bridge colgado dejaba
// al agente colgado para siempre (hallazgo auditoría 6-b).
// Nuevo: getSymbolInfo (sizing exacto multi-broker) y getPendingOrders
// (limpieza de pendientes obsoletos del pipeline).
// PROMPT 06 §5/§13: placeOrder invoca al EXECUTION GUARD independiente
// y verifica request-vs-actual tras la respuesta del broker.
// P0 EXECUTION TRUTH:
//   - §9: X-AGT-Token se envía en TODAS las llamadas (BRIDGE_TOKEN env,
//     jamás hardcodeado, jamás impreso en logs ni errores).
//   - §7: getHistoryOrders / getHistoryDeals / getHistoryPosition para
//     reconstruir ejecuciones desde la historia real de MT5.
//   - Códigos de error clasificables (BRIDGE_HTTP_4xx/5xx,
//     BRIDGE_UNREACHABLE, BRIDGE_TIMEOUT) para que el punto de envío
//     distinga RECHAZO CLARO de RESULTADO AMBIGUO (fail-closed §12).
// ============================================================

import { assertOrderAllowed, type GuardCheck } from "../agent/execution_guard.js";

const MT5_BRIDGE_URL = process.env.MT5_BRIDGE_URL ?? "http://localhost:5001";
const BRIDGE_TIMEOUT_MS = (() => {
  const v = parseInt(process.env.BRIDGE_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : 5000;
})();

export interface MT5Tick {
  symbol: string;
  bid: number;
  ask: number;
  spread: number;
  digits: number;
  time: string;
}

export interface MT5AccountInfo {
  login: number;
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  currency: string;
  leverage: number;
  server: string;
}

export interface MT5Candle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  tickVolume: number;
  realVolume: number;
  spread: number;
}

export interface MT5OrderRequest {
  symbol: string;
  type: "BUY" | "SELL" | "BUY_LIMIT" | "SELL_LIMIT" | "BUY_STOP" | "SELL_STOP";
  volume: number;
  price?: number;
  stopLoss?: number;
  takeProfit?: number;
  comment?: string;
  /** Epoch en SEGUNDOS: expiración de órdenes pendientes (ORDER_TIME_SPECIFIED).
   *  Sin valor → GTC (compatibilidad hacia atrás con bridge viejo). */
  expiration?: number;
}

export interface MT5OrderResult {
  success: boolean;
  ticket: number;
  retcode: number;
  comment: string;
  volume: number;
  price: number;
  symbol: string;
  type: string;
}

/**
 * Info de contrato del símbolo (GET /symbol_info/<symbol> del bridge).
 * Base del sizing exacto multi-broker (tick_value/tick_size) — Task 8-a.
 * Los valores monetarios vienen en la MONEDA DE LA CUENTA.
 */
export interface MT5SymbolInfo {
  name: string;
  digits: number;
  point: number;
  /** Valor del tick por lote (en moneda de la cuenta) para un movimiento de tradeTickSize */
  tradeTickValue: number;
  /** Tamaño del tick en unidades de PRECIO */
  tradeTickSize: number;
  volumeMin: number;
  volumeMax: number;
  volumeStep: number;
  contractSize: number;
  currencyProfit: string;
  description: string;
}

export interface MT5PendingOrder {
  ticket: number;
  symbol: string;
  type: string;
  volume: number;
  price: number;
  sl: number;
  tp: number;
  comment: string;
  /** ISO 8601: momento de colocación de la orden pendiente */
  time: string;
}

export interface MT5Position {
  ticket: number;
  symbol: string;
  type: "BUY" | "SELL";
  volume: number;
  openPrice: number;
  currentPrice: number;
  sl: number;
  tp: number;
  profit: number;
  comment: string;
  openTime: string;
}

/**
 * P0 §9: token del bridge (X-AGT-Token) por entorno. NUNCA hardcodeado,
 * NUNCA impreso en logs ni incluido en mensajes de error.
 */
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN ?? "";

// ── Helper ─────────────────────────────────────────────────
/**
 * Fetch al bridge con TIMEOUT OBLIGATORIO (AbortController) y autenticación
 * X-AGT-Token en TODAS las llamadas (P0 §9: también en los nuevos endpoints
 * históricos). El token viaja solo en el header; jamás en la URL ni en logs.
 * Códigos de error clasificables:
 *   BRIDGE_TIMEOUT      → respuesta no llegó (resultado AMBIGUO si era /order)
 *   BRIDGE_UNREACHABLE  → fallo de transporte (resultado AMBIGUO si era /order)
 *   BRIDGE_HTTP_<status> → el bridge respondió; 4xx en /order = rechazo CLARO
 */
async function bridgeFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${MT5_BRIDGE_URL}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BRIDGE_TIMEOUT_MS);

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (BRIDGE_TOKEN !== "") {
    headers["X-AGT-Token"] = BRIDGE_TOKEN;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      ...options,
      headers, // P0 §9: X-AGT-Token SIEMPRE presente (env BRIDGE_TOKEN), fusionado tras options
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      const e = new Error(
        `MT5 Bridge timeout tras ${BRIDGE_TIMEOUT_MS}ms en ${path} (bridge colgado o saturado). Sube BRIDGE_TIMEOUT_MS si tu red lo justifica.`
      ) as Error & { code: string };
      e.code = "BRIDGE_TIMEOUT";
      throw e;
    }
    const e = new Error(
      `MT5 Bridge no disponible en ${MT5_BRIDGE_URL}. Asegúrate de que bridge.py esté corriendo. Error: ${(err as Error).message}`
    ) as Error & { code: string };
    e.code = "BRIDGE_UNREACHABLE";
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text();
    // P0 §36: el body del error puede contener texto del bridge — nunca
    // incluimos headers ni el token; solo status + body acotado.
    const e = new Error(
      `MT5 Bridge error ${res.status}: ${body.slice(0, 500)}`
    ) as Error & { code: string };
    e.code = `BRIDGE_HTTP_${res.status}`;
    throw e;
  }

  return res.json() as Promise<T>;
}

// ── P0 EXECUTION TRUTH: tipos de historia MT5 (§7/§8) ───────
/**
 * ORDER histórico = intención del broker. stateName canónico del bridge:
 * STARTED | PLACED | CANCELED | PARTIAL | FILLED | REJECTED | EXPIRED |
 * CALCULATED | MODIFY. positionId ≠ ticket (ORDER TICKET ≠ POSITION TICKET).
 */
export interface MT5HistoryOrder {
  ticket: number;
  time: string;
  timeEpoch: number;
  timeMsc: number;
  type: string;
  volumeInitial: number;
  volumeCurrent: number;
  priceOpen: number;
  priceCurrent: number;
  sl: number;
  tp: number;
  state: number;
  stateName: string;
  comment: string;
  positionId: number;
  magic: number;
  retcode: number;
  symbol: string;
}

/**
 * DEAL = evidencia central de ejecución (P0 §2). entryName: IN | OUT |
 * INOUT | OUT_BY. reasonName: CLIENT | MOBILE | WEB | EXPERT | SL | TP |
 * SO | ROLLOVER | VMARGIN | SPLIT.
 */
export interface MT5HistoryDeal {
  ticket: number;
  order: number;
  time: string;
  timeEpoch: number;
  timeMsc: number;
  type: string;
  entry: number;
  entryName: string;
  volume: number;
  price: number;
  profit: number;
  commission: number;
  swap: number;
  fee: number;
  symbol: string;
  comment: string;
  positionId: number;
  magic: number;
  reason: number;
  reasonName: string;
}

export interface MT5HistoryPosition {
  position_ticket: number;
  deals: MT5HistoryDeal[];
  orders: MT5HistoryOrder[];
}

export interface MT5HistoryOrdersQuery {
  /** Epoch en SEGUNDOS (desde) — default: últimos 7 días */
  fromEpoch?: number;
  /** Epoch en SEGUNDOS (hasta) — default: ahora + 60s */
  toEpoch?: number;
  ticket?: number;
  positionId?: number;
}

export interface MT5HistoryDealsQuery {
  fromEpoch?: number;
  toEpoch?: number;
  ticket?: number;
  positionId?: number;
}

// ── API Pública ─────────────────────────────────────────────
export const MT5Bridge = {
  /**
   * Verifica que el bridge y MT5 estén activos.
   */
  async health(): Promise<boolean> {
    try {
      const data = await bridgeFetch<{ status: string }>("/health");
      return data.status === "ok";
    } catch {
      return false;
    }
  },

  /**
   * Información de la cuenta: balance, equity, etc.
   */
  async getAccount(): Promise<MT5AccountInfo> {
    return bridgeFetch<MT5AccountInfo>("/account");
  },

  /**
   * Precio actual (bid/ask) de un símbolo.
   */
  async getPrice(symbol: string): Promise<MT5Tick> {
    return bridgeFetch<MT5Tick>(`/price/${encodeURIComponent(symbol)}`);
  },

  /**
   * Últimas N velas del símbolo en el timeframe dado.
   * Usadas para calcular RVOL.
   */
  async getCandles(symbol: string, timeframe: string, count: number): Promise<MT5Candle[]> {
    const data = await bridgeFetch<{ candles: MT5Candle[] }>(
      `/candles/${encodeURIComponent(symbol)}/${timeframe}/${count}`
    );
    return data.candles;
  },

  /**
   * Coloca una orden en MT5.
   *
   * PROMPT 06 §5: aquí vive el EXECUTION GUARD INDEPENDIENTE — se evalúa
   * DESPUÉS del tool y del hard-gate, en el único punto por el que pasa
   * cualquier orden real (LLM, dashboard, Telegram, MCP futuro). Un veredicto
   * negativo del guard lanza y la orden NUNCA sale del proceso.
   *
   * PROMPT 06 §13: tras la respuesta del broker se VERIFICA request-vs-actual
   * (retcode, volume, price) y se anota verification_status: 'verified' |
   * 'divergence'. Nunca se asume ejecutado por el mero HTTP 200.
   */
  async placeOrder(
    order: MT5OrderRequest,
    ctx?: { decisionId?: number | null; approvalStatus?: string | null }
  ): Promise<MT5OrderResult & { verification: "verified" | "divergence"; guardChecks: GuardCheck[] }> {
    // ── EXECUTION GUARD (fail-closed): el tick se resuelve AQUÍ, en el punto
    //    de envío, para juzgar con datos vivos y no con los de la decisión. ──
    const tick = await this.getPrice(order.symbol);
    const guard = await assertOrderAllowed(order, ctx ?? {}, tick);
    if (!guard.allowed) {
      const e = new Error(
        `🛑 EXECUTION GUARD RECHAZA LA ORDEN (${order.symbol} ${order.type} vol=${order.volume}): ${guard.reason}`
      ) as Error & { code: string; guardChecks: GuardCheck[] };
      e.code = "GUARD_REJECTED";
      e.guardChecks = guard.checks;
      throw e;
    }

    const result = await bridgeFetch<MT5OrderResult>("/order", {
      method: "POST",
      body: JSON.stringify(order),
    });

    // ── §13 VERIFY: retcode aceptado + concordancia request vs actual ──
    const ACCEPTED_RETCODES = new Set([10008, 10009]); // TRADE_RETCODE_PLACED / DONE
    const retcodeOk = ACCEPTED_RETCODES.has(Number(result.retcode));
    const priceTol = Math.max(Math.abs(Number(result.price) || 0) * 0.001, 1e-8);
    const priceOk =
      !order.price || !result.price ||
      Math.abs(Number(result.price) - Number(order.price)) <= priceTol;
    const volumeOk = !result.volume || Math.abs(Number(result.volume) - Number(order.volume)) < 1e-8;
    const verification: "verified" | "divergence" = retcodeOk && priceOk && volumeOk ? "verified" : "divergence";
    if (verification === "divergence") {
      console.warn(
        `[MT5Bridge] ⚠️ DIVERGENCIA request-vs-actual: retcode=${result.retcode} (ok=${retcodeOk}), price req=${order.price} real=${result.price} (ok=${priceOk}), volume req=${order.volume} real=${result.volume} (ok=${volumeOk})`
      );
    }
    return { ...result, verification, guardChecks: guard.checks };
  },

  /**
   * Lista posiciones abiertas.
   */
  async getPositions(): Promise<MT5Position[]> {
    const data = await bridgeFetch<{ positions: MT5Position[] }>("/positions");
    return data.positions;
  },

  /**
   * Lista las órdenes pendientes (con comment y time para poder expirarlas).
   */
  async getPendingOrders(): Promise<MT5PendingOrder[]> {
    const data = await bridgeFetch<{ orders: MT5PendingOrder[] }>("/orders");
    return data.orders;
  },

  /**
   * Cancela una orden pendiente.
   */
  async cancelOrder(ticket: number): Promise<boolean> {
    const data = await bridgeFetch<{ success: boolean }>(`/cancel/${ticket}`, {
      method: "DELETE",
    });
    return data.success;
  },

  /**
   * Información de contrato del símbolo (digits, point, tick_value,
   * volume_step, contract_size...). Base del sizing exacto multi-broker.
   * 404 del bridge (símbolo inexistente) → error; el llamador decide el
   * fallback honesto (tabla PIP_VALUE_USD o rechazo).
   */
  async getSymbolInfo(symbol: string): Promise<MT5SymbolInfo> {
    const raw = await bridgeFetch<Record<string, unknown>>(
      `/symbol_info/${encodeURIComponent(symbol)}`
    );
    return {
      name: String(raw.name ?? ""),
      digits: Number(raw.digits ?? 0),
      point: Number(raw.point ?? 0),
      tradeTickValue: Number(raw.trade_tick_value ?? 0),
      tradeTickSize: Number(raw.trade_tick_size ?? 0),
      volumeMin: Number(raw.volume_min ?? 0),
      volumeMax: Number(raw.volume_max ?? 0),
      volumeStep: Number(raw.volume_step ?? 0),
      contractSize: Number(raw.contract_size ?? 0),
      currencyProfit: String(raw.currency_profit ?? ""),
      description: String(raw.description ?? ""),
    };
  },

  // ── P0 EXECUTION TRUTH: historia MT5 (§7) ─────────

  /**
   * Historia de ÓRDENES (intención del broker). window por defecto 7 días.
   * Con ticket/positionId delega en las variantes exactas de la API real.
   */
  async getHistoryOrders(q: MT5HistoryOrdersQuery = {}): Promise<MT5HistoryOrder[]> {
    const params = new URLSearchParams();
    if (q.fromEpoch !== undefined) params.set("from", String(Math.floor(q.fromEpoch)));
    if (q.toEpoch !== undefined) params.set("to", String(Math.floor(q.toEpoch)));
    if (q.ticket !== undefined) params.set("ticket", String(q.ticket));
    if (q.positionId !== undefined) params.set("position", String(q.positionId));
    const qs = params.toString();
    const data = await bridgeFetch<{ orders: MT5HistoryOrder[] }>(
      `/history/orders${qs ? `?${qs}` : ""}`
    );
    return data.orders ?? [];
  },

  /** Historia de DEALS (evidencia central de ejecución). */
  async getHistoryDeals(q: MT5HistoryDealsQuery = {}): Promise<MT5HistoryDeal[]> {
    const params = new URLSearchParams();
    if (q.fromEpoch !== undefined) params.set("from", String(Math.floor(q.fromEpoch)));
    if (q.toEpoch !== undefined) params.set("to", String(Math.floor(q.toEpoch)));
    if (q.ticket !== undefined) params.set("ticket", String(q.ticket));
    if (q.positionId !== undefined) params.set("position", String(q.positionId));
    const qs = params.toString();
    const data = await bridgeFetch<{ deals: MT5HistoryDeal[] }>(
      `/history/deals${qs ? `?${qs}` : ""}`
    );
    return data.deals ?? [];
  },

  /**
   * Reconstrucción de UNA posición por POSITION TICKET (no por order ticket).
   * 404 del bridge → null honesto (sin evidencia, sin inventar).
   */
  async getHistoryPosition(positionTicket: number): Promise<MT5HistoryPosition | null> {
    try {
      return await bridgeFetch<MT5HistoryPosition>(
        `/history/position/${encodeURIComponent(String(positionTicket))}`
      );
    } catch (err) {
      const e = err as Error & { code?: string };
      if (e.code === "BRIDGE_HTTP_404") return null;
      throw err;
    }
  },
};
