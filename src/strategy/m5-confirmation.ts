// B8 — Confirmación M5 (Pilar 3a: impulso/reacción al POI)
import type { Candle, StrategyConfig } from './types.js';
import { detectBodyBreaks } from './h1-context.js';

// R8.1/R8.2: CHOCH M5 a favor del trade, con la vela de ruptura dentro o sobre la caja ±1 pip
export function confirmM5(candlesM5: Candle[], dir: 'long' | 'short', poi: { top: number; bottom: number }, sinceTime: number, cfg: StrategyConfig, sinceIndex: number): { m5ChochTime: number; brokenLevel: number } | null {
  const bull = dir === 'long';
  const breaks = detectBodyBreaks(candlesM5, cfg.swingLookback).filter(b => b.dir === (bull ? 'bull' : 'bear'));
  const tol = 1 * cfg.pipSize;
  for (let i = breaks.length - 1; i >= 0; i--) {
    const b = breaks[i];
    if (b.time <= sinceTime || b.index < sinceIndex) continue;
    const c = candlesM5[b.index];
    const overlaps = c.high >= poi.bottom - tol && c.low <= poi.top + tol; // R8.2
    if (overlaps) return { m5ChochTime: b.time, brokenLevel: b.level };
  }
  return null;
}
