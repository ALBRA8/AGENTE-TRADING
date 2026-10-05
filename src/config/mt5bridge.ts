// ============================================================
// src/config/mt5bridge.ts
// Cliente HTTP para el bridge local de MetaTrader 5
// ============================================================

const MT5_BRIDGE_URL = process.env.MT5_BRIDGE_URL ?? "http://localhost:5001";

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
async function bridgeFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${MT5_BRIDGE_URL}${path}`;
  
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
  } catch (err) {
    throw new Error(
      `MT5 Bridge no disponible en ${MT5_BRIDGE_URL}. Asegúrate de que bridge.py esté corriendo. Error: ${(err as Error).message}`
    );
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
   * Cancela una orden pendiente.
   */
  async cancelOrder(ticket: number): Promise<boolean> {
    const data = await bridgeFetch<{ success: boolean }>(`/cancel/${ticket}`, {
      method: "DELETE",
    });
    return data.success;
  },
};
