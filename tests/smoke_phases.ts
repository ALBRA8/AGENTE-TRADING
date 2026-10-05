// Smoke test de Fases 2/4/5 sin APIs externas:
// - decision_log + trade_orders + settlement + brain_eval + observability
// NVIDIA_API_KEY dummy: nvidia.ts solo valida presencia al importar.
process.env.NVIDIA_API_KEY = "nvapi-smoke-test-not-real";
process.env.DB_PATH = "./data/smoke_test.db";
process.env.SETTLEMENT_HORIZON_HOURS = "0.001"; // horizon casi inmediato para el test

// Imports dinámicos: los static de ESM se hoistean ANTES del setup de env
const { default: db, saveDecision, saveOrder, getUnsettledExecuteDecisions, getRecentExecuteDecision, claimDecision, releaseDecision, updateDecisionOutcome } = await import("../src/database/sqlite.js");
const { evaluateBrain, renderBrainReport } = await import("../src/agent/brain_eval.js");
const { runSettlement } = await import("../src/agent/settlement.js");
const { getAgentStatus } = await import("../src/agent/observability.js");
const { checkNews } = await import("../src/agent/tools/check_news.js");
const { checkDXY } = await import("../src/agent/tools/check_dxy.js");
const { checkMarketHours } = await import("../src/agent/tools/check_market_hours.js");
const { buildTrackRecord, getTrackRecord } = await import("../src/agent/trackrecord.js");
const { generateLicenseKey, validateLicense } = await import("../src/license.js");

import fs from "node:fs";

function assert(cond: boolean, msg: string) {
  // writeSync: inmune al buffer perdido si el cleanup nativo de better-sqlite3
  // aborta el proceso al salir (quirk conocido de Node 24 + better-sqlite3)
  const line = cond ? `✅ ${msg}\n` : `❌ FALLO: ${msg}\n`;
  fs.writeSync(1, line);
  if (!cond) process.exitCode = 1;
}

