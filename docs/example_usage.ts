// Ejemplo de uso del sistema de backtesting profesional

import { BacktestEngine } from "../src/backtest";
import { MT5Bridge } from "../src/config/mt5bridge";
import type { RawCandle } from "../src/backtest/types";

async function runBacktestAdvanced() {
  console.log("🚀 Iniciando Backtest Avanzado\n");

  // Paso 1: Obtener datos de MT5
  console.log("1. Descargando velas de MT5...");
  const rawCandles = await MT5Bridge.getCandles("US30", "M15", 1000);

  // Paso 2: Configurar backtest
  console.log("2. Configurando estrategia...");
  const config = {
    asset: "US30",
    timeframe: "M15" as const,
    startDate: new Date(rawCandles[0].time),
    endDate: new Date(rawCandles[rawCandles.length - 1].time),
    initialBalance: 25000,
    riskPerTrade: 1.0,
    rvolThreshold: 1.5,       // Solo setups con 1.5x volumen
    slMultiplier: 1.0,
    tpRatio: 3.0,             // 1:3 Risk/Reward
    maxSlPips: 12,           // US30: Max 12 pips SL
    requireFVG: true,         // Solo con imbalance
    requireKillzone: true,   // Solo NY Killzone
    allowHedging: false,
    maxConcurrentTrades: 1,
  };

  // Paso 3: Ejecutar backtest
  console.log("3. Ejecutando simulacion SMC...\n");
  const engine = new BacktestEngine({
    enableMonteCarlo: true,
    monteCarloIterations: 10000,
    reportOutputDir: "./data/backtest_reports",
  });

  const result = await engine.runBacktest(rawCandles, config);

  // Paso 4: Mostrar resultados
  console.log("\n📊 RESULTADOS:");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log();
  console.log(`Retorno Total:     ${result.metrics.totalReturn.toFixed(2)}%`);
  console.log(`Win Rate:          ${result.metrics.winRate.toFixed(1)}%`);
  console.log(`Profit Factor:     ${result.metrics.profitFactor.toFixed(2)}`);
  console.log(`Sharpe Ratio:      ${result.metrics.sharpeRatio.toFixed(2)}`);
  console.log(`Max Drawdown:      ${result.metrics.maxDrawdown.toFixed(2)}%`);
  console.log(`SQN:               ${result.metrics.sqn.toFixed(2)}`);
  console.log();

  // Paso 5: Validar sistema
  if (result.metrics.sqn > 2.0 && result.metrics.profitFactor > 1.8) {
    console.log("🟢 Sistema VALIDO para trading real\n");
  } else if (result.metrics.sqn > 1.6 && result.metrics.profitFactor > 1.5) {
    console.log("🟡 Sistema ACEPTABLE - Revisar granularidad\n");
  } else {
    console.log("🔴 Sistema DEBIL - NO usar en live\n");
  }

  // Paso 6: Generar reporte HTML
  console.log("4. Generando reporte HTML...");
  const reportPath = engine.generateReport(result, true);
  console.log(`Reporte: ${reportPath}\n`);
}

// Ejemplo: Backtest en varios timeframes
async function multiTimeframeBacktest() {
  const symbol = "US30";
  const timeframes = ["M5", "M15", "H1"] as const;
  const results = [];

  console.log("🔬 Comparando timeframes\n");

  for (const tf of timeframes) {
    const candles = await MT5Bridge.getCandles(symbol, tf, 500);
    
    const engine = new BacktestEngine({ enableMonteCarlo: false });
    const result = await engine.runBacktest(candles, {
      asset: symbol,
      timeframe: tf,
      startDate: new Date(candles[0].time),
      endDate: new Date(candles[candles.length - 1].time),
      initialBalance: 10000,
      riskPerTrade: 1.0,
      tpRatio: 3.0,
      requireFVG: true,
      requireKillzone: false,
      allowHedging: false,
      maxConcurrentTrades: 1,
      rvolThreshold: 1.2,
      slMultiplier: 1,
      maxSlPips: 15,
    });

    results.push({
      timeframe: tf,
      trades: result.metrics.totalTrades,
      winRate: result.metrics.winRate,
      profitFactor: result.metrics.profitFactor,
      sharpe: result.metrics.sharpeRatio,
      sqn: result.metrics.sqn,
    });
  }

  // Resultados
  console.table(results);
}

// Ejemplo: Grid search de parámetros
async function optimizeStrategy() {
  const symbol = "US30";
  const candles = await MT5Bridge.getCandles(symbol, "M15", 1000);

  const tpRatios = [2.0, 2.5, 3.0, 3.5, 4.0];
  const requireFVGOptions = [true, false];

  const results = [];

  console.log("🎛️ Grid Search - Optimizando parametros\n");

  for (const tp of tpRatios) {
    for (const fvg of requireFVGOptions) {
      const engine = new BacktestEngine({ enableMonteCarlo: false });
      const result = await engine.runBacktest(candles, {
        asset: symbol,
        timeframe: "M15",
        startDate: new Date(candles[0].time),
        endDate: new Date(candles[candles.length - 1].time),
        initialBalance: 10000,
        riskPerTrade: 1.0,
        requireFVG: fvg,
        requireKillzone: false,
        allowHedging: false,
        maxConcurrentTrades: 1,
        rvolThreshold: 1.2,
        slMultiplier: 1,
        maxSlPips: 15,
        tpRatio: tp,
      });

      results.push({
        tpRatio: tp,
        requireFVG: fvg,
        winRate: result.metrics.winRate.toFixed(1),
        profitFactor: result.metrics.profitFactor.toFixed(2),
        sqn: result.metrics.sqn.toFixed(2),
        totalTrades: result.metrics.totalTrades,
      });
    }
  }

  // Ordenar por SQN descendente
  results.sort((a, b) => parseFloat(b.sqn) - parseFloat(a.sqn));
  console.log("\n🏆 Mejores configuraciones (por SQN):");
  console.table(results.slice(0, 5));
}

// Ejemplo simple con datos de prueba
async function demoBacktest() {
  const engine = new BacktestEngine({ enableMonteCarlo: true });
  
  // runDemoBacktest usa datos sintéticos para pruebas
  const result = await engine.runDemoBacktest();

  console.log("\n📊 Demo Backtest:");
  console.log(`Trades: ${result.metrics.totalTrades}`);
  console.log(`Win Rate: ${result.metrics.winRate.toFixed(1)}%`);
  console.log(`Profit Factor: ${result.metrics.profitFactor.toFixed(2)}`);
}

// Exportar para uso
export { runBacktestAdvanced, multiTimeframeBacktest, optimizeStrategy, demoBacktest };
