// ============================================================
// src/backtest/index.ts
// Módulo unificado de backtesting profesional
// Exporta todo el sistema de backtesting
// ============================================================

// ═══════════════════════════════════════════════════════════
// MOTOR PRINCIPAL
// ═══════════════════════════════════════════════════════════

export { BacktestEngine, type BacktestEngineConfig } from "./engine.js";

// ═══════════════════════════════════════════════════════════
// DETECTORES SMC
// ═══════════════════════════════════════════════════════════

export {
  SMCDetector,
  type SMCState,
  type SMCStructure,
  processCandles,
  detectFVGs,
  detectSwingPoints,
  detectStructureShifts,
  associateFVGsWithSetups,
  calculateRVOL,
  isNYKillzone,
  isValidSetup,
} from "./smc_detector.js";

// ═══════════════════════════════════════════════════════════
// SIMULACIÓN
// ═══════════════════════════════════════════════════════════

export { TradeSimulator, simulateTrades } from "./simulator.js";

// ═══════════════════════════════════════════════════════════
// MÉTRICAS
// ═══════════════════════════════════════════════════════════

export {
  MetricsCalculator,
  calculateMetrics,
  monteCarloSimulation,
  calculateBuyHold,
} from "./metrics.js";

// ═══════════════════════════════════════════════════════════
// REPORTES
// ═══════════════════════════════════════════════════════════

export { ReportGenerator, generateHTMLReport } from "./report_generator.js";

// ═══════════════════════════════════════════════════════════
// WALK-FORWARD ANALYSIS (Anti-Overfitting)
// ═══════════════════════════════════════════════════════════

export { WalkForwardAnalyzer } from "./walk_forward.js";

// ═══════════════════════════════════════════════════════════
// PORTFOLIO BACKTESTING (Multi-Asset)
// ═══════════════════════════════════════════════════════════

export { PortfolioBacktester } from "./portfolio.js";

// ═══════════════════════════════════════════════════════════
// REGIME DETECTION (Trending vs Ranging)
// ═══════════════════════════════════════════════════════════

export {
  RegimeAnalyzer,
  RegimeDetector,
} from "./regime.js";

// ═══════════════════════════════════════════════════════════
// STRESS TESTING (Anti-Fragility)
// ═══════════════════════════════════════════════════════════

export {
  StressTestEngine,
  generateStressReport,
  HISTORICAL_SCENARIOS,
} from "./stress_test.js";
export type {
  StressScenario,
  StressResult,
  StressedResult,
  StressedTrade,
  StressedMetrics,
} from "./stress_test.js";

// ═══════════════════════════════════════════════════════════
// TIPOS
// ═══════════════════════════════════════════════════════════

export type {
  // Candles
  RawCandle,
  ProcessedCandle,

  // SMC
  SMCStructure,
  FVG,
  SwingPoint,
  SMCSetup,
  SMCState,
  BOSChange,
  ChoCh,

  // Trading
  Trade,
  TradeDirection,
  TradeResult,

  // Configuración
  BacktestConfig,
  BacktestEngineConfig,

  // Métricas
  PerformanceMetrics,
  SetupMetrics,
  HourMetrics,

  // Monte Carlo
  MonteCarloResult,

  // Resultados
  BacktestResult,
  EquityPoint,
  BenchmarkResult,
  HeatmapData,
  ReportOptions,

  // WFA
  WFAWindow,
  WFAResult,

  // Portfolio
  PortfolioConfig,
  PortfolioPosition,
  PortfolioResult,

  // Regime
  MarketRegime,
  RegimeConfig,
  RegimeState,
  RegimeStats,

  // Stress Testing
  StressScenario,
  StressResult,
  StressedResult,
  StressedTrade,
  StressedMetrics,
  StressEventType,
  StressedEquityImpact,
  StressedRisk,
  StressSummary,
} from "./types.js";
