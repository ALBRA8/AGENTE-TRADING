// ============================================================
// tests/timemachine.test.ts — TIME MACHINE (port runTimeMachine)
// Sin APIs externas ni bridge: velas sintéticas deterministas.
//  (a) buildSessions: agrupa por día, EXCLUYE la vela en curso,
//      mediana de barras/sesión correcta.
//  (b) Monte Carlo determinista: misma seed ⇒ números idénticos;
//      distribución target/stop/close suma 1.0.
//  (c) Regla conservadora: barra sintética que contiene SL y TP a la
//      vez ⇒ cuenta STOP (pérdida), nunca target.
//  (d) Replay histórico con gap: apertura a través del SL ⇒ exit en
//      apertura (peor que -1R) y contador de gaps activo.
//  (e) Fill LIMIT favorable: apertura bajo el entry (BUY) ⇒ fill en
//      apertura, no en entry.
//  (f) Veredicto: umbrales 🟢/🟡/🔴 coherentes.
// Ejecutar: node --import tsx tests/timemachine.test.ts
// ============================================================

const { buildSessions, buildPool, simulate, replayHistory, timeMachineVerdict } =
  await import("../src/backtest/timemachine.js");
const { mulberry32 } = await import("../src/backtest/engine.js");

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.error(`  ❌ ${name} ${detail}`);
  }
}

// ── Generador de velas sintéticas (random walk determinista) ──
function genSessions(nSessions: number, barsPer: number, seed: number) {
  const rng = mulberry32(seed);
  const out: {
    time: string; open: number; high: number; low: number; close: number;
  }[] = [];
  const base = new Date(Date.UTC(2026, 0, 5, 14, 30, 0)); // 5 Ene 2026 14:30 UTC
  let px = 100;
  for (let d = 0; d < nSessions; d++) {
    for (let i = 0; i < barsPer; i++) {
      const t = new Date(base.getTime() + (d * 1440 + i * 5) * 60_000);
      const o = px;
      const drift = (rng() - 0.5) * 0.6;
      const c = o + drift;
      const h = Math.max(o, c) + rng() * 0.2;
      const l = Math.min(o, c) - rng() * 0.2;
      out.push({
        time: t.toISOString().slice(0, 19).replace("T", " "),
        open: +o.toFixed(4),
        high: +h.toFixed(4),
        low: +l.toFixed(4),
        close: +c.toFixed(4),
      });
      px = c;
    }
    px += (rng() - 0.5) * 2; // gap entre sesiones
  }
  return out;
}

console.log("\n━━━ (a) buildSessions ━━━");
{
  const candles = genSessions(30, 60, 7);
  const lastCloseMs = new Date(candles[candles.length - 1].time + "Z").getTime() + 5 * 60_000;
  // (1) now DENTRO de la última vela (abrió hace 2.5 min): vela en curso excluida
  const mid = buildSessions(candles, 5, lastCloseMs - 2.5 * 60_000);
  check("excluye la vela en curso", mid.excludedInProgress === true);
  check("29 sesiones completas (la de hoy queda parcial)", mid.sessions.length === 29, `got ${mid.sessions.length}`);
  check("currentIndex = 58 (59 velas cerradas hoy)", mid.currentIndex === 58, `got ${mid.currentIndex}`);
  // (2) now DESPUÉS del cierre de la última vela: nada excluido. La sesión
  //     del último día sigue siendo "current" por diseño (el pool son solo
  //     sesiones PASADAS completas) — conservador y suficiente.
  const after = buildSessions(candles, 5, lastCloseMs + 1000);
  check("vela cerrada → no excluye", after.excludedInProgress === false);
  check("29 sesiones completas en el pool", after.sessions.length === 29, `got ${after.sessions.length}`);
  check("sesión actual completa: 60 velas", after.currentSession?.bars.length === 60, `got ${after.currentSession?.bars.length}`);
  check("currentIndex = 59", after.currentIndex === 59, `got ${after.currentIndex}`);
  check(
    "mediana de barras = 60",
    after.medianSessionBars === 60,
    `got ${after.medianSessionBars}`
  );
  check(
    "sesión actual es el último día",
    after.currentSession?.date === candles[candles.length - 1].time.slice(0, 10)
  );
}

console.log("\n━━━ (b) Monte Carlo determinista ━━━");
{
  const candles = genSessions(40, 60, 11);
  const data = buildSessions(candles, 5, new Date(candles[candles.length - 1].time + "Z").getTime() + 6 * 60_000);
  const pool = buildPool(data.sessions);
  const plan = { entry: 100, stop: 98, target: 104, side: "BUY" as const };
  const A = simulate({ ...plan, pool, fromIndex: 30, horizonBars: 20, replays: 5000, seed: 19 });
  const B = simulate({ ...plan, pool, fromIndex: 30, horizonBars: 20, replays: 5000, seed: 19 });
  const C = simulate({ ...plan, pool, fromIndex: 30, horizonBars: 20, replays: 5000, seed: 20 });
  check("misma seed ⇒ mismo resultado", JSON.stringify(A) === JSON.stringify(B));
  check("otra seed ⇒ resultado distinto", JSON.stringify(A) !== JSON.stringify(C));
  const sum = A.targetFirst + A.stopFirst + A.unresolved;
  check("distribución suma 1.0", Math.abs(sum - 1) < 1e-9, `sum=${sum}`);
  check("R medio finito y razonable", Number.isFinite(A.avgR) && Math.abs(A.avgR) < 5);
}

