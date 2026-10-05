// ============================================================
// src/backtest/engine.ts
// Motor principal de backtesting - Orquesta todo
// ============================================================

import {
  BacktestConfig,
  BacktestResult,
  RawCandle,
  Trade,
  EquityPoint,
} from "./types.js";
import {
  processCandles,
  detectFVGs,
  detectSwingPoints,
  detectStructureShifts,
  associateFVGsWithSetups,
} from "./smc_detector.js";
import { simulateTrades } from "./simulator.js";
import {
  calculateMetrics,
  monteCarloSimulation,
  calculateBuyHold,
} from "./metrics.js";
import { generateHTMLReport, ReportOptions } from "./report_generator.js";

export interface BacktestEngineConfig {
  // Configuración de límites
  maxCandlesToProcess?: number; // Por defecto 5000
  enableMonteCarlo?: boolean; // Por defecto true
  monteCarloIterations?: number; // Por defecto 10000
  reportOutputDir?: string; // Directorio para reportes HTML
}

/** Clase principal del motor de backtesting */
export class BacktestEngine {
  private config: BacktestEngineConfig;

  constructor(config: BacktestEngineConfig = {}) {
    this.config = {
      maxCandlesToProcess: config.maxCandlesToProcess ?? 5000,
      enableMonteCarlo: config.enableMonteCarlo ?? true,
      monteCarloIterations: config.monteCarloIterations ?? 10000,
      reportOutputDir: config.reportOutputDir ?? "./data/backtest_reports",
    };
  }

  /**
   * Ejecuta un backtest completo
   */
  async runBacktest(
    rawCandles: RawCandle[],
    backtestConfig: BacktestConfig
  ): Promise<BacktestResult> {
    console.log(`
🚀 Iniciando Backtest Pro
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Activo: ${backtestConfig.asset}
Timeframe: ${backtestConfig.timeframe}
Período: ${backtestConfig.startDate.toLocaleDateString()} → ${backtestConfig.endDate.toLocaleDateString()}
Balance Inicial: $${backtestConfig.initialBalance.toLocaleString()}
Risk/Trade: ${backtestConfig.riskPerTrade}%
TP Ratio: 1:${backtestConfig.tpRatio}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    `);

    // Limitar cantidad de velas para performance
    const limitedCandles = rawCandles.slice(-this.config.maxCandlesToProcess!);

    // ─────────────────────────────
    // FASE 1: Preprocesamiento
    // ─────────────────────────────
    console.log("📊 Fase 1: Preprocesando velas...");
    const processedCandles = processCandles(limitedCandles);
    const volumes = processedCandles.map((c) => c.tickVolume);
    console.log(`   ✓ ${processedCandles.length} velas procesadas`);

    // ─────────────────────────────
    // FASE 2: Detección SMC
    // ─────────────────────────────
    console.log("🔍 Fase 2: Detectando estructuras SMC...");

    const fvgs = detectFVGs(processedCandles);
    console.log(`   ✓ ${fvgs.length} Fair Value Gaps detectados`);

    const swings = detectSwingPoints(processedCandles, 5);
    console.log(`   ✓ ${swings.length} Swing Points detectados`);

    const setups = detectStructureShifts(processedCandles, swings, volumes);
    console.log(`   ✓ ${setups.length} Setups detectados (${setups.filter((s) => s.type === "BOS").length} BOS, ${setups.filter((s) => s.type === "ChoCh").length} ChoCh)`);

    const setupsWithFVG = associateFVGsWithSetups(setups, fvgs);
    const validSetups = setupsWithFVG.filter((s) => s.confidence > 0.5);
    console.log(`   ✓ ${validSetups.length} setups con alta confianza (>0.5)`);

    // ─────────────────────────────
    // FASE 3: Simulación
    // ─────────────────────────────
    console.log("💰 Fase 3: Simulando trades...");
    const { trades, equityCurve } = simulateTrades(
      processedCandles,
      validSetups,
      backtestConfig
    );
    console.log(`   ✓ ${trades.length} trades simulados`);

    // ─────────────────────────────
    // FASE 4: Métricas
    // ─────────────────────────────
    console.log("📈 Fase 4: Calculando métricas...");
    const metrics = calculateMetrics(trades, equityCurve, backtestConfig);
    console.log(`   ✓ Win Rate: ${metrics.winRate.toFixed(1)}%`);
    console.log(`   ✓ Total Return: ${metrics.totalReturn.toFixed(2)}%`);
    console.log(`   ✓ Sharpe Ratio: ${metrics.sharpeRatio.toFixed(2)}`);
    console.log(`   ✓ Max Drawdown: ${metrics.maxDrawdown.toFixed(2)}%`);

    // ─────────────────────────────
    // FASE 5: Monte Carlo
    // ─────────────────────────────
    let monteCarlo = undefined;
    if (this.config.enableMonteCarlo && trades.length > 10) {
      console.log("🎲 Fase 5: Simulando Monte Carlo...");
      monteCarlo = monteCarloSimulation(
        trades,
        backtestConfig,
        this.config.monteCarloIterations
      );
      console.log(`   ✓ Risk of Ruin: ${monteCarlo.riskOfRuin.toFixed(1)}%`);
      console.log(`   ✓ Prob. Profit: ${monteCarlo.probabilityOfProfit.toFixed(1)}%`);
    }

    // ─────────────────────────────
    // FASE 6: Benchmarks
    // ─────────────────────────────
    const benchmarks = calculateBuyHold(processedCandles, backtestConfig);
    console.log(`   ✓ Buy & Hold Return: ${benchmarks.return.toFixed(2)}%`);
    console.log(`   ✓ Alpha v/s B&H: ${(metrics.totalReturn - benchmarks.return).toFixed(2)}%`);

    // ─────────────────────────────
    // RESULTADO
    // ─────────────────────────────
    const result: BacktestResult = {
      config: backtestConfig,
      trades,
      equityCurve,
      metrics,
      monteCarlo,
      benchmarks,
      timeExecuted: new Date(),
    };

    console.log(`
✅ Backtest Completado
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    `);

    return result;
  }

