import type { Tool } from "../types.js";
import { MT5Bridge, type MT5OrderRequest, type MT5SymbolInfo } from "../../config/mt5bridge.js";
import { getSlForSymbol } from "../../config/asset_risk_table.js"; // Task 11-a: tabla única de SL por activo (solo fallback)
import {
  getRecentExecuteDecision,
  claimDecision,
  releaseDecision,
  saveOrder,
} from "../../database/sqlite.js";
import { assertExecutionForDecision } from "../policy.js";

/**
 * Herramienta de ejecución de órdenes via MT5 local (sin MetaApi)
 * SOP v3.3 (Task 8-a) con HARD-GATE ONE-SHOT + SIZING EXACTO + DEMO POR DEFECTO:
 *  - Solo ejecuta si existe una decisión EXECUTE vigente emitida por
 *    runDecisionPipeline (≤15 min, sin decisión posterior que la invalide).
 *  - ONE-SHOT: cada decisión autoriza UNA sola orden (claim atómico en DB).
 *  - VINCULANTE: dirección obligatoria coincidente, SL acotado al plan y
 *    riesgo forzado al valor de la decisión (el LLM no puede inflarlo).
 *  - SIZING EXACTO: si el bridge expone symbol_info, el valor-pip se
 *    calcula desde trade_tick_value/trade_tick_size (multi-broker real);
 *    fallback honesto a la tabla PIP_VALUE_USD. Lote redondeado a
 *    volume_step y acotado por volume_min/volume_max y MAX_LOT.
 *  - EXPIRACIÓN: las órdenes pendientes nacen con expiration = validez de
 *    la decisión (15 min) — se acabaron las LIMIT GTC eternas.
 *  - MODO DEMO POR DEFECTO: sin LIVE_TRADING=true NADA se envía a MT5;
 *    el lotaje y los precios se calculan igual y el registro queda marcado
 *    como demo en trade_orders.
 *  - Comentario MT5 con prefijo "AGT-<DIR>-<SIMBOLO>-<decisión>": el
 *    pipeline lo usa para cancelar pendientes obsoletos o en contra del bias.
 */

interface ExecuteTradeArgs {
  symbol: string;
  direction: "BUY" | "SELL";
  stopLossPips: number;
  riskPercentage?: number;
  comment?: string;
}

// PROMPT 06 §23: SIN BYPASS. El escape PIPELINE_GATE=off fue eliminado
// (auditorías 9-e/9-h: era una puerta trasera de policy que anulaba el
// one-shot y el binding de SL/riesgo). El hard-gate SIEMPRE está activo;
// la variable solo se conserva para AVISAR que el escape fue solicitado
// e ignorado. La única autoridad de bypass es el EXECUTION GUARD, que
// re-valida todo dentro de MT5Bridge.placeOrder.
const PIPELINE_GATE_ENV_OFF = (process.env.PIPELINE_GATE ?? "").toLowerCase() === "off";
const MAX_RISK_PCT = Math.min(2, Math.max(0.1, parseFloat(process.env.MAX_RISK_PCT ?? "1.0")) || 1.0);
const MAX_LOT = Math.max(0.01, parseFloat(process.env.MAX_LOT ?? "10")) || 10;
/** Ventana de validez de la decisión EXECUTE (minutos) → expiración de la orden */
export const DECISION_VALIDITY_MINUTES = 15;

// ── Valor del pip en USD por 1 lote estándar (por unidad de pipSize) ──
// Cuenta USD. Sobrescribible por env: PIP_VALUE_OVERRIDES='{"MY_SYMBOL":5}'
// TABLA DE FALLBACK: solo se usa si el bridge no expone symbol_info.
// Con symbol_info disponible, el valor se calcula del contrato real.
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

// ═══════════════════════════════════════════════════════════
// Sizing exacto (funciones puras exportadas para tests)
// ═══════════════════════════════════════════════════════════

export type PipValueSource = "symbol_info" | "tabla_PIP_VALUE_USD";

