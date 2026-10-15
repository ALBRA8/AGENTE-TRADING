// Tests STRATEGY ENGINE V1.0 — fixtures sintéticos US30 explícitos, driver por cierre de vela M1
import assert from 'node:assert';
import { evaluate, createEngineState } from '../src/strategy/engine.ts';
import { DEFAULT_STRATEGY_CONFIG } from '../src/strategy/strategy.config.ts';
import type { Candle, EngineInput, EngineState, SessionLevels } from '../src/strategy/types.ts';

const MIN = 60_000;
const T0 = Date.parse('2026-10-14T13:10:00Z'); // 09:10 ET (killzone NY)
const tm = (m: number) => T0 - m * MIN;        // "T-<minutos>"

// helper: vela explícita [o,h,l,c]
const K = (time: number, t: [number, number, number, number], v = 100): Candle =>
  ({ time, open: t[0], high: t[1], low: t[2], close: t[3], volume: v });

// H1: swing high i3 (39990) + swing low i5 (39860) + BOS bull i7 (40010 > 39990) → sesgo bull
const H1: Candle[] = [
  K(tm(600), [39790, 39882, 39780, 39880]), K(tm(540), [39880, 39952, 39870, 39950]),
  K(tm(480), [39950, 39952, 39898, 39900]), K(tm(420), [39900, 39990, 39898, 39980]),
  K(tm(360), [39980, 39982, 39928, 39930]), K(tm(300), [39930, 39932, 39860, 39870]),
  K(tm(240), [39870, 39942, 39862, 39940]), K(tm(180), [39940, 40012, 39932, 40010]),
  K(tm(120), [40010, 40014, 39988, 39990]), K(tm(60), [39990, 40062, 39982, 40060]),
];
// H1 range: solo las 6 primeras (sin BOS confirmado)
const H1_RANGE = H1.slice(0, 6);

// M15: BOS válido j12 (cierre 40090 > swing high j3 40080, con mecha j9 bajo micro low j7 39940 = D-4)
// POI = j9 (última vela contraria antes del impulso): caja [39952, 39890]
const M15_BASE: Candle[] = [
  K(tm(270), [40020, 40050, 40010, 40040]), K(tm(255), [40040, 40070, 40030, 40060]),
  K(tm(240), [40060, 40065, 40020, 40030]), K(tm(225), [40030, 40080, 40020, 40070]),
  K(tm(210), [40070, 40075, 40010, 40020]), K(tm(195), [40020, 40025, 39970, 39980]),
  K(tm(180), [39980, 39985, 39955, 39960]), K(tm(165), [39960, 39965, 39940, 39950]),
  K(tm(150), [39950, 39955, 39945, 39950]), K(tm(135), [39950, 39952, 39890, 39900]),
  K(tm(120), [39900, 40010, 39895, 40000]), K(tm(105), [40000, 40060, 39990, 40050]),
  K(tm(90), [40050, 40095, 40040, 40090]), K(tm(75), [40090, 40130, 40080, 40120]),
];
const M15_INVALIDATOR = K(tm(60), [39900, 39905, 39860, 39870]); // cierre 39870 < bottom 39890 → R15.1

// M5: sweep interno (i4 low 39878 < micro low M15 39940/39890 → cierre de vuelta i5),
// micro high i8 (39920), CHOCH M5 i12 (cierre 39930, solapa caja), BOS para BE i17 (cierre 39948 > swing i14 39945)
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
const M5_FLAT: Candle[] = [ // nunca toca 39940 → sin sweep
  K(tm(125), [39950, 39960, 39948, 39958]), K(tm(120), [39958, 39962, 39954, 39960]),
  K(tm(115), [39960, 39963, 39956, 39958]), K(tm(110), [39958, 39961, 39955, 39959]),
];

