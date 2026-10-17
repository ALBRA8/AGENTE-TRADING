// Tests del CABLEADO del STRATEGY ENGINE V1.0 (runner + integración pipeline).
// Cubre: niveles de sesión D-12, flujo completo S0→S9 a través del runner con
// filtrado estricto por CIERRE de vela (más estricto que el test del núcleo),
// paridad runner↔evaluate() paso a paso, noop/no-repaint, fail-closed que
// preserva la secuencia, blackout R15.6, killzone default DST-safe,
// mapeo gates→flags, plan determinista (modo source) y modo por env.
import assert from 'node:assert';
import { evaluate, createEngineState } from '../src/strategy/engine.ts';
import { StrategyEngineRunner, computeSessionLevels } from '../src/strategy/runner.ts';
import { getStrategyEngineMode, gatesToEngineFlags, planFromSignal } from '../src/strategy/integration.ts';
import type { CandleProvider, MultiTF } from '../src/data/candle_provider.ts';
import type { Candle, EngineState, SessionLevels, StrategySignal } from '../src/strategy/types.ts';
import type { Gate } from '../src/agent/pipeline.ts';

const MIN = 60_000;
const T0 = Date.parse('2026-10-14T13:10:00Z'); // 09:10 ET (killzone NY, EDT)
const tm = (m: number) => T0 - m * MIN;

const K = (time: number, t: [number, number, number, number], v = 100): Candle =>
  ({ time, open: t[0], high: t[1], low: t[2], close: t[3], volume: v });

