// ============================================================
// src/backtest/index.ts
// Módulo unificado de backtesting profesional
// Exporta el sistema de backtesting
//
// FIX (auditoría 9-g): el barrel re-exportaba símbolos inexistentes
// (SMCDetector, MetricsCalculator, TradeSimulator, ReportGenerator,
// SMCState, BOSChange, ChoCh, TradeDirection, TradeResult,
// BenchmarkResult…), lo que generaba 36 errores tsc y CRASHEABA el
// import de TODO el módulo (TS2305 al cargar index.js).
// Ahora solo se exportan símbolos que existen de verdad.
// ============================================================

// ═══════════════════════════════════════════════════════════
// MOTOR PRINCIPAL + §7 REPRODUCIBILIDAD
// ═══════════════════════════════════════════════════════════

export {
  BacktestEngine,
  buildRunManifest,
  persistBacktestManifest,
  computeCandlesHash,
  seedFromHash,
  mulberry32,
  verdictHeader,
  CODE_VERSION,
  type BacktestEngineConfig,
  type BacktestRunManifest,
  type BacktestVerdict,
} from "./engine.js";

// ═══════════════════════════════════════════════════════════
// DETECTORES SMC
// ═══════════════════════════════════════════════════════════

export {
  SWING_LOOKBACK,
  processCandles,
  detectFVGs,
  detectSwingPoints,
  detectStructureShifts,
  associateFVGsWithSetups,
  isNYKillzone,
  isValidSetup,
} from "./smc_detector.js";

// ═══════════════════════════════════════════════════════════
// SIMULACIÓN
// ═══════════════════════════════════════════════════════════

export {
  simulateTrades,
  resolvePipSize,
  resolvePipValueUSD,
  DEFAULT_FRICTION,
  type FrictionConfig,
} from "./simulator.js";

// ═══════════════════════════════════════════════════════════
// MÉTRICAS
// ═══════════════════════════════════════════════════════════

export {
  calculateMetrics,
  monteCarloSimulation,
  calculateBuyHold,
} from "./metrics.js";

// ═══════════════════════════════════════════════════════════
// REPORTES
// ═══════════════════════════════════════════════════════════

export { generateHTMLReport, type ReportOptions } from "./report_generator.js";

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

// ═══════════════════════════════════════════════════════════
// TIPOS (solo los declarados de verdad en types.ts)
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

  // Trading
  Trade,

  // Configuración
  BacktestConfig,

  // Métricas
  PerformanceMetrics,
  SetupMetrics,
  HourMetrics,

  // Monte Carlo
  MonteCarloResult,

  // Resultados
  BacktestResult,
  EquityPoint,
  HeatmapData,

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
  StressEventType,
  StressScenario,
  StressedMetrics,
  StressedEquityImpact,
  StressedRisk,
  StressSummary,
  StressResult,
  StressedResult,
  StressedTrade,
} from "./types.js";
