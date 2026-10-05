import type { Tool } from "../types.js";
import { MT5Bridge } from "../../config/mt5bridge.js";

/**
 * Herramienta de ejecución de órdenes via MT5 local (sin MetaApi)
 * Mantiene el SOP v2: solo ejecuta si ChoCh + RVOL + horario confirmados
 */
interface ExecuteTradeArgs {
  symbol: string;
  direction: "BUY" | "SELL";
  stopLossPips: number;
  riskPercentage?: number;
  comment?: string;
}

export const executeTradeMT5: Tool = {
  definition: {
    type: "function",
    function: {
      name: "executeTradeMT5",
      description: "Ejecuta una orden Limit en MetaTrader 5 local via bridge. Calcula el lotaje automáticamente según el balance y el riesgo. SOLO usar cuando ChoCh M1 está confirmado, RVOL >= 1.5x y checkMarketHours aprueba la sesión.",
      parameters: {
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description: "Símbolo tal como aparece en MT5 (ej. US30, BTCUSD, GBPJPY)."
          },
          direction: {
            type: "string",
            enum: ["BUY", "SELL"],
            description: "Dirección de la operación."
          },
          stopLossPips: {
            type: "number",
            description: "Stop Loss en pips/puntos desde el precio de entrada."
          },
          riskPercentage: {
            type: "number",
            description: "Porcentaje del balance a arriesgar. Default: 0.5%"
          },
          comment: {
            type: "string",
            description: "Comentario opcional para etiquetar la orden en MT5."
          }
        },
        required: ["symbol", "direction", "stopLossPips"]
      }
    }
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const {
      symbol,
      direction,
      stopLossPips,
      riskPercentage = 0.5,
      comment = "Bot-SMC-v2"
    } = args as unknown as ExecuteTradeArgs;

    // 1. Verificar que el bridge esté activo
    const isAlive = await MT5Bridge.health();
    if (!isAlive) {
      return `❌ **MT5 Bridge no disponible.**\n- Asegúrate de que MT5 esté abierto.\n- Ejecuta en tu terminal: \`python bridge.py\`\n- Verifica que esté escuchando en http://localhost:5001`;
    }

    try {
      // 2. Obtener balance y precio actual
      const [account, tick] = await Promise.all([
        MT5Bridge.getAccount(),
        MT5Bridge.getPrice(symbol),
      ]);

      const balance      = account.balance;
      const riskAmount   = balance * (riskPercentage / 100);
      const ask          = tick.ask;
      const bid          = tick.bid;
      const digits       = tick.digits;

      // 3. Calcular pip value según activo
      let pipValue = 1.0; // base para índices en USD
      if (symbol.includes("JPY"))    pipValue = 0.01;  // pares JPY
      if (symbol.includes("BTC"))    pipValue = 1.0;   // BTC / punto
      if (symbol.includes("XAU"))    pipValue = 10.0;  // Oro

      // 4. Calcular lotaje con el riesgo definido
      const riskPerLot = stopLossPips * pipValue;
      const lotSize    = Math.max(0.01, Math.floor((riskAmount / riskPerLot) * 100) / 100);

      // 5. Definir precios de la orden límite (entrada en retroceso del 50% del SL)
      const retracementPips = stopLossPips * 0.5;
      let entryPrice: number;
      let stopLossPrice: number;
      let takeProfitPrice: number;

      const multiplier = digits <= 2 ? 1 : 0.0001;
      const pipSize    = digits <= 2 ? 1 : (symbol.includes("JPY") ? 0.01 : 0.0001);

      if (direction === "BUY") {
        entryPrice     = parseFloat((ask - retracementPips * pipSize).toFixed(digits));
        stopLossPrice  = parseFloat((entryPrice - stopLossPips * pipSize).toFixed(digits));
        takeProfitPrice= parseFloat((entryPrice + stopLossPips * 3 * pipSize).toFixed(digits));
      } else {
        entryPrice     = parseFloat((bid + retracementPips * pipSize).toFixed(digits));
        stopLossPrice  = parseFloat((entryPrice + stopLossPips * pipSize).toFixed(digits));
        takeProfitPrice= parseFloat((entryPrice - stopLossPips * 3 * pipSize).toFixed(digits));
      }

      const orderType = direction === "BUY" ? "BUY_LIMIT" : "SELL_LIMIT";

      // 6. Enviar orden al bridge
      const result = await MT5Bridge.placeOrder({
        symbol,
        type:       orderType,
        volume:     lotSize,
        price:      entryPrice,
        stopLoss:   stopLossPrice,
        takeProfit: takeProfitPrice,
        comment:    comment,
      });

      return `
### ✅ Orden ${orderType} Ejecutada en MT5
| Campo | Valor |
|---|---|
| **Símbolo** | ${symbol} |
| **Balance** | $${balance.toFixed(2)} ${account.currency} |
| **Lote** | ${lotSize} (${riskPercentage}% de riesgo) |
| **Tipo** | ${orderType} |
| **Precio Entrada** | ${entryPrice} |
| **Stop Loss** | ${stopLossPrice} (${stopLossPips} pips) |
| **Take Profit** | ${takeProfitPrice} (1:3 RR) |
| **Ticket MT5** | #${result.ticket} |
| **Servidor** | ${account.server} |
      `.trim();

    } catch (err) {
      return `❌ **Error al ejecutar orden en MT5:**\n${(err as Error).message}`;
    }
  }
};
