// ============================================================
// src/backtest/simulator.ts
// Motor de simulación: ejecuta trades basado en setups SMC
// ============================================================

import {
  ProcessedCandle,
  SMCSetup,
  Trade,
  BacktestConfig,
  EquityPoint,
} from "./types.js";
import { isNYKillzone, isValidSetup } from "./smc_detector.js";

/** Calcula el lotaje basado en riesgo */
function calculateLotSize(
  stopLossPips: number,
  riskPercentage: number,
  currentBalance: number,
  symbol: string
): { lotSize: number; riskAmount: number } {
  const riskAmount = currentBalance * (riskPercentage / 100);

  // Pip value según activo (simplificado para US30)
  let pipValue = 1.0; // USD por pip para US30 (0.01 = 1 pip)
  if (symbol.includes("JPY")) pipValue = 0.01;
  if (symbol.includes("BTC")) pipValue = 1.0;
  if (symbol.includes("XAU")) pipValue = 10.0;

  // Risk amount = Lot * StopLossPips * PipValue
  // Lot = RiskAmount / (StopLossPips * PipValue)
  const lotSize = riskAmount / (stopLossPips * pipValue);

  // Redondear a 2 decimales (0.01 lotes)
  return {
    lotSize: Math.max(0.01, Math.floor(lotSize * 100) / 100),
    riskAmount,
  };
}

/** Calcula Stop Loss dinámico por activo */
function calculateStopLoss(
  entryPrice: number,
  direction: "LONG" | "SHORT",
  config: BacktestConfig,
  setup: SMCSetup
): { stopLoss: number; stopLossPips: number } {
  const isIndex = config.asset.includes("30") || config.asset.includes("100");
  const isCrypto = config.asset.includes("BTC");
  const isGold = config.asset.includes("XAU");
  const isJPY = config.asset.includes("JPY");

  // Digits según activo
  const digits = isIndex || isCrypto ? 2 : isJPY ? 3 : 5;
  const pipSize = digits === 2 ? 1 : digits === 3 ? 0.01 : 0.0001;

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

  return { stopLoss, stopLossPips };
}