async function main() {
  // Limpieza
  db.exec(`DELETE FROM decision_log; DELETE FROM trade_orders; DELETE FROM agent_lessons;
           DELETE FROM agent_errors; DELETE FROM trade_performance; DELETE FROM brain_evaluations;`);

  // ── 1. Hard-gate: decisión EXECUTE vigente ──
  const decId = saveDecision({
    symbol: "US30",
    timeframe: "M5",
    finalAction: "EXECUTE",
    direction: "BUY",
    stopLossPips: 15,
    riskPct: 0.5,
    confidence: 0.82,
    gatesJson: JSON.stringify([
      { name: "market_hours", status: "GREEN", detail: "Killzone NY" },
      { name: "news", status: "GREEN", detail: "Sin eventos" },
    ]),
    reasoning: "ChoCh M1 confirmado",
    tokensUsed: 4200,
    latencyMs: 21000,
  });
  assert(getRecentExecuteDecision("us30", 15)?.id === decId, "hard-gate: getRecentExecuteDecision encuentra EXECUTE vigente (case-insensitive)");

  // ── 2. Orden vinculada a la decisión ──
  saveOrder({
    decisionId: decId,
    symbol: "US30",
    direction: "BUY",
    orderType: "BUY_LIMIT",
    volume: 0.33,
    entryPrice: 44120,
    stopLoss: 44105,
    takeProfit: 44165,
    ticket: 987654,
    riskPct: 0.5,
  });

  // BACKDATE: simular que la decisión es de hace 2 días para que venza el horizonte
  db.prepare(`UPDATE decision_log SET created_at = datetime('now', '-2 days') WHERE id = ?`).run(decId);

  // PnL reportado manualmente en trade_performance (posterior a la decisión)
  db.prepare(
    `INSERT INTO trade_performance (timestamp, asset, setup_detected, nemotron_thought, result_pl)
     VALUES (datetime('now', '-1 day'), 'US30', 'ChoCh M1', 'test', 145.50)`
  ).run();

  // ── 3. Settlement: debe cerrar con PnL 145.50 y source performance_log ──
  const summary = await runSettlement(10);
  assert(summary.settled === 1, `settlement cierra 1 decisión con PnL real (got settled=${summary.settled})`);
  const settled = db.prepare(`SELECT outcome_pnl, outcome_settled, outcome_source FROM decision_log WHERE id = ?`).get(decId) as any;
  assert(settled.outcome_pnl === 145.5 && settled.outcome_settled === 1 && settled.outcome_source === "performance_log",
    `outcome persistido correctamente (pnl=${settled.outcome_pnl}, settled=${settled.outcome_settled}, source=${settled.outcome_source})`);

  // ── 4. EXECUTE sin orden → tras max attempts expira como no_execution ──
  const dec2 = saveDecision({ symbol: "XAUUSD", finalAction: "EXECUTE", direction: "SELL", confidence: 0.7 });
  db.prepare(`UPDATE decision_log SET created_at = datetime('now', '-3 days'), settle_attempts = 7 WHERE id = ?`).run(dec2);
  const s2 = await runSettlement(10);
  assert(s2.expired === 1, `EXECUTE sin orden expira como sin seguimiento (expired=${s2.expired})`);
  const exp = db.prepare(`SELECT outcome_source FROM decision_log WHERE id = ?`).get(dec2) as any;
  assert(exp.outcome_source === "no_execution", `fuente correcta para falta de seguimiento (${exp.outcome_source})`);

  // ── 5. Brain eval ──
  const report = evaluateBrain();
  assert(report.stats.totalDecisions === 2, `brain eval cuenta decisiones (got ${report.stats.totalDecisions})`);
  assert(report.stats.settled === 1 && report.stats.wins === 1, `brain eval contabiliza 1 settled win`);
  assert(report.stats.followThroughRate !== null, `follow-through rate calculado`);
  assert(report.score > 0 && report.score <= 100, `brain score en rango (${report.score})`);
  const md = renderBrainReport(report);
  assert(md.includes("Evaluación del Cerebro"), "render markdown del brain report OK");

  // ── 6. Observability ──
  const status = getAgentStatus(false);
  assert(status.decisions.last7d === 2, `observability: 7d decisions (${status.decisions.last7d})`);
  assert(status.performance.totalPnl === 145.5, `observability: pnl total (${status.performance.totalPnl})`);
  assert(status.safety.pipelineGate === true, `observability: hard-gate ON`);
  assert(typeof status.dependencies.nvidiaKey === "boolean", `observability: dependencias reportadas`);

  // ── 7. Unsettled list respeta horizonte ──
  const dec3 = saveDecision({ symbol: "NAS100", finalAction: "EXECUTE", direction: "BUY", confidence: 0.9 });
  db.prepare(`UPDATE decision_log SET created_at = datetime('now', '-0.001 days') WHERE id = ?`).run(dec3);
  const pendingNow = getUnsettledExecuteDecisions(1, 10); // horizonte 1h → dec3 (reciente) NO debe salir
  assert(!pendingNow.some((d) => d.id === dec3), `horizonte respeta decisiones recientes`);

  // ── 8. HARD-GATE ONE-SHOT (fix auditoría) ──
  const dec4 = saveDecision({ symbol: "BTCUSD", finalAction: "EXECUTE", direction: "BUY", stopLossPips: 500, riskPct: 0.5, confidence: 0.8 });
  assert(getRecentExecuteDecision("BTCUSD", 15)?.id === dec4, "one-shot: decisión EXECUTE visible antes del claim");
  assert(claimDecision(dec4) === true, "one-shot: claim atómico exitoso la primera vez");
  assert(getRecentExecuteDecision("BTCUSD", 15) === undefined, "one-shot: decisión consumida ya NO autoriza órdenes");
  assert(claimDecision(dec4) === false, "one-shot: segundo claim rechazado");
  releaseDecision(dec4);
  assert(getRecentExecuteDecision("BTCUSD", 15)?.id === dec4, "one-shot: release restaura la decisión (orden falló)");

  // Invalidación por decisión posterior: un WAIT posterior anula el EXECUTE viejo
  const dec5 = saveDecision({ symbol: "ETHTEST", finalAction: "EXECUTE", direction: "SELL", stopLossPips: 20, riskPct: 0.5 });
  const dec6 = saveDecision({ symbol: "ETHTEST", finalAction: "WAIT", confidence: 0.4 });
  assert(getRecentExecuteDecision("ETHTEST", 15) === undefined, "invalidación: WAIT posterior anula el EXECUTE previo (stale-execute cerrado)");
  void dec5; void dec6;

  // Dirección NULL no autoriza nada (el gate lo exige, aquí validamos el dato)
  const decNull = saveDecision({ symbol: "NULLDIR", finalAction: "EXECUTE", confidence: 0.9 });
  const nullDir = getRecentExecuteDecision("NULLDIR", 15);
  assert(nullDir && !nullDir.direction, "dirección nula persistida (el gate del tool la rechaza)");

  // ── 9. DATOS HONESTOS (fix auditoría): sin simulaciones en la ruta de decisión ──
  delete process.env.TAVILY_API_KEY;
  const newsOut = await checkNews.execute({ asset: "US30" });
  assert(newsOut.includes("NO DISPONIBLE") && !newsOut.includes("🟢"), "checkNews sin key → UNKNOWN honesto (sin simulación)");
  const dxyOut = await checkDXY.execute({ asset: "US30" });
  assert(dxyOut.includes("NO DISPONIBLE") && !dxyOut.includes("Divergencia"), "checkDXY sin feed → UNKNOWN honesto (sin divergencia inventada)");
  const rvolOut = await import("../src/agent/tools/check_rvol.js").then((m) => m.checkRVOL.execute({ asset: "US30", timeframe: "M5" }));
  assert(rvolOut.includes("NO DISPONIBLE") && !rvolOut.includes("Simulado") && !/\d\.\d+x/.test(rvolOut.split("RVOL")[1] || ""), "checkRVOL sin bridge → UNKNOWN honesto (sin Math.random)");

  // Killzone en código: US30 fuera de killzone NY → PRECAUCIÓN o RED según hora
  const hoursUS = await checkMarketHours.execute({ asset: "US30" });
  assert(hoursUS.includes("Killzone") || hoursUS.includes("PRECAUCIÓN") || hoursUS.includes("CIERRE") || hoursUS.includes("NO RECOMENDADO"), `checkMarketHours aplica killzones del SOP en código`);
  const hoursGBP = await checkMarketHours.execute({ asset: "GBPJPY" });
  assert(hoursGBP.includes("Londres") || hoursGBP.includes("NO RECOMENDADO") || hoursGBP.includes("CIERRE"), "checkMarketHours aplica regla GBPJPY solo-Londres");

  // ── 10. LOCK de settlement (fix auditoría): segunda llamada concurrente se omite ──
  const lockProbe = await import("../src/agent/settlement.js").then(async (m) => {
    // Simula concurrencia: marca running y llama — debe omitir sin lanzar
    (m.maintenanceState as any).running = true;
    const s = await m.runSettlement(5);
    (m.maintenanceState as any).running = false;
    return s;
  });
  assert(lockProbe.details.some((d: string) => d.includes("lock")), "lock anti-duplicado: settlement concurrente se omite");

  // ── 11. TRACK RECORD (Task 8-b): buildTrackRecord PURA con filas fake ──
  const fakeRows = [
    { created_at: "2026-01-01 10:00:00", symbol: "US30", final_action: "WAIT", reasoning: "Fuera de killzone NY", gates_json: null, outcome_pnl: null, outcome_settled: 0 },
    { created_at: "2026-01-02 10:00:00", symbol: "NAS100", final_action: "WAIT", reasoning: "Fuera de killzone NY", gates_json: null, outcome_pnl: null, outcome_settled: 0 },
    { created_at: "2026-01-03 10:00:00", symbol: "NAS100", final_action: "WAIT", reasoning: "Sin BOS en M15", gates_json: null, outcome_pnl: null, outcome_settled: 0 },
    { created_at: "2026-01-04 10:00:00", symbol: "US30", final_action: "EXECUTE", reasoning: null, gates_json: null, outcome_pnl: 100, outcome_settled: 1 },
    { created_at: "2026-01-05 10:00:00", symbol: "XAUUSD", final_action: "EXECUTE", reasoning: null, gates_json: null, outcome_pnl: -50, outcome_settled: 1 },
    { created_at: "2026-01-06 10:00:00", symbol: "XAUUSD", final_action: "EXECUTE", reasoning: null, gates_json: null, outcome_pnl: 30, outcome_settled: 1 },
    { created_at: "2026-01-07 10:00:00", symbol: "BTCUSD", final_action: "ABORTED", reasoning: "Abortado por gate rojo: news", gates_json: null, outcome_pnl: null, outcome_settled: 0 },
  ];
  const tr = buildTrackRecord(fakeRows, [{ created_at: "2026-01-07 11:00:00", score: 71.5 }]);
  assert(tr.totalDecisiones === 7 && tr.demo === false,
    `trackrecord: total y etiqueta demo:false (got total=${tr.totalDecisiones}, demo=${tr.demo})`);
  assert(tr.porAccion.EXECUTE === 3 && tr.porAccion.WAIT === 3 && tr.porAccion.ABORTED === 1 && tr.porAccion.REVIEW === 0,
    "trackrecord: porAcción correcta (3E/3W/0R/1A)");
  assert(tr.settledConPnl === 3 && tr.wins === 2 && tr.losses === 1,
    "trackrecord: settled/wins/losses correctos");
  assert(tr.winRate !== null && Math.abs((tr.winRate ?? 0) - 2 / 3) < 1e-3,
    `trackrecord: win rate 2/3 redondeado a 4 decimales (got ${tr.winRate})`);
  assert(tr.expectancyPct === 26.67 && tr.totalPnl === 80,
    `trackrecord: expectancy (100-50+30)/3=26.67 y PnL total 80 (got ${tr.expectancyPct}/${tr.totalPnl})`);
  assert(tr.mejorSimbolo?.symbol === "US30" && tr.peorSimbolo?.symbol === "XAUUSD",
    `trackrecord: mejor/peor símbolo por PnL (got ${tr.mejorSimbolo?.symbol}/${tr.peorSimbolo?.symbol})`);
  assert(tr.rachaActual === 1,
    `trackrecord: racha actual +1 (última cerrada ganadora, got ${tr.rachaActual})`);
  assert(tr.topRazonesEspera.length === 2 && tr.topRazonesEspera[0].razon === "Fuera de killzone NY" && tr.topRazonesEspera[0].conteo === 2 && tr.topRazonesEspera[1].razon === "Sin BOS en M15",
    "trackrecord: razones de espera ordenadas por conteo (2x killzone, 1x BOS)");
  assert(tr.serieTemporal.length === 3 && tr.serieTemporal[2].pnlAcumulado === 80,
    "trackrecord: serie temporal acumulada (3 fechas, cierre en 80)");
  assert(tr.ultimoBrainScore === 71.5,
    `trackrecord: brain score más reciente (got ${tr.ultimoBrainScore})`);

  // Fallback: WAIT sin reasoning → motivo desde gates_json (primer gate no-GREEN)
  const trGates = buildTrackRecord([
    { created_at: "2026-02-01 10:00:00", symbol: "US30", final_action: "WAIT", reasoning: null,
      gates_json: JSON.stringify([{ name: "market_hours", status: "YELLOW", detail: "Fuera de killzone principal" }]),
      outcome_pnl: null, outcome_settled: 0 },
  ]);
  assert(trGates.topRazonesEspera[0]?.razon.includes("market_hours") === true,
    `trackrecord: fallback a gates_json cuando reasoning vacío (got "${trGates.topRazonesEspera[0]?.razon}")`);

  // DB vacía → estructura válida con ceros, sin throw
  const trEmpty = buildTrackRecord([], []);
  assert(
    trEmpty.totalDecisiones === 0 && trEmpty.winRate === null && trEmpty.expectancyPct === null &&
    trEmpty.serieTemporal.length === 0 && trEmpty.topRazonesEspera.length === 0 &&
    Array.isArray(trEmpty.symbols) && trEmpty.mejorSimbolo === null,
    "trackrecord: DB vacía → ceros/nulls sin throw"
  );

  // getTrackRecord sobre la DB real del smoke test (sin PII)
  saveDecision({ symbol: "EURTEST", finalAction: "WAIT", confidence: 0.5, reasoning: "Fuera de killzone NY" });
  const trDb = getTrackRecord();
  assert(trDb.demo === false && trDb.totalDecisiones === 8,
    `getTrackRecord: lee decision_log real (8 decisiones, got ${trDb.totalDecisiones})`);
  assert(trDb.winRate === 1 && trDb.expectancyPct === 145.5,
    `getTrackRecord: 1 settled win → winRate 1.0 y expectancy 145.5 (got ${trDb.winRate}/${trDb.expectancyPct})`);
  assert(trDb.topRazonesEspera.length >= 1 && trDb.topRazonesEspera[0].razon.includes("killzone"),
    `getTrackRecord: motivo real de WAIT extraído ("${trDb.topRazonesEspera[0]?.razon}")`);
  const trDump = JSON.stringify(trDb);
  assert(!trDump.includes("user_id") && !trDump.includes("web_session") && !trDump.includes("@"),
    "getTrackRecord: SIN PII (ni user_id, ni sesiones, ni emails)");

  // ── 12. LICENCIA OFFLINE (Task 8-b): generate + validate ──
  const SECRET = "smoke-license-secret";
  const keyOk = generateLicenseKey("Owner@Example.com", 30, SECRET);
  const resOk = validateLicense(keyOk, SECRET);
  assert(resOk.valid === true && resOk.email === "owner@example.com" && (resOk.daysLeft ?? 0) >= 29 && (resOk.daysLeft ?? 0) <= 30,
    `licencia: generate→validate redonda OK (email=${resOk.email}, daysLeft=${resOk.daysLeft})`);
  assert(validateLicense(keyOk.slice(0, -3) + "aaa", SECRET).valid === false,
    "licencia: key manipulada → inválida");
  const wrongSecret = validateLicense(keyOk, "otro-secreto");
  assert(wrongSecret.valid === false && wrongSecret.reason === "firma_invalida",
    `licencia: secreto distinto → firma_invalida (got ${wrongSecret.reason})`);
  const expired = validateLicense(generateLicenseKey("expired@example.com", -1, SECRET), SECRET);
  assert(expired.valid === false && expired.reason === "expirada",
    `licencia: expirada detectada (got ${expired.reason}, daysLeft=${expired.daysLeft})`);
  assert(validateLicense("basura-no-es-una-key", SECRET).reason === "formato_invalido",
    "licencia: formato basura → formato_invalido");
  assert(validateLicense(keyOk, "").valid === false,
    "licencia: sin secreto → no valida (nunca true por defecto)");
  const keyYear = validateLicense(generateLicenseKey("trader@test.io", 365, SECRET), SECRET);
  assert(keyYear.valid === true && (keyYear.daysLeft ?? 0) >= 364,
    `licencia: roundtrip 365 días (daysLeft=${keyYear.daysLeft})`);

  fs.writeSync(1, "\n🧪 Smoke test completo.\n");
  try { db.close(); } catch {}
  // Exit natural: process.exit() con fetch keepalive + statements pendientes
  // de GC dispara el assert nativo de Node 24 + better-sqlite3 (cosmético).
}

main().catch((e) => {
  console.error("💥", e);
  process.exit(1);
});
