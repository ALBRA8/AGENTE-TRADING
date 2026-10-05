// Test de Track A (Task 8-a) sin APIs externas:
// - Kill-switches de cuenta (risk_controls.ts) con providers inyectados
// - Sizing exacto con symbol_info (computePipValueUSD / computeLotFromRisk)
// - Expiración de órdenes pendientes (buildOrderExpiration)
// - Helpers de DB para el gate account_risk (getTodayRealizedPnl / getConsecutiveLosses)
// - Analizador SMC EN VIVO (analyzeLiveStructure) con velas sintéticas
process.env.NVIDIA_API_KEY = "nvapi-risk-test-not-real";
process.env.DB_PATH = "./data/risk_smc_test.db";

// Imports dinámicos: los static de ESM se hoistean ANTES del setup de env
const { default: db, saveDecision } = await import("../src/database/sqlite.js");
const { getTodayRealizedPnl, getConsecutiveLosses } = await import("../src/database/sqlite.js");
const { getAccountRisk } = await import("../src/agent/risk_controls.js");
const { computePipValueUSD, computeLotFromRisk, buildOrderExpiration } = await import("../src/agent/tools/execute_trade_mt5.js");
const { analyzeLiveStructure } = await import("../src/smc/live.js");

import fs from "node:fs";

function assert(cond: boolean, msg: string) {
  // writeSync: inmune al buffer perdido si el cleanup nativo de better-sqlite3
  // aborta el proceso al salir (mismo quirk que tests/smoke_phases.ts)
  const line = cond ? `✅ ${msg}\n` : `❌ FALLO: ${msg}\n`;
  fs.writeSync(1, line);
  if (!cond) process.exitCode = 1;
}

// ── Fábricas de datos fake ──────────────────────────────────

const account = (balance: number, equity = balance) => ({
  login: 123, balance, equity, margin: 0, freeMargin: equity, currency: "USD", leverage: 100, server: "test",
});

const position = (symbol: string, volume: number, profit = 0) => ({
  ticket: Math.floor(Math.random() * 1e6), symbol, type: "BUY" as const, volume,
  openPrice: 100, currentPrice: 100, sl: 0, tp: 0, profit, comment: "test", openTime: new Date().toISOString(),
});

/** Vela sintética con cuerpo o->c y mechas simétricas pequeñas (0.1) */
function mkCandle(i: number, o: number, c: number, tickVolume: number) {
  const t = new Date(Date.UTC(2026, 9, 1, 12, i)).toISOString();
  return { time: t, open: o, high: Math.max(o, c) + 0.1, low: Math.min(o, c) - 0.1, close: c, tickVolume, realVolume: 0, spread: 2 };
}

/**
 * Serie alcista en zigzag determinista: 10 velas de impulso (+0.3, volumen
 * alto) + 6 de retroceso (−0.3, volumen bajo) → higher lows + ruptura de
 * high en cada ciclo → swings limpios y BOS bullish detectable.
 *
 * Clave para el detector (comparación ESTRICTA de highs/lows con lookback 5):
 * la vela que abre cada tramo lleva una micro-reversión (±0.05 en la apertura
 * respecto al cierre anterior) para que su mecha NO empate con la mecha de la
 * vela pivote del tramo anterior. Sin eso, swing high/low nunca se detectan.
 */
function buildRisingCandles(n: number) {
  const candles = [] as any[];
  let price = 100;
  let o = price;
  for (let i = 0; i < n; i++) {
    const phase = i % 16;
    const impulse = phase < 10;
    if (i > 0) o = impulse ? price + 0.05 : price - 0.05; // micro-reversión al girar
    price = price + (impulse ? 0.3 : -0.3);
    const vol = impulse ? 2000 : 600;
    candles.push(mkCandle(i, o, price, vol));
  }
  return candles;
}

