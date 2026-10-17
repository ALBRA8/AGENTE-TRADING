// ============================================================
// tests/candle_provider.test.ts — SE-DATA (se-data-2)
// Mock del bridge (sin red): alineación multi-TF, dedupe, gaps fail-closed,
// staleness, exclusión de vela en curso, caché TTL, bridge que falla.
// Ejecutar: npx tsx tests/candle_provider.test.ts
// ============================================================
import fs from "node:fs";
import type {
  BridgeCandle,
  BridgeCandleClient,
  ProviderEvent,
  TF,
} from "../src/data/candle_provider.js";

const { MT5CandleProvider, TF_MINUTES } = await import(
  "../src/data/candle_provider.js"
);

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string): void {
  // writeSync: inmune a buffers perdidos si el proceso muere al salir
  const line = cond ? `✅ ${msg}\n` : `❌ FALLO: ${msg}\n`;
  fs.writeSync(1, line);
  if (cond) passed++;
  else failed++;
  if (!cond) process.exitCode = 1;
}

// ── Fixture: frontera común de cierre H1/M15/M5/M1 ─────────
// 15:00:00Z es divisible por 60/15/5/1 min ⇒ cierre simultáneo de los 4 TFs.
const CLOSE = Date.UTC(2026, 9, 15, 15, 0, 0); // epoch ms

function mkCandle(t: number, i: number): BridgeCandle {
  return {
    time: new Date(t).toISOString(), // el bridge real devuelve ISO string
    open: 40000 + i * 0.5,
    high: 40001 + i * 0.5,
    low: 39999 + i * 0.5,
    close: 40000.5 + i * 0.5,
    tickVolume: 100 + i,
  };
}

interface SeriesOpts {
  forming?: boolean;        // añade vela en curso que abre en CLOSE
  skipOffsetBars?: number;  // elimina la vela N barras antes de la última (hueco)
  dupLast?: boolean;        // duplica la última vela (mismo timestamp, close distinto VÁLIDO)
  corruptOne?: boolean;     // vela inválida en medio de la serie (crea hueco al caer)
  corruptFirst?: boolean;   // vela inválida al PRINCIPIO (cae sin crear hueco interno)
  lastOpenShiftMs?: number; // desplaza la apertura de la última vela (skew)
}

const DUP_CLOSE = 40030.5; // close del duplicado: distinto del original Y válido (== high)

function buildSeries(tf: TF, closed: number, opts: SeriesOpts = {}): BridgeCandle[] {
  const tfMs = TF_MINUTES[tf] * 60_000;
  const lastOpen = CLOSE - tfMs + (opts.lastOpenShiftMs ?? 0);
  const out: BridgeCandle[] = [];
  let i = 0;
  for (let k = closed - 1; k >= 0; k--) {
    const t = lastOpen - k * tfMs;
    if (opts.skipOffsetBars !== undefined && k === opts.skipOffsetBars) continue;
    out.push(mkCandle(t, i++));
  }
  if (opts.dupLast && out.length > 0) out.push({ ...out[out.length - 1], close: DUP_CLOSE });
  if (opts.corruptOne && out.length > 2) out[1] = { ...out[1], high: 1, low: 2 };
  if (opts.corruptFirst && out.length > 1) out[0] = { ...out[0], open: NaN };
  if (opts.forming) out.push(mkCandle(CLOSE, 999)); // vela viva: cierra en CLOSE+TF > NOW
  return out;
}

// ── Mock del bridge client (inyección) ─────────────────────
// NOTA: devuelve la serie COMPLETA sin recortar por `count` — así los
// recuentos del fixture (60 cerradas + forming) son deterministas.
class MockBridge implements BridgeCandleClient {
  calls = 0;
  failFor = new Set<string>();
  series = new Map<TF, BridgeCandle[]>();
  async getCandles(symbol: string, timeframe: string, count: number): Promise<BridgeCandle[]> {
    void symbol;
    void count;
    this.calls++;
    if (this.failFor.has(timeframe)) throw new Error("bridge caído (mock)");
    return this.series.get(timeframe as TF) ?? [];
  }
}

