import type { Tool } from "../types.js";
import { MT5Bridge } from "../../config/mt5bridge.js";
import {
  getRecentExecuteDecision,
  claimDecision,
  releaseDecision,
  saveOrder,
} from "../../database/sqlite.js";

/**
 * Herramienta de ejecución de órdenes via MT5 local (sin MetaApi)
 * SOP v3.2 con HARD-GATE ONE-SHOT:
 *  - Solo ejecuta si existe una decisión EXECUTE vigente emitida por
 *    runDecisionPipeline (≤15 min, sin decisión posterior que la invalide).
 *  - ONE-SHOT: cada decisión autoriza UNA sola orden (claim atómico en DB).
 *  - VINCULANTE: dirección obligatoria coincidente, SL acotado al plan y
 *    riesgo forzado al valor de la decisión (el LLM no puede inflarlo).
 *  - Lotaje calculado con tabla de valor-pip por activo (configurable por
 *    env). Símbolo desconocido → RECHAZO (fail-closed, sin adivinar).
 */

interface ExecuteTradeArgs {
  symbol: string;
  direction: "BUY" | "SELL";
  stopLossPips: number;
  riskPercentage?: number;
  comment?: string;
}

// Escape de emergencia: PIPELINE_GATE=off desactiva el gate (SOLO debug local;
// en producción debe mantenerse "on" — observability lo reporta como 🔴 OFF)
const PIPELINE_GATE = (process.env.PIPELINE_GATE ?? "on").toLowerCase() !== "off";
const MAX_RISK_PCT = Math.min(2, Math.max(0.1, parseFloat(process.env.MAX_RISK_PCT ?? "1.0")) || 1.0);
const MAX_LOT = Math.max(0.01, parseFloat(process.env.MAX_LOT ?? "10")) || 10;

// ── Valor del pip en USD por 1 lote estándar (por unidad de pipSize) ──
// Cuenta USD. Sobrescribible por env: PIP_VALUE_OVERRIDES='{"MY_SYMBOL":5}'
// Si el broker usa contratos distintos, AJUSTAR AQUÍ o vía env — el sizing
// se calcula con esta tabla; el símbolo fuera de tabla se rechaza.
const PIP_VALUE_USD: Record<string, number> = {
  US30: 1,     // índice: contrato por punto ($1/punto/lote convención Vantage)
  NAS100: 1,
  SPX500: 1,
  GER40: 1,
  XAUUSD: 100, // pip = 1.0 USD de precio → 100 oz/lote → $100 por pip
  BTCUSD: 1,   // 1 BTC/lote → $1 por punto
  GBPJPY: 6.6, // pip=0.01 JPY → 100k GBP → ~1000 JPY ≈ $6.6 (aprox; override con env)
  EURJPY: 6.6,
  USDJPY: 6.6,
};
const PIP_SIZE_BY_SYMBOL: Record<string, number> = {
  US30: 1, NAS100: 1, SPX500: 1, GER40: 1,
  XAUUSD: 1, BTCUSD: 1,
  GBPJPY: 0.01, EURJPY: 0.01, USDJPY: 0.01,
};
const DIGITS_BY_SYMBOL: Record<string, number> = {
  US30: 2, NAS100: 2, SPX500: 2, GER40: 2,
  XAUUSD: 2, BTCUSD: 2,
  GBPJPY: 3, EURJPY: 3, USDJPY: 3,
};
const DEFAULT_SL_PIPS: Record<string, number> = {
  US30: 15, NAS100: 20, XAUUSD: 30, GBPJPY: 20, BTCUSD: 500,
};

