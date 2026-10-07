// ============================================================
// tests/backtest_validity.test.ts (Task 10-b, §7 validez del backtesting)
// Sin APIs externas (mismo estilo que tests/risk_smc.test.ts):
//  (a) Detector: BOS bullish en zigzag alcista; ChoCh SOLO con reversión real
//      y siempre en la dirección correcta (nunca BOS+ChoCh contradictorios).
//  (b) FVGs recién formados NO nacen mitigados (fix "FVG nace mitigado").
//  (c) Simulator: run con pérdidas sin crash y P&L real
//      = lotSize × Δprecio × pipValue (fricción 0) + fricción por defecto.
//  (d) Manifest: sin data_hash → INVALID; completo → VALID + fila en backtest_runs.
//  (e) PRNG mulberry32: misma seed ⇒ misma secuencia.
// Ejecutar: node --import tsx tests/backtest_validity.test.ts
// ============================================================
process.env.DB_PATH = "./data/backtest_validity_test.db";

// Imports dinámicos: los static de ESM se hoistean ANTES del setup de env
const { processCandles, detectFVGs, detectSwingPoints, detectStructureShifts } =
  await import("../src/backtest/smc_detector.js");
const { SMCStructure } = await import("../src/backtest/types.js");
const {
  simulateTrades,
} = await import("../src/backtest/simulator.js");
const {
  BacktestEngine,
  buildRunManifest,
  verdictHeader,
  mulberry32,
} = await import("../src/backtest/engine.js");
const { monteCarloSimulation } = await import("../src/backtest/metrics.js");
const { WalkForwardAnalyzer } = await import("../src/backtest/walk_forward.js");
const { default: db } = await import("../src/database/sqlite.js");

import fs from "node:fs";

// ── Mitigación del quirk nativo (better-sqlite3 + Node 24, ver tests/smoke_phases.ts):
// los Statement temporales que GC finaliza a mitad de run pueden abortar el
// proceso (SIGABRT, punto aleatorio). Retenemos referencia a TODO statement
// creado vía db.prepare para que NUNCA se finalicen por GC → el resultado es
// determinista y el abort (si ocurre) solo puede darse al salir, como en
// tests/risk_smc.test.ts (exit 134 cosmético tras todos los asserts).
const keepAliveStatements: unknown[] = [];
const originalPrepare = db.prepare.bind(db);
(db as unknown as { prepare: unknown }).prepare = (...args: unknown[]) => {
  const stmt = (originalPrepare as (...a: unknown[]) => unknown)(...args);
  keepAliveStatements.push(stmt);
  return stmt;
};

function assert(cond: boolean, msg: string) {
  // writeSync: inmune al buffer perdido si el cleanup nativo de better-sqlite3
  // aborta el proceso al salir (mismo quirk que tests/risk_smc.test.ts)
  const line = cond ? `✅ ${msg}\n` : `❌ FALLO: ${msg}\n`;
  fs.writeSync(1, line);
  if (!cond) process.exitCode = 1;
}

const APPROX = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

// ── Fábricas de datos sintéticos ────────────────────────────

/** Vela sintética con cuerpo o->c y mechas simétricas pequeñas (0.1) */
function mkCandle(i: number, o: number, c: number, tickVolume: number, spread = 0) {
  const t = new Date(Date.UTC(2024, 0, 1, 0, i * 15)).toISOString();
  return {
    time: t,
    open: o,
    high: Math.max(o, c) + 0.1,
    low: Math.min(o, c) - 0.1,
    close: c,
    tickVolume,
    realVolume: 0,
    spread,
  };
}

/**
 * Zigzag alcista determinista (mismo patrón que tests/risk_smc.test.ts):
 * 10 velas de impulso (+0.3, volumen alto) + 6 de retroceso (−0.3, volumen
 * bajo) → higher lows + ruptura de high en cada ciclo. Micro-reversión de
 * ±0.05 en la apertura de cada tramo para que las mechas no empatecen.
 */
function buildRisingCandles(n: number) {
  const candles = [] as any[];
  let price = 100;
  let o = price;
  for (let i = 0; i < n; i++) {
    const phase = i % 16;
    const impulse = phase < 10;
    if (i > 0) o = impulse ? price + 0.05 : price - 0.05;
    price = price + (impulse ? 0.3 : -0.3);
    const vol = impulse ? 2000 : 600;
    candles.push(mkCandle(i, o, price, vol));
  }
  return candles;
}

