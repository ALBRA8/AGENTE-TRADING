// ============================================================
// src/backtest/engine.ts
// Motor principal de backtesting - Orquesta todo
//
// Task 10-b (§7 REPRODUCIBILIDAD): cada run genera un manifest
// { run_id, data_hash (sha256 de las velas consumidas), params_json,
//   code_version, seed (PRNG mulberry32) } y lo persiste en la tabla
// append-only `backtest_runs` vía saveBacktestRunManifest (sqlite.ts).
// Regla del cliente: un backtest NO reproducible = INVÁLIDO. El output
// impreso SIEMPRE lleva la cabecera de honestidad correspondiente:
//  ⚠️ [INVALID / NOT REPRODUCIBLE — prohibido para decisiones reales o promoción de lecciones]
//  ⚠️ [REPRODUCIBLE — válido estadísticamente PENDIENTE de revisión de sesgos]
// Nunca se presenta un run como verdad absoluta.
// ============================================================

import { createHash, randomUUID } from "node:crypto";
import {
  BacktestConfig,
  BacktestResult,
  RawCandle,
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
  // §7 reproducibilidad: seed del PRNG para Monte Carlo/aleatoriedad.
  // Si no se aporta, se DERIVA del data_hash (misma data ⇒ misma seed).
  seed?: number;
}

export type BacktestVerdict = "VALID_REPRODUCIBLE" | "INVALID_NOT_REPRODUCIBLE";

/** Manifest de reproducibilidad de un run (§7) */
export interface BacktestRunManifest {
  runId: string;
  engine: string;
  symbol: string;
  dataHash?: string;
  paramsJson?: string;
  codeVersion?: string;
  seed?: number;
  verdict: BacktestVerdict;
  /** Campos ausentes que impiden la reproducibilidad */
  missing: string[];
  /** true si el manifest llegó a la tabla backtest_runs */
  persisted: boolean;
  /** Advertencias de validez que siguen abiertas aunque el run sea reproducible */
  warnings: string[];
}

/** Versión de código del run (env GIT_COMMIT o "dev") */
export const CODE_VERSION: string = process.env.GIT_COMMIT || "dev";

/** Cabecera OBLIGATORIA de honestidad para cualquier output de backtest (§7) */
export function verdictHeader(verdict: BacktestVerdict): string {
  return verdict === "VALID_REPRODUCIBLE"
    ? "⚠️ [REPRODUCIBLE — válido estadísticamente PENDIENTE de revisión de sesgos]"
    : "⚠️ [INVALID / NOT REPRODUCIBLE — prohibido para decisiones reales o promoción de lecciones]";
}

/**
 * PRNG determinista mulberry32: misma seed ⇒ misma secuencia.
 * Se usa para Monte Carlo y para cualquier aleatoriedad del motor
 * (datos demo incluidos). 0 ≤ retorno < 1.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seed determinista derivada del data_hash (32 bits) */
export function seedFromHash(dataHash: string): number {
  return parseInt(dataHash.slice(0, 8), 16) >>> 0;
}

/**
 * sha256 del dataset efectivamente consumido (tras el recorte de ventana):
 * time|o|h|l|c|vol|rvol|spread por vela. Dos runs con hashes distintos NO son
 * comparables (la ventana móvil del bridge cambia cada día).
 */
export function computeCandlesHash(candles: RawCandle[]): string {
  const hash = createHash("sha256");
  for (const c of candles) {
    hash.update(
      `${c.time}|${c.open}|${c.high}|${c.low}|${c.close}|${c.tickVolume}|${c.realVolume}|${c.spread}\n`
    );
  }
  return hash.digest("hex");
}

/**
 * Construye el manifest de un run y su veredicto (§7):
 * VALID_REPRODUCIBLE solo si TODOS los campos de reproducibilidad están;
 * si falta cualquiera (o no se puede persistir) → INVALID_NOT_REPRODUCIBLE.
 */
