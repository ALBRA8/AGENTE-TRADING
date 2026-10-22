// ============================================================
// src/lib/bridges/mt5-bridge.ts
// ARNÉS — Bridge MT5 (stack real): envuelve MT5Bridge existente
// (src/config/mt5bridge.ts) que ya integra EXECUTION GUARD fail-closed,
// token X-AGT-Token y verificación request-vs-actual.
//
// Operaciones de LECTURA y de ÓRDENES: placeOrder pasa por el guard
// existente (ninguna orden nueva escapa al control del SOP).
// Import dinámico: el módulo lee env al cargar; el arnés no debe
// acoplar eso al bootstrap.
// ============================================================

import type { IBridge, BridgeResult, BridgeHealth } from "./types.js";
import type {
  MT5OrderRequest,
  MT5HistoryOrdersQuery,
  MT5HistoryDealsQuery,
} from "../../config/mt5bridge.js";

type Mt5Module = typeof import("../../config/mt5bridge.js");

export class Mt5Bridge implements IBridge {
  readonly type = "mt5";
  readonly name = "MetaTrader 5 Bridge (Flask local :5001)";
  private mod: Mt5Module | null = null;

  async isAvailable(): Promise<boolean> {
    try {
      if (!this.mod) this.mod = await import("../../config/mt5bridge.js");
      return await this.mod.MT5Bridge.health();
    } catch {
      this.mod = null;
      return false;
    }
  }

  async execute(operation: string, params: Record<string, unknown>): Promise<BridgeResult> {
    try {
      if (!this.mod && !(await this.isAvailable())) {
        return { success: false, error: "MT5 Bridge no alcanzable", source: this.type };
      }
      const mt5 = this.mod!.MT5Bridge;
      switch (operation) {
        case "account":
          return { success: true, data: await mt5.getAccount(), source: this.type };
        case "price":
          return { success: true, data: await mt5.getPrice(String(params.symbol ?? "")), source: this.type };
        case "candles":
          return {
            success: true,
            data: await mt5.getCandles(
              String(params.symbol ?? ""),
              String(params.timeframe ?? "M15"),
              Math.max(1, Math.min(1000, Number(params.count ?? 100)))
            ),
            source: this.type,
          };
        case "symbol-info":
          return { success: true, data: await mt5.getSymbolInfo(String(params.symbol ?? "")), source: this.type };
        case "positions":
          return { success: true, data: await mt5.getPositions(), source: this.type };
        case "pending-orders":
          return { success: true, data: await mt5.getPendingOrders(), source: this.type };
        case "history-orders":
          return { success: true, data: await mt5.getHistoryOrders((params.query ?? {}) as MT5HistoryOrdersQuery), source: this.type };
        case "history-deals":
          return { success: true, data: await mt5.getHistoryDeals((params.query ?? {}) as MT5HistoryDealsQuery), source: this.type };
        case "history-position":
          return {
            success: true,
            data: await mt5.getHistoryPosition(Number(params.ticket)),
            source: this.type,
          };
        case "place-order":
          // Pasa por EXECUTION GUARD fail-closed dentro de placeOrder (§5/§13).
          return {
            success: true,
            data: await mt5.placeOrder(
              params.order as MT5OrderRequest,
              (params.ctx as { decisionId?: number | null; approvalStatus?: string | null }) ?? {}
            ),
            source: this.type,
          };
        case "close-position":
          return {
            success: true,
            data: await mt5.closePosition(Number(params.ticket), params.volume as number | undefined),
            source: this.type,
          };
        case "modify-position":
          return {
            success: true,
            data: await mt5.modifyPosition(Number(params.ticket), params.sl as number | undefined, params.tp as number | undefined),
            source: this.type,
          };
        case "cancel-order":
          return { success: true, data: { cancelled: await mt5.cancelOrder(Number(params.ticket)) }, source: this.type };
        default:
          return { success: false, error: `Operación no soportada: ${operation}`, source: this.type };
      }
    } catch (e) {
      return { success: false, error: (e as Error).message, source: this.type };
    }
  }

  async healthCheck(): Promise<BridgeHealth> {
    const t0 = Date.now();
    const available = await this.isAvailable();
    return {
      available,
      latency: Date.now() - t0,
      details: { type: this.type, url: process.env.MT5_BRIDGE_URL ?? "http://localhost:5001" },
    };
  }
}