/** Simula ejecución de trades basado en setups */
export function simulateTrades(
  candles: ProcessedCandle[],
  setups: SMCSetup[],
  config: BacktestConfig
): { trades: Trade[]; equityCurve: EquityPoint[] } {
  const trades: Trade[] = [];
  const equityCurve: EquityPoint[] = [];

  let currentBalance = config.initialBalance;
  let maxBalance = config.initialBalance;
  let maxDrawdown = 0;

  const activeTrades: Trade[] = [];

  // Tracking de MAE/MFE durante el trade
  const tradeTrackers = new Map<number, { maxDrawdown: number; maxProfit: number }>();

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    const candleTime = candle.time;

    // Buscar setups en esta vela
    const setupsInCandle = setups.filter((s) => s.index === i);

    for (const setup of setupsInCandle) {
      // Validar filtros
      if (
        !isValidSetup(setup, {
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

      // Determinar dirección
      const direction: "LONG" | "SHORT" =
        setup.direction === "BULLISH" ? "LONG" : "SHORT";

      // Calcular entry (usar close de la vela de setup)
      const entryPrice = candle.close;

      // Calcular SL
      const { stopLoss, stopLossPips } = calculateStopLoss(
        entryPrice,
        direction,
        config,
        setup
      );

      // Calcular TP (RR ratio)
      const tpDistance = stopLossPips * config.tpRatio;
      const takeProfit =
        direction === "LONG"
          ? entryPrice + tpDistance * (stopLossPips > 100 ? 0.01 : 0.0001)
          : entryPrice - tpDistance * (stopLossPips > 100 ? 0.01 : 0.0001);

      // Calcular lotaje
      const { lotSize, riskAmount } = calculateLotSize(
        stopLossPips,
        config.riskPerTrade,
        currentBalance,
        config.asset
      );

      const trade: Trade = {
        entry: setup,
        exit: {
          index: i,
          time: candleTime,
          price: entryPrice,
          reason: "SIGNAL_END", // se actualizará
        },
        direction,
        entryPrice,
        stopLoss,
        takeProfit,
        volume: lotSize,
        profit: 0,
        profitPips: 0,
        duration: 0,
        riskPercentage: config.riskPerTrade,
        setupType: setup.type + (setup.fvg ? "_FVG" : ""),
        maxDrawdownPips: 0,
        maxProfitPips: 0,
      };

      activeTrades.push(trade);
      tradeTrackers.set(trades.length, { maxDrawdown: 0, maxProfit: 0 });
      trades.push(trade);
    }

    // Actualizar trades activos
    for (const trade of activeTrades) {
      const tracker = tradeTrackers.get(trades.indexOf(trade));

      // Calcular profit actual (en pips)
      const currentPips =
        trade.direction === "LONG"
          ? (candle.close - trade.entryPrice) /
            (trade.entryPrice > 1000 ? 0.01 : 0.0001)
          : (trade.entryPrice - candle.close) /
            (trade.entryPrice > 1000 ? 0.01 : 0.0001);

      // Actualizar MAE/MFE
      if (currentPips < 0) {
        if (tracker) tracker.maxDrawdown = Math.max(tracker.maxDrawdown, -currentPips);
      } else {
        if (tracker) tracker.maxProfit = Math.max(tracker.maxProfit, currentPips);
      }

      // Verificar SL touch
      const slHit =
        trade.direction === "LONG"
          ? candle.low <= trade.stopLoss
          : candle.high >= trade.stopLoss;

      // Verificar TP touch
      const tpHit =
        trade.direction === "LONG"
          ? candle.high >= trade.takeProfit
          : candle.low <= trade.takeProfit;

      // Time exit si pasa mucho tiempo sin moverse (30 velas = criterio simple)
      const barsSinceEntry = i - trade.entry.index;
      const timeExit =
        barsSinceEntry > 30 &&
        ((trade.direction === "LONG" && candle.close < trade.entryPrice) ||
          (trade.direction === "SHORT" && candle.close > trade.entryPrice));

      if (slHit) {
        // Stop Loss ejecutado
        const exitTracker = tradeTrackers.get(trades.indexOf(trade));
        trade.exit = {
          index: i,
          time: candleTime,
          price: trade.stopLoss,
          reason: "SL_HIT",
        };
        trade.profitPips = -trade.stopLossPips;
        trade.maxDrawdownPips = exitTracker?.maxDrawdown || trade.stopLossPips;
        trade.maxProfitPips = exitTracker?.maxProfit || 0;

        // Calcular profit en moneda
        const pipValue =
          config.asset.includes("XAU") ? 10 : config.asset.includes("BTC") ? 1 : 1;
        trade.profit = -riskAmount;
        trade.duration = barsSinceEntry;

        currentBalance += trade.profit;
      } else if (tpHit) {
        // Take Profit ejecutado
        const exitTracker = tradeTrackers.get(trades.indexOf(trade));
        trade.exit = {
          index: i,
          time: candleTime,
          price: trade.takeProfit,
          reason: "TP_HIT",
        };
        trade.profitPips = config.tpRatio * trade.stopLossPips;
        trade.maxDrawdownPips = exitTracker?.maxDrawdown || 0;
        trade.maxProfitPips = trade.profitPips;

        // Calcular profit en moneda (RR * risk)
        trade.profit = trade.riskPercentage * config.tpRatio * (currentBalance / 100);
        trade.duration = barsSinceEntry;

        currentBalance += trade.profit;
      } else if (timeExit) {
        // Time-based exit
        const exitTracker = tradeTrackers.get(trades.indexOf(trade));
        const profitPips =
          trade.direction === "LONG"
            ? (candle.close - trade.entryPrice) / (trade.entryPrice > 1000 ? 0.01 : 0.0001)
            : (trade.entryPrice - candle.close) / (trade.entryPrice > 1000 ? 0.01 : 0.0001);

        trade.exit = {
          index: i,
          time: candleTime,
          price: candle.close,
          reason: "TIMEOUT",
        };
        trade.profitPips = profitPips;
        trade.maxDrawdownPips = exitTracker?.maxDrawdown || Math.abs(Math.min(profitPips, 0));
        trade.maxProfitPips = exitTracker?.maxProfit || Math.max(profitPips, 0);

        trade.profit = (profitPips / trade.stopLossPips) * riskAmount;
        trade.duration = barsSinceEntry;

        currentBalance += trade.profit;
      }
    }

    // Limpiar trades cerrados de activeTrades
    const closedTrades = activeTrades.filter((t) => t.exit.reason !== "SIGNAL_END");
    for (const closed of closedTrades) {
      const index = activeTrades.indexOf(closed);
      if (index > -1) activeTrades.splice(index, 1);
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

  // Cerrar trades que quedaron abiertos al final del período
  const lastCandle = candles[candles.length - 1];
  for (const trade of activeTrades) {
    const profitPips =
      trade.direction === "LONG"
        ? (lastCandle.close - trade.entryPrice) / (trade.entryPrice > 1000 ? 0.01 : 0.0001)
        : (trade.entryPrice - lastCandle.close) / (trade.entryPrice > 1000 ? 0.01 : 0.0001);

    trade.exit = {
      index: candles.length - 1,
      time: lastCandle.time,
      price: lastCandle.close,
      reason: "SIGNAL_END",
    };
    trade.profitPips = profitPips;
    trade.profit = (profitPips / trade.stopLossPips) * riskAmount;
    trade.duration = candles.length - 1 - trade.entry.index;
  }

  return { trades, equityCurve };
}