/**
 * Valor del pip del plan (pipSize unidades de precio) por 1 lote, en
 * moneda de la cuenta.
 *
 * Matemática con symbol_info: trade_tick_value es el valor de UN tick
 * (de tamaño trade_tick_size) POR LOTE → el valor de 1.0 unidad de
 * precio por lote es tick_value / tick_size, y un "pip" del plan que
 * mide `pipSize` unidades de precio vale (tick_value / tick_size) × pipSize.
 * Ej. XAUUSD (tick 0.01 → $1 por 100oz): (1 / 0.01) × 1.0 = $100/pip/lote.
 *
 * Fallback: tabla PIP_VALUE_USD + overrides por env. Null = símbolo
 * desconocido → el llamador debe RECHAZAR (fail-closed, nunca adivinar).
 */
export function computePipValueUSD(
  symbol: string,
  pipSize: number,
  info?: MT5SymbolInfo | null
): { value: number; source: PipValueSource } | null {
  if (info && info.tradeTickValue > 0 && info.tradeTickSize > 0 && pipSize > 0) {
    return { value: (info.tradeTickValue / info.tradeTickSize) * pipSize, source: "symbol_info" };
  }
  const overrides = loadPipOverrides();
  const tableValue = overrides[symbol] ?? PIP_VALUE_USD[symbol];
  if (tableValue && tableValue > 0) return { value: tableValue, source: "tabla_PIP_VALUE_USD" };
  return null;
}

export interface LotSizing {
  lotSize: number;
  rawLotSize: number;
  realRisk: number;
  riskPerLot: number;
  usdPerPipPerLot: number;
  source: PipValueSource;
  /** below_min: ni el lote mínimo respeta el riesgo | invalid: datos incoherentes */
  rejected?: "below_min" | "invalid";
}

/**
 * Lote para arriesgar `riskAmount` con un SL de `stopLossPips` pips,
 * redondeado SIEMPRE HACIA ABAJO al volume_step del símbolo y acotado
 * por volume_min, volume_max del broker y MAX_LOT del agente.
 * Redondear hacia abajo garantiza que el riesgo real ≤ riesgo planificado.
 */
export function computeLotFromRisk(
  riskAmount: number,
  stopLossPips: number,
  usdPerPipPerLot: number,
  source: PipValueSource,
  info?: MT5SymbolInfo | null
): LotSizing {
  const riskPerLot = stopLossPips * usdPerPipPerLot;
  const raw = riskPerLot > 0 && Number.isFinite(riskPerLot) ? riskAmount / riskPerLot : NaN;
  const base: LotSizing = {
    lotSize: 0,
    rawLotSize: Number.isFinite(raw) ? raw : 0,
    realRisk: 0,
    riskPerLot,
    usdPerPipPerLot,
    source,
  };

  if (!Number.isFinite(raw) || raw <= 0) {
    return { ...base, rejected: "invalid" };
  }

  const step = info && info.volumeStep > 0 ? info.volumeStep : 0.01;
  const min = info && info.volumeMin > 0 ? info.volumeMin : 0.01;
  const brokerMax = info && info.volumeMax > 0 ? info.volumeMax : Number.MAX_SAFE_INTEGER;
  const max = Math.min(MAX_LOT, brokerMax);

  let lot = parseFloat((Math.floor(raw / step + 1e-9) * step).toFixed(8));
  if (lot < min) {
    return { ...base, lotSize: lot, rawLotSize: raw, realRisk: lot * riskPerLot, rejected: "below_min" };
  }
  if (lot > max) {
    lot = parseFloat((Math.floor(max / step + 1e-9) * step).toFixed(8));
  }
  return { ...base, lotSize: lot, rawLotSize: raw, realRisk: lot * riskPerLot };
}

/** Epoch (segundos) en el que expira la orden pendiente = validez de la decisión */
export function buildOrderExpiration(validMinutes: number = DECISION_VALIDITY_MINUTES): number {
  return Math.floor(Date.now() / 1000) + Math.round(validMinutes * 60);
}

/**
 * Tamaño del "pip" del plan en unidades de precio. Si hay symbol_info se
 * aplica la regla MT5 clásica (pip = point×10 en símbolos de 3/5 dígitos);
 * si no, tabla conocida o heurística por dígitos (comportamiento histórico).
 */
