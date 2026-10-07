// ============================================================
// src/backtest/metrics.ts
// Calculador de métricas profesionales de trading
// Sharpe, Sortino, Calmar, SQN, Monte Carlo, etc.
// ============================================================

import {
  Trade,
  EquityPoint,
  PerformanceMetrics,
  MonteCarloResult,
  BacktestConfig,
  SetupMetrics,
  HourMetrics,
} from "./types.js";

/** Calcula métricas de rendimiento para un conjunto de trades */
export function calculateMetrics(
  trades: Trade[],
  equityCurve: EquityPoint[],
  config: BacktestConfig
): PerformanceMetrics {
  if (trades.length === 0) {
    return getEmptyMetrics();
  }

  // === Estadísticas Básicas ===
  const winners = trades.filter((t) => t.profit > 0);
  const losers = trades.filter((t) => t.profit <= 0);

  const totalTrades = trades.length;
  const winRate = (winners.length / totalTrades) * 100;
  const lossRate = (losers.length / totalTrades) * 100;

  const totalProfit = trades.reduce((sum, t) => sum + t.profit, 0);
  const totalReturn = (totalProfit / config.initialBalance) * 100;

  const avgWin = winners.length > 0 ?
    winners.reduce((sum, t) => sum + t.profit, 0) / winners.length : 0;
  const avgLoss = losers.length > 0 ?
    losers.reduce((sum, t) => sum + t.profit, 0) / losers.length : 0;

  const winLossRatio = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0;

  const largestWin = winners.length > 0 ?
    Math.max(...winners.map((t) => t.profit)) : 0;
  const largestLoss = losers.length > 0 ?
    Math.min(...losers.map((t) => t.profit)) : 0;

  // === Expectancy ===
  const expectancy = (winRate / 100 * avgWin) + (lossRate / 100 * avgLoss);
  const expectancyRatio = avgLoss !== 0 ?
    expectancy / Math.abs(avgLoss) : 0;

  // === Max Drawdown ===
  let maxDrawdown = 0;
  let maxDrawdownAmount = 0;
  let maxDrawdownStart = 0;
  let maxDrawdownEnd = 0;
  let peak = config.initialBalance;
  const peakIndices: number[] = [];

  for (let i = 0; i < equityCurve.length; i++) {
    if (equityCurve[i].equity > peak) {
      peak = equityCurve[i].equity;
      peakIndices.push(i);
    }

    const drawdown = (peak - equityCurve[i].equity) / peak;
    const drawdownAmount = peak - equityCurve[i].equity;

    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
      maxDrawdownAmount = drawdownAmount;
      maxDrawdownStart = peakIndices[peakIndices.length - 1] || 0;
      maxDrawdownEnd = i;
    }
  }

  const maxDrawdownDuration = maxDrawdownEnd - maxDrawdownStart;

  // === Annualized Return (CAGR) ===
  const firstTime = equityCurve[0]?.time;
  const lastTime = equityCurve[equityCurve.length - 1]?.time;
  const years = firstTime && lastTime ?
    (lastTime.getTime() - firstTime.getTime()) / (365.25 * 24 * 60 * 60 * 1000) : 0;

  const annualizedReturn = years > 0 ?
    ((Math.pow((config.initialBalance + totalProfit) / config.initialBalance, 1 / years) - 1) * 100) : 0;

  // === Sharpe Ratio ===
  // Monthly returns para calcular Sharpe
  const monthlyReturns = calculateMonthlyReturns(equityCurve);
  const avgMonthlyReturn = monthlyReturns.length > 0 ?
    monthlyReturns.reduce((a, b) => a + b, 0) / monthlyReturns.length : 0;
  const monthlyStdDev = calculateStdDev(monthlyReturns, avgMonthlyReturn);
  const annualizedStdDev = monthlyStdDev * Math.sqrt(12);
  const sharpeRatio = annualizedStdDev !== 0 ?
    annualizedReturn / annualizedStdDev : 0;

  // === Sortino Ratio ===
  const downsideReturns = monthlyReturns.filter((r) => r < 0);
  const avgDownside = downsideReturns.length > 0 ?
    downsideReturns.reduce((a, b) => a + b, 0) / downsideReturns.length : 0;
  const downsideStdDev = calculateStdDev(downsideReturns, avgDownside);
  const annualizedDownside = downsideStdDev * Math.sqrt(12);
  const sortinoRatio = annualizedDownside !== 0 ?
    (annualizedReturn - 2) / annualizedDownside : 0; // 2% tasa libre de riesgo

  // === Calmar Ratio ===
  const calmarRatio = maxDrawdown !== 0 ?
    annualizedReturn / (maxDrawdown * 100) : 0;

  // === Profit Factor ===
  const grossProfit = winners.reduce((sum, t) => sum + t.profit, 0);
  const grossLoss = Math.abs(losers.reduce((sum, t) => sum + t.profit, 0));
  const profitFactor = grossLoss !== 0 ? grossProfit / grossLoss : grossProfit;

  // === Recovery Factor ===
  const recoveryFactor = maxDrawdownAmount !== 0 ?
    totalProfit / maxDrawdownAmount : totalProfit;

  // === SQN (System Quality Number) - Van Tharp ===
  const tradesPnl = trades.map((t) => t.profit / (t.maxDrawdownPips || 1)); // en R mults
  const avgR = tradesPnl.reduce((a, b) => a + b, 0) / tradesPnl.length;
  const stdDevR = calculateStdDev(tradesPnl, avgR);
  const sqn = stdDevR !== 0 ?
    Math.sqrt(tradesPnl.length) * (avgR / stdDevR) : 0;

  // === Duración ===
  const avgTradeDuration = trades.reduce((sum, t) => sum + t.duration, 0) / trades.length;
  const avgWinDuration = winners.length > 0 ?
    winners.reduce((sum, t) => sum + t.duration, 0) / winners.length : 0;
  const avgLossDuration = losers.length > 0 ?
    losers.reduce((sum, t) => sum + t.duration, 0) / losers.length : 0;

  // === Consecutive ===
  const { maxConsecutiveWins, maxConsecutiveLosses } =
    calculateConsecutiveStats(trades);
  const { avgConsecutiveWins, avgConsecutiveLosses } =
    calculateAvgConsecutiveStats(trades);

  // === Underwater Analysis ===
  const underwaterDays = equityCurve.filter(
    (e) => e.drawdownPercentage > 0
  ).length;
  const underwaterPercentage = (underwaterDays / equityCurve.length) * 100;

  // === Métricas por Setup ===
  const metricsBySetup = calculateMetricsBySetup(trades);

  // === Métricas por Hora (EST) ===
  const metricsByHour = calculateMetricsByHour(trades);

  return {
    totalReturn,
    totalProfit,
    annualizedReturn,
    maxDrawdown: maxDrawdown * 100,
    maxDrawdownAmount,
    maxDrawdownDuration,
    sharpeRatio,
    sortinoRatio,
    calmarRatio,
    profitFactor,
    recoveryFactor,
    totalTrades,
    winRate,
    lossRate,
    avgWin,
    avgLoss,
    winLossRatio,
    largestWin,
    largestLoss,
    avgTrade: expectancy,
    expectancy: expectancyRatio,
    sqn,
    avgTradeDuration,
    avgWinDuration,
    avgLossDuration,
    maxConsecutiveWins,
    maxConsecutiveLosses,
    avgConsecutiveWins,
    avgConsecutiveLosses,
    underwaterDays,
    underwaterPercentage,
    metricsBySetup,
    metricsByHour,
  };
}