async function main() {
  // ── 1. Helpers de DB para kill-switches ──
  db.exec(`DELETE FROM decision_log; DELETE FROM trade_orders;`);
  assert(getTodayRealizedPnl() === 0, "DB vacía: PnL de hoy = 0");
  assert(getConsecutiveLosses() === 0, "DB vacía: racha de pérdidas = 0");

  const d1 = saveDecision({ symbol: "US30", finalAction: "EXECUTE", direction: "BUY", confidence: 0.8 });
  const d2 = saveDecision({ symbol: "US30", finalAction: "EXECUTE", direction: "SELL", confidence: 0.7 });
  const d3 = saveDecision({ symbol: "XAUUSD", finalAction: "EXECUTE", direction: "BUY", confidence: 0.9 });
  const settleToday = (id: number, pnl: number) =>
    db.prepare(`UPDATE decision_log SET outcome_settled = 1, outcome_pnl = ?, outcome_timestamp = datetime('now') WHERE id = ?`).run(pnl, id);
  settleToday(d1, 100);
  settleToday(d2, -60);
  settleToday(d3, -30);

  assert(Math.abs(getTodayRealizedPnl() - 10) < 1e-9, `PnL de hoy = 100-60-30 = 10 (got ${getTodayRealizedPnl()})`);
  assert(getConsecutiveLosses() === 2, `racha actual = 2 pérdidas consecutivas (got ${getConsecutiveLosses()})`);

  // Un settled de hace 2 días NO cuenta como hoy (ni para PnL ni adelanta la racha)
  const d4 = saveDecision({ symbol: "NAS100", finalAction: "EXECUTE", direction: "SELL", confidence: 0.6 });
  db.prepare(`UPDATE decision_log SET outcome_settled = 1, outcome_pnl = -500, outcome_timestamp = datetime('now','-2 days') WHERE id = ?`).run(d4);
  assert(Math.abs(getTodayRealizedPnl() - 10) < 1e-9, "PnL histórico (hace 2 días) NO se atribuye a hoy");
  assert(getConsecutiveLosses() === 2, "racha respeta orden temporal (la pérdida vieja no encabeza)");

  // ── 2. Kill-switches con providers inyectados ──
  const base = {
    account: () => account(10000, 10050),
    positions: () => [] as any[],
    pnlToday: () => -40,
    consecutiveLosses: () => 1,
  };

  const ok = await getAccountRisk(base);
  assert(ok.ok === true && ok.evaluated === true && ok.violations.length === 0, "cuenta sana: ok=true sin violaciones");
  assert(Math.abs((ok.details.dailyLossLimitUsd ?? 0) - 100.4) < 1e-9, `límite diario = (10000+40)*1% = 100.4 (got ${ok.details.dailyLossLimitUsd})`);

  const daily = await getAccountRisk({ ...base, pnlToday: () => -150 });
  assert(daily.ok === false && daily.violations.some((v) => v.includes("PÉRDIDA DIARIA")), "kill-switch: pérdida diaria 150 > 100.4 dispara violación");

  const tooMany = await getAccountRisk({ ...base, positions: () => [position("US30", 0.5), position("NAS100", 0.5), position("XAUUSD", 0.5)] });
  assert(tooMany.ok === false && tooMany.violations.some((v) => v.includes("MÁXIMO DE POSICIONES")), "kill-switch: 3 posiciones abiertas > 2");

  const exposure = await getAccountRisk({ ...base, positions: () => [position("US30", 2), position("XAUUSD", 1.5)] });
  assert(exposure.ok === false && exposure.violations.some((v) => v.includes("EXPOSICIÓN")), "kill-switch: exposición 3.5 lotes > 3");

  const streakOut = await getAccountRisk({ ...base, consecutiveLosses: () => 2 });
  assert(streakOut.ok === false && streakOut.violations.some((v) => v.includes("RACHA DE PÉRDIDAS")), "kill-switch: 2 pérdidas consecutivas suspende el trading");

  const noAccount = await getAccountRisk({ ...base, account: () => { throw new Error("bridge caído"); } });
  assert(noAccount.evaluated === false && noAccount.ok === false, "fail-closed: cuenta ilegible → evaluated=false y bloqueo");

  const noPnl = await getAccountRisk({ ...base, pnlToday: () => { throw new Error("db rota"); } });
  assert(noPnl.ok === false && noPnl.violations.some((v) => v.includes("NO verificable")), "fail-closed: PnL ilegible → límite diario no verificable");

  // ── 3. Sizing exacto (symbol_info vs tabla fallback) ──
  const infoXAU = { name: "XAUUSD", digits: 2, point: 0.01, tradeTickValue: 1, tradeTickSize: 0.01, volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01 } as any;
  const pvXAU = computePipValueUSD("XAUUSD", 1, infoXAU);
  assert(pvXAU !== null && pvXAU.source === "symbol_info" && Math.abs(pvXAU.value - 100) < 1e-9, `pip value XAUUSD por symbol_info = $100/pip/lote (got ${pvXAU?.value})`);

  const pvUS30 = computePipValueUSD("US30", 1, null);
  assert(pvUS30 !== null && pvUS30.source === "tabla_PIP_VALUE_USD" && pvUS30.value === 1, "fallback tabla: US30 = $1/pip/lote");

  assert(computePipValueUSD("SIMBOLO_RARO", 1, null) === null, "fail-closed: símbolo desconocido sin symbol_info → null (rechazar)");

  const sizing = computeLotFromRisk(50, 20, 6.6, "symbol_info", infoXAU);
  assert(sizing.lotSize === 0.37 && sizing.rejected === undefined, `lote round-down a step: 50/(20×6.6)=0.3787 → 0.37 (got ${sizing.lotSize})`);
  assert(sizing.realRisk <= 50, `riesgo real ${sizing.realRisk} ≤ planificado 50 (round-down garantiza)`);
  assert(Math.abs(sizing.realRisk - 0.37 * 132) < 1e-6, `riesgo real = lote × pips × $/pip (got ${sizing.realRisk})`);

  const belowMin = computeLotFromRisk(0.05, 20, 6.6, "symbol_info", infoXAU);
  assert(belowMin.rejected === "below_min", "rechazo below_min: ni el lote mínimo respeta el riesgo");

  const capped = computeLotFromRisk(1_000_000, 1, 1, "symbol_info", { ...infoXAU, volumeMax: 100 });
  assert(capped.lotSize === 10, `cap por MAX_LOT (default 10) aunque el riesgo pida más (got ${capped.lotSize})`);

  const t0 = Math.floor(Date.now() / 1000);
  const exp = buildOrderExpiration(15);
  assert(exp >= t0 + 899 && exp <= t0 + 901, "expiración de orden pendiente = decisión + 15 min (epoch)");

  // ── 4. SMC EN VIVO con velas sintéticas (detector real) ──
  const candles = buildRisingCandles(90);
  const live = await analyzeLiveStructure("US30", "M5", candles);
  assert(live.available === true, "serie sintética: análisis disponible");
  assert(live.candleCount === 90, `candleCount = 90 (got ${live.candleCount})`);
  assert(Math.abs(live.lastPrice - candles[candles.length - 1].close) < 1e-9, "lastPrice = cierre de la última vela");
  assert(live.swings.length >= 4, `swings detectados por el detector real (got ${live.swings.length})`);
  assert(live.structureShifts.length >= 1, `BOS/ChoCh detectados en la serie (got ${live.structureShifts.length})`);
  assert(live.trend === "ALCISTA", `tendencia derivada de swings reales = ALCISTA (got ${live.trend})`);
  assert(live.reportText.includes("EN VIVO"), "reporte marcado como estructura EN VIVO");

  const few = await analyzeLiveStructure("US30", "M5", candles.slice(0, 10));
  assert(few.available === false && (few.unavailableReason ?? "").includes("Velas insuficientes"), "fail-closed: 10 velas → insuficientes, sin análisis");

  const dirty = [...buildRisingCandles(90), null, { time: "x", open: NaN, high: NaN, low: NaN, close: NaN, tickVolume: 0, realVolume: 0, spread: 0 }] as any[];
  const cleaned = await analyzeLiveStructure("US30", "M5", dirty);
  assert(cleaned.available === true && cleaned.candleCount === 90, "velas corruptas (NaN/null) descartadas antes de analizar");

  const badTf = await analyzeLiveStructure("US30", "H4", candles);
  assert(badTf.available === false && (badTf.unavailableReason ?? "").includes("Timeframe no soportado"), "timeframe no soportado → rechazo honesto");

  // ── Cleanup ──
  // Unlink ANTES de cerrar (en Linux el inode sobrevive mientras esté abierto).
  // El close va en try/catch: el assert nativo de Node 24 + better-sqlite3 al
  // salir es cosmético (mismo quirk documentado en tests/smoke_phases.ts).
  const DB_PATH = "./data/risk_smc_test.db";
  for (const f of [DB_PATH, `${DB_PATH}-journal`, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
  }
  try { db.close(); } catch {}
  fs.writeSync(1, "\n🧪 Risk/SMC test completo.\n");
}

main().catch((err) => {
  fs.writeSync(2, `❌ ERROR FATAL: ${(err as Error).stack ?? err}\n`);
  process.exitCode = 1;
});