export function buildRunManifest(args: {
  runId?: string;
  engine?: string;
  symbol?: string;
  dataHash?: string;
  paramsJson?: string;
  codeVersion?: string;
  seed?: number;
}): { manifest: BacktestRunManifest } {
  const runId = args.runId ?? randomUUID();
  const missing: string[] = [];
  if (!args.dataHash) missing.push("dataHash");
  if (!args.paramsJson) missing.push("paramsJson");
  if (!args.codeVersion) missing.push("codeVersion");
  if (args.seed === undefined || args.seed === null || !Number.isFinite(args.seed)) {
    missing.push("seed");
  }
  const complete = missing.length === 0;

  const manifest: BacktestRunManifest = {
    runId,
    engine: args.engine ?? "simulation",
    symbol: args.symbol ?? "UNKNOWN",
    dataHash: args.dataHash,
    paramsJson: args.paramsJson,
    codeVersion: args.codeVersion,
    seed: args.seed,
    verdict: complete ? "VALID_REPRODUCIBLE" : "INVALID_NOT_REPRODUCIBLE",
    missing,
    persisted: false,
    warnings: [],
  };
  return { manifest };
}

/**
 * Persistencia best-effort del manifest en backtest_runs (tabla append-only).
 * Devuelve false si la DB no está disponible → el run se marca INVALID:
 * sin registro verificable no hay reproducibilidad demostrable (§7).
 */
export async function persistBacktestManifest(
  manifest: BacktestRunManifest,
  metricsJson?: string
): Promise<boolean> {
  try {
    const { saveBacktestRunManifest } = await import("../database/sqlite.js");
    saveBacktestRunManifest({
      runId: manifest.runId,
      engine: manifest.engine,
      symbol: manifest.symbol,
      dataHash: manifest.dataHash,
      paramsJson: manifest.paramsJson,
      codeVersion: manifest.codeVersion,
      seed: manifest.seed,
      verdict: manifest.verdict,
      metricsJson,
    });
    return true;
  } catch (err) {
    console.warn(
      `⚠️ No se pudo persistir el manifest del backtest en backtest_runs: ${(err as Error).message}`
    );
    return false;
  }
}

/** Clase principal del motor de backtesting */
export class BacktestEngine {
  private config: BacktestEngineConfig;

  /** Manifest del último run ejecutado (para tools/registro) */
  public lastManifest: BacktestRunManifest | null = null;

  constructor(config: BacktestEngineConfig = {}) {
    this.config = {
      maxCandlesToProcess: config.maxCandlesToProcess ?? 5000,
      enableMonteCarlo: config.enableMonteCarlo ?? true,
      monteCarloIterations: config.monteCarloIterations ?? 10000,
      reportOutputDir: config.reportOutputDir ?? "./data/backtest_reports",
      seed: config.seed,
    };
  }