function seedMock(mb: MockBridge, perTf: number, opts: SeriesOpts = {}, tfs: TF[] = ["H1", "M15", "M5", "M1"]): void {
  for (const tf of tfs) mb.series.set(tf, buildSeries(tf, perTf, opts));
}

const TFS: TF[] = ["H1", "M15", "M5", "M1"];
const isSortedAsc = (arr: { time: number }[]): boolean =>
  arr.every((c, i) => i === 0 || c.time > arr[i - 1].time);
const noDupes = (arr: { time: number }[]): boolean =>
  new Set(arr.map((c) => c.time)).size === arr.length;

// ═══ Tests ═════════════════════════════════════════════════

// 1) Alineación multi-TF correcta
{
  const mb = new MockBridge();
  seedMock(mb, 60, { forming: true });
  const events: ProviderEvent[] = [];
  let now = CLOSE;
  const p = new MT5CandleProvider(mb, { now: () => now, onEvent: (e) => events.push(e) });
  const r = await p.getAligned("US30", TFS, 50);
  assert(r !== null, "1.1 getAligned devuelve MultiTF con fixture fresco y completo");
  if (r) {
    assert(r.alignedAt === CLOSE, `1.2 alignedAt = último cierre común 15:00Z (got ${new Date(r.alignedAt).toISOString()})`);
    assert(
      r.h1.length === 60 && r.m15.length === 60 && r.m5.length === 60 && r.m1.length === 60,
      `1.3 60 velas cerradas por TF (h1=${r.h1.length} m15=${r.m15.length} m5=${r.m5.length} m1=${r.m1.length})`
    );
    assert(
      r.h1[r.h1.length - 1].time + TF_MINUTES.H1 * 60_000 === CLOSE &&
        r.m1[r.m1.length - 1].time + 60_000 === CLOSE,
      "1.4 la última vela de cada TF cierra exactamente en alignedAt"
    );
    assert(
      isSortedAsc(r.h1) && isSortedAsc(r.m15) && isSortedAsc(r.m5) && isSortedAsc(r.m1),
      "1.5 todas las series en orden ascendente"
    );
    assert(r.gaps.length === 0 && r.stale === false, "1.6 sin gaps ni staleness en fixture fresco");
    assert(r.m1[r.m1.length - 1].time === CLOSE - 60_000, "1.7 vela en curso EXCLUIDA (no-repaint §0.2)");
    assert(events.length === 0, "1.8 sin eventos anómalos en el camino feliz");
  }
}

// 2) Dedupe de timestamps
{
  const mb = new MockBridge();
  seedMock(mb, 60, { forming: true, dupLast: true });
  const p = new MT5CandleProvider(mb, { now: () => CLOSE });
  const r = await p.getAligned("US30", ["M1"], 50);
  assert(r !== null && r.m1.length === 60, `2.1 duplicado absorbido: 60 únicas (61 cerradas crudas + forming excluida) (got ${r?.m1.length})`);
  assert(r !== null && noDupes(r.m1), "2.2 cero timestamps duplicados tras dedupe");
  assert(r !== null && r.m1[r.m1.length - 1].close === DUP_CLOSE, "2.3 gana la ÚLTIMA ocurrencia del timestamp (snapshot más fresco, válido)");
}

