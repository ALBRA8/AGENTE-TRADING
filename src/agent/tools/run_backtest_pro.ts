// ============================================================
// src/agent/tools/run_backtest_pro.ts
// Tool mejorado con opciones PRO (simulacion historica + metricas institucionales + stress testing)
// ============================================================

import type { Tool } from "../types.js";
import db from "../../database/sqlite.js";
import { BacktestEngine } from "../../backtest/engine.js";
import { StressTestEngine, generateStressReport, HISTORICAL_SCENARIOS } from "../../backtest/stress_test.js";
import type { BacktestConfig, StressScenario } from "../../backtest/types.js";
import { MT5Bridge } from "../../config/mt5bridge.js";

interface RunBacktestArgs {
  mode?: "report" | "simulation" | "stress" | "wfa" | "portfolio" | "regime";
  period?: "week" | "month" | "all";
  asset?: string;
  timeframe?: "M1" | "M5" | "M15" | "H1" | "H4";
  candleCount?: number;
  initialBalance?: number;
  riskPerTrade?: number;
  tpRatio?: number;
  requireFVG?: boolean;
  requireKillzone?: boolean;
  generateHTML?: boolean;
  // Stress testing params
  stressScenarios?: string[]; // IDs de escenarios a probar (ej: "flash_crash", "brexit")
  enableRandomScenarios?: boolean; // Agregar escenarios aleatorios
}

