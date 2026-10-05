// ============================================================
// src/backtest/types.ts
// Tipos para el sistema de backtesting profesional
// ============================================================

export interface RawCandle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  tickVolume: number;
  realVolume: number;
  spread: number;
}

export interface ProcessedCandle {
  time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  tickVolume: number;
  up: boolean; // true if close > open
  body: number; // |close - open|
  wickTop: number; // high - max(open, close)
  wickBottom: number; // min(open, close) - low
  range: number; // high - low
}

export enum SMCStructure {
  BOS = "BOS", // Break of Structure
  ChoCh = "ChoCh", // Change of Character
  NEUTRAL = "NEUTRAL"
}

export interface FVG {
  startIndex: number;
  endIndex: number;
  startTime: Date;
  endTime: Date;
  type: "BULLISH" | "BEARISH";
  top: number;
  bottom: number;
  isMitigated: boolean;
  mitigationIndex?: number;
}

export interface SwingPoint {
  index: number;
  time: Date;
  price: number;
  type: "HIGH" | "LOW";
}

export interface SMCSetup {
  index: number;
  time: Date;
  type: SMCStructure;
  direction: "BULLISH" | "BEARISH";
  price: number;
  confidence: number; // 0-1 based on volume/structure
  fvg?: FVG; // Associated Fair Value Gap
  swingPoints: SwingPoint[];
  rvol: number; // Relative Volume
}

export interface Trade {
  entry: SMCSetup;
  exit: {
    index: number;
    time: Date;
    price: number;
    reason: "TP_HIT" | "SL_HIT" | "SIGNAL_END" | "TIMEOUT";
  };
  direction: "LONG" | "SHORT";
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  volume: number;
  profit: number; // in currency
  profitPips: number;
  duration: number; // in minutes
  riskPercentage: number;
  setupType: string; // "BOS", "ChoCh", "FVG_CONFIRMED", etc.
  maxDrawdownPips: number; // Maximum adverse excursion during trade
  maxProfitPips: number; // Maximum favorable excursion during trade
}

export interface BacktestConfig {
  asset: string;
  timeframe: "M1" | "M5" | "M15" | "H1" | "H4";
  startDate: Date;
  endDate: Date;
  initialBalance: number;
  riskPerTrade: number; // % del balance
  rvolThreshold: number; // default 1.5
  slMultiplier: number; // Stop Loss como múltiplo del setup (default 1.0)
  tpRatio: number; // Take Profit ratio (default 3.0 for 1:3)
  maxSlPips: number; // Máximo SL dinámico por activo
  requireFVG: boolean; // Requerir FVG para entrada
  requireKillzone: boolean; // Solo operar en Killzone NY
  allowHedging: boolean; // Permitir trades en ambas direcciones
  maxConcurrentTrades: number; // Máximo de trades simultáneos
}

export interface PerformanceMetrics {
  // Retorno
  totalReturn: number; // %
  totalProfit: number; // en moneda
  annualizedReturn: number; // CAGR

  // Riesgo
  maxDrawdown: number; // % del peak
  maxDrawdownAmount: number; // en moneda
  maxDrawdownDuration: number; // días

  // Ratios
  sharpeRatio: number;
  sortinoRatio: number;
  calmarRatio: number;
  profitFactor: number;
  recoveryFactor: number;

  // Trade statistics
  totalTrades: number;
  winRate: number; // %
  lossRate: number; // %
  avgWin: number; // en moneda
  avgLoss: number; // en moneda
  winLossRatio: number; // |avgWin| / |avgLoss|
  largestWin: number;
  largestLoss: number;
  avgTrade: number; // Expectancy en moneda
  expectancy: number; // Expectancy en RR
  sqn: number; // System Quality Number (Van Tharp)

  // Duración
  avgTradeDuration: number; // minutos
  avgWinDuration: number;
  avgLossDuration: number;

  // Consecución
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  avgConsecutiveWins: number;
  avgConsecutiveLosses: number;

  // Drawdowns
  underwaterDays: number; // días bajo peak
  underwaterPercentage: number; // % del tiempo

  // Por setup
  metricsBySetup: Record<string, SetupMetrics>;

  // Por hora
  metricsByHour: Record<number, HourMetrics>;
}

export interface SetupMetrics {
  count: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  totalProfit: number;
  expectancy: number;
}

export interface HourMetrics {
  hour: number; // 0-23 EST
  count: number;
  winRate: number;
  avgProfit: number;
}

export interface MonteCarloResult {
  iterations: number;
  finalEquity: {
    mean: number;
    median: number;
    worst: number;
    best: number;
    percentiles: Record<number, number>; // 5th, 10th, 25th, 75th, 90th, 95th
  };
  drawdown: {
    mean: number;
    worst: number;
    percentiles: Record<number, number>;
  };
  profitFactor: {
    mean: number;
    percentiles: Record<number, number>;
  };
  riskOfRuin: number; // % de simulaciones con drawdown > 50%
  probabilityOfProfit: number; // % de simulaciones con profit > 0
}

export interface BacktestResult {
  config: BacktestConfig;
  trades: Trade[];
  equityCurve: EquityPoint[];
  metrics: PerformanceMetrics;
  monteCarlo?: MonteCarloResult;
  benchmarks: {
    buyHold: number; // % retorno buy & hold
    buyHoldDrawdown: number;
  };
  timeExecuted: Date;
}

export interface EquityPoint {
  time: Date;
  equity: number;
  highWaterMark: number;
  drawdownPercentage: number;
  openTrade?: Trade;
}