/** Zigzag bajista determinista (espejo del alcista)
 *  La micro-reversión se aplica TAMBIÉN en i=0: sin ella, la mecha de la
 *  primera vela bajista EMPATA con el high del último swing alcista y el
 *  swing high del techo nunca se confirma (comparación estricta) → el ChoCh
 *  no tendría ventana (H,L,H,L) disponible. */
function buildFallingCandles(n: number, startPrice: number, startIdx = 0) {
  const candles = [] as any[];
  let price = startPrice;
  let o = price;
  for (let i = 0; i < n; i++) {
    const phase = i % 16;
    const impulse = phase < 10; // impulso bajista
    o = impulse ? price - 0.05 : price + 0.05;
    price = price + (impulse ? -0.3 : 0.3);
    const vol = impulse ? 2000 : 600;
    candles.push(mkCandle(startIdx + i, o, price, vol));
  }
  return candles;
}

function detectAll(candles: any[]) {
  const processed = processCandles(candles);
  const volumes = processed.map((c) => c.tickVolume);
  const swings = detectSwingPoints(processed, 5);
  const setups = detectStructureShifts(processed, swings, volumes);
  return { processed, swings, setups };
}

const BASE_CONFIG = {
  asset: "US30",
  timeframe: "M15" as const,
  startDate: new Date(Date.UTC(2024, 0, 1)),
  endDate: new Date(Date.UTC(2024, 0, 2)),
  initialBalance: 10000,
  riskPerTrade: 1.0,
  rvolThreshold: 0,
  slMultiplier: 1.0,
  tpRatio: 3.0,
  maxSlPips: 15,
  requireFVG: false,
  requireKillzone: false,
  allowHedging: false,
  maxConcurrentTrades: 1,
};

