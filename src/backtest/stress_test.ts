// ============================================================
// src/backtest/stress_test.ts
// Stress Testing - Simula condiciones extremas del mercado
// Basado en eventos reales: Flash Crash 2010, Brexit 2016, COVID 2020
// ============================================================

import type {
  RawCandle,
  BacktestConfig,
  BacktestResult,
  Trade,
  PerformanceMetrics,
} from "./types.js";
import { BacktestEngine } from "./engine.js";

// ═══════════════════════════════════════════════════════════
// TIPOS (Importados de types.ts)
// ═══════════════════════════════════════════════════════════

import type { StressScenario, StressResult, StressedResult, StressedTrade, StressedMetrics } from "./types.js";

// ═══════════════════════════════════════════════════════════
// SCENARIOS REALISTAS (Basados en eventos históricos)
// ═══════════════════════════════════════════════════════════

export const HISTORICAL_SCENARIOS: StressScenario[] = [
  {
    id: "flash_crash_2010",
    name: "Flash Crash May 2010",
    description: "Crash del 9% en minutos, recuperación parcial en 24h",
    eventType: "flash_crash",
    probability: 0.02, // 2% de años
    marketConditions: {
      priceSpike: -0.09,
      volatilityMultiplier: 5.0,
      slippagePercent: 0.03,   // 300 pips slippage
      liquidationCascad: true, // Stop hunts en cascada
      recoveryTime: 48,        // 48 velas M15 (12 horas)
    },
  },
  {
    id: "brexit_2016",
    name: "Brexit Gap",
    description: "Gap de -8% overnight, alta volatilidad por 3 días",
    eventType: "gap_overnight",
    probability: 0.03,
    marketConditions: {
      gapPercent: -0.08,
      spreadMultiplier: 10.0,
      volatilityMultiplier: 4.0,
      slippagePercent: 0.02,
      liquidityMultiplier: 0.2,
    },
  },
  {
    id: "covid_crash_2020",
    name: "COVID Market Crash",
    description: "Crash del 35% en 3 semanas, VIX spike",
    eventType: "volatility_spike",
    probability: 0.05,
    marketConditions: {
      volatilityMultiplier: 8.0,
      spreadMultiplier: 5.0,
      slippagePercent: 0.04,
      recoveryTime: 240, // 10 días de velas H1
    },
  },
  {
    id: "russell_rebalance",
    name: "Index Rebalance",
    description: "Russell/S&P rebalance con congestion y slippage",
    eventType: "illiquidity",
    probability: 0.04, // 4 veces al año
    marketConditions: {
      liquidityMultiplier: 0.15,
      slippagePercent: 0.015,
      executionDelay: 3000,   // 3 segundos
      spreadMultiplier: 3.0,
    },
  },
  {
    id: "vix_spike_2018",
    name: "Volatility Event 2018",
    description: "VIX explosion +400% en un día, XIV collapse",
    eventType: "volatility_spike",
    probability: 0.03,
    marketConditions: {
      volatilityMultiplier: 6.0,
      priceSpike: -0.04,
      slippagePercent: 0.025,
      executionDelay: 5000,
      recoveryTime: 32,
    },
  },
  {
    id: "war_gap",
    name: "Geopolitical Shock",
    description: "Gap de apertura por evento geopolítico",
    eventType: "gap_overnight",
    probability: 0.02,
    marketConditions: {
      gapPercent: -0.05,
      volatilityMultiplier: 3.0,
      spreadMultiplier: 4.0,
    },
  },
  {
    id: "circuit_breaker",
    name: "Limit Down/Circuit Breaker",
    description: "Mercado pausado tras caída > 7%",
    eventType: "flash_crash",
    probability: 0.015,
    marketConditions: {
      priceSpike: -0.07,
      slippagePercent: 0.05,  // 500 pips!
      liquidityMultiplier: 0.05, // Casi nada de liquidez
      recoveryTime: 96,        // 4 horas
    },
  },
  {
    id: "low_liquidity",
    name: "Holiday Trading",
    description: "Liquidez mínima en días festivos",
    eventType: "illiquidity",
    probability: 0.10, // 10% de días
    marketConditions: {
      liquidityMultiplier: 0.25,
      spreadMultiplier: 2.5,
      slippagePercent: 0.01,
    },
  },
];

// ═══════════════════════════════════════════════════════════
// STRESS TEST ENGINE
// ═══════════════════════════════════════════════════════════