export const runBacktestPro: Tool = {
  definition: {
    type: "function",
    function: {
      name: "runBacktestPro",
      description: `EJECUTA backtesting profesional con dos modos:

MODO REPORT: Analiza trades historicos ejecutados por el bot.
MODO SIMULATION: Simula trades historicos con datos reales de MT5.

Para simulacion, requiere que el bridge MT5 este activo.`,
      parameters: {
        type: "object",
        properties: {
    mode: {
      type: "string",
      enum: ["report", "simulation", "stress"],
      description: "'report'=trades pasados, 'simulation'=PRO backtest, 'stress'=Stress Testing",
    },
          period: {
            type: "string",
            enum: ["week", "month", "all"],
            description: "Para mode='report': periodo de analisis. Default: 'week'",
          },
          asset: {
            type: "string",
            description: "Para mode='simulation': simbolo (ej: 'US30'). Default: 'US30'",
          },
          timeframe: {
            type: "string",
            enum: ["M1", "M5", "M15", "H1", "H4"],
            description: "Para mode='simulation': timeframe. Default: 'M15'",
          },
          candleCount: {
            type: "number",
            description: "Para mode='simulation': numero de velas (100-5000). Default: 1000",
          },
          initialBalance: {
            type: "number",
            description: "Para mode='simulation': balance inicial en $. Default: 10000",
          },
          riskPerTrade: {
            type: "number",
            description: "Para mode='simulation': porcentaje riesgo por trade. Default: 1.0",
          },
          tpRatio: {
            type: "number",
            description: "Para mode='simulation': ratio Take Profit (ej: 3 para 1:3). Default: 3.0",
          },
          requireFVG: {
            type: "boolean",
            description: "Para mode='simulation': requerir FVG confirmado. Default: true",
          },
          requireKillzone: {
            type: "boolean",
            description: "Para mode='simulation': solo operar en Killzone NY. Default: false",
          },
    generateHTML: {
      type: "boolean",
      description: "Para mode='simulation': generar reporte HTML. Default: true",
    },
    stressScenarios: {
      type: "array",
      items: { type: "string" },
      description: "Para mode='stress': IDs de escenarios (flash_crash, brexit, covid, etc). Default: all",
    },
    enableRandomScenarios: {
      type: "boolean",
      description: "Para mode='stress': agregar escenarios aleatorios. Default: true",
    },
  },
  required: ["mode"],
},
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const { mode = "report" } = args as unknown as RunBacktestArgs;

    if (mode === "report") {
      return await runReportMode(args);
    } else if (mode === "stress") {
      return await runStressMode(args);
    } else {
      return await runSimulationMode(args);
    }
  },
};

async function runReportMode(args: Record<string, unknown>): Promise<string> {
  const { period = "week" } = args as unknown as RunBacktestArgs;

  let dateFilter = "";
  if (period === "week") {
    dateFilter = `AND timestamp >= datetime('now', '-7 days')`;
  } else if (period === "month") {
    dateFilter = `AND timestamp >= datetime('now', '-30 days')`;
  }

  const trades = db
    .prepare(
      `SELECT * FROM trade_performance WHERE result_pl IS NOT NULL ${dateFilter} ORDER BY timestamp ASC`
    )
    .all() as Array<{
    id: number;
    timestamp: string;
    asset: string;
    setup_detected: string;
    result_pl: number;
    error_made: string;
    dxy_correlation: string;
  }>;

  if (trades.length === 0) {
    return `📊 Backtesting Report (${period})

No hay trades registrados con resultado P/L para el periodo seleccionado.

Usa 'logTradePerformance' al cerrar cada operacion para registrar datos.`;
  }

  const total = trades.length;
  const winners = trades.filter((t) => t.result_pl > 0);
  const losers = trades.filter((t) => t.result_pl <= 0);
  const winRate = ((winners.length / total) * 100).toFixed(1);
  const avgWin =
    winners.length > 0 ? (winners.reduce((a, t) => a + t.result_pl, 0) / winners.length).toFixed(2) : "0";
  const avgLoss =
    losers.length > 0 ? Math.abs(losers.reduce((a, t) => a + t.result_pl, 0) / losers.length).toFixed(2) : "0";
  const totalPL = trades.reduce((a, t) => a + t.result_pl, 0).toFixed(2);
  const expectancy = ((parseFloat(winRate) / 100) * parseFloat(avgWin) - (1 - parseFloat(winRate) / 100) * parseFloat(avgLoss)).toFixed(2);

  const byAsset: Record<string, { wins: number; total: number; pl: number }> = {};
  for (const t of trades) {
    const asset = t.asset || "UNKNOWN";
    if (!byAsset[asset]) byAsset[asset] = { wins: 0, total: 0, pl: 0 };
    byAsset[asset].total++;
    byAsset[asset].pl += t.result_pl;
    if (t.result_pl > 0) byAsset[asset].wins++;
  }

  const assetSummary = Object.entries(byAsset)
    .map(([a, s]) => ` ${a}: ${s.wins}/${s.total} win | $${s.pl.toFixed(0)} total`)
    .join("\n");

  return `
📊 Backtest Report - ${period === "week" ? "Ultima Semana" : period === "month" ? "Ultimo Mes" : "Historico"}

${total} trades | ${winRate}% WR | P/L: $${totalPL}

Win Rate:       ${winRate}%
Ganancia Prom:    $${avgWin}
Perdida Prom:     $${avgLoss}
Expectativa:      $${expectancy}

Por Activo:
${assetSummary}

Para calculo completo con metricas institucionales:
runBacktestPro con mode='simulation'
  `.trim();
}

async function runSimulationMode(args: Record<string, unknown>): Promise<string> {
  const {
    asset = "US30",
    timeframe = "M15",
    candleCount = 1000,
    initialBalance = 10000,
    riskPerTrade = 1.0,
    tpRatio = 3.0,
    requireFVG = true,
    requireKillzone = false,
    generateHTML = true,
  } = args as unknown as RunBacktestArgs;

  try {
    const health = await MT5Bridge.health();
    if (!health) {
      return `
❌ Bridge MT5 no disponible

Para usar la simulacion PRO necesitas:
1. MT5 abierto con un chart de ${asset}
2. Bridge Python ejecutandose (python bridge.py)

Sin bridge, usa mode='report' para analizar trades pasados.
      `.trim();
    }

    const candles = await MT5Bridge.getCandles(asset, timeframe, Math.min(candleCount, 5000));

    if (candles.length === 0) {
      return `❌ No se pudieron obtener velas para ${asset} ${timeframe}`;
    }

    const config: BacktestConfig = {
      asset,
      timeframe,
      startDate: new Date(candles[0].time),
      endDate: new Date(candles[candles.length - 1].time),
      initialBalance,
      riskPerTrade,
      rvolThreshold: 1.2,
      slMultiplier: 1.0,
      tpRatio,
      maxSlPips: 15,
      requireFVG,
      requireKillzone,
      allowHedging: false,
      maxConcurrentTrades: 1,
    };

    const engine = new BacktestEngine({
      maxCandlesToProcess: 5000,
      enableMonteCarlo: true,
      monteCarloIterations: 5000,
    });

    const result = await engine.runBacktest(candles, config);

    if (generateHTML) {
      const reportPath = engine.generateReport(result, true);
      console.log(`Report HTML: ${reportPath}`);
    }

    const m = result.metrics;
    const mc = result.monteCarlo;

    return `
🚀 Backtest PRO Completado - ${asset} ${timeframe}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Resultados Principales
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Balance Final:     $${(result.equityCurve[result.equityCurve.length - 1]?.equity || initialBalance).toLocaleString()}
Retorno Total:     ${m.totalReturn.toFixed(2)}%
Trades:            ${m.totalTrades}
Win Rate:          ${m.winRate.toFixed(1)}%
Profit Factor:     ${m.profitFactor.toFixed(2)}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Metricas de Riesgo (Institucionales)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Sharpe Ratio:      ${m.sharpeRatio.toFixed(2)} ${m.sharpeRatio > 1 ? "✅" : "⚠️"}
Sortino Ratio:     ${m.sortinoRatio.toFixed(2)}
Calmar Ratio:      ${m.calmarRatio.toFixed(2)}
Max Drawdown:      ${m.maxDrawdown.toFixed(2)}%
SQN (Quality):     ${m.sqn.toFixed(2)} ${getSQNRating(m.sqn)}

${mc ? `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Monte Carlo (${mc.iterations.toLocaleString()} sims)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Prob. Profit:      ${mc.probabilityOfProfit.toFixed(1)}%
Risk of Ruin:      ${mc.riskOfRuin.toFixed(1)}% ${mc.riskOfRuin < 5 ? "✅" : "⚠️"}
Worst DD:          ${mc.drawdown.worst.toFixed(1)}%
P95 Equity:        $${mc.finalEquity.percentiles["95"].toLocaleString()}
` : ""}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Buy & Hold Baseline
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

B&H Return:        ${result.benchmarks.buyHold.toFixed(2)}%
Alpha generado:    ${(m.totalReturn - result.benchmarks.buyHold).toFixed(2)}%

${generateHTML ? `📄 Reporte HTML generado en data/backtest_reports/` : ""}
  `.trim();
  } catch (error) {
    return `❌ Error en simulacion: ${(error as Error).message}`;
  }
}

function getSQNRating(sqn: number): string {
  if (sqn > 2.5) return "🟢 Excelente";
  if (sqn > 1.6) return "🟡 Bueno";
  if (sqn > 0.9) return "🟠 Promedio";
  if (sqn > 0) return "🔴 Debil";
  return "🔴 Inaceptable";
}

// ═══════════════════════════════════════════════════════════
// STRESS TESTING MODE
// ═══════════════════════════════════════════════════════════

async function runStressMode(args: Record<string, unknown>): Promise<string> {
  const {
    asset = "US30",
    timeframe = "M15",
    candleCount = 1000,
    initialBalance = 10000,
    riskPerTrade = 1.0,
    tpRatio = 3.0,
    requireFVG = true,
    requireKillzone = false,
    stressScenarios,
    enableRandomScenarios = true,
  } = args as unknown as RunBacktestArgs;

  try {
    const health = await MT5Bridge.health();
    if (!health) {
      return `❌ Bridge MT5 no disponible. Requiere MT5 abierto y bridge activo.`;
    }

    const candles = await MT5Bridge.getCandles(asset, timeframe, Math.min(candleCount, 5000));
    if (candles.length === 0) {
      return `❌ No se pudieron obtener velas para ${asset} ${timeframe}`;
    }

    const config: BacktestConfig = {
      asset,
      timeframe,
      startDate: new Date(candles[0].time),
      endDate: new Date(candles[candles.length - 1].time),
      initialBalance,
      riskPerTrade,
      rvolThreshold: 1.2,
      slMultiplier: 1.0,
      tpRatio,
      maxSlPips: 15,
      requireFVG,
      requireKillzone,
      allowHedging: false,
      maxConcurrentTrades: 1,
    };

    // Filtrar escenarios si se especificaron
    let scenarios = [...HISTORICAL_SCENARIOS];
    if (stressScenarios && stressScenarios.length > 0) {
      scenarios = HISTORICAL_SCENARIOS.filter((s) => stressScenarios.includes(s.id));
      if (scenarios.length === 0) {
        const validIds = HISTORICAL_SCENARIOS.map((s) => s.id).join(", ");
        return `❌ Escenarios no válidos. IDs disponibles: ${validIds}`;
      }
    }

    // Crear engine con escenarios filtrados
    const stressEngine = new StressTestEngine(scenarios, { enableMonteCarlo: true });
    const stressResult = await stressEngine.runStressTest(candles, config);

    // Generar reporte de texto
    const reportText = generateStressReport(stressResult);

    // Guardar reporte detallado en archivo
    const reportPath = `/mnt/d/PROYECTOS/AGENTES CON IA/AGENTE TRADING/data/stress_reports/stress_${asset}_${timeframe}_${Date.now()}.txt`;
    await Bun.write(reportPath, reportText);

    // Resumen ejecutivo
    const s = stressResult.summary;
    const b = stressResult.baseline.metrics;

    return `
🧪 STRESS TEST COMPLETO - ${asset} ${timeframe}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BASELINE (Condiciones Normales)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Trades: ${b.totalTrades} | Win Rate: ${b.winRate.toFixed(1)}%
Max DD: ${b.maxDrawdown.toFixed(2)}% | SQN: ${b.sqn.toFixed(2)}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ESTRÉS EXTREMO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Escenarios probados: ${stressResult.scenarios.length}
Peor Escenario: ${s.worstScenario}

Max Drawdown (estrés): ${s.worstDrawdown.toFixed(2)}%
Drawdown Promedio: ${s.avgDrawdown.toFixed(2)}%

Tasa de Supervivencia: ${s.survivalRate.toFixed(0)}%
Capital en Riesgo: ${s.capitalAtRisk.toFixed(1)}%

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BUFFER RECOMENDADO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⚠️ Capital adicional recomendado: +${s.recommendedBuffer.toFixed(0)}%
   (Para cubrir el peor escenario posible)

Ejemplo: Si operas con $${initialBalance.toLocaleString()},
         considera un buffer de $${(initialBalance * s.recommendedBuffer / 100).toLocaleString()}
         Capital total sugerido: $${(initialBalance * (1 + s.recommendedBuffer / 100)).toLocaleString()}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RECOMENDACIONES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${stressResult.recommendations.map((r) => `  ${r}`).join("\n")}

📄 Reporte detallado guardado:
   ${reportPath}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
VEREDICTO: ${s.survivalRate >= 80 && s.recommendedBuffer < 100 ? "🟢 SISTEMA RESISTENTE" : s.survivalRate >= 60 ? "🟡 REQUIERE AJUSTES" : "🔴 ALTO RIESGO EN ESTRÉS"}
`.trim();
  } catch (error) {
    return `❌ Error en stress test: ${(error as Error).message}`;
  }
}
