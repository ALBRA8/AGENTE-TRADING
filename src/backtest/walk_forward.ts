// ============================================================
// src/backtest/walk_forward.ts
// Walk-Forward Analysis - El estándar oro contra overfitting
// Divide datos en múltiples períodos de entrenamiento/prueba
// ============================================================

import type { BacktestResult, BacktestConfig, RawCandle, WFAWindow, WFAResult } from "./types.js";
import { BacktestEngine } from "./engine.js";
import { MetricsCalculator } from "./metrics.js";

interface WFAOptions {
  // Tamaño de ventana de entrenamiento (ej: 6 meses)
  trainWindow: "1M" | "3M" | "6M" | "1Y";
  // Tamaño de ventana de prueba (ej: 2 meses)
  testWindow: "1W" | "2W" | "1M" | "2M";
  // Cuánto overlap entre ventanas (0 = no overlap, 0.5 = 50%)
  overlap: number;
  // Parámetros a optimizar en cada ventana de train
  paramGrid: {
    tpRatio: number[];
    requireFVG: boolean[];
    rvolThreshold: number[];
    riskPerTrade: number[];
  };
  // Métrica objetivo para optimizar (sqn, sharpe, profitFactor)
  optimizationMetric: "sqn" | "sharpeRatio" | "profitFactor";
  // Umbral mínimo para considerar una ventana "válida"
  minAcceptableMetric: number;
}

interface OptimizedParams {
  tpRatio: number;
  requireFVG: boolean;
  rvolThreshold: number;
  riskPerTrade: number;
  score: number;
}

export class WalkForwardAnalyzer {
  private engine: BacktestEngine;
  private metricsCalc: MetricsCalculator;

  constructor() {
    this.engine = new BacktestEngine({ enableMonteCarlo: false });
    this.metricsCalc = new MetricsCalculator();
  }

  /**
   * Ejecuta Walk-Forward Analysis completo
   * Para cada ventana:
   * 1. Optimiza parámetros en train data (grid search)
   * 2. Corre backtest con parámetros óptimos en test data
   * 3. Guarda resultados
   */
  async runWFA(
    candles: RawCandle[],
    baseConfig: BacktestConfig,
    options: WFAOptions
  ): Promise<WFAResult> {
    const windows = this.generateWindows(candles, options);
    const results: WFAWindow[] = [];

    console.log(`\n🔄 Walk-Forward Analysis: ${windows.length} ventanas`);
    console.log(`   Train: ${options.trainWindow} | Test: ${options.testWindow}`);
    console.log(`   Optimizando: ${options.optimizationMetric}\n`);

    for (let i = 0; i < windows.length; i++) {
      const w = windows[i];
      console.log(`\n📊 Ventana ${i + 1}/${windows.length}`);
      console.log(`   Train: ${w.trainStart.toLocaleDateString()} → ${w.trainEnd.toLocaleDateString()}`);
      console.log(`   Test:  ${w.testStart.toLocaleDateString()} → ${w.testEnd.toLocaleDateString()}`);

      // Fase 1: Optimización en train data
      console.log("   [1/3] Optimizando parámetros...");
      const optimized = await this.optimizeWindow(w.trainCandles, baseConfig, options);

      // Fase 2: Backtest en test data con parámetros óptimos
      console.log("   [2/3] Testeando en datos OOS...");
      const testResult = await this.runOptimized(
        w.testCandles,
        baseConfig,
        optimized
      );

      // Fase 3: Revisar consistencia (aller-test en train con params óptimos)
      console.log("   [3/3] Validando consistencia...");
      const trainResult = await this.runOptimized(
        w.trainCandles,
        baseConfig,
        optimized
      );

      const windowResult: WFAWindow = {
        id: i + 1,
        trainPeriod: { start: w.trainStart, end: w.trainEnd },
        testPeriod: { start: w.testStart, end: w.testEnd },
        optimizedParams: optimized,
        trainMetrics: trainResult.metrics,
        testMetrics: testResult.metrics,
        consistencyScore: this.calculateConsistency(trainResult.metrics, testResult.metrics),
        isValid: testResult.metrics.sqn >= options.minAcceptableMetric,
      };

      results.push(windowResult);

      // Log resumen de esta ventana
      this.logWindowSummary(windowResult);
    }

    // Análisis final de robustez
    const finalAnalysis = this.analyzeWFAResults(results, options);

    return {
      windows: results,
      summary: finalAnalysis,
      isRobust: finalAnalysis.robustnessScore >= 0.7,
      recommendation: this.generateRecommendation(finalAnalysis),
    };
  }

