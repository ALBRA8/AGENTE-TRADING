// ============================================================
// src/config/mt5bridge.ts
// Cliente HTTP para el bridge local de MetaTrader 5
//
// Task 8-a: TODAS las llamadas llevan timeout con AbortController
// (BRIDGE_TIMEOUT_MS, default 5000) — antes un bridge colgado dejaba
// al agente colgado para siempre (hallazgo auditoría 6-b).
// Nuevo: getSymbolInfo (sizing exacto multi-broker) y getPendingOrders
// (limpieza de pendientes obsoletos del pipeline).
// ============================================================

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

// ── Helper ─────────────────────────────────────────────────
/**
 * Fetch al bridge con TIMEOUT OBLIGATORIO (AbortController).
 * Sin esto, un bridge colgado (socket abierto sin respuesta) bloqueaba
 * al agente indefinidamente. Timeout por env BRIDGE_TIMEOUT_MS (5000 default).
 */
async function bridgeFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${MT5_BRIDGE_URL}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BRIDGE_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "Content-Type": "application/json" },
      ...options,
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(
        `MT5 Bridge timeout tras ${BRIDGE_TIMEOUT_MS}ms en ${path} (bridge colgado o saturado). Sube BRIDGE_TIMEOUT_MS si tu red lo justifica.`
      );
    }
    throw new Error(
      `MT5 Bridge no disponible en ${MT5_BRIDGE_URL}. Asegúrate de que bridge.py esté corriendo. Error: ${(err as Error).message}`
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`MT5 Bridge error ${res.status}: ${body}`);
  }

  return res.json() as Promise<T>;
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
   */
  async placeOrder(order: MT5OrderRequest): Promise<MT5OrderResult> {
    return bridgeFetch<MT5OrderResult>("/order", {
      method: "POST",
      body: JSON.stringify(order),
    });
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
};