export class StressTestEngine {
  private baselineEngine: BacktestEngine;

  constructor(
    private scenarios: StressScenario[] = HISTORICAL_SCENARIOS,
    options?: { enableMonteCarlo?: boolean }
  ) {
    this.baselineEngine = new BacktestEngine(options);
  }

  /**
   * Ejecuta stress testing completo
   * Compara baseline vs cada scenario
   */
  async runStressTest(
    candles: RawCandle[],
    config: BacktestConfig
  ): Promise<StressResult> {
    console.log("\n🧪 Iniciando Stress Testing");
    console.log(`   Scenarios: ${this.scenarios.length}`);
    console.log(`   Candles: ${candles.length}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

    // Paso 1: Baseline - backtest normal
    console.log("📊 Fase 1: Baseline (condiciones normales)");
    const baseline = await this.baselineEngine.runBacktest(candles, config);
    
    console.log(`   Trades: ${baseline.metrics.totalTrades}`);
    console.log(`   Win Rate: ${baseline.metrics.winRate.toFixed(1)}%`);
    console.log(`   Max DD: ${baseline.metrics.maxDrawdown.toFixed(2)}%`);
    console.log(`   SQN: ${baseline.metrics.sqn.toFixed(2)}\n`);

    // Paso 2: Opcional - generar scenarios aleatorios
    const allScenarios = [...this.scenarios, ...this.generateRandomScenarios(5)];

    // Paso 3: Run cada scenario
    console.log("📊 Fase 2: Simulando escenarios de estrés\n");
    const stressedResults: Record<string, StressedResult> = {};

    for (const scenario of allScenarios) {
      console.log(`   🎯 ${scenario.name}...`);
      const result = await this.applyScenario(candles, config, baseline, scenario);
      stressedResults[scenario.id] = result;
      this.logScenarioResult(result);
    }

    // Paso 4: Análisis consolidado
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📈 Análisis Final de Estrés\n");
    const summary = this.generateSummary(baseline, stressedResults);
    const recommendations = this.generateRecommendations(summary, stressedResults);

    return {
      scenarios: allScenarios,
      baseline,
      stressed: stressedResults,
      summary,
      recommendations,
    };
  }

  /**
   * Aplica un scenario específico al backtest
   */
  private async applyScenario(
    candles: RawCandle[],
    config: BacktestConfig,
    baseline: BacktestResult,
    scenario: StressScenario
  ): Promise<StressedResult> {
    // Clonar trades del baseline y aplicar estrés
    const stressedTrades = baseline.trades.map((trade) => {
      return this.applyStressToTrade(trade, scenario);
    });

    // Recalcular métricas con trades estresados
    const metrics = this.calculateStressedMetrics(stressedTrades, baseline, scenario);

    // Calcular equity impact
    let equity = baseline.equityCurve[0].equity;
    let peak = equity;
    let maxDrawdown = 0;
    let drawdownStart: Date | null = null;
    let maxDdDuration = 0;
    let currentDdDuration = 0;

    const stressedEquity: number[] = [];

    for (const trade of stressedTrades) {
      equity += trade.stressedPnL;
      stressedEquity.push(equity);

      if (equity > peak) {
        peak = equity;
        if (drawdownStart) {
          currentDdDuration = 0;
          drawdownStart = null;
        }
      } else {
        if (!drawdownStart) {
          drawdownStart = trade.exitTime;
        }
        currentDdDuration++;
        maxDdDuration = Math.max(maxDdDuration, currentDdDuration);

        const dd = ((peak - equity) / peak) * 100;
        if (dd > maxDrawdown) {
          maxDrawdown = dd;
        }
      }
    }

    // Calcular recovery time
    const recoveryTime = this.calculateRecoveryTime(stressedEquity, maxDrawdown);

    // Calcular risk metrics
    const returns = stressedEquity.map((e, i) => 
      i === 0 ? 0 : (e - stressedEquity[i - 1]) / stressedEquity[i - 1]
    ).slice(1);

    const riskMetrics = this.calculateRiskMetrics(returns, config.initialBalance, stressedEquity);

    return {
      scenario,
      affectedTrades: stressedTrades,
      metrics,
      equityImpact: {
        finalEquity: equity,
        maxDrawdown,
        drawdownDuration: maxDdDuration,
        recoveryTime: recoveryTime.candles,
        timeUnderWater: recoveryTime.totalUnderWater,
      },
      risk: riskMetrics,
    };
  }

  /**
   * Aplica estrés a un trade individual
   */
  private applyStressToTrade(
    trade: Trade,
    scenario: StressScenario
  ): StressedTrade {
    const stressed: StressedTrade = {
      ...trade,
      originalPnL: trade.netPnL,
      stressedPnL: trade.netPnL,
      slippageApplied: 0,
      scenarioApplied: scenario.id,
    };

    const conditions = scenario.marketConditions;

    // Aplicar slippage
    if (conditions.slippagePercent) {
      const slippageCost = trade.initialBalance * conditions.slippagePercent;
      stressed.slippageApplied = slippageCost;
      stressed.stressedPnL -= slippageCost;
    }

    // Aplicar gap (si el trade estaba expuesto overnight)
    if (conditions.gapPercent && this.isOvernightTrade(trade)) {
      const gapImpact = trade.initialBalance * Math.abs(conditions.gapPercent);
      // Gap contra la posición
      const direction = trade.direction === "long" ? 1 : -1;
      const gapAgainst = conditions.gapPercent * direction < 0;
      
      if (gapAgainst) {
        stressed.gapApplied = -gapImpact;
        stressed.stressedPnL -= gapImpact;
      } else {
        stressed.gapApplied = gapImpact * 0.5; // Beneficio parcial
        stressed.stressedPnL += gapImpact * 0.5;
      }
    }

    // Ejecución delayada (puede causar entrada peor)
    if (conditions.executionDelay && Math.random() < 0.3) {
      const delayPenality = trade.grossPnL * 0.15; // 15% peor fill
      stressed.stressedPnL -= delayPenality;
      stressed.executionDelayed = true;
    }

    // Re-evaluar resultado
    if (stressed.stressedPnL > 0) {
      stressed.result = "win";
    } else if (stressed.stressedPnL < 0) {
      stressed.result = "loss";
    } else {
      stressed.result = "breakeven";
    }

    stressed.netPnL = stressed.stressedPnL;

    return stressed;
  }

  /**
   * Determina si un trade estaba expuesto overnight
   */
  private isOvernightTrade(trade: Trade): boolean {
    const entryHour = trade.entryTime.getHours();
    const exitHour = trade.exitTime.getHours();
    
    // Trade que cruza cierre de mercado (22:00 EST para índices)
    return (entryHour >= 20 || entryHour <= 9) && (exitHour >= 20 || exitHour <= 9);
  }

  /**
   * Calcula métricas estresadas
   */
  private calculateStressedMetrics(
    trades: StressedTrade[],
    baseline: BacktestResult,
    scenario: StressScenario
  ): StressedMetrics {
    const wins = trades.filter((t) => t.result === "win");
    const losses = trades.filter((t) => t.result === "loss");

    const grossWin = wins.reduce((a, t) => a + t.stressedPnL, 0);
    const grossLoss = Math.abs(losses.reduce((a, t) => a + t.stressedPnL, 0));

    const equity = trades.map((t) => t.stressedPnL).reduce((a, b) => a + b, baseline.equityCurve[0].equity);
    const equitySeries = [equity];
    for (const t of trades) {
      equitySeries.push(equitySeries[equitySeries.length - 1] + t.stressedPnL);
    }

    // Max drawdown
    let peak = equitySeries[0];
    let maxDD = 0;
    for (const e of equitySeries) {
      if (e > peak) peak = e;
      const dd = ((peak - e) / peak) * 100;
      maxDD = Math.max(maxDD, dd);
    }

    return {
      totalTrades: trades.length,
      winRate: (wins.length / trades.length) * 100,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0,
      sharpeRatio: this.calculateSharpe(equitySeries),
      maxDrawdown: maxDD,
      recoveryFactor: maxDD > 0 ? Math.abs((equity - equitySeries[0]) / maxDD) : 999,
      breakevenPace: this.calculateBreakevenPace(trades),
    };
  }

  private calculateSharpe(equity: number[]): number {
    const returns: number[] = [];
    for (let i = 1; i < equity.length; i++) {
      returns.push((equity[i] - equity[i - 1]) / equity[i - 1]);
    }

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
    const std = Math.sqrt(variance);

    return std === 0 ? 0 : (mean / std) * Math.sqrt(252); // Annualized
  }

  private calculateBreakevenPace(trades: Trade[]): number {
    if (trades.length === 0) return 0;
    
    let cumulative = 0;
    let maxBreakeven = 0;
    
    for (let i = 0; i < trades.length; i++) {
      cumulative += trades[i].netPnL;
      if (cumulative < 0) {
        maxBreakeven = i + 1;
      }
    }
    
    return maxBreakeven;
  }

  private calculateRecoveryTime(equity: number[], maxDD: number): { candles: number; totalUnderWater: number } {
    if (maxDD === 0) return { candles: 0, totalUnderWater: 0 };

    let peak = equity[0];
    let inDrawdown = false;
    let drawdownStart = 0;
    let maxRecovery = 0;
    let recovery = 0;
    let totalUnderWater = 0;

    for (let i = 0; i < equity.length; i++) {
      if (equity[i] > peak) {
        peak = equity[i];
        if (inDrawdown) {
          maxRecovery = Math.max(maxRecovery, i - drawdownStart);
          inDrawdown = false;
        }
      } else {
        if (!inDrawdown) {
          inDrawdown = true;
          drawdownStart = i;
        }
        totalUnderWater++;
      }
    }

    return { candles: maxRecovery, totalUnderWater };
  }

  private calculateRiskMetrics(
    returns: number[],
    initialBalance: number,
    equity: number[]
  ): StressedResult["risk"] {
    const sorted = [...returns].sort((a, b) => a - b);
    
    // Risk of Ruin (probalidad de perder 50%)
    const ruinThreshold = initialBalance * 0.5;
    const ruiningCases = equity.filter((e) => e < ruinThreshold).length;
    const riskOfRuin = (ruiningCases / equity.length) * 100;

    // Tail risk (peor 1%)
    const tailIndex = Math.floor(sorted.length * 0.01);
    const tailRisk = sorted[tailIndex] || 0;

    // VaR (Value at Risk)
    const var95Index = Math.floor(sorted.length * 0.05);
    const var99Index = Math.floor(sorted.length * 0.01);
    const var95 = -sorted[var95Index] * 100; // Convertir a %
    const var99 = -sorted[var99Index] * 100;

    return {
      riskOfRuin,
      tailRisk: tailRisk * 100,
      var95: Math.max(0, var95),
      var99: Math.max(0, var99),
    };
  }

  private generateRandomScenarios(count: number): StressScenario[] {
    const random: StressScenario[] = [];
    
    for (let i = 0; i < count; i++) {
      const gap = -0.02 - Math.random() * 0.06; // -2% a -8%
      const vol = 2 + Math.random() * 5;       // 2x a 7x vol
      
      random.push({
        id: `random_${i}`,
        name: `Random Event ${i + 1}`,
        description: `Synthetic stress scenario`,
        eventType: Math.random() > 0.5 ? "volatility_spike" : "gap_overnight",
        probability: 0.01 + Math.random() * 0.04,
        marketConditions: {
          gapPercent: gap,
          volatilityMultiplier: vol,
          slippagePercent: 0.01 + Math.random() * 0.03,
        },
      });
    }
    
    return random;
  }

  private generateSummary(
    baseline: BacktestResult,
    stressed: Record<string, StressedResult>
  ): StressResult["summary"] {
    const results = Object.values(stressed);
    
    const drawdowns = results.map((r) => r.equityImpact.maxDrawdown);
    const worstDD = Math.max(...drawdowns);
    const avgDD = drawdowns.reduce((a, b) => a + b, 0) / drawdowns.length;
    
    const worstScenario = results.reduce((w, r) => 
      r.equityImpact.maxDrawdown > w.equityImpact.maxDrawdown ? r : w
    );

    const survivalRate = results.filter((r) => r.equityImpact.finalEquity > baseline.config.initialBalance * 0.5).length / results.length * 100;

    // Capital buffer recomendado
    const ddMultiple = worstDD / baseline.metrics.maxDrawdown;
    const recommendedBuffer = Math.max(50, ddMultiple * 1.5);

    return {
      worstScenario: worstScenario.scenario.name,
      worstDrawdown: worstDD,
      avgDrawdown: avgDD,
      capitalAtRisk: worstDD,
      survivalRate,
      recommendedBuffer,
    };
  }

  private generateRecommendations(
    summary: StressResult["summary"],
    stressed: Record<string, StressedResult>
  ): string[] {
    const recommendations: string[] = [];

    if (summary.worstDrawdown > baseline.metrics.maxDrawdown * 2) {
      recommendations.push(
        `🚨 AUMENTAR buffer de capital: ${summary.recommendedBuffer.toFixed(0)}% extra recomendado`
      );
    }

    if (summary.survivalRate < 80) {
      recommendations.push(
        `⚠️ Riesgo de ruina alto: Solo ${summary.survivalRate.toFixed(0)}% de escenarios sobreviven`
      );
    }

    // Analizar peores escenarios
    const byType: Record<string, StressedResult[]> = {};
    for (const r of Object.values(stressed)) {
      if (!byType[r.scenario.eventType]) byType[r.scenario.eventType] = [];
      byType[r.scenario.eventType].push(r);
    }

    for (const [type, results] of Object.entries(byType)) {
      const avgDD = results.reduce((a, r) => a + r.equityImpact.maxDrawdown, 0) / results.length;
      if (avgDD > 30) {
        recommendations.push(
          `🎯 Considera deshabilitar trading durante ${type} (Avg DD: ${avgDD.toFixed(1)}%)`
        );
      }
    }

    // Recomendación final
    if (recommendations.length === 0) {
      recommendations.push("✅ Sistema resistente a estrés. Buffer actual suficiente.");
    }

    return recommendations;
  }

  private logScenarioResult(result: StressedResult): void {
    const s = result.scenario;
    const m = result.metrics;
    const e = result.equityImpact;

    console.log(`      Max DD: ${e.maxDrawdown.toFixed(1)}%`);
    console.log(`      Final Equity: $${e.finalEquity.toLocaleString()}`);
    console.log(`      Win Rate: ${m.winRate.toFixed(1)}% (vs baseline)`);
    console.log(`      Recovery: ${e.recoveryTime} trades`);
    console.log(`      Risk of Ruin: ${result.risk.riskOfRuin.toFixed(1)}%\n`);
  }
}

// ═══════════════════════════════════════════════════════════
// UTILIDADES
// ═══════════════════════════════════════════════════════════

export function generateStressReport(result: StressResult): string {
  let report = `
╔══════════════════════════════════════════════════════════════════╗
║                    STRESS TEST REPORT                             ║
╚══════════════════════════════════════════════════════════════════╝

📊 BASELINE (Condiciones Normales)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Trades:           ${result.baseline.metrics.totalTrades}
Win Rate:         ${result.baseline.metrics.winRate.toFixed(1)}%
Max Drawdown:     ${result.baseline.metrics.maxDrawdown.toFixed(1)}%
SQN:              ${result.baseline.metrics.sqn.toFixed(2)}
Profit Factor:    ${result.baseline.metrics.profitFactor.toFixed(2)}

📈 STRESS SUMMARY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Escenarios:       ${result.scenarios.length}
Worst Case:       ${result.summary.worstScenario}
Worst DD:         ${result.summary.worstDrawdown.toFixed(1)}%
Avg DD (stress):  ${result.summary.avgDrawdown.toFixed(1)}%
Survival Rate:    ${result.summary.survivalRate.toFixed(0)}%
Capital Buffer:   +${result.summary.recommendedBuffer.toFixed(0)}%

🎯 SCENARIO BREAKDOWN
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;

  for (const [id, r] of Object.entries(result.stressed)) {
    const diffDD = r.equityImpact.maxDrawdown - result.baseline.metrics.maxDrawdown;
    report += `
🔥 ${r.scenario.name}
   Probabilidad: ${(r.scenario.probability * 100).toFixed(0)}% / año
   Max DD:       ${r.equityImpact.maxDrawdown.toFixed(1)}% (${diffDD >= 0 ? "+" : ""}${diffDD.toFixed(1)}%)
   VaR 95%:      ${r.risk.var95.toFixed(1)}%
   Recovery:     ${r.equityImpact.recoveryTime} trades
   Trades Afect: ${r.affectedTrades.filter(t => t.slippageApplied > 0).length}
`;
  }

  report += `

🚨 RECOMMENDATIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${result.recommendations.map((r) => `  ${r}`).join("\n")}

⚠️ Si el peor escenario se materializa:
   - Drawdown adicional: +${(result.summary.worstDrawdown - result.baseline.metrics.maxDrawdown).toFixed(1)}%
   - Capital adicional necesario: $${(result.baseline.config.initialBalance * (result.summary.recommendedBuffer / 100)).toLocaleString()}
   - Tiempo de recuperación: Ver scenario específico
`;

  return report;
}