// ── Fixtures (idénticos a tests/strategy_engine.test.ts) ──────────────────
const H1: Candle[] = [
  K(tm(600), [39790, 39882, 39780, 39880]), K(tm(540), [39880, 39952, 39870, 39950]),
  K(tm(480), [39950, 39952, 39898, 39900]), K(tm(420), [39900, 39990, 39898, 39980]),
  K(tm(360), [39980, 39982, 39928, 39930]), K(tm(300), [39930, 39932, 39860, 39870]),
  K(tm(240), [39870, 39942, 39862, 39940]), K(tm(180), [39940, 40012, 39932, 40010]),
  K(tm(120), [40010, 40014, 39988, 39990]), K(tm(60), [39990, 40062, 39982, 40060]),
];
const M15_BASE: Candle[] = [
  K(tm(270), [40020, 40050, 40010, 40040]), K(tm(255), [40040, 40070, 40030, 40060]),
  K(tm(240), [40060, 40065, 40020, 40030]), K(tm(225), [40030, 40080, 40020, 40070]),
  K(tm(210), [40070, 40075, 40010, 40020]), K(tm(195), [40020, 40025, 39970, 39980]),
  K(tm(180), [39980, 39985, 39955, 39960]), K(tm(165), [39960, 39965, 39940, 39950]),
  K(tm(150), [39950, 39955, 39945, 39950]), K(tm(135), [39950, 39952, 39890, 39900]),
  K(tm(120), [39900, 40010, 39895, 40000]), K(tm(105), [40000, 40060, 39990, 40050]),
  K(tm(90), [40050, 40095, 40040, 40090]), K(tm(75), [40090, 40130, 40080, 40120]),
];
const M5_BASE: Candle[] = [
  K(tm(125), [39940, 39950, 39930, 39945]), K(tm(120), [39945, 39955, 39935, 39950]),
  K(tm(115), [39950, 39952, 39920, 39925]), K(tm(110), [39925, 39927, 39900, 39905]),
  K(tm(105), [39905, 39907, 39878, 39885]), K(tm(100), [39885, 39905, 39880, 39900]),
  K(tm(95), [39900, 39915, 39895, 39910]), K(tm(90), [39910, 39912, 39900, 39905]),
  K(tm(85), [39905, 39920, 39900, 39915]), K(tm(80), [39915, 39917, 39905, 39910]),
  K(tm(75), [39910, 39912, 39900, 39905]), K(tm(70), [39905, 39907, 39895, 39900]),
  K(tm(65), [39900, 39935, 39898, 39930]), K(tm(60), [39930, 39932, 39920, 39925]),
  K(tm(55), [39925, 39945, 39920, 39940]), K(tm(50), [39940, 39942, 39930, 39935]),
  K(tm(45), [39935, 39940, 39928, 39932]), K(tm(40), [39932, 39950, 39930, 39948]),
];
function m1Pre(fromMin: number, toMin: number): Candle[] {
  const out: Candle[] = [];
  let c = 39970;
  for (let m = fromMin; m >= toMin; m--) { out.push(K(tm(m), [c, c + 2, c - 2, c + 1])); c += 1; }
  return out;
}
const M1_FLOW: Candle[] = [
  K(tm(70), [39991, 39993, 39945, 39950]), K(tm(69), [39950, 39952, 39938, 39942]),
  K(tm(68), [39942, 39950, 39940, 39948]), K(tm(67), [39948, 39950, 39942, 39944]),
  K(tm(66), [39944, 39946, 39900, 39905]), K(tm(65), [39905, 39912, 39903, 39908]),
  K(tm(64), [39908, 39913, 39906, 39910]), K(tm(63), [39910, 39915, 39908, 39912]),
  K(tm(62), [39912, 39913, 39905, 39908]), K(tm(61), [39908, 39910, 39900, 39905]),
  K(tm(60), [39905, 39925, 39903, 39922]), K(tm(59), [39922, 39927, 39920, 39925]),
  K(tm(58), [39925, 39927, 39918, 39920]), K(tm(57), [39920, 39922, 39913, 39915]),
  K(tm(56), [39915, 39917, 39908, 39910]), K(tm(55), [39910, 39912, 39904, 39906]),
  K(tm(54), [39906, 39908, 39900, 39902]), K(tm(53), [39902, 39910, 39900, 39908]),
  K(tm(52), [39908, 39916, 39906, 39914]), K(tm(51), [39914, 39918, 39912, 39916]),
  K(tm(50), [39916, 39920, 39914, 39918]), K(tm(49), [39918, 39922, 39916, 39920]),
  K(tm(48), [39920, 39924, 39918, 39922]), K(tm(47), [39922, 39926, 39920, 39924]),
  K(tm(46), [39924, 39928, 39922, 39926]), K(tm(45), [39926, 39930, 39924, 39928]),
  K(tm(44), [39928, 39932, 39926, 39930]), K(tm(43), [39930, 39934, 39928, 39932]),
  K(tm(42), [39932, 39936, 39930, 39934]), K(tm(41), [39934, 39938, 39932, 39936]),
  K(tm(40), [39936, 39940, 39934, 39938]), K(tm(39), [39938, 39942, 39936, 39940]),
  K(tm(38), [39940, 39944, 39938, 39942]), K(tm(37), [39942, 39946, 39940, 39944]),
  K(tm(36), [39944, 39948, 39942, 39946]), K(tm(35), [39946, 39985, 39944, 39980]),
];
const M1_ALL: Candle[] = [...m1Pre(92, 71), ...M1_FLOW];
const LEVELS: SessionLevels = { pdh: 40200, pdl: 39600, londonHigh: 40050, londonLow: 39650, asiaHigh: 39980, asiaLow: 39600 };

// ── Provider mock (mismo patrón que candle_provider.test.ts, sin red) ─────
class MockProvider implements CandleProvider {
  lastRejectReason: string | null = null;
  constructor(public multi: MultiTF | null) {}
  async getAligned(): Promise<MultiTF | null> {
    if (!this.multi) { this.lastRejectReason = "mock: datos ausentes (fail-closed)"; return null; }
    return this.multi;
  }
  async getCandlesOnClose() { return null; }
  invalidateCache(): void {}
}

/** MultiTF con higiene de CIERRE real: cada TF solo expone velas cuya
 *  apertura + duración ≤ alignedAt (el provider real garantiza lo mismo). */
function multiAt(now: number, h1: Candle[], m15: Candle[], m5: Candle[], m1: Candle[]): MultiTF {
  return {
    h1: h1.filter(c => c.time + 60 * MIN <= now),
    m15: m15.filter(c => c.time + 15 * MIN <= now),
    m5: m5.filter(c => c.time + 5 * MIN <= now),
    m1: m1.filter(c => c.time + MIN <= now),
    alignedAt: now, gaps: [], stale: false, staleReasons: [],
  };
}