console.log("\n━━━ (c) Regla conservadora (SL y TP en la misma barra) ━━━");
{
  // Pool patológico: TODAS las barras del slot 0 contienen stop y target
  // (un solo slot → pool = [ slot ]; slot = [ barra ratios ])
  const pool = [[{ hr: 1.5, lr: 0.5, cr: 1.0 }]]; // hi=+50%, lo=-50% desde entry
  const res = simulate({
    pool, entry: 100, stop: 98, target: 104, side: "BUY",
    fromIndex: 0, horizonBars: 1, replays: 500, seed: 3,
  });
  check(
    "barra que toca ambos niveles ⇒ STOP (pérdida), nunca target",
    res.stopFirst === 1.0 && res.targetFirst === 0.0,
    `stop=${res.stopFirst} target=${res.targetFirst}`
  );
  check("todas las R = -1", Math.abs(res.avgR + 1) < 1e-9, `avgR=${res.avgR}`);
}

console.log("\n━━━ (d) Replay histórico: gap a través del SL ━━━");
{
  const sess = {
    date: "2026-01-05",
    bars: [
      { t: 1, o: 105, h: 106, l: 95, c: 104 }, // trigger: l<=100 → fill@100
      { t: 2, o: 85, h: 86, l: 84, c: 85.5 },  // ABRE bajo el stop 90 → exit@85 (gap, -1.5R)
      { t: 3, o: 86, h: 90, l: 85, c: 89 },
    ],
  };
  const h = replayHistory({ sessions: [sess], entry: 100, stop: 90, target: 110, side: "BUY" });
  check("disparó 1 vez", h.fired === 1, `fired=${h.fired}`);
  check("resultado = stop", h.stop === 1);
  check("gap contado", h.gapped === 1, `gapped=${h.gapped}`);
  check("R peor que -1 por el gap", h.worstR <= -1.5 + 1e-9, `worstR=${h.worstR}`);
}

console.log("\n━━━ (e) Fill LIMIT favorable (apertura bajo entry) ━━━");
{
  const sess = {
    date: "2026-01-06",
    bars: [
      { t: 1, o: 95, h: 97, l: 94, c: 96 }, // abre en 95 (< entry 100): fill@95 mejor
      { t: 2, o: 96, h: 99, l: 95.5, c: 98 },
      { t: 3, o: 98, h: 103, l: 97, c: 102 }, // toca target 110? NO → cierra sesión
    ],
  };
  const h = replayHistory({ sessions: [sess], entry: 100, stop: 90, target: 110, side: "BUY" });
  check("disparó", h.fired === 1);
  check("sin SL/TP → neither con cierre a favor", h.neither === 1, JSON.stringify(h));
  // exit = cierre 102, fill = 95 → r = 7/10 = +0.7
  check("R = +0.7 (fill@95, exit@102)", Math.abs(h.avgR - 0.7) < 1e-9, `avgR=${h.avgR}`);
}

console.log("\n━━━ (g) Fill degenerado (gap más allá del plan) se descarta ━━━");
{
  // BUY entry=100, stop=90: la sesión abre en 85 (gap bajo el stop) →
  // fill@85 deja el stop POR ENCIMA del fill: geometría rota → descartada,
  // sin R fabricado (+14R tipo) que envenene el promedio.
  const sess = {
    date: "2026-01-07",
    bars: [
      { t: 1, o: 85, h: 96, l: 80, c: 95 }, // trigger (l<=100), fill@85 → degenerado
      { t: 2, o: 95, h: 105, l: 94, c: 104 },
    ],
  };
  const h = replayHistory({ sessions: [sess], entry: 100, stop: 90, target: 110, side: "BUY" });
  check("fill degenerado detectado", h.degenerate === 1, JSON.stringify(h));
  check("NO cuenta como fired ni aporta R", h.fired === 0 && h.avgR === 0, `fired=${h.fired} avgR=${h.avgR}`);
}

console.log("\n━━━ (h) Veredicto (umbrales) ━━━");
{
  const good = timeMachineVerdict(
    { replays: 1000, horizonBars: 20, targetFirst: 0.5, stopFirst: 0.25, unresolved: 0.25, greenPct: 0.6, avgR: 0.6, medianR: 0.5, p5R: -1, p95R: 2, rTarget: 2 },
    { sessionsTested: 60, fired: 30, target: 18, stop: 10, neither: 2, avgR: 0.4, worstR: -1.5, gapped: 1, degenerate: 0 }
  );
  const bad = timeMachineVerdict(
    { replays: 1000, horizonBars: 20, targetFirst: 0.2, stopFirst: 0.6, unresolved: 0.2, greenPct: 0.25, avgR: -0.5, medianR: -1, p5R: -1, p95R: 2, rTarget: 2 },
    { sessionsTested: 60, fired: 30, target: 5, stop: 22, neither: 3, avgR: -0.45, worstR: -1.5, gapped: 2, degenerate: 0 }
  );
  const coin = timeMachineVerdict(
    { replays: 1000, horizonBars: 20, targetFirst: 0.3, stopFirst: 0.29, unresolved: 0.41, greenPct: 0.45, avgR: 0.05, medianR: 0, p5R: -1, p95R: 2, rTarget: 2 },
    { sessionsTested: 60, fired: 8, target: 4, stop: 3, neither: 1, avgR: 0.1, worstR: -1, gapped: 0, degenerate: 0 }
  );
  check("🟢 sesgo favorable", good.level === "GREEN");
  check("🔴 desfavorable", bad.level === "RED");
  check("🟡 moneda al aire (historial no significativo: 8 disparos)", coin.level === "YELLOW");
}

console.log(`\n━━━ RESULTADO: ${passed} pass, ${failed} fail ━━━`);
if (failed > 0) process.exit(1);
