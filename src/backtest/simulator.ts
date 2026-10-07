// ============================================================
// src/backtest/simulator.ts
// Motor de simulación: ejecuta trades basado en setups SMC
//
// FIXES DE VALIDEZ (auditoría 9-g, implementados en Task 10-b):
//  1. Look-ahead estructural: se entra en la vela de CONFIRMACIÓN
//     (setup.index + SWING_LOOKBACK), nunca en la vela del swing (que solo es
//     confirmable 5 velas después). SL/TP se evalúan desde la vela SIGUIENTE
//     a la entrada, nunca con el rango de la vela de entrada (precio previo).
//  2. P&L REAL: profit = lotSize × Δprecio × pipValue (coherente con
//     computeLotFromRisk/computePipValueUSD de execute_trade_mt5.ts).
//     Eliminado el P&L fabricado riskPercentage×tpRatio×balance.
//  3. UN SOLO pipSize por símbolo para SL, TP y P&L (se elimina la
//     heurística stopLossPips>100?0.01:0.0001 que daba TPs imposibles).
//  4. Sin ReferenceError: el riskAmount de cada trade vive en metadatos
//     propios (antes estaba fuera de scope y crashaba cualquier pérdida).
//  5. Fricción honesta por trade: spread + comisión + slippage (≠ 0).
//  6. Regla de ambigüedad intra-vela documentada: si SL y TP se tocan en la
//     MISMA vela se asume SL primero (conservador).
// ============================================================

import {
  ProcessedCandle,
  SMCSetup,
  Trade,
  BacktestConfig,
  EquityPoint,
} from "./types.js";
import { isValidSetup, SWING_LOOKBACK } from "./smc_detector.js";

// ── Tablas de pip (espejo de PIP_SIZE_BY_SYMBOL / PIP_VALUE_USD de
//    execute_trade_mt5.ts — MANTENER SINCRONIZADO; se replica aquí para que
//    el motor de backtest no dependa de la DB/bridge que arrastra ese módulo) ──
const PIP_SIZE_BY_SYMBOL: Record<string, number> = {
  US30: 1, NAS100: 1, SPX500: 1, GER40: 1,
  XAUUSD: 1, BTCUSD: 1,
  GBPJPY: 0.01, EURJPY: 0.01, USDJPY: 0.01,
};
const PIP_VALUE_USD: Record<string, number> = {
  US30: 1, NAS100: 1, SPX500: 1, GER40: 1,   // índices: $1/punto/lote
  XAUUSD: 100,                               // pip = 1.0 de precio → $100/pip/lote
  BTCUSD: 1,
  GBPJPY: 6.6, EURJPY: 6.6, USDJPY: 6.6,
};

/** Tope de lotaje (mismo criterio MAX_LOT del agente en vivo) */
const MAX_LOT = 10;

/** Tamaño del pip en unidades de precio para un símbolo (único para SL/TP/P&L) */
export function resolvePipSize(symbol: string): number {
  const tabled = PIP_SIZE_BY_SYMBOL[symbol];
  if (tabled) return tabled;
  if (symbol.includes("JPY")) return 0.01;
  // Fallback histórico: índices (30/100) y BTC → 1.0; resto FX 5 dígitos → 0.0001
  const isIndex = symbol.includes("30") || symbol.includes("100");
  const isCrypto = symbol.includes("BTC");
  return isIndex || isCrypto ? 1 : 0.0001;
}

/** Valor del pip en USD por 1 lote (fallback de tabla; sin symbol_info en backtest) */
export function resolvePipValueUSD(symbol: string): number {
  return PIP_VALUE_USD[symbol] ?? 1;
}

// ── Fricción de ejecución (auditoría 9-g: "ejecución sin fricción") ──
export interface FrictionConfig {
  /** Spread en PIPS (1 pip = pipSize unidades de precio), cobrado en la entrada */
  spreadPoints: number;
  /** Comisión en USD por lote (ida y vuelta), cobrada al cierre */
  commissionPerLot: number;
  /** Slippage adverso en PIPS aplicado a fills de stop */
  slippagePoints: number;
}