const FLOW_FLAGS = { sessionLevels: LEVELS, inKillzone: true } as const;

// ---------- 1) computeSessionLevels: PDH/PDL + ventanas Londres/Asia (D-12) ----------
{
  const day1 = Date.parse('2026-10-13T15:00:00Z'); // 11:00 ET (dentro del día ET anterior)
  const day0 = Date.parse('2026-10-12T15:00:00Z');
  const h1 = [
    K(day0, [40800, 41000, 39900, 40100]),        // día aún anterior: NO cuenta para PDH/PDL
    K(day1, [39900, 40100, 39700, 40000]),        // día ET completo anterior → PDH 40100 / PDL 39700
    K(Date.parse('2026-10-14T17:00:00Z'), [40050, 40250, 39850, 40100]), // hoy 13:00 ET: fuera de Londres/Asia, no toca PDH/PDL
  ];
  const m5 = [
    K(Date.parse('2026-10-14T12:00:00Z'), [39900, 40050, 39650, 39990]), // 08:00 ET: dentro de Londres
    K(Date.parse('2026-10-14T16:30:00Z'), [40200, 40500, 40150, 40300]), // 12:30 ET: FUERA de Londres
  ];
  const m15 = [K(Date.parse('2026-10-14T02:00:00Z'), [39700, 39980, 39600, 39800])]; // 22:00 ET día -1: ventana Asia
  const now = T0; // 09:10 ET
  const r = computeSessionLevels(h1, m15, m5, now);
  assert.strictEqual(r.levels.pdh, 40100, `PDH del último día ET completo (got ${r.levels.pdh})`);
  assert.strictEqual(r.levels.pdl, 39700, `PDL del último día ET completo (got ${r.levels.pdl})`);
  assert.strictEqual(r.levels.londonHigh, 40050, 'High de Londres solo dentro de 03:00-12:00 ET');
  assert.strictEqual(r.levels.londonLow, 39650, 'Low de Londres solo dentro de 03:00-12:00 ET');
  assert.strictEqual(r.levels.asiaHigh, 39980, 'High de Asia (19:00-04:00 ET)');
  assert.strictEqual(r.levels.asiaLow, 39600, 'Low de Asia');
  assert.strictEqual(r.h1ExtremeHigh, 41000, 'extremo estructural H1 = máximo del histórico visible');
  assert.strictEqual(r.h1ExtremeLow, 39700);
  console.log('OK computeSessionLevels: PDH/PDL por día ET + ventanas Londres/Asia DST-safe');
}