function loadPipOverrides(): Record<string, number> {
  try {
    return JSON.parse(process.env.PIP_VALUE_OVERRIDES ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
}

export const executeTradeMT5: Tool = {
  definition: {
    type: "function",
    function: {
      name: "executeTradeMT5",
      description: "Ejecuta una orden Limit en MetaTrader 5 local via bridge. Calcula el lotaje automáticamente según el balance y el riesgo. SOLO usar cuando ChoCh M1 está confirmado, RVOL >= 1.5x y checkMarketHours aprueba la sesión. Requiere decisión EXECUTE vigente del pipeline (hard-gate one-shot).",
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
            description: "Stop Loss en pips/puntos desde el precio de entrada. Debe coincidir con el plan de la decisión vigente."
          },
          riskPercentage: {
            type: "number",
            description: "OBSOLETO: el riesgo se hereda de la decisión EXECUTE vigente; este valor es ignorado por seguridad."
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
      symbol: rawSymbol,
      direction,
      stopLossPips,
      riskPercentage,
      comment = "Bot-SMC-v3"
    } = args as unknown as ExecuteTradeArgs;
    const symbol = String(rawSymbol).trim().toUpperCase();

    // ── HARD-GATE (SOP v3.2) ────────────────────────────────
    let gatedDecisionId: number | undefined;
    let boundRiskPct = Math.min(MAX_RISK_PCT, Math.max(0.1, riskPercentage ?? 0.5));

    if (PIPELINE_GATE) {
      const decision = getRecentExecuteDecision(symbol, 15);
      if (!decision) {
        return [
          `🚫 **EJECUCIÓN BLOQUEADA POR EL HARD-GATE (SOP v3.2)**`,
          ``,
          `No hay una decisión **EXECUTE** vigente, sin consumir y sin decisiones posteriores para **${symbol}** (ventana: 15 minutos).`,
          ``,
          `**Qué hacer:** ejecuta primero \`runDecisionPipeline\` con este activo. Si la decisión es EXECUTE, esta orden pasará.`,
          ``,
          `_Este bloqueo es de código, no del LLM: ningún filtro del SOP puede saltarse por convencimiento._`,
        ].join("\n");
      }

      // Dirección obligatoria: una EXECUTE sin dirección no autoriza nada
      if (!decision.direction) {
        return `🚫 **EJECUCIÓN BLOQUEADA:** la decisión vigente #${decision.id} no tiene dirección definida (plan incompleto). Ejecuta \`runDecisionPipeline\` de nuevo.`;
      }
      if (decision.direction.toUpperCase() !== String(direction).toUpperCase()) {
        return `🚫 **EJECUCIÓN BLOQUEADA:** la decisión vigente #${decision.id} autoriza **${decision.direction}**, no ${direction}. Reevalúa con \`runDecisionPipeline\` si el contexto cambió.`;
      }

      // Vinculación del SL al plan (tolerancia: hasta 1.25x el SL del plan,
      // nunca la mitad): el LLM no puede estirar ni encoger el riesgo real
      if (decision.stop_loss_pips && Number.isFinite(decision.stop_loss_pips)) {
        const planSL = decision.stop_loss_pips;
        if (stopLossPips > planSL * 1.25 || stopLossPips < planSL * 0.5) {
          return `🚫 **EJECUCIÓN BLOQUEADA:** el SL solicitado (${stopLossPips} pips) no coincide con el plan de la decisión #${decision.id} (${planSL} pips). Usa el SL del plan o reevalúa con \`runDecisionPipeline\`.`;
        }
      }

      // Riesgo FORZADO desde la decisión: el riskPercentage del LLM se ignora
      if (decision.risk_pct && Number.isFinite(decision.risk_pct)) {
        boundRiskPct = Math.min(MAX_RISK_PCT, Math.max(0.1, decision.risk_pct));
      }

      // ONE-SHOT: reclamar la decisión atómicamente (una decisión = una orden)
      if (!claimDecision(decision.id)) {
        return `🚫 **EJECUCIÓN BLOQUEADA:** la decisión #${decision.id} ya fue consumida por una orden previa (one-shot). Ejecuta \`runDecisionPipeline\` para una nueva decisión.`;
      }
      gatedDecisionId = decision.id;
    }

    // 1. Verificar que el bridge esté activo (con liberación del claim si falla)
    const isAlive = await MT5Bridge.health();
    if (!isAlive) {
      if (gatedDecisionId) releaseDecision(gatedDecisionId);
      return `❌ **MT5 Bridge no disponible.**\n- Asegúrate de que MT5 esté abierto.\n- Ejecuta en tu terminal: \`python bridge.py\`\n- Verifica que esté escuchando en http://localhost:5001`;
    }

    try {
      // 2. Obtener balance y precio actual
      const [account, tick] = await Promise.all([
        MT5Bridge.getAccount(),
        MT5Bridge.getPrice(symbol),
      ]);

      const balance = account.balance;
      const riskAmount = balance * (boundRiskPct / 100);
      const ask = tick.ask;
      const bid = tick.bid;
      const digits = tick.digits;

      // 3. Valor del pip: tabla honesta por símbolo (fail-closed)
      //    Símbolo fuera de tabla sin override → RECHAZO, nunca adivinar.
      const overrides = loadPipOverrides();
      const pipValue = overrides[symbol] ?? PIP_VALUE_USD[symbol];
      if (!pipValue || pipValue <= 0) {
        if (gatedDecisionId) releaseDecision(gatedDecisionId);
        return [
          `🚫 **Símbolo ${symbol} no está en la tabla de valor-pip (PIP_VALUE_USD).**`,
          ``,
          `El sizing requiere el valor real del pip para no arriesgar de más. Dos opciones:`,
          `1. Añade el símbolo a \`PIP_VALUE_USD\` en \`execute_trade_mt5.ts\`.`,
          `2. Exporta \`PIP_VALUE_OVERRIDES='{"${symbol}": <usd_por_pip_por_lote>}'\` en tu .env.`,
        ].join("\n");
      }

      // Validación de sanidad del SL (código, no LLM)
      if (!Number.isFinite(stopLossPips) || stopLossPips <= 0 || stopLossPips > 10_000) {
        if (gatedDecisionId) releaseDecision(gatedDecisionId);
        return `🚫 **SL inválido (${stopLossPips}).** Debe ser un número positivo y razonable de pips/puntos.`;
      }

      // 4. Calcular lotaje con el riesgo definido (cap de seguridad MAX_LOT)
      const riskPerLot = stopLossPips * pipValue;
      const rawLotSize = riskAmount / riskPerLot;
      const lotSize = Math.min(MAX_LOT, Math.max(0.01, Math.floor(rawLotSize * 100) / 100));
      const realRisk = lotSize * riskPerLot;

      // Si el lote mínimo (0.01) ya excede el riesgo previsto, avisar con claridad
      if (rawLotSize < 0.01) {
        if (gatedDecisionId) releaseDecision(gatedDecisionId);
        return `🚫 **Riesgo incompatible con el lotaje mínimo**: 0.01 lotes arriesgaría $${(0.01 * riskPerLot).toFixed(2)} pero el plan permite $${riskAmount.toFixed(2)} (${boundRiskPct}%). Reduce el SL o sube el riesgo en el plan si lo aceptas conscientemente.`;
      }

      // 5. Definir precios de la orden límite (entrada en retroceso del 50% del SL)
      const retracementPips = stopLossPips * 0.5;
      const pipSize = PIP_SIZE_BY_SYMBOL[symbol] ?? (digits <= 2 ? 1 : 0.0001);

      let entryPrice: number;
      let stopLossPrice: number;
      let takeProfitPrice: number;

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

      // 6. Enviar orden al bridge (si falla, liberar la decisión reclamada)
      let result;
      try {
        result = await MT5Bridge.placeOrder({
          symbol,
          type:       orderType,
          volume:     lotSize,
          price:      entryPrice,
          stopLoss:   stopLossPrice,
          takeProfit: takeProfitPrice,
          comment:    comment,
        });
      } catch (orderErr) {
        if (gatedDecisionId) releaseDecision(gatedDecisionId);
        throw orderErr;
      }

      // 7. Registrar la orden para el settlement (vínculo decisión ↔ orden)
      try {
        saveOrder({
          decisionId: gatedDecisionId,
          symbol,
          direction,
          orderType,
          volume: lotSize,
          entryPrice,
          stopLoss: stopLossPrice,
          takeProfit: takeProfitPrice,
          ticket: result.ticket,
          riskPct: boundRiskPct,
          status: "placed",
        });
      } catch (dbErr) {
        // La orden ya salió: el fallo de telemetría no debe engañar al usuario
        console.warn(`[ExecuteMT5] No se pudo registrar la orden en trade_orders: ${(dbErr as Error).message}`);
      }

      const slSource = DEFAULT_SL_PIPS[symbol] ? `(default ${DEFAULT_SL_PIPS[symbol]})` : "";

      return `
### ✅ Orden ${orderType} Ejecutada en MT5
| Campo | Valor |
|---|---|
| **Símbolo** | ${symbol} |
| **Balance** | $${balance.toFixed(2)} ${account.currency} |
| **Lote** | ${lotSize} (máx permitido ${MAX_LOT}) |
| **Riesgo** | ${boundRiskPct}% → **$${realRisk.toFixed(2)} reales** (${pipValue}$/pip/lote · ${stopLossPips} pips${slSource}) |
| **Tipo** | ${orderType} |
| **Precio Entrada** | ${entryPrice} |
| **Stop Loss** | ${stopLossPrice} (${stopLossPips} pips) |
| **Take Profit** | ${takeProfitPrice} (1:3 RR) |
| **Decisión** | #${gatedDecisionId ?? "—"} (consumida, one-shot) |
| **Ticket MT5** | #${result.ticket} |
| **Servidor** | ${account.server} |
      `.trim();

    } catch (err) {
      if (gatedDecisionId) releaseDecision(gatedDecisionId);
      return `❌ **Error al ejecutar orden en MT5:**\n${(err as Error).message}`;
    }
  }
};