// M1: pre-fase monotónica (sin swings → sin breaks) + ventana engineered
function m1Pre(fromMin: number, toMin: number): Candle[] {
  const out: Candle[] = [];
  let c = 39970;
  for (let m = fromMin; m >= toMin; m--) { out.push(K(tm(m), [c, c + 2, c - 2, c + 1])); c += 1; }
  return out;
}
const M1_FLOW: Candle[] = [ // T-70 .. T-35
  K(tm(70), [39991, 39993, 39945, 39950]),   // retorno a la caja (low 39945 ≤ top 39952) — llega vía M5 i8 en T-85
  K(tm(69), [39950, 39952, 39938, 39942]), K(tm(68), [39942, 39950, 39940, 39948]),
  K(tm(67), [39948, 39950, 39942, 39944]),
  K(tm(66), [39944, 39946, 39900, 39905]),   // caída al POI (low 39900 → extremo/SL 39898)
  K(tm(65), [39905, 39912, 39903, 39908]),   // (M5 CHOCH cierra en T-65)
  K(tm(64), [39908, 39913, 39906, 39910]), K(tm(63), [39910, 39915, 39908, 39912]), // micro high 39915
  K(tm(62), [39912, 39913, 39905, 39908]), K(tm(61), [39908, 39910, 39900, 39905]),
  K(tm(60), [39905, 39925, 39903, 39922]),   // CHOCH M1 (39922 > 39915) → trigger → LIMIT 39905
  K(tm(59), [39922, 39927, 39920, 39925]), K(tm(58), [39925, 39927, 39918, 39920]),
  K(tm(57), [39920, 39922, 39913, 39915]), K(tm(56), [39915, 39917, 39908, 39910]),
  K(tm(55), [39910, 39912, 39904, 39906]),   // fill LIMIT (low 39904 ≤ 39905)
  K(tm(54), [39906, 39908, 39900, 39902]), K(tm(53), [39902, 39910, 39900, 39908]),
  K(tm(52), [39908, 39916, 39906, 39914]), K(tm(51), [39914, 39918, 39912, 39916]),
  K(tm(50), [39916, 39920, 39914, 39918]), K(tm(49), [39918, 39922, 39916, 39920]),
  K(tm(48), [39920, 39924, 39918, 39922]), K(tm(47), [39922, 39926, 39920, 39924]),
  K(tm(46), [39924, 39928, 39922, 39926]), K(tm(45), [39926, 39930, 39924, 39928]),
  K(tm(44), [39928, 39932, 39926, 39930]), K(tm(43), [39930, 39934, 39928, 39932]),
  K(tm(42), [39932, 39936, 39930, 39934]), K(tm(41), [39934, 39938, 39932, 39936]),
  K(tm(40), [39936, 39940, 39934, 39938]),   // BE estructural (M5 i17 cerró T-40)
  K(tm(39), [39938, 39942, 39936, 39940]), K(tm(38), [39940, 39944, 39938, 39942]),
  K(tm(37), [39942, 39946, 39940, 39944]), K(tm(36), [39944, 39948, 39942, 39946]),
  K(tm(35), [39946, 39985, 39944, 39980]),   // TP hit (high 39985 ≥ 39980 = asiaHigh)
];
const M1_DEEP_WICK = K(tm(66), [39944, 39946, 39780, 39905]); // mecha profunda → SL ~127 pips → R12.3
const M1_INVALIDATOR = K(tm(75), [39987, 39989, 39880, 39885]); // cierre 39885 < bottom 39890 → R15.1 en S4

const LEVELS: SessionLevels = { pdh: 40200, pdl: 39600, londonHigh: 40050, londonLow: 39650, asiaHigh: 39980, asiaLow: 39600 };

interface Opts { deepWick?: boolean; invalidate?: boolean; h1?: Candle[]; m5?: Candle[]; news?: boolean; risk?: string | null }

function drive(o: Opts = {}): { st: EngineState; types: string[]; lastSignal: any; allEvents: any[] } {
  let st = createEngineState('US30');
  const types: string[] = [];
  const allEvents: any[] = [];
  let lastSignal = null as any;
  const m1 = [...m1Pre(92, 71), ...M1_FLOW];
  if (o.deepWick) { const i = m1.findIndex(c => c.time === tm(66)); m1[i] = M1_DEEP_WICK; }
  if (o.invalidate) { const i = m1.findIndex(c => c.time === tm(75)); m1[i] = M1_INVALIDATOR; }
  const m5 = o.m5 ?? M5_BASE;
  const m15 = [...M15_BASE];
  const h1 = o.h1 ?? H1;
  for (let m = 92; m >= 35; m--) {
    const now = tm(m);
    const out = evaluate(st, {
      now, candlesH1: h1,
      candlesM15: m15.filter(c => c.time <= now),
      candlesM5: m5.filter(c => c.time <= now),
      candlesM1: m1.filter(c => c.time <= now),
      sessionLevels: LEVELS, inKillzone: true,
      newsBlackout: o.news ?? false, riskBlocked: o.risk ?? null,
      h1ExtremeHigh: 40120, h1ExtremeLow: 39860,
    } satisfies EngineInput);
    st = out.state;
    allEvents.push(...st.events);
    for (const e of st.events) if (!types.includes(e.type)) types.push(e.type);
    if (out.signal && st.events.some(e => e.type === 'ORDER_READY')) lastSignal = out.signal; // señal en el momento ORDER_READY
    else if (out.signal && !lastSignal) lastSignal = out.signal;
  }
  return { st, types, lastSignal, allEvents };
}

