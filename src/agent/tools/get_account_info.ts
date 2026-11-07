// ============================================================
// src/agent/tools/get_account_info.ts
// Tool: Obtiene balance e información de la cuenta en MetaTrader 5
// ============================================================

import type { Tool } from "../types.js";
import { MT5Bridge } from "../../config/mt5bridge.js";

export const getAccountInfoTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "getAccountInfo",
      description:
        "Obtiene el balance actual, equidad, margen libre y datos de la cuenta conectada en MetaTrader 5 (MT5). " +
        "Úsala SIEMPRE que el usuario pregunte por su balance, saldo, equidad o estado de cuenta.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },

  async execute(): Promise<string> {
    try {
      const acc = await MT5Bridge.getAccount();
      return JSON.stringify({
        status: "success",
        cuenta: acc.login,
        balance: acc.balance,
        equidad: acc.equity,
        margenLibre: acc.freeMargin,
        moneda: acc.currency,
        apalancamiento: `1:${acc.leverage}`,
        servidor: acc.server,
      }, null, 2);
    } catch (err) {
      return JSON.stringify({
        status: "error",
        error: `No se pudo consultar la cuenta MT5: ${(err as Error).message}`,
      });
    }
  },
};