/** Calcula métricas por tipo de setup */
function calculateMetricsBySetup(trades: Trade[]): Record<string, SetupMetrics> {
  const bySetup: Record<string, Trade[]> = {};

  for (const trade of trades) {
    if (!bySetup[trade.setupType]) bySetup[trade.setupType] = [];
    bySetup[trade.setupType].push(trade);
  }

  const metrics: Record<string, SetupMetrics> = {};
  for (const [setup, setupTrades] of Object.entries(bySetup)) {
    const winners = setupTrades.filter((t) => t.profit > 0);
    const profit = setupTrades.reduce((sum, t) => sum + t.profit, 0);

    metrics[setup] = {
      count: setupTrades.length,
      wins: winners.length,
      losses: setupTrades.length - winners.length,
      winRate: winners.length / setupTrades.length * 100,
      avgWin: winners.length > 0 ?
        winners.reduce((sum, t) => sum + t.profit, 0) / winners.length : 0,
      avgLoss: setupTrades.length > winners.length ?
        setupTrades.filter((t) => t.profit <= 0)
          .reduce((sum, t) => sum + t.profit, 0) /
        (setupTrades.length - winners.length) : 0,
      totalProfit: profit,
      expectancy: setupTrades.length > 0 ? profit / setupTrades.length : 0,
    };
  }

  return metrics;
}