// ---------- 1) Flujo long completo S0→S9 ----------
{
  const { st, types, lastSignal, allEvents } = drive();
  for (const ev of ['SWEEP', 'POI_CREATED', 'POI_ENTERED', 'M5_CONFIRMED', 'M1_TRIGGER', 'ORDER_READY', 'FILLED', 'BE_SET', 'TP_HIT']) {
    assert.ok(types.includes(ev), `falta evento ${ev} en ${JSON.stringify(types)}`);
  }
  assert.strictEqual(st.seq, null, 'secuencia cerrada tras TP');
  const sig = lastSignal;
  assert.ok(sig, 'señal emitida');
  assert.strictEqual(sig.direction, 'long');
  assert.strictEqual(sig.risk.riskPct, 0.5);
  assert.strictEqual(sig.openTradeContext.tfsUsed.length, 4, 'B11: 4 TFs');
  assert.ok(sig.sl && sig.sl.pips <= DEFAULT_STRATEGY_CONFIG.maxSlPips, `SL ${sig.sl?.pips} ≤ 15 pips`);
  assert.ok(sig.tp && sig.tp.rr >= DEFAULT_STRATEGY_CONFIG.minRR, `RR ${sig.tp?.rr} ≥ 2`);
  assert.strictEqual(sig.tp.liquidityRef, 'asia_high', 'TP = liquidez externa más cercana (R13.1)');
  assert.strictEqual(sig.sl.structuralRef, 'choch_extreme', 'SL estructural (R12.1)');
  assert.ok(allEvents.some(e => e.type === 'ORDER_READY' && e.detail.includes('SL 39898')), 'SL = extremo del fallo estructural - buffer (R12.1)');
  console.log('OK flujo long completo S0→S9: sweep→BOS→POI→retorno→M5→M1→retest→BE→TP');
}

// ---------- 2) SL > 15 pips ⇒ REJECTED_SL (R12.3) ----------
{
  const { types } = drive({ deepWick: true });
  assert.ok(types.includes('REJECTED_SL'), `REJECTED_SL en ${JSON.stringify(types)}`);
  assert.ok(!types.includes('ORDER_READY'), 'no hay orden');
  console.log('OK SL > 15 pips ⇒ rechazo (R12.3)');
}

// ---------- 3) Cierre más allá de la POI ⇒ invalidación (R15.1) ----------
{
  const { types, allEvents } = drive({ invalidate: true });
  assert.ok(allEvents.some(e => e.detail.includes('R15.1')), `R15.1 en ${JSON.stringify(allEvents.map(e => e.detail))}`);
  assert.ok(!types.includes('ORDER_READY'), 'no llegó a orden');
  assert.ok(!types.includes('M5_CONFIRMED'), 'murió antes de la confirmación M5');
  console.log('OK cierre más allá de la POI ⇒ invalidación (R15.1)');
}

// ---------- 4) H1 range ⇒ no-trade (R16.2) ----------
{
  const { st } = drive({ h1: H1_RANGE });
  assert.strictEqual(st.seq, null, 'range ⇒ sin secuencia');
  assert.ok(st.events.some(e => e.detail.includes('range')), 'gate range');
  console.log('OK H1 range ⇒ no-trade (R16.2)');
}

// ---------- 5) Sin sweep ⇒ no setup (R16.3) ----------
{
  const { st } = drive({ m5: M5_FLAT });
  assert.strictEqual(st.seq, null, 'sin sweep ⇒ sin secuencia');
  assert.ok(st.events.some(e => e.detail.includes('sweep')), 'gate sweep');
  console.log('OK sin sweep de liquidez ⇒ no setup (R16.3)');
}

// ---------- 6) Gates: noticias (R16.4) y kill-switch (R16.5) ----------
{
  const { st } = drive({ news: true });
  assert.strictEqual(st.seq, null);
  assert.ok(st.events.some(e => e.detail.includes('noticias')));
  const r = drive({ risk: 'pérdida diaria 1%' });
  assert.strictEqual(r.st.seq, null);
  assert.ok(r.st.events.some(e => e.detail.includes('kill-switch')));
  console.log('OK gates noticias (R16.4) y kill-switch de riesgo (R16.5)');
}

console.log('\nTODOS LOS TESTS DEL STRATEGY ENGINE V1.0 EN VERDE');