// 3) Gap detection → fail-closed (B17.1) — hueco SOLO en M5
{
  const mb = new MockBridge();
  seedMock(mb, 60, { forming: true });
  mb.series.set("M5", buildSeries("M5", 60, { forming: true, skipOffsetBars: 10 }));
  const events: ProviderEvent[] = [];
  const p = new MT5CandleProvider(mb, { now: () => CLOSE, onEvent: (e) => events.push(e) });
  const r = await p.getAligned("US30", TFS, 50);
  assert(r === null, "3.1 hueco en M5 ⇒ getAligned = null (fail-closed)");
  assert(
    p.lastRejectReason !== null && p.lastRejectReason.includes("B17.1") && p.lastRejectReason.includes("M5"),
    `3.2 motivo registra la regla y el TF (got: ${p.lastRejectReason})`
  );
  const gapEv = events.find((e) => e.kind === "gap_detected");
  assert(gapEv !== undefined && gapEv.kind === "gap_detected" && gapEv.tf === "M5", "3.3 evento gap_detected emitido con tf=M5");
  assert(
    gapEv !== undefined && gapEv.kind === "gap_detected" && gapEv.gaps[0].includes("1 vela"),
    `3.4 el gap cuantifica la vela ausente (got: ${gapEv && gapEv.kind === "gap_detected" ? gapEv.gaps[0] : "n/a"})`
  );
}

// 3b) failOnGaps:false → diagnóstico sin bloquear
{
  const mb = new MockBridge();
  seedMock(mb, 60, { forming: true });
  mb.series.set("M5", buildSeries("M5", 60, { forming: true, skipOffsetBars: 10 }));
  const p = new MT5CandleProvider(mb, { now: () => CLOSE, failOnGaps: false });
  const r = await p.getAligned("US30", TFS, 50);
  assert(r !== null && r.gaps.length === 1 && r.gaps[0].startsWith("M5:"),
    `3b.1 failOnGaps:false ⇒ MultiTF con gaps registrado (${r?.gaps.length ?? 0})`);
}

// 4) Staleness: marca, no bloquea (live.ts:439-448)
{
  const mb = new MockBridge();
  seedMock(mb, 60, { forming: true });
  const events: ProviderEvent[] = [];
  const now = CLOSE + 3 * 60 * 60_000 + 2 * 60_000; // 3h02m después del cierre común
  const p = new MT5CandleProvider(mb, { now: () => now, onEvent: (e) => events.push(e) });
  const r = await p.getAligned("US30", TFS, 50);
  assert(r !== null, "4.1 stale NO bloquea: getAligned sigue devolviendo MultiTF");
  assert(r !== null && r.stale === true && r.staleReasons.length === 4,
    `4.2 los 4 TFs marcados stale (>3×TF de antigüedad) (got ${r?.staleReasons.length})`);
  assert(r !== null && r.staleReasons[0].includes("mercado cerrado o feed muerto"),
    "4.3 motivo de staleness legible (higiene live.ts)");
  assert(events.filter((e) => e.kind === "stale").length === 4, "4.4 evento stale por TF");
}

// 5) Bridge que falla (uno y todos los TFs)
{
  const mb = new MockBridge();
  seedMock(mb, 60, { forming: true });
  mb.failFor.add("M5");
  const events: ProviderEvent[] = [];
  const p = new MT5CandleProvider(mb, { now: () => CLOSE, onEvent: (e) => events.push(e) });
  const r = await p.getAligned("US30", TFS, 50);
  assert(r === null, "5.1 fallo del bridge en UN TF ⇒ null (fail-closed §0.3)");
  assert(p.lastRejectReason !== null && p.lastRejectReason.includes("M5"), "5.2 motivo identifica el TF caído");
  assert(events.some((e) => e.kind === "bridge_error"), "5.3 evento bridge_error emitido");

  const mb2 = new MockBridge(); // bridge caído entero: ninguna TF tiene serie
  mb2.failFor.add("H1"); mb2.failFor.add("M15"); mb2.failFor.add("M5"); mb2.failFor.add("M1");
  const p2 = new MT5CandleProvider(mb2, { now: () => CLOSE });
  assert((await p2.getAligned("US30", TFS, 50)) === null, "5.4 bridge caído completo ⇒ null");
  assert((await p2.getCandlesOnClose("US30", "M1", 50)) === null, "5.5 getCandlesOnClose también fail-closed");
}