/** Calcula métricas por hora del día */
function calculateMetricsByHour(trades: Trade[]): Record<number, HourMetrics> {
  const byHour: Record<number, Trade[]> = {};

  for (const trade of trades) {
    const estHour = (trade.entry.time.getUTCHours() - 5 + 24) % 24;
    if (!byHour[estHour]) byHour[estHour] = [];
    byHour[estHour].push(trade);
  }

  const metrics: Record<number, HourMetrics> = {};
  for (let hour = 0; hour < 24; hour++) {
    const hourTrades = byHour[hour] || [];
    if (hourTrades.length === 0) continue;

    const winners = hourTrades.filter((t) => t.profit > 0);
    const profit = hourTrades.reduce((sum, t) => sum + t.profit, 0);

    metrics[hour] = {
      hour,
      count: hourTrades.length,
      winRate: winners.length / hourTrades.length * 100,
      avgProfit: profit / hourTrades.length,
    };
  }

  return metrics;
}

/** Simulación Monte Carlo
 *  rng inyectable (Task 10-b, §7 reproducibilidad): el motor pasa un PRNG
 *  sembrado (mulberry32) para que la misma seed + mismos trades den SIEMPRE
 *  el mismo resultado. Además el shuffle original `sort(() => Math.random()-0.5)`
 *  estaba SESGADO (no produce permutaciones uniformes) → Fisher-Yates real. */
export function monteCarloSimulation(
  trades: Trade[],
  config: BacktestConfig,
  iterations: number = 10000,
  rng: () => number = Math.random
): MonteCarloResult {
  const initialBalance = config.initialBalance;
  const tradePnL = trades.map((t) => t.profit);

  const finalEquities: number[] = [];
  const drawdowns: number[] = [];
  const profitFactors: number[] = [];
  const profitable: boolean[] = [];

  for (let i = 0; i < iterations; i++) {
    // Desordenar trades aleatoriamente: Fisher-Yates con el PRNG inyectado
    // (permutación uniforme, determinista si rng está sembrado)
    const shuffled = [...tradePnL];
    for (let j = shuffled.length - 1; j > 0; j--) {
      const k = Math.floor(rng() * (j + 1));
      const tmp = shuffled[j];
      shuffled[j] = shuffled[k];
      shuffled[k] = tmp;
    }

    let equity = initialBalance;
    let peak = initialBalance;
    let maxDD = 0;

    for (const pnl of shuffled) {
      equity += pnl;
      if (equity > peak) peak = equity;
      const dd = (peak - equity) / peak;
      if (dd > maxDD) maxDD = dd;
    }

    // Calcular profit factor para esta simulación
    const wins = shuffled.filter((p) => p > 0).reduce((a, b) => a + b, 0);
    const losses = Math.abs(shuffled.filter((p) => p < 0).reduce((a, b) => a + b, 0));
    const pf = losses > 0 ? wins / losses : wins;

    finalEquities.push(equity);
    drawdowns.push(maxDD);
    profitFactors.push(pf);
    profitable.push(equity > initialBalance);
  }

  // Percentiles
  const sortedEquity = [...finalEquities].sort((a, b) => a - b);
  const sortedDD = [...drawdowns].sort((a, b) => a - b);
  const sortedPF = [...profitFactors].sort((a, b) => a - b);

  const getPercentile = (arr: number[], p: number) =>
    arr[Math.floor((p / 100) * arr.length)];

  const ruinThreshold = 0.5; // 50% drawdown = ruin
  const riskOfRuin = drawdowns.filter((d) => d > ruinThreshold).length / iterations;

  return {
    iterations,
    finalEquity: {
      mean: finalEquities.reduce((a, b) => a + b, 0) / iterations,
      median: getPercentile(sortedEquity, 50),
      worst: Math.min(...finalEquities),
      best: Math.max(...finalEquities),
      percentiles: {
        5: getPercentile(sortedEquity, 5),
        10: getPercentile(sortedEquity, 10),
        25: getPercentile(sortedEquity, 25),
        75: getPercentile(sortedEquity, 75),
        90: getPercentile(sortedEquity, 90),
        95: getPercentile(sortedEquity, 95),
      },
    },
    drawdown: {
      mean: drawdowns.reduce((a, b) => a + b, 0) / iterations * 100,
      worst: Math.max(...drawdowns) * 100,
      percentiles: {
        5: getPercentile(sortedDD, 5) * 100,
        10: getPercentile(sortedDD, 10) * 100,
        50: getPercentile(sortedDD, 50) * 100,
        90: getPercentile(sortedDD, 90) * 100,
        95: getPercentile(sortedDD, 95) * 100,
      },
    },
    profitFactor: {
      mean: profitFactors.reduce((a, b) => a + b, 0) / iterations,
      percentiles: {
        5: getPercentile(sortedPF, 5),
        50: getPercentile(sortedPF, 50),
        95: getPercentile(sortedPF, 95),
      },
    },
    riskOfRuin: riskOfRuin * 100,
    probabilityOfProfit: profitable.filter((p) => p).length / iterations * 100,
  };
}

