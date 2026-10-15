// B3/B4/B5 — Liquidez interna/externa, High/Low de Londres, sweep de NY
import type { Candle, SessionLevels, StrategyConfig } from './types.js';
import { findSwings } from './h1-context.js';

// D-12: ventanas canónicas DST-safe (America/New_York)
const ET = 'America/New_York';
function etMinutes(t: number): number {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: ET, hour12: false, hour: '2-digit', minute: '2-digit' });
  const [h, m] = f.format(new Date(t)).split(':').map(Number);
  return (h % 24) * 60 + m;
}
export function etDateKey(t: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
}
// offset real (ms) de la zona ET en el instante t: zonedWall(asUTC) − t
// (negativo al oeste de UTC; EDT=-4h, EST=-5h) — DST-safe por construcción
function etOffsetMs(t: number): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: ET, hour12: false, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const get = (type: string): number => Number(dtf.formatToParts(new Date(t)).find(p => p.type === type)!.value);
  const asUTC = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUTC - Math.floor(t / 1000) * 1000;
}
// convierte hora pared ET (dateKey + minutos desde 00:00, tolera >24h)
// a UTC ms: se lee la hora pared como si fuera UTC y se le resta el offset
// real de ET en ese instante (UTC = pared − offset). Ventanas 03/08/12/19h
// están lejos de la transición DST (02:00 ET) ⇒ una pasada es exacta.
function etWallToUTC(dateKey: string, minutes: number): number {
  const naive = Date.parse(`${dateKey}T00:00:00Z`) + minutes * 60_000;
  return naive - etOffsetMs(naive);
}

export interface SessionWindow { startUTC: number; endUTC: number; name: 'LDN' | 'NY_KZ' | 'ASIA' }

// R4.1/D-12: Londres 03:00-12:00 ET, killzone NY 08:00-12:00 ET, Asia 19:00-04:00 ET
export function resolveSessionWindows(t: number): SessionWindow[] {
  const key = etDateKey(t);
  const ldn = { startUTC: etWallToUTC(key, 3 * 60), endUTC: etWallToUTC(key, 12 * 60), name: 'LDN' as const };
  const nykz = { startUTC: etWallToUTC(key, 8 * 60), endUTC: etWallToUTC(key, 12 * 60), name: 'NY_KZ' as const };
  const asiaKey = etMinutes(t) >= 19 * 60 ? key : etDateKey(t - 24 * 3600_000);
  const asia = { startUTC: etWallToUTC(asiaKey, 19 * 60), endUTC: etWallToUTC(asiaKey, 28 * 60), name: 'ASIA' as const };
  return [ldn, nykz, asia];
}

// R4.1: High/Low de sesión sobre velas cerradas de la ventana
export function computeSessionHighLow(candles: Candle[], w: SessionWindow): { high: number | null; low: number | null } {
  const inWin = candles.filter(c => c.time >= w.startUTC && c.time < w.endUTC);
  if (inWin.length === 0) return { high: null, low: null };
  return { high: Math.max(...inWin.map(c => c.high)), low: Math.min(...inWin.map(c => c.low)) };
}

export interface InternalLiquidity { highs: number[]; lows: number[] }

// R3.1/D-4: swings internos del rango estructural (combustible del precio)
export function computeInternalLiquidity(candles: Candle[], cfg: StrategyConfig, maxLevels = 5): InternalLiquidity {
  const swings = findSwings(candles, 1); // micro-swings
  return {
    highs: swings.filter(s => s.kind === 'high').slice(-maxLevels).map(s => s.price),
    lows: swings.filter(s => s.kind === 'low').slice(-maxLevels).map(s => s.price),
  };
}

export interface SweepResult { swept: boolean; at: number | null; kind: 'high' | 'low' | null }