  /**
   * Genera un reporte HTML profesional
   */
  generateReport(
    result: BacktestResult,
    includeTrades: boolean = false
  ): string {
    const reportPath = generateHTMLReport(result, {
      outputDir: this.config.reportOutputDir!,
      includeTrades,
      includeMonteCarlo: !!result.monteCarlo,
      theme: "dark",
    });

    console.log(`
📄 Reporte HTML generado:
   ${reportPath}
    `);

    return reportPath;
  }

  /**
   * Ejecuta un backtest con datos de ejemplo (para pruebas)
   */
  async runDemoBacktest(): Promise<BacktestResult> {
    // Generar datos de ejemplo sencillos
    const rawCandles: RawCandle[] = [];
    const startDate = new Date("2024-01-01");
    let price = 35000;

    for (let i = 0; i < 500; i++) {
      const date = new Date(startDate);
      date.setMinutes(i * 15); // M15

      const volatility = price * 0.001; // 0.1% volatility
      const change = (Math.random() - 0.5) * volatility;

      const open = price;
      const close = price + change;
      const high = Math.max(open, close) + Math.random() * volatility * 0.5;
      const low = Math.min(open, close) - Math.random() * volatility * 0.5;

      rawCandles.push({
        time: date.toISOString(),
        open,
        high,
        low,
        close,
        tickVolume: Math.floor(Math.random() * 1000) + 500,
        realVolume: Math.floor(Math.random() * 5000) + 1000,
        spread: 0.1,
      });

      price = close;
    }

    const config: BacktestConfig = {
      asset: "US30",
      timeframe: "M15",
      startDate: startDate,
      endDate: new Date(rawCandles[rawCandles.length - 1].time),
      initialBalance: 10000,
      riskPerTrade: 1.0,
      rvolThreshold: 1.2,
      slMultiplier: 1.0,
      tpRatio: 3.0,
      maxSlPips: 15,
      requireFVG: true,
      requireKillzone: false,
      allowHedging: false,
      maxConcurrentTrades: 1,
    };

    return this.runBacktest(rawCandles, config);
  }
}

// Exportar funciones auxiliares también
export {
  processCandles,
  detectFVGs,
  detectSwingPoints,
  detectStructureShifts,
  associateFVGsWithSetups,
  simulateTrades,
  calculateMetrics,
  monteCarloSimulation,
  calculateBuyHold,
  generateHTMLReport,
};