export interface HeatmapData {
  setupVsHour: number[][];
  dayOfWeek: number[];
  rvolVsResult: number[];
}

// ═══════════════════════════════════════════════════════════
// WALK-FORWARD ANALYSIS TYPES
// ═══════════════════════════════════════════════════════════

export interface WFAWindow {
  id: number;
  trainPeriod: { start: Date; end: Date };
  testPeriod: { start: Date; end: Date };
  optimizedParams: {
    tpRatio: number;
    requireFVG: boolean;
    rvolThreshold: number;
    riskPerTrade: number;
    score: number;
  };
  trainMetrics: PerformanceMetrics;
  testMetrics: PerformanceMetrics;
  consistencyScore: number; // 0-1
  isValid: boolean;
}

export interface WFAResult {
  windows: WFAWindow[];
  summary: {
    totalWindows: number;
    validWindows: number;
    robustnessScore: number; // 0-1
    averageTestSQN: number;
    averageTestProfitFactor: number;
    averageTestSharpe: number;
    averageConsistency: number;
    parameterStability: {
      tpRatio: number;
      requireFVG: number;
      rvolThreshold: number;
    };
    worstWindow: WFAWindow;
    bestWindow: WFAWindow;
  };
  isRobust: boolean;
  recommendation: string;
}

// ═══════════════════════════════════════════════════════════
// PORTFOLIO BACKTEST TYPES
// ═══════════════════════════════════════════════════════════

export interface PortfolioConfig {
  assets: string[];
  primary: string; // Asset principal para correlación
  equalWeight: boolean;
  maxPositionSize: number; // % máximo por posición
  correlationThreshold: number; // Skip si correlación > threshold
  rebalanceFrequency: "daily" | "weekly" | "monthly";
}

export interface PortfolioPosition {
  asset: string;
  direction: "long" | "short";
  size: number; // en % del portfolio
  entryPrice: number;
  unrealizedPnL: number;
}

export interface PortfolioResult {
  asset: string;
  trades: Trade[];
  metrics: PerformanceMetrics;
  correlationWithPrimary: number;
  contributionToPortfolio: number; // % del retorno total
  riskContribution: number; // % del riesgo total
}

// ═══════════════════════════════════════════════════════════
// REGIME DETECTION TYPES
// ═══════════════════════════════════════════════════════════

export type MarketRegime = "trending_up" | "trending_down" | "ranging" | "volatile" | "low_volatility";

export interface RegimeConfig {
  adxThreshold: number;        // > 25 = trending
  adxTrending: number;         // > 40 = strong trend
  atrPeriod: number;          // Período para ATR
  volatilityPercentile: number; // P80 = high vol, P20 = low vol
  lookback: number;           // Velas para cálculo
}

export interface RegimeState {
  regime: MarketRegime;
  adx: number;
  atr: number;
  volatility: number;         // ATR como % del precio
  trendDirection: "up" | "down" | "neutral";
  confidence: number;         // 0-1
  since: Date;               // Cuándo empezó este régimen
  duration: number;            // Velas en este régimen
}

export interface RegimeStats {
  byRegime: Record<MarketRegime, {
    trades: number;
    winRate: number;
    profitFactor: number;
    avgReturn: number;
  }>;
  bestRegime: MarketRegime;
  worstRegime: MarketRegime;
  regimeTransitions: Array<{
    from: MarketRegime;
    to: MarketRegime;
    count: number;
    avgReturnAfter: number;
  }>;
}

// ═══════════════════════════════════════════════════════════
// STRESS TESTING TYPES
// ═══════════════════════════════════════════════════════════

export type StressEventType = "gap_overnight" | "flash_crash" | "volatility_spike" | "illiquidity" | "slippage_surge";

export interface StressScenario {
  id: string;
  name: string;
  description: string;
  eventType: StressEventType;
  probability: number; // Probabilidad histórica por año
  marketConditions: {
    gapPercent?: number;
    volatilityMultiplier?: number;
    spreadMultiplier?: number;
    slippagePercent?: number;
    liquidityMultiplier?: number;
    executionDelay?: number;
    priceSpike?: number;
    recoveryTime?: number;
    liquidationCascad?: boolean;
  };
}

export interface StressedMetrics {
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  sharpeRatio: number;
  maxDrawdown: number;
  recoveryFactor: number;
  breakevenPace: number;
}

export interface StressedTrade extends Trade {
  originalPnL: number;
  stressedPnL: number;
  slippageApplied: number;
  gapApplied?: number;
  executionDelayed?: boolean;
  scenarioApplied: string;
}

export interface StressedEquityImpact {
  finalEquity: number;
  maxDrawdown: number;
  drawdownDuration: number;
  recoveryTime: number;
  timeUnderWater: number;
}

export interface StressedRisk {
  riskOfRuin: number;
  tailRisk: number;
  var95: number;
  var99: number;
}

export interface StressedResult {
  scenario: StressScenario;
  affectedTrades: StressedTrade[];
  metrics: StressedMetrics;
  equityImpact: StressedEquityImpact;
  risk: StressedRisk;
}

export interface StressSummary {
  worstScenario: string;
  worstDrawdown: number;
  avgDrawdown: number;
  capitalAtRisk: number;
  survivalRate: number;
  recommendedBuffer: number;
}

export interface StressResult {
  scenarios: StressScenario[];
  baseline: BacktestResult;
  stressed: Record<string, StressedResult>;
  summary: StressSummary;
  recommendations: string[];
}
