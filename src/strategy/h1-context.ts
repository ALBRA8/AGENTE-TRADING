// B1 — Contexto H1 (Pilar 1) + helpers compartidos de estructura (D-1, D-2, D-5)
import type { Bias, Candle } from './types.js';
import type { StrategyConfig } from './types.js';

export interface Swing { index: number; time: number; price: number; kind: 'high' | 'low' }

// D-1: swing confirmado si el extremo de la ventana [i-L, i+L]
export function findSwings(candles: Candle[], L: number): Swing[] {
  const out: Swing[] = [];
  for (let i = L; i < candles.length - L; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - L; j <= i + L; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) out.push({ index: i, time: candles[i].time, price: candles[i].high, kind: 'high' });
    if (isLow) out.push({ index: i, time: candles[i].time, price: candles[i].low, kind: 'low' });
  }
  return out;
}

export interface BodyBreak { dir: 'bull' | 'bear'; index: number; time: number; level: number }

// D-2/D-5: para cada swing confirmado, busca la primera vela que rompa su nivel con cuerpo (desde su confirmación)
export function detectBodyBreaks(candles: Candle[], L: number): BodyBreak[] {
  const swings = findSwings(candles, L);
  const breaks: BodyBreak[] = [];
  for (const s of swings) {
    for (let k = s.index + L; k < candles.length; k++) {
      if (s.kind === 'high' && candles[k].close > s.price) { breaks.push({ dir: 'bull', index: k, time: candles[k].time, level: s.price }); break; }
      if (s.kind === 'low' && candles[k].close < s.price) { breaks.push({ dir: 'bear', index: k, time: candles[k].time, level: s.price }); break; }
    }
  }
  return breaks.sort((a, b) => a.index - b.index);
}

// D-5: último CHOCH confirmado (ruptura del swing opuesto a la tendencia vigente)
export function detectLastChoch(candles: Candle[], L: number): (BodyBreak & { brokenLevel: number }) | null {
  const breaks = detectBodyBreaks(candles, L);
  if (breaks.length < 2) return null;
  const last = breaks[breaks.length - 1];
  const prev = breaks[breaks.length - 2];
  if (last.dir !== prev.dir) return { ...last, brokenLevel: last.level }; // cambio de carácter
  return null;
}

export interface H1Context { bias: Bias; lastBosTime: number | null; lastSwingHigh: number | null; lastSwingLow: number | null; extremeHigh: number; extremeLow: number }

// R1.1-R1.3: sesgo = dirección del último BOS H1 mientras el precio respete la estructura
export function computeH1Bias(candlesH1: Candle[], cfg: StrategyConfig): H1Context {
  const L = cfg.swingLookback;
  const swings = findSwings(candlesH1, L);
  const breaks = detectBodyBreaks(candlesH1, L);
  const lastSwingHigh = [...swings].reverse().find(s => s.kind === 'high')?.price ?? null;
  const lastSwingLow = [...swings].reverse().find(s => s.kind === 'low')?.price ?? null;
  const extremeHigh = Math.max(...candlesH1.map(c => c.high));
  const extremeLow = Math.min(...candlesH1.map(c => c.low));
  if (candlesH1.length < 2 * L + 2 || breaks.length === 0) {
    return { bias: 'range', lastBosTime: null, lastSwingHigh, lastSwingLow, extremeHigh, extremeLow }; // fail-closed
  }
  const last = breaks[breaks.length - 1];
  const lastClose = candlesH1[candlesH1.length - 1].close;
  let bias: Bias = 'range';
  if (last.dir === 'bull' && lastSwingLow !== null && lastClose > lastSwingLow) bias = 'bull';      // R1.1
  else if (last.dir === 'bear' && lastSwingHigh !== null && lastClose < lastSwingHigh) bias = 'bear';
  return { bias, lastBosTime: last.time, lastSwingHigh, lastSwingLow, extremeHigh, extremeLow };
}