async function main() {
  fs.writeSync(1, "MARK: main start\n");
  // ═══════════════════════════════════════════════════════
  // (a) DETECTOR: BOS y ChoCh con dirección real
  // ═══════════════════════════════════════════════════════
  const rising = buildRisingCandles(120);
  fs.writeSync(1, "MARK: velas construidas\n");
  const up = detectAll(rising);
  fs.writeSync(1, "MARK: detectAll rising OK\n");

  assert(
    up.setups.some((s) => s.type === SMCStructure.BOS && s.direction === "BULLISH"),
    `zigzag alcista produce BOS BULLISH (${up.setups.filter((s) => s.type === SMCStructure.BOS).length} BOS)`
  );
  assert(
    up.setups.filter((s) => s.type === SMCStructure.ChoCh).length === 0,
    "zigzag alcista (tendencia pura, sin reversión) NO produce ningún ChoCh"
  );

  // Reversión real: alcista → bajista
  const topPrice = rising[rising.length - 1].close;
  const reversal = [...rising, ...buildFallingCandles(120, topPrice)];
  const rev = detectAll(reversal);

  const chochBear = rev.setups.filter(
    (s) => s.type === SMCStructure.ChoCh && s.direction === "BEARISH"
  );
  assert(
    chochBear.length >= 1,
    `serie con reversión clara produce ChoCh BEARISH (${chochBear.length})`
  );
  assert(
    rev.setups.some((s) => s.type === SMCStructure.BOS && s.direction === "BULLISH") &&
      rev.setups.some((s) => s.type === SMCStructure.BOS && s.direction === "BEARISH"),
    "la serie mixta mantiene BOS BULLISH (tramo alcista) y BOS BEARISH (tramo bajista)"
  );

  // Invariantes de dirección en TODOS los setups de ambas series:
  // BULLISH ⇒ ruptura AL ALZA (s3 > s1); BEARISH ⇒ ruptura A LA BAJA (s3 < s1).
  // ChoCh ⇒ carácter previo OPUESTO (s2 vs s0): alcista tras LL, bajista tras HH.
  const allSetups = [...up.setups, ...rev.setups];
  const dirOk = allSetups.every((s) => {
    const [s0, s1, s2, s3] = s.swingPoints;
    if (s.direction === "BULLISH") return s3.price > s1.price;
    return s3.price < s1.price;
  });
  assert(dirOk, `invariante de ruptura: dirección coherente con s3-vs-s1 en ${allSetups.length} setups`);

  const chochOk = allSetups
    .filter((s) => s.type === SMCStructure.ChoCh)
    .every((s) => {
      const [s0, , s2] = s.swingPoints;
      return s.direction === "BULLISH" ? s2.price < s0.price : s2.price > s0.price;
    });
  assert(chochOk, "invariante ChoCh: solo tras carácter previo contrario (LL→alza / HH→baja)");

  // FIX del hallazgo "BOS BULLISH + ChoCh BEARISH simultáneos": la misma vela
  // no puede emitir un BOS y un ChoCh CONTRADICTORIOS entre sí.
  const byIndex = new Map<number, Set<string>>();
  for (const s of allSetups) {
    const set = byIndex.get(s.index) ?? new Set<string>();
    set.add(`${s.type}:${s.direction}`);
    byIndex.set(s.index, set);
  }
  let contradiction = false;
  for (const set of byIndex.values()) {
    if (
      (set.has("BOS:BULLISH") && set.has("ChoCh:BEARISH")) ||
      (set.has("BOS:BEARISH") && set.has("ChoCh:BULLISH"))
    ) {
      contradiction = true;
    }
  }
  assert(!contradiction, "ninguna vela emite BOS + ChoCh contradictorios simultáneos");

  // ═══════════════════════════════════════════════════════
  // (b) FVG: recién formado NO está mitigado
  // ═══════════════════════════════════════════════════════
  const gapRaws = [
    mkCandle(0, 100, 100, 1000),
    mkCandle(1, 100, 100, 1000), // i-2 del FVG
    mkCandle(2, 100, 100, 1000),
    mkCandle(3, 103, 103.5, 1000), // vela final del FVG: low 102.9 > high vela 1
    mkCandle(4, 103.5, 103.7, 1000),
    mkCandle(5, 103.7, 103.9, 1000),
  ];
  // Ajustar low de la vela 3 a 102.9 para el gap limpio
  gapRaws[3].low = 102.9;
  const fvgs0 = detectFVGs(processCandles(gapRaws));
  const fvg = fvgs0.find((f) => f.type === "BULLISH" && f.endIndex === 3);
  assert(!!fvg, `FVG bullish detectado en endIndex=3 (top=${fvg?.top}, bottom=${fvg?.bottom})`);
  assert(
    !!fvg && fvg.isMitigated === false,
    "FVG recién formado NO nace mitigado (la vela final del propio gap no lo mitiga)"
  );

  // El precio vuelve a la zona DESPUÉS de formarse → SÍ se mitiga
  gapRaws.push(mkCandle(6, 103.9, 102, 1000));
  gapRaws[6].low = 101.5; // dentro de [100.2, 102.9]
  const fvgs1 = detectFVGs(processCandles(gapRaws));
  const fvgMit = fvgs1.find((f) => f.type === "BULLISH" && f.endIndex === 3);
  assert(
    !!fvgMit && fvgMit.isMitigated === true && fvgMit.mitigationIndex === 6,
    "FVG se marca mitigado SOLO cuando el precio regresa a la zona (mitigationIndex=6)"
  );

  // ═══════════════════════════════════════════════════════
  // (c) SIMULATOR: run con pérdidas sin crash + P&L real
  // ═══════════════════════════════════════════════════════
  // Velas: alcistas 0..15 (close 100→103), luego bajistas 16..40 → SL garantizado
  const simCandles = [] as any[];
  let px = 100;
  for (let i = 0; i <= 15; i++) {
    simCandles.push(mkCandle(i, px, px + 0.2, 1000)); // sin spread
    px += 0.2;
  }
  for (let i = 16; i <= 40; i++) {
    px -= 2;
    simCandles.push(mkCandle(i, px + 2, px, 1000));
  }
  const simProcessed = processCandles(simCandles);

  // Setup LONG artesanal: swing en vela 10 → ENTRADA en vela 15 (confirmación)
  const setup = {
    index: 10,
    time: simProcessed[10].time,
    type: SMCStructure.BOS,
    direction: "BULLISH" as const,
    price: 102,
    confidence: 1,
    swingPoints: [],
    rvol: 1,
  };

  // c.1 — Fricción CERO: P&L exacto = lotSize × Δprecio × pipValue
  const { trades: tf, equityCurve: eqf } = simulateTrades(
    simProcessed,
    [setup as any],
    BASE_CONFIG,
    { spreadPoints: 0, commissionPerLot: 0, slippagePoints: 0 }
  );
  assert(tf.length === 1, `run corto con pérdidas completa sin crash (1 trade, ${tf.length})`);
  const t0 = tf[0];
  // lot = floor(100$ / (15 pips × 1 $/pip) × 100)/100 = 6.66
  assert(t0.volume === 6.66, `lotSize round-down = 6.66 lote (got ${t0.volume})`);
  assert(t0.exit.reason === "SL_HIT", `el trade cierra por SL_HIT (got ${t0.exit.reason})`);
  // entrada = close(15) = 103 (sin spread); SL = 103 − 15 = 88; Δ = −15
  // P&L real = 6.66 × (−15) × (1 $/pip/pipSize) = −99.9  (antes: +3% fabricado / crash)
  assert(
    APPROX(t0.profit, 6.66 * -15 * 1),
    `P&L real = lotSize × Δprecio × pipValue = −99.9$ (got ${t0.profit})`
  );
  assert(APPROX(t0.profitPips, -15), `profitPips = −15 (got ${t0.profitPips})`);
  assert(
    eqf[eqf.length - 1].equity < BASE_CONFIG.initialBalance,
    "la equity curve refleja las pérdidas (sin crash a mitad de run)"
  );

  // c.2 — Fricción por DEFECTO (spread 2 + slippage 1 + comisión 7/lote): empeora
  const { trades: td } = simulateTrades(simProcessed, [setup as any], BASE_CONFIG);
  const t1 = td[0];
  // entrada = 103 + 2 (spread) = 105 → SL = 90 → fill = 90 − 1 (slippage) = 89
  // P&L = 6.66 × (89 − 105) − 7 × 6.66 = −106.56 − 46.62 = −153.18
  assert(
    APPROX(t1.profit, 6.66 * -16 - 7 * 6.66),
    `fricción default aplicada: P&L = −153.18$ (got ${t1.profit})`
  );
  assert(
    t1.profit < t0.profit,
    "la fricción por defecto empeora el resultado (nunca lo mejora)"
  );

  // c.3 — Ambigüedad intra-vela: SL y TP tocados en la MISMA vela ⇒ SL primero
  const ambCandles = [] as any[];
  for (let i = 0; i <= 7; i++) ambCandles.push(mkCandle(i, 100, 100, 1000));
  ambCandles.push(mkCandle(8, 100.5, 105, 1000)); // vela que toca SL y TP
  ambCandles[8].low = 89.9;
  ambCandles[8].high = 110.5;
  ambCandles.push(mkCandle(9, 105, 105, 1000));
  const ambSetup = {
    index: 2,
    time: processCandles(ambCandles)[2].time,
    type: SMCStructure.BOS,
    direction: "BULLISH" as const,
    price: 100,
    confidence: 1,
    swingPoints: [],
    rvol: 1,
  };
  const ambCfg = { ...BASE_CONFIG, maxSlPips: 10, tpRatio: 1.0 };
  const { trades: ta } = simulateTrades(
    processCandles(ambCandles),
    [ambSetup as any],
    ambCfg,
    { spreadPoints: 0, commissionPerLot: 0, slippagePoints: 0 }
  );
  assert(
    ta.length === 1 && ta[0].exit.reason === "SL_HIT",
    `ambigüedad intra-vela (SL y TP en la misma vela) ⇒ se asume SL primero (got ${ta[0]?.exit.reason})`
  );

  // ═══════════════════════════════════════════════════════
  // (d) MANIFEST §7: reproducibilidad → veredicto
  // ═══════════════════════════════════════════════════════
  const invalid = buildRunManifest({ symbol: "US30" });
  assert(
    invalid.manifest.verdict === "INVALID_NOT_REPRODUCIBLE" &&
      invalid.manifest.missing.includes("dataHash"),
    `manifest sin data_hash ⇒ INVALID_NOT_REPRODUCIBLE (missing=${invalid.manifest.missing.join(",")})`
  );

  const valid = buildRunManifest({
    symbol: "US30",
    dataHash: "deadbeefdeadbeef",
    paramsJson: "{}",
    codeVersion: "dev",
    seed: 42,
  });
  assert(
    valid.manifest.verdict === "VALID_REPRODUCIBLE" && valid.manifest.missing.length === 0,
    "manifest completo (data_hash+params+code_version+seed) ⇒ VALID_REPRODUCIBLE"
  );

  assert(
    verdictHeader("INVALID_NOT_REPRODUCIBLE").includes("prohibido para decisiones reales") &&
      verdictHeader("VALID_REPRODUCIBLE").includes("PENDIENTE de revisión de sesgos"),
    "cabeceras obligatorias §7 presentes en ambos veredictos"
  );

  // Integración: run completo del engine persiste el manifest en backtest_runs
  const engine = new BacktestEngine({ enableMonteCarlo: false });
  const runCandles = buildRisingCandles(120);
  const engineCfg = {
    ...BASE_CONFIG,
    startDate: new Date(runCandles[0].time),
    endDate: new Date(runCandles[runCandles.length - 1].time),
  };
  await engine.runBacktest(runCandles, engineCfg);
  const man = engine.lastManifest;
  assert(!!man, "engine.runBacktest produce manifest de reproducibilidad");
  assert(
    !!man && man.verdict === "VALID_REPRODUCIBLE" && man.persisted === true,
    `run con manifest completo + DB ⇒ VALID_REPRODUCIBLE persistido (got ${man?.verdict}, persisted=${man?.persisted})`
  );
  assert(
    !!man && man.dataHash && man.dataHash.length === 64 && typeof man.seed === "number",
    `data_hash sha256 de 64 hex y seed numérica (seed=${man?.seed})`
  );
  const row = db
    .prepare(`SELECT verdict, data_hash, seed FROM backtest_runs WHERE run_id = ?`)
    .get(man!.runId) as { verdict: string; data_hash: string; seed: number } | undefined;
  assert(
    !!row && row.verdict === "VALID_REPRODUCIBLE" && row.data_hash === man!.dataHash,
    "fila en tabla append-only backtest_runs con verdict y data_hash del run"
  );

  // Monte Carlo sembrado: misma seed ⇒ resultados idénticos
  const fakeTrades = Array.from({ length: 12 }, (_, i) => ({
    profit: i % 2 === 0 ? 120 : -80,
  })) as any[];
  const mcCfg = { ...BASE_CONFIG } as any;
  const mcA = JSON.stringify(monteCarloSimulation(fakeTrades, mcCfg, 500, mulberry32(7)));
  const mcB = JSON.stringify(monteCarloSimulation(fakeTrades, mcCfg, 500, mulberry32(7)));
  assert(mcA === mcB, "Monte Carlo con PRNG sembrado: misma seed ⇒ mismo resultado exacto");

  // ═══════════════════════════════════════════════════════
  // (e) PRNG mulberry32: determinista por seed
  // ═══════════════════════════════════════════════════════
  const rngA = mulberry32(1234);
  const rngB = mulberry32(1234);
  const seqA = Array.from({ length: 10 }, () => rngA());
  const seqB = Array.from({ length: 10 }, () => rngB());
  assert(
    seqA.every((v, i) => v === seqB[i]) && seqA.every((v) => v >= 0 && v < 1),
    "mulberry32(1234) ×2 genera la MISMA secuencia en [0,1)"
  );
  const seqC = Array.from({ length: 10 }, () => mulberry32(1235)());
  assert(
    seqA.some((v, i) => v !== seqC[i]),
    "semilla distinta ⇒ secuencia distinta"
  );

  // ═══════════════════════════════════════════════════════
  // (f) WFA corre (import roto fixed) y train/test SIN solape
  // ═══════════════════════════════════════════════════════
  const wfaCandles = buildRisingCandles(2880); // 30 días × 96 velas M15
  const wfa = new WalkForwardAnalyzer();
  const wfaRes = await wfa.runWFA(wfaCandles, engineCfg as any, {
    trainWindow: "1W",
    testWindow: "1W",
    overlap: 0,
    optimizationMetric: "profitFactor",
    minAcceptableMetric: 0,
    paramGrid: {
      tpRatio: [2],
      requireFVG: [false],
      rvolThreshold: [1.0],
      riskPerTrade: [0.5],
    },
  } as any);
  assert(wfaRes.windows.length >= 1, `WFA corre sin crash y genera ${wfaRes.windows.length} ventana(s)`);
  const noOverlap = wfaRes.windows.every((w) => {
    const trainEnd = new Date(w.trainPeriod.end).getTime();
    const testStart = new Date(w.testPeriod.start).getTime();
    return testStart >= trainEnd;
  });
  assert(noOverlap, "todas las ventanas WFA tienen train/test sin solape (testStart ≥ trainEnd)");

  // ── Cleanup ──
  // Unlink ANTES de cerrar (en Linux el inode sobrevive mientras esté abierto).
  // El close va en try/catch: el assert nativo de Node 24 + better-sqlite3 al
  // salir es cosmético (mismo quirk documentado en tests/smoke_phases.ts).
  const DB_PATH = "./data/backtest_validity_test.db";
  for (const f of [DB_PATH, `${DB_PATH}-journal`, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
  }
  try { db.close(); } catch {}
  fs.writeSync(1, "\n🧪 Backtest validity test completo.\n");
}

main().catch((err) => {
  fs.writeSync(2, `❌ ERROR FATAL: ${(err as Error).stack ?? err}\n`);
  process.exitCode = 1;
});