// ---------- 2) Flujo completo S0→S9 A TRAVÉS DEL RUNNER (cierre estricto) + paridad ----------
{
  const prov = new MockProvider(null as unknown as MultiTF);
  const runner = new StrategyEngineRunner({ provider: prov });
  let rawSt: EngineState = createEngineState('US30');
  const types: string[] = [];
  let orderSignal: StrategySignal | null = null;
  let closedSignal: StrategySignal | null = null;

  for (let m = 91; m >= 34; m--) {
    const now = tm(m); // instante de CIERRE de la vela M1 que abre en tm(m+1)
    prov.multi = multiAt(now, H1, M15_BASE, M5_BASE, M1_ALL);
    const fetched = await runner.fetchMultiTF('US30');
    assert.ok(fetched.ok, `fetch fail-closed inesperado en m=${m}`);
    const tick = runner.evaluateTick('US30', fetched, FLOW_FLAGS);
    assert.ok(tick.ok && !tick.noop, `tick ok en m=${m}: ${tick.reason}`);

    // PARIDAD: el engine puro con EXACTAMENTE los mismos inputs debe dar el mismo estado/eventos
    const comp = computeSessionLevels(prov.multi.h1, prov.multi.m15, prov.multi.m5, now);
    const rawOut = evaluate(rawSt, {
      now, candlesH1: prov.multi.h1, candlesM15: prov.multi.m15,
      candlesM5: prov.multi.m5, candlesM1: prov.multi.m1,
      sessionLevels: LEVELS, inKillzone: true, newsBlackout: false, riskBlocked: null,
      h1ExtremeHigh: comp.h1ExtremeHigh, h1ExtremeLow: comp.h1ExtremeLow,
    });
    rawSt = rawOut.state;
    assert.strictEqual(tick.state, rawSt.seq?.stage ?? 'S0_SCAN', `paridad de estado en m=${m}`);
    assert.strictEqual(
      JSON.stringify(tick.events.map(e => [e.type, e.detail])),
      JSON.stringify(rawSt.events.map(e => [e.type, e.detail])),
      `paridad de eventos en m=${m}`
    );

    for (const e of tick.events) if (!types.includes(e.type)) types.push(e.type);
    if (tick.events.some(e => e.type === 'ORDER_READY') && tick.signal) orderSignal = tick.signal;
    if (tick.closed) closedSignal = tick.closed;
  }

  for (const ev of ['SWEEP', 'POI_CREATED', 'POI_ENTERED', 'M5_CONFIRMED', 'M1_TRIGGER', 'ORDER_READY', 'FILLED', 'BE_SET', 'TP_HIT']) {
    assert.ok(types.includes(ev), `falta evento ${ev} en ${JSON.stringify(types)}`);
  }
  assert.ok(orderSignal, 'señal ORDER_READY capturada a través del runner');
  assert.strictEqual(orderSignal.direction, 'long');
  assert.strictEqual(orderSignal.entry?.price, 39905, 'LIMIT = retest 50% del bloque trigger');
  assert.strictEqual(orderSignal.sl?.price, 39898, 'SL estructural = extremo del fallo - buffer');
  assert.strictEqual(orderSignal.tp?.liquidityRef, 'asia_high', 'TP = liquidez externa más cercana');
  assert.strictEqual(orderSignal.risk.riskPct, 0.5);
  assert.strictEqual(orderSignal.openTradeContext.tfsUsed.length, 4, 'B11: 4 TFs usados');
  assert.ok(closedSignal, 'cierre TP capturado a través del runner');
  assert.strictEqual(closedSignal.tp?.liquidityRef, 'asia_high');
  console.log('OK flujo completo S0→S9 vía runner (cierre estricto) + paridad runner↔engine paso a paso');
}

// ---------- 3) Noop: mismo alignedAt ⇒ tick deduplicado (no-repaint) ----------
{
  const prov = new MockProvider(multiAt(tm(60), H1, M15_BASE, M5_BASE, M1_ALL));
  const runner = new StrategyEngineRunner({ provider: prov });
  const t1 = runner.evaluateTick('US30', { ok: true, data: prov.multi! }, FLOW_FLAGS);
  assert.ok(t1.ok && !t1.noop);
  const t2 = runner.evaluateTick('US30', { ok: true, data: prov.multi! }, FLOW_FLAGS);
  assert.ok(t2.ok && t2.noop, 'segundo tick con el mismo cierre = noop');
  assert.strictEqual(t2.events.length, 0, 'noop no emite eventos');
  assert.strictEqual(t2.state, t1.state, 'noop preserva el estado');
  console.log('OK dedupe por cierre M1 (una evaluación por vela)');
}

// ---------- 4) Fail-closed por datos: la secuencia NO se pierde ----------
{
  const prov = new MockProvider(null as unknown as MultiTF);
  const runner = new StrategyEngineRunner({ provider: prov });
  // avanzar hasta S4 (retorno a la caja ocurre con cierre tm(69))
  for (let m = 91; m >= 62; m--) {
    prov.multi = multiAt(tm(m), H1, M15_BASE, M5_BASE, M1_ALL);
    runner.evaluateTick('US30', { ok: true, data: prov.multi! }, FLOW_FLAGS);
  }
  const before = runner.getEngineState('US30');
  assert.ok(before?.seq, 'secuencia activa antes del fallo de datos');
  // tick con provider caído
  prov.multi = null;
  const bad = runner.evaluateTick('US30', { ok: false, reason: 'mock: bridge caído' }, FLOW_FLAGS);
  assert.strictEqual(bad.ok, false);
  assert.match(bad.reason ?? '', /bridge caído/);
  const after = runner.getEngineState('US30');
  assert.strictEqual(after?.seq?.stage, before?.seq?.stage, 'fail-closed NO toca la secuencia');
  // datos de vuelta: la secuencia continúa donde estaba
  prov.multi = multiAt(tm(61), H1, M15_BASE, M5_BASE, M1_ALL);
  const resumed = runner.evaluateTick('US30', { ok: true, data: prov.multi! }, FLOW_FLAGS);
  assert.ok(resumed.ok && !resumed.noop && resumed.state === 'S4_IN_POI', `secuencia continúa (${resumed.state})`);
  console.log('OK fail-closed por datos preserva la secuencia y se recupera');
}