  /**
   * Genera ventanas train/test según opciones
   */
  private generateWindows(
    candles: RawCandle[],
    options: WFAOptions
  ): Array<{
    trainStart: Date;
    trainEnd: Date;
    testStart: Date;
    testEnd: Date;
    trainCandles: RawCandle[];
    testCandles: RawCandle[];
  }> {
    const trainMs = this.parseTimeWindow(options.trainWindow);
    const testMs = this.parseTimeWindow(options.testWindow);
    const stepMs = trainMs + testMs - Math.floor(trainMs * options.overlap);

    const windows = [];
    const totalStart = new Date(candles[0].time).getTime();
    const totalEnd = new Date(candles[candles.length - 1].time).getTime();

    let currentStart = totalStart;

    while (currentStart + trainMs + testMs <= totalEnd) {
      const trainStart = new Date(currentStart);
      const trainEnd = new Date(currentStart + trainMs);
      const testStart = trainEnd;
      const testEnd = new Date(currentStart + trainMs + testMs);

      const trainCandles = candles.filter(
        (c) => new Date(c.time) >= trainStart && new Date(c.time) < trainEnd
      );
      const testCandles = candles.filter(
        (c) => new Date(c.time) >= testStart && new Date(c.time) <= testEnd
      );

      if (trainCandles.length > 100 && testCandles.length > 20) {
        windows.push({
          trainStart,
          trainEnd,
          testStart,
          testEnd,
          trainCandles,
          testCandles,
        });
      }

      currentStart += stepMs;
    }

    return windows;
  }

  /**
   * Optimización de parámetros por grid search en una ventana
   */
  private async optimizeWindow(
    trainCandles: RawCandle[],
    baseConfig: BacktestConfig,
    options: WFAOptions
  ): Promise<OptimizedParams> {
    let bestScore = -Infinity;
    let bestParams: OptimizedParams | null = null;

    const { tpRatio, requireFVG, rvolThreshold, riskPerTrade } = options.paramGrid;
    const totalCombinations =
      tpRatio.length * requireFVG.length * rvolThreshold.length * riskPerTrade.length;

    let tested = 0;

    for (const tp of tpRatio) {
      for (const fvg of requireFVG) {
        for (const rv of rvolThreshold) {
          for (const risk of riskPerTrade) {
            const config: BacktestConfig = {
              ...baseConfig,
              tpRatio: tp,
              requireFVG: fvg,
              rvolThreshold: rv,
              riskPerTrade: risk,
            };

            const result = await this.engine.runBacktest(trainCandles, config);
            const score = result.metrics[options.optimizationMetric];

            if (score > bestScore) {
              bestScore = score;
              bestParams = {
                tpRatio: tp,
                requireFVG: fvg,
                rvolThreshold: rv,
                riskPerTrade: risk,
                score,
              };
            }

            tested++;
          }
        }
      }
    }

    return bestParams!;
  }

  /**
   * Corre backtest con parámetros optimizados
   */
  private async runOptimized(
    candles: RawCandle[],
    baseConfig: BacktestConfig,
    params: OptimizedParams
  ): Promise<BacktestResult> {
    const config: BacktestConfig = {
      ...baseConfig,
      tpRatio: params.tpRatio,
      requireFVG: params.requireFVG,
      rvolThreshold: params.rvolThreshold,
      riskPerTrade: params.riskPerTrade,
    };

    return this.engine.runBacktest(candles, config);
  }

  /**
   * Calcula consistencia entre train y test
   * Valor 1.0 = perfecta consistencia, 0.0 = total inconsistencia
   */
  private calculateConsistency(
    trainMetrics: BacktestResult["metrics"],
    testMetrics: BacktestResult["metrics"]
  ): number {
    const metrics = ["winRate", "profitFactor", "sqn", "sharpeRatio"];
    let totalScore = 0;

    for (const m of metrics) {
      const trainVal = trainMetrics[m as keyof typeof trainMetrics] as number;
      const testVal = testMetrics[m as keyof typeof testMetrics] as number;

      if (trainVal === 0) continue;

      // Ratio de consistencia (más cerca de 1 es mejor)
      const ratio = Math.min(testVal, trainVal) / Math.max(testVal, trainVal);
      totalScore += ratio;
    }

    return totalScore / metrics.length;
  }