// 6) Velas insuficientes
{
  const mb = new MockBridge();
  seedMock(mb, 60, { forming: true });
  const events: ProviderEvent[] = [];
  const p = new MT5CandleProvider(mb, { now: () => CLOSE, onEvent: (e) => events.push(e) });
  assert((await p.getAligned("US30", TFS, 300)) === null, "6.1 minCount 300 con 60 disponibles ⇒ null");
  assert(events.some((e) => e.kind === "insufficient_candles"), "6.2 evento insufficient_candles emitido");
  assert(p.lastRejectReason !== null && p.lastRejectReason.includes("§2.1/B17.1"), "6.3 motivo cita el contrato de datos");
  const p2 = new MT5CandleProvider(new MockBridge(), { now: () => CLOSE }); // sin datos
  assert((await p2.getAligned("US30", TFS, 50)) === null, "6.4 series vacías ⇒ null");
  assert((await p.getAligned("US30", [], 50)) === null, "6.5 lista de TFs vacía ⇒ null");
  assert((await p.getAligned("US30", TFS, 0)) === null, "6.6 minCount inválido ⇒ null");
}

// 7) Caché LRU con TTL: segunda llamada dentro de TTL NO re-fetch
{
  const mb = new MockBridge();
  seedMock(mb, 60, { forming: true });
  let now = CLOSE;
  const p = new MT5CandleProvider(mb, { now: () => now, cacheTtlMs: 5000 });
  await p.getAligned("US30", TFS, 50);
  assert(mb.calls === 4, `7.1 primer ciclo: 1 fetch por TF (got ${mb.calls})`);
  await p.getAligned("US30", TFS, 50);
  assert(mb.calls === 4, `7.2 segunda llamada dentro de TTL sirve de caché (got ${mb.calls})`);
  now = CLOSE + 1000; // sigue dentro del TTL
  await p.getAligned("US30", TFS, 50);
  assert(mb.calls === 4, "7.3 cache hit también con el reloj avanzado < TTL");
  now = CLOSE + 6000; // TTL expirado
  await p.getAligned("US30", TFS, 50);
  assert(mb.calls === 8, `7.4 TTL expirado ⇒ re-fetch de los 4 TFs (got ${mb.calls})`);
  await p.getAligned("US30", TFS, 50, { fresh: true });
  assert(mb.calls === 12, `7.5 fresh:true fuerza re-fetch aunque la caché viva (got ${mb.calls})`);
  p.invalidateCache("US30");
  await p.getAligned("US30", TFS, 50);
  assert(mb.calls === 16, "7.6 invalidateCache(symbol) vacía solo ese símbolo");
}

// 8) getCandlesOnClose: cierre de vela, stale y caché por TF
{
  const mb = new MockBridge();
  seedMock(mb, 60, { forming: true });
  let now = CLOSE;
  const p = new MT5CandleProvider(mb, { now: () => now, cacheTtlMs: 5000 });
  const r1 = await p.getCandlesOnClose("US30", "M1", 50);
  assert(r1 !== null && r1.candles.length === 60, "8.1 getCandlesOnClose devuelve solo cerradas");
  assert(r1 !== null && r1.candles[r1.candles.length - 1].time === CLOSE - 60_000,
    "8.2 la vela en curso queda fuera (no-repaint §0.2)");
  assert(r1 !== null && r1.stale === false && r1.staleReason === null, "8.3 fresco: stale=false");
  const callsAfterFirst = mb.calls;
  now = CLOSE + 1000;
  const r2 = await p.getCandlesOnClose("US30", "M1", 50);
  assert(mb.calls === callsAfterFirst, "8.4 segunda llamada dentro de TTL = caché, no re-fetch");
  assert(r2 !== null && r2.candles.length === 60, "8.5 caché entrega la misma serie cerrada");
  now = CLOSE + 10 * 60_000; // age 10 min > 3×1 min ⇒ stale
  const r3 = await p.getCandlesOnClose("US30", "M1", 50);
  assert(r3 !== null && r3.stale === true && r3.staleReason !== null,
    "8.6 staleness marcado en getCandlesOnClose (>3×TF, live.ts:439-448)");
  assert((await p.getCandlesOnClose("US30", "M1", 300)) === null, "8.7 insuficientes ⇒ null");
}