function resolvePipSize(symbol: string, digits: number, info: MT5SymbolInfo | null): number {
  const tabled = PIP_SIZE_BY_SYMBOL[symbol];
  if (tabled) return tabled;
  if (info && info.point > 0) {
    return digits === 3 || digits === 5 ? info.point * 10 : info.point;
  }
  return digits <= 2 ? 1 : 0.0001;
}

function formatPipValue(value: number, source: PipValueSource): string {
  return source === "symbol_info"
    ? `${value.toFixed(2)}$/pip/lote (symbol_info del broker)`
    : `${value}$/pip/lote (tabla PIP_VALUE_USD — añade symbol_info al bridge para exactitud total)`;
}

export const executeTradeMT5: Tool = {
  definition: {
    type: "function",
    function: {
      name: "executeTradeMT5",
      description: "Ejecuta una orden Limit en MetaTrader 5 local via bridge. Calcula el lotaje con symbol_info del broker (tick_value/tick_size) o tabla fallback. MODO DEMO POR DEFECTO: sin LIVE_TRADING=true la orden NO se envía a MT5 (solo se calcula y se registra). SOLO usar cuando el pipeline emita una decisión EXECUTE vigente (hard-gate one-shot).",
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
      stopLossPips: stopLossPipsArg,
      riskPercentage,
      comment = "Bot-SMC-v3"
    } = args as unknown as ExecuteTradeArgs;
    const symbol = String(rawSymbol).trim().toUpperCase();

    // Task 11-a: si la orden NO TRAE SL explícito (campo ausente/null/NaN) y
    // el símbolo resuelve en la tabla única de SL por activo
    // (asset_risk_table.ts), ese valor es el fallback — LÍNEA DE INTEGRACIÓN
    // de la tabla. Un SL explícito pero inválido (0, negativo) NO se
    // sustituye: se mantiene y el chequeo de sanidad de más abajo lo rechaza
    // (fail-closed intacto, nunca se inventa un SL donde el llamador envió
    // basura). Si la decisión vigente trae SL del plan, el hard-gate manda
    // (tolerancia 0.5x–1.25x).
    const stopLossPips: number =
      stopLossPipsArg != null && Number.isFinite(stopLossPipsArg)
        ? stopLossPipsArg
        : getSlForSymbol(symbol) ?? stopLossPipsArg;

    // ── HARD-GATE (SOP v3.2, one-shot, SIEMPRE activo) ──
    let gatedDecisionId: number | undefined;
    let gatedApprovalStatus: string | null = null;
    let boundRiskPct = Math.min(MAX_RISK_PCT, Math.max(0.1, riskPercentage ?? 0.5));
    if (PIPELINE_GATE_ENV_OFF) {
      console.warn("[ExecuteMT5] PIPELINE_GATE=off solicitado e IGNORADO — el bypass fue eliminado (PROMPT 06 §23)");
    }

    {
      const decision = getRecentExecuteDecision(symbol, DECISION_VALIDITY_MINUTES);
      if (!decision) {
        return [
          `🚫 **EJECUCIÓN BLOQUEADA POR EL HARD-GATE (SOP v3.2)**`,
          ``,
          `No hay una decisión **EXECUTE** vigente, sin consumir y sin decisiones posteriores para **${symbol}** (ventana: ${DECISION_VALIDITY_MINUTES} minutos).`,
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

      // Riesgo FORZADO desde la decisión: el riskPercentage del LLM se ignora.
      // PROMPT 06 §8: si la decisión no trae riesgo numérico → RECHAZO
      // (nunca caer silenciosamente al valor propuesto por el LLM).
      if (decision.risk_pct && Number.isFinite(decision.risk_pct)) {
        boundRiskPct = Math.min(MAX_RISK_PCT, Math.max(0.1, decision.risk_pct));
      } else {
        return `🚫 **EJECUCIÓN BLOQUEADA:** la decisión #${decision.id} no tiene risk_pct numérico (fail-closed §8). Ejecuta \`runDecisionPipeline\` de nuevo — el planner debe emitir un riesgo válido.`;
      }

      // ONE-SHOT: reclamar la decisión atómicamente (una decisión = una orden)
      if (!claimDecision(decision.id)) {
        return `🚫 **EJECUCIÓN BLOQUEADA:** la decisión #${decision.id} ya fue consumida por una orden previa (one-shot). Ejecuta \`runDecisionPipeline\` para una nueva decisión.`;
      }
      gatedDecisionId = decision.id;
      gatedApprovalStatus = decision.approval_status ?? null;

      // ── POLICY (PROMPT 06 §6/§12/§19): la gobernanza decide si está
      // permitido — kill switch, modo, nivel efectivo y aprobación humana.
      const policyVerdict = assertExecutionForDecision(decision.approval_status ?? null);
      if (!policyVerdict.allowed) {
        releaseDecision(decision.id);
        return [
          `🛑 **EJECUCIÓN BLOQUEADA POR POLICY**`,
          ``,
          `${policyVerdict.reason}`,
          ``,
          `_La decisión #${decision.id} fue liberada (sigue vigente hasta su expiración)._`,
        ].join("\n");
      }
    }

    // 1. Verificar que el bridge esté activo (con liberación del claim si falla)
    const isAlive = await MT5Bridge.health();
    if (!isAlive) {
      if (gatedDecisionId) releaseDecision(gatedDecisionId);
      return `❌ **MT5 Bridge no disponible.**\n- Asegúrate de que MT5 esté abierto.\n- Ejecuta en tu terminal: \`python bridge.py\`\n- Verifica que esté escuchando en http://localhost:5001`;
    }

    try {
      // 2. Obtener balance, precio actual e info de contrato del símbolo
      const [account, tick] = await Promise.all([
        MT5Bridge.getAccount(),
        MT5Bridge.getPrice(symbol),
      ]);
      // symbol_info NO es crítico para proceder: si falla cae a la tabla
      // PIP_VALUE_USD (fallback honesto ya auditado), pero se intenta primero
      // porque es la única vía de sizing exacto multi-broker.
      let symbolInfo: MT5SymbolInfo | null = null;
      try {
        symbolInfo = await MT5Bridge.getSymbolInfo(symbol);
      } catch {
        symbolInfo = null;
      }

      const balance = account.balance;
      const riskAmount = balance * (boundRiskPct / 100);
      const ask = tick.ask;
      const bid = tick.bid;
      const digits = symbolInfo && symbolInfo.digits > 0 ? symbolInfo.digits : tick.digits;

      // Validación de sanidad del SL (código, no LLM)
      if (!Number.isFinite(stopLossPips) || stopLossPips <= 0 || stopLossPips > 10_000) {
        if (gatedDecisionId) releaseDecision(gatedDecisionId);
        return `🚫 **SL inválido (${stopLossPips}).** Debe ser un número positivo y razonable de pips/puntos.`;
      }

      // 3. Valor del pip: symbol_info (exacto) → tabla honesta → RECHAZO
      const pipSize = resolvePipSize(symbol, digits, symbolInfo);
      const pipValueInfo = computePipValueUSD(symbol, pipSize, symbolInfo);
      if (!pipValueInfo) {
        if (gatedDecisionId) releaseDecision(gatedDecisionId);
        return [
          `🚫 **Símbolo ${symbol} sin fuente de valor-pip (fail-closed).**`,
          ``,
          `Ni el bridge expone \`symbol_info\` para este símbolo ni está en la tabla \`PIP_VALUE_USD\`.`,
          `El sizing exige el valor real del pip para no arriesgar de más. Opciones:`,
          `1. Verifica que \`GET /symbol_info/${symbol}\` responda 200 desde el bridge (el símbolo debe existir en MT5).`,
          `2. Añade el símbolo a \`PIP_VALUE_USD\` en \`execute_trade_mt5.ts\`.`,
          `3. Exporta \`PIP_VALUE_OVERRIDES='{"${symbol}": <usd_por_pip_por_lote>}'\` en tu .env.`,
        ].join("\n");
      }
      const pipValue = pipValueInfo.value;

      // 4. Calcular lotaje exacto (round-down a volume_step, caps volume_min/max + MAX_LOT)
      const sizing = computeLotFromRisk(riskAmount, stopLossPips, pipValue, pipValueInfo.source, symbolInfo);
      if (sizing.rejected === "invalid") {
        if (gatedDecisionId) releaseDecision(gatedDecisionId);
        return `🚫 **Datos de sizing incoherentes:** riesgo $${riskAmount.toFixed(2)}, SL ${stopLossPips} pips, valor-pip ${pipValue}. No se envía nada a MT5.`;
      }
      if (sizing.rejected === "below_min") {
        if (gatedDecisionId) releaseDecision(gatedDecisionId);
        const minLot = symbolInfo && symbolInfo.volumeMin > 0 ? symbolInfo.volumeMin : 0.01;
        return `🚫 **Riesgo incompatible con el lotaje mínimo**: ${minLot} lotes arriesgaría $${(minLot * sizing.riskPerLot).toFixed(2)} pero el plan permite $${riskAmount.toFixed(2)} (${boundRiskPct}%). Reduce el SL o sube el riesgo en el plan si lo aceptas conscientemente.`;
      }

      const lotSize = sizing.lotSize;
      const realRisk = sizing.realRisk;
      const pipValueStr = formatPipValue(pipValue, pipValueInfo.source);

      // 5. Definir precios de la orden límite (entrada en retroceso del 50% del SL)
      const retracementPips = stopLossPips * 0.5;

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

      // 6. Comentario auditable para MT5: el pipeline cancela pendientes por
      //    prefijo "AGT-" + dirección/símbolo codificados aquí.
      const baseComment = `AGT-${direction}-${symbol}-${gatedDecisionId ?? "manual"}`;
      const mt5Comment =
        comment && comment !== "Bot-SMC-v3"
          ? `${baseComment}|${String(comment)}`.slice(0, 31)
          : baseComment.slice(0, 31);

      // 7. Payload con EXPIRACIÓN: la orden muere con la validez de la decisión
      const orderPayload: MT5OrderRequest = {
        symbol,
        type:       orderType,
        volume:     lotSize,
        price:      entryPrice,
        stopLoss:   stopLossPrice,
        takeProfit: takeProfitPrice,
        comment:    mt5Comment,
      };
      const isPending = orderType.includes("LIMIT") || orderType.includes("STOP");
      const expirationEpoch = isPending ? buildOrderExpiration(DECISION_VALIDITY_MINUTES) : undefined;
      if (expirationEpoch !== undefined) orderPayload.expiration = expirationEpoch;

      // 8. MODO DEMO POR DEFECTO (fail-safe de dinero real)
      //    Sin LIVE_TRADING=true NADA sale hacia MT5: se calcula todo igual,
      //    se registra con status "demo" y se responde con transparencia.
      const liveTrading = process.env.LIVE_TRADING === "true";
      if (!liveTrading) {
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
            riskPct: boundRiskPct,
            status: "demo",
          });
        } catch (dbErr) {
          console.warn(`[ExecuteMT5] No se pudo registrar la orden demo en trade_orders: ${(dbErr as Error).message}`);
        }

        const slSource = DEFAULT_SL_PIPS[symbol] ? `(default ${DEFAULT_SL_PIPS[symbol]})` : "";
        return [
          `**[DEMO] Orden simulada (NO enviada a MT5). Configura LIVE_TRADING=true para operar en real.**`,
          ``,
          `### 🧪 Orden ${orderType} simulada — ${symbol}`,
          `| Campo | Valor |`,
          `|---|---|`,
          `| **Balance** | $${balance.toFixed(2)} ${account.currency} |`,
          `| **Lote** | ${lotSize} (crudo ${sizing.rawLotSize.toFixed(4)} → round-down a volume_step${symbolInfo ? ` ${symbolInfo.volumeStep}` : ""}, máx ${MAX_LOT}) |`,
          `| **Riesgo** | ${boundRiskPct}% → **$${realRisk.toFixed(2)} reales** (${pipValueStr} · ${stopLossPips} pips${slSource}) |`,
          `| **Tipo** | ${orderType} |`,
          `| **Precio Entrada** | ${entryPrice} |`,
          `| **Stop Loss** | ${stopLossPrice} (${stopLossPips} pips) |`,
          `| **Take Profit** | ${takeProfitPrice} (1:3 RR) |`,
          `| **Expira** | ${expirationEpoch ? new Date(expirationEpoch * 1000).toISOString() : "—"} (${DECISION_VALIDITY_MINUTES} min) |`,
          `| **Decisión** | #${gatedDecisionId ?? "—"} (consumida, one-shot) |`,
          `| **Ticket MT5** | — (demo, no enviado) |`,
          `| **Servidor** | ${account.server} |`,
        ].join("\n");
      }

      // 9. Enviar orden al bridge con CONTEXTO de aprobación (§5/§13):
      //    el EXECUTION GUARD dentro de placeOrder re-valida TODO en el
      //    punto de envío (kill switch, riesgo de cuenta, spread, dedup…).
      let result;
      try {
        result = await MT5Bridge.placeOrder(orderPayload, {
          decisionId: gatedDecisionId ?? null,
          approvalStatus: gatedApprovalStatus, // el guard re-verifica el §12 en el punto de envío
        });
      } catch (orderErr) {
        const err = orderErr as Error & { code?: string };
        if (err.code === "BRIDGE_TIMEOUT") {
          // §13: estado DESCONOCIDO — la orden pudo haber llegado a MT5.
          // NO se libera la decisión (evita duplicar la orden en un retry):
          // queda consumida y la orden se registra como 'unknown'.
          try {
            saveOrder({
              decisionId: gatedDecisionId,
              symbol, direction, orderType,
              volume: lotSize, entryPrice, stopLoss: stopLossPrice, takeProfit: takeProfitPrice,
              riskPct: boundRiskPct,
              status: "unknown",
              verificationStatus: "unknown",
            });
          } catch {}
          return `⚠️ **Timeout del bridge tras enviar la orden: estado DESCONOCIDO.**\nLa decisión #${gatedDecisionId} queda CONSUMIDA (no se libera) para evitar duplicar la orden. Verifica en MT5 si la orden existe antes de reintentar nada.`;
        }
        if (err.code === "GUARD_REJECTED") {
          // El guard rechazó ANTES de enviar: no hay orden en MT5 → liberar.
          if (gatedDecisionId) releaseDecision(gatedDecisionId);
          return `🛑 **EXECUTION GUARD RECHAZÓ LA ORDEN (sin envío):**\n${err.message}\n\n_La decisión #${gatedDecisionId} fue liberada._`;
        }
        if (gatedDecisionId) releaseDecision(gatedDecisionId);
        throw orderErr;
      }

      // 10. Registrar la orden para el settlement (vínculo decisión ↔ orden)
      //     con verificación request-vs-actual (§13).
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
          riskAmount: realRisk,
          strategy: `SMC-hardgate`,
          expiration: expirationEpoch ?? null,
          verificationStatus: result.verification,
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
| **Lote** | ${lotSize} (crudo ${sizing.rawLotSize.toFixed(4)} → round-down a volume_step${symbolInfo ? ` ${symbolInfo.volumeStep}` : ""}, máx ${MAX_LOT}) |
| **Riesgo** | ${boundRiskPct}% → **$${realRisk.toFixed(2)} reales** (${pipValueStr} · ${stopLossPips} pips${slSource}) |
| **Tipo** | ${orderType} |
| **Precio Entrada** | ${entryPrice} |
| **Stop Loss** | ${stopLossPrice} (${stopLossPips} pips) |
| **Take Profit** | ${takeProfitPrice} (1:3 RR) |
| **Expira** | ${expirationEpoch ? new Date(expirationEpoch * 1000).toISOString() : "—"} (${DECISION_VALIDITY_MINUTES} min) |
| **Decisión** | #${gatedDecisionId ?? "—"} (consumida, one-shot) |
| **Ticket MT5** | #${result.ticket} |
| **Verificación §13** | ${result.verification === "verified" ? "✅ verified (retcode/precio/volumen concilian)" : "⚠️ divergence — revisar en MT5"} |
| **Servidor** | ${account.server} |
      `.trim();

    } catch (err) {
      if (gatedDecisionId) releaseDecision(gatedDecisionId);
      return `❌ **Error al ejecutar orden en MT5:**\n${(err as Error).message}`;
    }
  }
};