  /**
   * Analiza resultados de todas las ventanas
   */
  private analyzeWFAResults(windows: WFAWindow[], options: WFAOptions): WFAResult["summary"] {
    const testMetrics = windows.map((w) => w.testMetrics);
    const validWindows = windows.filter((w) => w.isValid);

    // Métricas agregadas de test
    const avgTestSQN =
      testMetrics.reduce((a, m) => a + m.sqn, 0) / testMetrics.length;
    const avgTestPF =
      testMetrics.reduce((a, m) => a + m.profitFactor, 0) / testMetrics.length;
    const avgTestSharpe =
      testMetrics.reduce((a, m) => a + m.sharpeRatio, 0) / testMetrics.length;
    const avgConsistency =
      windows.reduce((a, w) => a + w.consistencyScore, 0) / windows.length;

    // Estabilidad de parámetros optimizados
    const paramStability = {
      tpRatio: this.calculateParamStability(windows, "tpRatio"),
      requireFVG: this.calculateParamStability(windows, "requireFVG"),
      rvolThreshold: this.calculateParamStability(windows, "rvolThreshold"),
    };

    // Robustness Score (0-1)
    const robustnessScore =
      // 40%: Cuántas ventanas pasaron el umbral
      0.4 * (validWindows.length / windows.length) +
      // 30%: Consistencia promedio
      0.3 * avgConsistency +
      // 30%: Estabilidad de parámetros
      0.3 *
        ((paramStability.tpRatio +
          paramStability.requireFVG +
          paramStability.rvolThreshold) /
          3);

    return {
      totalWindows: windows.length,
      validWindows: validWindows.length,
      robustnessScore,
      averageTestSQN: avgTestSQN,
      averageTestProfitFactor: avgTestPF,
      averageTestSharpe: avgTestSharpe,
      averageConsistency: avgConsistency,
      parameterStability: paramStability,
      worstWindow: windows.reduce((min, w) =>
        w.testMetrics.sqn < min.testMetrics.sqn ? w : min
      ),
      bestWindow: windows.reduce((max, w) =>
        w.testMetrics.sqn > max.testMetrics.sqn ? w : max
      ),
    };
  }

  private calculateParamStability<K extends keyof OptimizedParams>(
    windows: WFAWindow[],
    param: K
  ): number {
    const values = windows.map((w) => w.optimizedParams[param]);

    if (typeof values[0] === "boolean") {
      // Para booleanos, proporción del valor más común
      const trueCount = values.filter((v) => v === true).length;
      return Math.max(trueCount, values.length - trueCount) / values.length;
    }

    // Para numéricos, coeficiente de variación inverso
    const numeric = values as number[];
    const mean = numeric.reduce((a, b) => a + b) / numeric.length;
    const variance = numeric.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / numeric.length;
    const cv = Math.sqrt(variance) / mean; // Coeficiente de variación
    return Math.max(0, 1 - cv); // 1 = perfecta estabilidad, 0 = volátil
  }

  private generateRecommendation(analysis: WFAResult["summary"]): string {
    if (analysis.robustnessScore >= 0.8) {
      return "✅ Sistema ROBUSTO. Listo para trading con capital moderado.";
    }
    if (analysis.robustnessScore >= 0.6) {
      return "🟡 Sistema ACEPTABLE. Usar con precaución, monitorear closely.";
    }
    if (analysis.validWindows / analysis.totalWindows < 0.5) {
      return "🔴 Sistema DÉBIL. Demasiadas ventanas fallaron. Revisar lógica.";
    }
    if (analysis.parameterStability.tpRatio < 0.5) {
      return "⚠️ Parámetros INESTABLES. Considerar fijar tpRatio y testear de nuevo.";
    }
    return "🔴 Sistema NO ROBUSTO. Risk of overfitting alto. NO usar en live.";
  }

  private logWindowSummary(window: WFAWindow): void {
    const m = window.testMetrics;
    const status = window.isValid ? "✅" : "⚠️";

    console.log(`\n   ${status} Ventana ${window.id}`);
    console.log(
      `       Train: SQN ${window.trainMetrics.sqn.toFixed(2)} → Test: SQN ${m.sqn.toFixed(2)}`
    );
    console.log(
      `       Consistencia: ${(window.consistencyScore * 100).toFixed(0)}% | ` +
        `WR: ${m.winRate.toFixed(1)}% | PF: ${m.profitFactor.toFixed(2)}`
    );
    console.log(
      `       Params: TP=${window.optimizedParams.tpRatio}, FVG=${window.optimizedParams.requireFVG}, RV=${window.optimizedParams.rvolThreshold}`
    );
  }

  private parseTimeWindow(window: string): number {
    const units: Record<string, number> = {
      W: 7 * 24 * 60 * 60 * 1000,
      M: 30 * 24 * 60 * 60 * 1000,
      Y: 365 * 24 * 60 * 60 * 1000,
    };

    const match = window.match(/(\d+)([WMY])/);
    if (!match) throw new Error(`Invalid time window: ${window}`);

    const [, num, unit] = match;
    return parseInt(num) * units[unit];
  }
}