// ---------- 5) Blackout de noticias ⇒ invalidación R15.6 ----------
{
  const prov = new MockProvider(null as unknown as MultiTF);
  const runner = new StrategyEngineRunner({ provider: prov });
  for (let m = 91; m >= 62; m--) {
    prov.multi = multiAt(tm(m), H1, M15_BASE, M5_BASE, M1_ALL);
    runner.evaluateTick('US30', { ok: true, data: prov.multi! }, FLOW_FLAGS);
  }
  prov.multi = multiAt(tm(61), H1, M15_BASE, M5_BASE, M1_ALL);
  const t = runner.evaluateTick('US30', { ok: true, data: prov.multi! }, { ...FLOW_FLAGS, newsBlackout: true });
  assert.strictEqual(t.state, 'S0_SCAN', 'blackout resetea a S0');
  assert.ok(t.events.some(e => e.type === 'INVALIDATED' && e.detail.includes('R15.6')), 'INVALIDATED R15.6');
  console.log('OK blackout de noticias invalida la secuencia (R15.6) a través del runner');
}

// ---------- 6) Killzone default DST-safe (evaluateMarketHours, fuente única) ----------
{
  const mk = (alignedAt: number): MultiTF => ({
    h1: [K(alignedAt - 3600_000, [39900, 39950, 39850, 39920])],
    m15: [K(alignedAt - 15 * MIN, [39910, 39930, 39900, 39920])],
    m5: [K(alignedAt - 5 * MIN, [39910, 39930, 39900, 39920])],
    m1: [K(alignedAt - MIN, [39910, 39930, 39900, 39920])],
    alignedAt, gaps: [], stale: false, staleReasons: [],
  });
  // martes 2026-01-13 15:30Z = 10:30 ET (EST, UTC-5) → killzone NY activa
  const tueAt = Date.parse('2026-01-13T15:30:00Z');
  const runnerTue = new StrategyEngineRunner({ provider: new MockProvider(mk(tueAt)) });
  const tue = runnerTue.evaluateTick('US30', { ok: true, data: mk(tueAt) }, {});
  assert.strictEqual(tue.inKillzone, true, 'martes 10:30 ET ⇒ killzone NY activa (US30)');
  // sábado 2026-01-17 → fin de semana ⇒ killzone false + GATE_BLOCK
  const satAt = Date.parse('2026-01-17T15:30:00Z');
  const runnerSat = new StrategyEngineRunner({ provider: new MockProvider(mk(satAt)) });
  const sat = runnerSat.evaluateTick('US30', { ok: true, data: mk(satAt) }, {});
  assert.strictEqual(sat.inKillzone, false, 'sábado ⇒ sin killzone (fail-closed)');
  assert.ok(sat.events.some(e => e.type === 'GATE_BLOCK' && e.detail.includes('killzone')), 'GATE_BLOCK fuera de killzone');
  console.log('OK killzone default vía evaluateMarketHours (DST-safe, política por activo)');
}