/** Calcula Buy & Hold benchmark */
export function calculateBuyHold(
  candles: { open: number; close: number }[],
  config: BacktestConfig
): { return: number; drawdown: number } {
  if (candles.length < 2) return { return: 0, drawdown: 0 };

  const buyPrice = candles[0].open;
  const sellPrice = candles[candles.length - 1].close;
  const totalReturn = ((sellPrice - buyPrice) / buyPrice) * 100;

  // Buy & Hold max drawdown
  let peak = candles[0].close;
  let maxDD = 0;

  for (const c of candles) {
    if (c.close > peak) peak = c.close;
    const dd = (peak - c.close) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  return { return: totalReturn, drawdown: maxDD * 100 };
}

// === Helpers ===

function calculateMonthlyReturns(equityCurve: EquityPoint[]): number[] {
  const returns: number[] = [];
  if (equityCurve.length < 2) return returns;

  let monthStart = equityCurve[0].equity;
  let currentMonth = equityCurve[0].time.getUTCMonth();

  for (let i = 1; i < equityCurve.length; i++) {
    const point = equityCurve[i];
    if (point.time.getUTCMonth() !== currentMonth) {
      const monthlyReturn = (point.equity - monthStart) / monthStart * 100;
      returns.push(monthlyReturn);
      monthStart = point.equity;
      currentMonth = point.time.getUTCMonth();
    }
  }

  return returns;
}

function calculateStdDev(values: number[], mean: number): number {
  if (values.length < 2) return 0;
  const squaredDiffs = values.map((v) => Math.pow(v - mean, 2));
  const avgSquaredDiff = squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(avgSquaredDiff);
}

function calculateConsecutiveStats(trades: Trade[]): { maxConsecutiveWins: number; maxConsecutiveLosses: number } {
  let maxWins = 0;
  let maxLosses = 0;
  let currentStreak = 0;

  for (const trade of trades) {
    if (trade.profit > 0) {
      currentStreak = currentStreak > 0 ? currentStreak + 1 : 1;
      maxWins = Math.max(maxWins, currentStreak);
    } else {
      currentStreak = currentStreak < 0 ? currentStreak - 1 : -1;
      maxLosses = Math.max(maxLosses, Math.abs(currentStreak));
    }
  }

  return { maxConsecutiveWins: maxWins, maxConsecutiveLosses: maxLosses };
}

function calculateAvgConsecutiveStats(trades: Trade[]): { avgConsecutiveWins: number; avgConsecutiveLosses: number } {
  const streaks: { wins: number[]; losses: number[] } = { wins: [], losses: [] };
  let currentStreak = 0;

  for (const trade of trades) {
    if (trade.profit > 0) {
      if (currentStreak < 0) streaks.losses.push(Math.abs(currentStreak));
      currentStreak = currentStreak > 0 ? currentStreak + 1 : 1;
    } else {
      if (currentStreak > 0) streaks.wins.push(currentStreak);
      currentStreak = currentStreak < 0 ? currentStreak - 1 : -1;
    }
  }

  // Agregar última racha
  if (currentStreak > 0) streaks.wins.push(currentStreak);
  else if (currentStreak < 0) streaks.losses.push(Math.abs(currentStreak));

  return {
    avgConsecutiveWins: streaks.wins.length > 0 ?
      streaks.wins.reduce((a, b) => a + b, 0) / streaks.wins.length : 0,
    avgConsecutiveLosses: streaks.losses.length > 0 ?
      streaks.losses.reduce((a, b) => a + b, 0) / streaks.losses.length : 0,
  };
}

function getEmptyMetrics(): PerformanceMetrics {
  return {
    totalReturn: 0,
    totalProfit: 0,
    annualizedReturn: 0,
    maxDrawdown: 0,
    maxDrawdownAmount: 0,
    maxDrawdownDuration: 0,
    sharpeRatio: 0,
    sortinoRatio: 0,
    calmarRatio: 0,
    profitFactor: 0,
    recoveryFactor: 0,
    totalTrades: 0,
    winRate: 0,
    lossRate: 0,
    avgWin: 0,
    avgLoss: 0,
    winLossRatio: 0,
    largestWin: 0,
    largestLoss: 0,
    avgTrade: 0,
    expectancy: 0,
    sqn: 0,
    avgTradeDuration: 0,
    avgWinDuration: 0,
    avgLossDuration: 0,
    maxConsecutiveWins: 0,
    maxConsecutiveLosses: 0,
    avgConsecutiveWins: 0,
    avgConsecutiveLosses: 0,
    underwaterDays: 0,
    underwaterPercentage: 0,
    metricsBySetup: {},
    metricsByHour: {},
  };
}