// D-7: mecha fuera del nivel + cierre de vuelta dentro de sweepMaxCandles velas; si permanece fuera = ruptura
export function detectSweep(candles: Candle[], level: number, kind: 'high' | 'low', cfg: StrategyConfig): SweepResult {
  const n = candles.length;
  if (n === 0) return { swept: false, at: null, kind: null };
  const scanFrom = Math.max(0, n - cfg.sweepMaxCandles - 5);
  for (let i = n - 1; i >= scanFrom; i--) {
    const c = candles[i];
    if (kind === 'low' && c.low < level) {
      for (let k = i; k <= Math.min(i + cfg.sweepMaxCandles, n - 1); k++) {
        if (candles[k].close > level) return { swept: true, at: candles[k].time, kind }; // cierre de vuelta
      }
      return { swept: false, at: null, kind: null }; // sigue fuera = ruptura
    }
    if (kind === 'high' && c.high > level) {
      for (let k = i; k <= Math.min(i + cfg.sweepMaxCandles, n - 1); k++) {
        if (candles[k].close < level) return { swept: true, at: candles[k].time, kind };
      }
      return { swept: false, at: null, kind: null };
    }
  }
  return { swept: false, at: null, kind: null };
}

// R5.2: NY debe barrer liquidez alineada con el setup (long → londonLow o low interno; short → espejo)
export function detectAlignedSweep(candlesM5: Candle[], levels: SessionLevels, dir: 'long' | 'short', cfg: StrategyConfig, internalLows: number[], internalHighs: number[]): SweepResult {
  if (dir === 'long') {
    const cands: Array<[number, 'high' | 'low']> = [];
    if (levels.londonLow !== null) cands.push([levels.londonLow, 'low']);
    if (levels.asiaLow !== null) cands.push([levels.asiaLow, 'low']);
    for (const l of internalLows) cands.push([l, 'low']);
    let best: SweepResult = { swept: false, at: null, kind: null };
    for (const [lvl, k] of cands) {
      const r = detectSweep(cands.length ? candlesM5 : candlesM5, lvl, k, cfg);
      if (r.swept && (best.at === null || (r.at ?? 0) > best.at)) best = r;
    }
    return best;
  }
  const cands: Array<[number, 'high' | 'low']> = [];
  if (levels.londonHigh !== null) cands.push([levels.londonHigh, 'high']);
  if (levels.asiaHigh !== null) cands.push([levels.asiaHigh, 'high']);
  for (const l of internalHighs) cands.push([l, 'high']);
  let best: SweepResult = { swept: false, at: null, kind: null };
  for (const [lvl, k] of cands) {
    const r = detectSweep(candlesM5, lvl, k, cfg);
    if (r.swept && (best.at === null || (r.at ?? 0) > best.at)) best = r;
  }
  return best;
}

// R3.2/D-6: liquidez externa (para TP B13.1)
export function externalLevels(levels: SessionLevels, h1ExtremeHigh: number | null, h1ExtremeLow: number | null): Array<{ ref: string; price: number }> {
  const out: Array<{ ref: string; price: number }> = [];
  if (levels.pdh !== null) out.push({ ref: 'pdh', price: levels.pdh });
  if (levels.pdl !== null) out.push({ ref: 'pdl', price: levels.pdl });
  if (levels.londonHigh !== null) out.push({ ref: 'london_high', price: levels.londonHigh });
  if (levels.londonLow !== null) out.push({ ref: 'london_low', price: levels.londonLow });
  if (levels.asiaHigh !== null) out.push({ ref: 'asia_high', price: levels.asiaHigh });
  if (levels.asiaLow !== null) out.push({ ref: 'asia_low', price: levels.asiaLow });
  if (h1ExtremeHigh !== null && h1ExtremeHigh !== undefined) out.push({ ref: 'structural_extreme', price: h1ExtremeHigh });
  if (h1ExtremeLow !== null && h1ExtremeLow !== undefined) out.push({ ref: 'structural_extreme', price: h1ExtremeLow });
  return out;
}