/** Defaults honestos ≠ 0: ninguna ejecución real es gratis */
export const DEFAULT_FRICTION: FrictionConfig = {
  spreadPoints: 2,
  commissionPerLot: 7,
  slippagePoints: 1,
};

/** Metadatos por trade que el tipo Trade no lleva (riesgo real, SL en pips) */
interface TradeMeta {
  stopLossPips: number;
  riskAmount: number; // USD arriesgados según sizing (antes del floor del lote)
  entryIndex: number; // vela de ENTRADA real (confirmación), no la del swing
  lotSize: number;
}

/** Calcula el lotaje basado en riesgo (equivalente a computeLotFromRisk con
 *  volume_step 0.01 y round-down: el riesgo real nunca supera el planificado) */
function calculateLotSize(
  stopLossPips: number,
  riskPercentage: number,
  currentBalance: number,
  pipValueUSD: number
): { lotSize: number; riskAmount: number } {
  const riskAmount = currentBalance * (riskPercentage / 100);
  // Risk = Lote × Pips × $/pip  ⇒  Lote = Risk / (Pips × $/pip)
  const riskPerLot = stopLossPips * pipValueUSD;
  const raw = riskPerLot > 0 ? riskAmount / riskPerLot : 0;
  const lotSize = Math.floor(raw * 100) / 100; // round-down a 0.01
  return { lotSize, riskAmount };
}

/** Calcula Stop Loss dinámico por activo (con el pipSize ÚNICO del símbolo) */
function calculateStopLoss(
  entryPrice: number,
  direction: "LONG" | "SHORT",
  config: BacktestConfig,
  setup: SMCSetup
): { stopLoss: number; stopLossPips: number; pipSize: number } {
  const pipSize = resolvePipSize(config.asset);
  const isCrypto = config.asset.includes("BTC");
  const isGold = config.asset.includes("XAU");
  const isJPY = config.asset.includes("JPY");

  // Pips base por activo
  let basePips = config.maxSlPips;
  if (!basePips) {
    if (config.asset === "US30") basePips = 15;
    else if (config.asset === "NAS100") basePips = 20;
    else if (isGold) basePips = 30;
    else if (isCrypto) basePips = 500;
    else if (isJPY) basePips = 20;
    else basePips = 15;
  }

  // Ajustar por tipo de setup
  if (setup.type === "ChoCh") {
    // ChoCh es reversión, SL más amplio
    basePips *= 1.3;
  }

  const stopLossPips = Math.min(basePips, config.maxSlPips || basePips);

  const stopLoss =
    direction === "LONG"
      ? entryPrice - stopLossPips * pipSize
      : entryPrice + stopLossPips * pipSize;

  return { stopLoss, stopLossPips, pipSize };
}