  /**
   * Ejecuta un backtest completo
   */
  async runBacktest(
    rawCandles: RawCandle[],
    backtestConfig: BacktestConfig
  ): Promise<BacktestResult> {
    if (rawCandles.length === 0) {
      throw new Error("runBacktest: 0 velas de entrada — nada que simular");
    }

    // Limitar cantidad de velas para performance
    const limitedCandles = rawCandles.slice(-this.config.maxCandlesToProcess!);

    // ─────────────────────────────
    // §7 MANIFEST DE REPRODUCIBILIDAD
    // ─────────────────────────────
    const dataHash = computeCandlesHash(limitedCandles);
    const seed = this.config.seed ?? seedFromHash(dataHash); // misma data ⇒ misma seed
    const { manifest } = buildRunManifest({
      engine: "simulation",
      symbol: backtestConfig.asset,
      dataHash,
      paramsJson: JSON.stringify(backtestConfig),
      codeVersion: CODE_VERSION,
      seed,
    });
    // Advertencias de validez que PERMANECEN abiertas aunque el run sea reproducible
    manifest.warnings.push(
      "equity realized-only: el maxDD intra-trade es invisible",
      "duraciones medidas en VELAS del timeframe (no en minutos reales)",
      "Sharpe/Sortino/SQN con formulación conocida-imperfecta (ver docs/BACKTEST_PRO.md)",
      "dataset = ventana móvil del bridge: sin validación de gaps/duplicados"
    );
    this.lastManifest = manifest;

    console.log(`
${verdictHeader(manifest.verdict)}
🚀 Iniciando Backtest Pro
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
run_id:       ${manifest.runId}
data_hash:    ${dataHash.slice(0, 16)}…
code_version: ${manifest.codeVersion}
seed:         ${manifest.seed}
Activo: ${backtestConfig.asset}
Timeframe: ${backtestConfig.timeframe}
Período: ${backtestConfig.startDate.toLocaleDateString()} → ${backtestConfig.endDate.toLocaleDateString()}
Balance Inicial: $${backtestConfig.initialBalance.toLocaleString()}
Risk/Trade: ${backtestConfig.riskPerTrade}%
TP Ratio: 1:${backtestConfig.tpRatio}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    `);

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
    console.log(`   ✓ Sharpe Ratio: ${metrics.sharpeRatio.toFixed(2)} (⚠️ formulación imperfecta)`);
    console.log(`   ✓ Max Drawdown: ${metrics.maxDrawdown.toFixed(2)}% (realized-only)`);

    // ─────────────────────────────
    // FASE 5: Monte Carlo (con PRNG sembrado — §7)
    // ─────────────────────────────
    let monteCarlo = undefined;
    if (this.config.enableMonteCarlo && trades.length > 10) {
      console.log("🎲 Fase 5: Simulando Monte Carlo (seed determinista)...");
      const rng = mulberry32(seed);
      monteCarlo = monteCarloSimulation(
        trades,
        backtestConfig,
        this.config.monteCarloIterations,
        rng
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
      // FIX tsc: mapear al shape declarado en BacktestResult (buyHold/buyHoldDrawdown)
      benchmarks: {
        buyHold: benchmarks.return,
        buyHoldDrawdown: benchmarks.drawdown,
      },
      timeExecuted: new Date(),
    };

    // ─────────────────────────────
    // §7 PERSISTENCIA DEL MANIFEST (append-only backtest_runs)
    // ─────────────────────────────
    const metricsSummary = JSON.stringify({
      totalTrades: metrics.totalTrades,
      winRate: metrics.winRate,
      profitFactor: metrics.profitFactor,
      totalReturn: metrics.totalReturn,
      maxDrawdown: metrics.maxDrawdown,
      expectancy: metrics.avgTrade,
    });
    const persisted = await persistBacktestManifest(manifest, metricsSummary);
    manifest.persisted = persisted;
    if (!persisted) {
      // Sin registro verificable no se puede auditar la reproducibilidad → INVALID
      manifest.verdict = "INVALID_NOT_REPRODUCIBLE";
      manifest.missing.push("persistence");
      console.log(verdictHeader(manifest.verdict));
    }

    console.log(`
✅ Backtest Completado — veredicto: ${manifest.verdict}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
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
    } as ReportOptions);

    console.log(`
📄 Reporte HTML generado:
   ${reportPath}
    `);

    return reportPath;
  }

  /**
   * Ejecuta un backtest con datos de ejemplo (para pruebas)
   * FIX (§7): la generación demo usa el PRNG sembrado mulberry32 en lugar de
   * Math.random → el demo es determinista y reproducible.
   */
  async runDemoBacktest(): Promise<BacktestResult> {
    // Generar datos de ejemplo sencillos (deterministas: seed fija)
    const rng = mulberry32(20240101);
    const rawCandles: RawCandle[] = [];
    const startDate = new Date("2024-01-01");
    let price = 35000;

    for (let i = 0; i < 500; i++) {
      const date = new Date(startDate);
      date.setMinutes(i * 15); // M15

      const volatility = price * 0.001; // 0.1% volatility
      const change = (rng() - 0.5) * volatility;

      const open = price;
      const close = price + change;
      const high = Math.max(open, close) + rng() * volatility * 0.5;
      const low = Math.min(open, close) - rng() * volatility * 0.5;

      rawCandles.push({
        time: date.toISOString(),
        open,
        high,
        low,
        close,
        tickVolume: Math.floor(rng() * 1000) + 500,
        realVolume: Math.floor(rng() * 5000) + 1000,
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