// ---------- 7) gatesToEngineFlags: mapeo fail-closed de gates ----------
{
  const g = (name: string, status: Gate['status'], detail = 'x'): Gate => ({ name, status, detail });
  const r1 = gatesToEngineFlags([g('news', 'RED'), g('account_risk', 'GREEN')]);
  assert.strictEqual(r1.newsBlackout, true, 'news RED ⇒ blackout');
  assert.strictEqual(r1.riskBlocked, null);
  const r2 = gatesToEngineFlags([g('news', 'GREEN'), g('account_risk', 'UNKNOWN', 'riesgo no evaluable')]);
  assert.strictEqual(r2.newsBlackout, false);
  assert.strictEqual(r2.riskBlocked, 'riesgo no evaluable', 'account UNKNOWN ⇒ kill-switch con detalle');
  const r3 = gatesToEngineFlags([g('news', 'YELLOW'), g('account_risk', 'GREEN')]);
  assert.strictEqual(r3.newsBlackout, true, 'news YELLOW ⇒ blackout (fail-closed)');
  const r4 = gatesToEngineFlags([g('news', 'GREEN'), g('account_risk', 'GREEN')]);
  assert.deepStrictEqual(r4, { newsBlackout: false, riskBlocked: null });
  console.log('OK mapeo gates del pipeline → flags del engine (fail-closed)');
}

// ---------- 8) planFromSignal: plan determinista para el modo source ----------
{
  const prov = new MockProvider(null as unknown as MultiTF);
  const runner = new StrategyEngineRunner({ provider: prov });
  let sig: StrategySignal | null = null;
  for (let m = 91; m >= 34 && !sig; m--) {
    prov.multi = multiAt(tm(m), H1, M15_BASE, M5_BASE, M1_ALL);
    const t = runner.evaluateTick('US30', { ok: true, data: prov.multi! }, FLOW_FLAGS);
    if (t.events.some(e => e.type === 'ORDER_READY') && t.signal) sig = t.signal;
  }
  assert.ok(sig, 'señal con orden para fabricar plan');
  const plan = planFromSignal(sig);
  assert.ok(plan, 'plan fabricado');
  assert.strictEqual(plan!.action, 'EXECUTE');
  assert.strictEqual(plan!.direction, 'BUY');
  assert.strictEqual(plan!.stopLossPips, Math.round(sig.sl!.pips * 10) / 10);
  assert.strictEqual(plan!.riskPct, 0.5);
  assert.ok(plan!.setup.startsWith('strategy_engine:'), `setup etiquetado (${plan!.setup})`);
  assert.ok(plan!.reasoning.includes('LIMIT 39905'), 'razonamiento determinista con la entrada');
  assert.ok(plan!.reasoning.includes('Pilar H1'), 'checklist OpenTrade B11 en el reasoning');
  // sin orden viva ⇒ null (fail-closed)
  const partial = { ...sig, entry: null, sl: null, tp: null } as unknown as StrategySignal;
  assert.strictEqual(planFromSignal(partial), null, 'señal sin entry/SL/TP ⇒ sin plan');
  console.log('OK planFromSignal: TradePlan determinista (modo source) + fail-closed sin orden');
}

// ---------- 9) getStrategyEngineMode: env con default SHADOW ----------
{
  const prev = process.env.STRATEGY_ENGINE_MODE;
  try {
    delete process.env.STRATEGY_ENGINE_MODE;
    assert.strictEqual(getStrategyEngineMode(), 'shadow', 'default = shadow');
    process.env.STRATEGY_ENGINE_MODE = 'off';
    assert.strictEqual(getStrategyEngineMode(), 'off');
    process.env.STRATEGY_ENGINE_MODE = 'source';
    assert.strictEqual(getStrategyEngineMode(), 'source');
    process.env.STRATEGY_ENGINE_MODE = 'SHADOW';
    assert.strictEqual(getStrategyEngineMode(), 'shadow', 'case-insensitive');
    process.env.STRATEGY_ENGINE_MODE = 'garbage';
    assert.strictEqual(getStrategyEngineMode(), 'shadow', 'valor desconocido ⇒ shadow (fail-safe)');
  } finally {
    if (prev === undefined) delete process.env.STRATEGY_ENGINE_MODE;
    else process.env.STRATEGY_ENGINE_MODE = prev;
  }
  console.log('OK modo del engine por env (off/shadow/source, default shadow)');
}

console.log('\nTODOS LOS TESTS DE CABLEADO DEL STRATEGY ENGINE EN VERDE');