/** Simula ejecución de trades basado en setups */
export function simulateTrades(
  candles: ProcessedCandle[],
  setups: SMCSetup[],
  config: BacktestConfig,
  friction: Partial<FrictionConfig> = {}
): { trades: Trade[]; equityCurve: EquityPoint[] } {
  const fr: FrictionConfig = { ...DEFAULT_FRICTION, ...friction };

  const trades: Trade[] = [];
  const equityCurve: EquityPoint[] = [];

  let currentBalance = config.initialBalance;
  let maxBalance = config.initialBalance;
  let maxDrawdown = 0;

  const activeTrades: Trade[] = [];
  const tradeMeta = new Map<Trade, TradeMeta>();
  // Tracking de MAE/MFE durante el trade (clave = objeto trade, no índice)
  const tradeTrackers = new Map<Trade, { maxDrawdown: number; maxProfit: number }>();

  const pipSize = resolvePipSize(config.asset);
  const pipValueUSD = resolvePipValueUSD(config.asset);

  // ── FIX look-ahead: la entrada ocurre en la vela de CONFIRMACIÓN ──
  // El swing s3 (setup.index) solo es observable en vivo SWING_LOOKBACK velas
  // después (el detector mira i+1..i+5). Agrupamos setups por vela de entrada.
  const entriesByBar = new Map<number, SMCSetup[]>();
  for (const setup of setups) {
    const entryIndex = setup.index + SWING_LOOKBACK;
    if (entryIndex < 0 || entryIndex >= candles.length) continue; // sin vela de confirmación → no operable
    const arr = entriesByBar.get(entryIndex);
    if (arr) arr.push(setup);
    else entriesByBar.set(entryIndex, [setup]);
  }

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    const candleTime = candle.time;

    // ── 1) Gestionar trades abiertos ANTES de abrir nuevos ──
    // Todo trade activo aquí entró en una vela PREVIA (al close), por lo que el
    // rango high/low de ESTA vela es estrictamente posterior a la entrada:
    // no hay precio-previo-a-la-entrada (hallazgo 9-g "SL/TP en la vela de entrada").
    for (const trade of [...activeTrades]) {
      const meta = tradeMeta.get(trade);
      const tracker = tradeTrackers.get(trade);
      if (!meta || !tracker) continue;

      // MAE/MFE con los EXTREMOS de la vela (no solo el close)
      const favorablePips =
        trade.direction === "LONG"
          ? (candle.high - trade.entryPrice) / pipSize
          : (trade.entryPrice - candle.low) / pipSize;
      const adversePips =
        trade.direction === "LONG"
          ? (trade.entryPrice - candle.low) / pipSize
          : (candle.high - trade.entryPrice) / pipSize;
      if (favorablePips > tracker.maxProfit) tracker.maxProfit = favorablePips;
      if (adversePips > tracker.maxDrawdown) tracker.maxDrawdown = adversePips;

      // ¿Toca SL / TP?
      const slHit =
        trade.direction === "LONG"
          ? candle.low <= trade.stopLoss
          : candle.high >= trade.stopLoss;
      const tpHit =
        trade.direction === "LONG"
          ? candle.high >= trade.takeProfit
          : candle.low <= trade.takeProfit;

      // Time exit si pasa mucho tiempo sin moverse (30 velas = criterio simple)
      const barsSinceEntry = i - meta.entryIndex;
      const timeExit =
        barsSinceEntry > 30 &&
        ((trade.direction === "LONG" && candle.close < trade.entryPrice) ||
          (trade.direction === "SHORT" && candle.close > trade.entryPrice));

      let exitPrice: number | null = null;
      let reason: Trade["exit"]["reason"] | null = null;

      // REGLA DE AMBIGÜEDAD INTRA-VELA (documentada): si el high y el low de la
      // MISMA vela alcanzan SL y TP no podemos conocer el orden real OHLC-intra;
      // asumimos SL PRIMERO (conservador: el backtest nunca se da un beneficio
      // que en vivo podría no existir).
      if (slHit) {
        // Gap-through honesto: si la vela ABRIÓ más allá del SL, el fill real
        // es la apertura (peor que el SL), no el nivel teórico.
        const worstOfOpenAndSL =
          trade.direction === "LONG"
            ? Math.min(candle.open, trade.stopLoss)
            : Math.max(candle.open, trade.stopLoss);
        const slippage = fr.slippagePoints * pipSize;
        exitPrice =
          trade.direction === "LONG"
            ? worstOfOpenAndSL - slippage
            : worstOfOpenAndSL + slippage;
        reason = "SL_HIT";
      } else if (tpHit) {
        // Gap a favor en TP: el fill real es la apertura si abrió más allá del TP
        exitPrice =
          trade.direction === "LONG"
            ? Math.max(candle.open, trade.takeProfit)
            : Math.min(candle.open, trade.takeProfit);
        reason = "TP_HIT";
      } else if (timeExit) {
        exitPrice = candle.close;
        reason = "TIMEOUT";
      }

      if (exitPrice !== null && reason !== null) {
        trade.exit = { index: i, time: candleTime, price: exitPrice, reason };

        // ── P&L REAL (auditoría 9-g: "P&L fabricado") ──
        // profit = lotSize × Δprecio × valor-pip-unitario, con
        // valor-pip-unitario = pipValueUSD / pipSize (USD por unidad de precio
        // y lote). Δprecio es el movimiento FAVORABLE de entrada→salida; el
        // spread (entrada) y el slippage/gap (salida) ya están dentro de los
        // precios. La comisión se cobra aparte por lote (ida y vuelta).
        // Coherente con computeLotFromRisk: SL completo ⇒ pérdida ≈ riesgo planificado.
        const deltaPrice =
          trade.direction === "LONG"
            ? exitPrice - trade.entryPrice
            : trade.entryPrice - exitPrice; // unidades de precio, favorable
        const pipsDelta = deltaPrice / pipSize;
        const grossUsd = pipsDelta * pipValueUSD * meta.lotSize;
        const commission = fr.commissionPerLot * meta.lotSize;
        trade.profit = grossUsd - commission;
        trade.profitPips = pipsDelta; // neto de spread/slippage; la comisión no es pips
        trade.maxDrawdownPips = tracker.maxDrawdown;
        trade.maxProfitPips = tracker.maxProfit;
        trade.duration = barsSinceEntry; // en VELAS del timeframe simulado

        currentBalance += trade.profit;

        // Quitar de activos
        const idx = activeTrades.indexOf(trade);
        if (idx > -1) activeTrades.splice(idx, 1);
      }
    }

    // ── 2) Nuevas entradas al CLOSE de la vela de confirmación i ──
    const setupsInCandle = entriesByBar.get(i) ?? [];
    for (const setup of setupsInCandle) {
      // Validar filtros
      if (
        !isValidSetup(
          setup,
          {
            requireFVG: config.requireFVG,
            requireKillzone: config.requireKillzone,
            rvolThreshold: config.rvolThreshold,
          },
          candleTime
        )
      ) {
        continue;
      }

      // Verificar máximo de trades simultáneos
      if (activeTrades.length >= config.maxConcurrentTrades) {
        continue;
      }

      // Sin hedging salvo autorización explícita
      const direction: "LONG" | "SHORT" =
        setup.direction === "BULLISH" ? "LONG" : "SHORT";
      if (
        !config.allowHedging &&
        activeTrades.some((t) => t.direction !== direction)
      ) {
        continue;
      }

      // Fricción de entrada: el spread se paga comprando al ask (LONG) o
      // vendiendo al bid (SHORT). El spread de la vela viene en UNIDADES DE
      // PRECIO (RawCandle.spread) y se convierte a pips con el pipSize del
      // símbolo; se aplica el MAYOR entre el de la vela y el configurado
      // (criterio conservador).
      const candleSpread =
        (candle as unknown as { spread?: number }).spread ?? 0; // arrastrado por processCandles
      const candleSpreadPips = candleSpread > 0 ? candleSpread / pipSize : 0;
      const spreadPips = Math.max(fr.spreadPoints, candleSpreadPips);
      const spreadPrice = spreadPips * pipSize;
      const entryPrice =
        direction === "LONG" ? candle.close + spreadPrice : candle.close - spreadPrice;

      // Calcular SL (mismo pipSize que TP y P&L)
      const { stopLoss, stopLossPips } = calculateStopLoss(
        entryPrice,
        direction,
        config,
        setup
      );
      if (!(stopLossPips > 0)) continue;

      // Calcular TP (RR ratio) con el MISMO pipSize del símbolo
      // (FIX 9-g: antes una heurística >100?0.01:0.0001 generaba TPs imposibles)
      const tpDistance = stopLossPips * config.tpRatio;
      const takeProfit =
        direction === "LONG"
          ? entryPrice + tpDistance * pipSize
          : entryPrice - tpDistance * pipSize;

      // Calcular lotaje (round-down: el riesgo real nunca excede el planificado)
      const { lotSize, riskAmount } = calculateLotSize(
        stopLossPips,
        config.riskPerTrade,
        currentBalance,
        pipValueUSD
      );
      // Fail-closed: si ni el lote mínimo respeta el riesgo, no se opera
      // (mismo criterio "below_min" que computeLotFromRisk en vivo)
      if (lotSize < 0.01) continue;
      const cappedLot = Math.min(lotSize, MAX_LOT);

      const trade: Trade = {
        entry: setup,
        exit: {
          index: i,
          time: candleTime,
          price: entryPrice,
          reason: "SIGNAL_END", // se actualizará al cerrar
        },
        direction,
        entryPrice,
        stopLoss,
        takeProfit,
        volume: cappedLot,
        profit: 0,
        profitPips: 0,
        duration: 0,
        riskPercentage: config.riskPerTrade,
        setupType: setup.type + (setup.fvg ? "_FVG" : ""),
        maxDrawdownPips: 0,
        maxProfitPips: 0,
      };

      activeTrades.push(trade);
      tradeMeta.set(trade, {
        stopLossPips,
        riskAmount,
        entryIndex: i, // vela de entrada REAL (confirmación)
        lotSize: cappedLot,
      });
      tradeTrackers.set(trade, { maxDrawdown: 0, maxProfit: 0 });
      trades.push(trade);
    }

    // Actualizar high-water mark y drawdown
    if (currentBalance > maxBalance) {
      maxBalance = currentBalance;
    }
    const currentDD = (maxBalance - currentBalance) / maxBalance;
    if (currentDD > maxDrawdown) {
      maxDrawdown = currentDD;
    }

    // Registrar punto de equity
    equityCurve.push({
      time: candleTime,
      equity: currentBalance,
      highWaterMark: maxBalance,
      drawdownPercentage: currentDD * 100,
    });
  }

  // Cerrar trades que quedaron abiertos al final del período (al close de la
  // última vela, con P&L real y comisión — FIX: antes su profit no entraba en
  // el balance ni en la equity, desincronizando métricas y curva).
  const lastCandle = candles[candles.length - 1];
  if (activeTrades.length > 0 && lastCandle) {
    for (const trade of activeTrades) {
      const meta = tradeMeta.get(trade);
      const exitPrice = lastCandle.close;
      const deltaPrice =
        trade.direction === "LONG"
          ? exitPrice - trade.entryPrice
          : trade.entryPrice - exitPrice;
      const pipsDelta = deltaPrice / pipSize;
      const grossUsd = meta ? pipsDelta * pipValueUSD * meta.lotSize : 0;
      const commission = meta ? fr.commissionPerLot * meta.lotSize : 0;

      trade.exit = {
        index: candles.length - 1,
        time: lastCandle.time,
        price: exitPrice,
        reason: "SIGNAL_END",
      };
      trade.profitPips = pipsDelta;
      trade.profit = grossUsd - commission;
      trade.duration = candles.length - 1 - (meta?.entryIndex ?? trade.entry.index);

      const tracker = tradeTrackers.get(trade);
      trade.maxDrawdownPips = tracker?.maxDrawdown ?? 0;
      trade.maxProfitPips = tracker?.maxProfit ?? 0;

      currentBalance += trade.profit;
    }
    activeTrades.length = 0;

    // Punto de equity final con las closures del último día
    if (currentBalance > maxBalance) maxBalance = currentBalance;
    const finalDD = (maxBalance - currentBalance) / maxBalance;
    if (finalDD > maxDrawdown) maxDrawdown = finalDD;
    equityCurve.push({
      time: lastCandle.time,
      equity: currentBalance,
      highWaterMark: maxBalance,
      drawdownPercentage: finalDD * 100,
    });
  }

  return { trades, equityCurve };
}