// 9) Alineación con skew entre TFs (M1 retrasado): último cierre común
{
  const mb = new MockBridge();
  seedMock(mb, 60, { forming: false });
  // M1 retrasado 1 minuto: su última vela cierra en CLOSE-1min en vez de CLOSE
  mb.series.set("M1", buildSeries("M1", 60, { lastOpenShiftMs: -60_000 }));
  const p = new MT5CandleProvider(mb, { now: () => CLOSE });
  const r = await p.getAligned("US30", ["M15", "M1"], 50);
  assert(r !== null, "9.1 skew de feed no rompe la alineación");
  if (r) {
    assert(r.alignedAt === CLOSE - 60_000,
      `9.2 alignedAt = último cierre COMÚN (M1) = ${new Date(r.alignedAt).toISOString()}`);
    assert(r.m15[r.m15.length - 1].time + TF_MINUTES.M15 * 60_000 <= r.alignedAt,
      "9.3 M15 truncado: ninguna vela cierra después del cierre común");
    assert(r.m15.length === 59, `9.4 la vela M15 que cerraba tras alignedAt se descartó (got ${r.m15.length})`);
    assert(r.m1.length === 60 && r.m1[r.m1.length - 1].time + 60_000 === r.alignedAt,
      "9.5 M1 conserva sus 60 velas y define el cierre común");
  }
}

// 10) Velas corruptas del bridge: se descartan, jamás se sirven
{
  // 10a: corrupta EN MEDIO ⇒ al caer deja hueco ⇒ cadena fail-closed completa
  const mb = new MockBridge();
  seedMock(mb, 60, { forming: true, corruptOne: true });
  const p = new MT5CandleProvider(mb, { now: () => CLOSE });
  const r = await p.getAligned("US30", TFS, 50);
  assert(r === null, "10.1 vela corrupta intermedia ⇒ hueco ⇒ null (B17.1 en cadena)");

  // 10b: corrupta al PRINCIPIO ⇒ cae sin hueco interno ⇒ el servicio sigue
  const mb2 = new MockBridge();
  seedMock(mb2, 60, { forming: true, corruptFirst: true });
  const p2 = new MT5CandleProvider(mb2, { now: () => CLOSE });
  const r2 = await p2.getAligned("US30", TFS, 50);
  assert(r2 !== null && isSortedAsc(r2.m5) && noDupes(r2.m5), "10.2 vela corrupta inicial descartada, serie válida restante");
  assert(
    r2 !== null &&
      [...r2.h1, ...r2.m15, ...r2.m5, ...r2.m1].every(
        (c) => Number.isFinite(c.time) && Number.isFinite(c.open) && Number.isFinite(c.high) &&
          Number.isFinite(c.low) && Number.isFinite(c.close) && c.high >= c.low
      ),
    "10.3 ninguna vela servida viola OHLC (validación live.ts:396-404)"
  );
}

// 11) Dedupe de TFs repetidos + un solo TF
{
  const mb = new MockBridge();
  seedMock(mb, 60, { forming: true });
  const p = new MT5CandleProvider(mb, { now: () => CLOSE });
  const r = await p.getAligned("US30", ["M5", "M5", "M5"], 50);
  assert(r !== null && r.m5.length === 60 && r.h1.length === 0 && r.m1.length === 0,
    "11.1 TFs duplicados se deduplican; TFs no pedidos = arrays vacíos");
  assert(mb.calls === 1, `11.2 un TF duplicado ⇒ un solo fetch (got ${mb.calls})`);
}

// ── Resumen ────────────────────────────────────────────────
fs.writeSync(1, `\n${failed === 0 ? "🟢" : "🔴"} candle_provider: ${passed} asserts OK, ${failed} fallos\n`);
process.exit(failed === 0 ? 0 : 1);
