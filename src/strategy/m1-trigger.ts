// B9/B10 — Trigger M1 (Pilar 3b: ejecución) — confirmM5 vive en m5-confirmation.ts
import type { Candle, StrategyConfig, TriggerInfo } from './types.js';
import { detectBodyBreaks } from './h1-context.js';

// R8.3 extremo del fallo estructural: el motor lo registra con extremeInPOI (engine.ts)

// R9.1/R9.2: CHOCH M1 a favor tras la confirmación + bloque trigger (OB/FVG M1 que causó el CHOCH)
export function triggerM1(candlesM1: Candle[], dir: 'long' | 'short', sinceTime: number, cfg: StrategyConfig): TriggerInfo | null {
  const bull = dir === 'long';
  const breaks = detectBodyBreaks(candlesM1, cfg.swingLookback).filter(b => b.dir === (bull ? 'bull' : 'bear'));
  if (breaks.length === 0) return null;
  const br = breaks[breaks.length - 1];
  if (br.time <= sinceTime) return null; // R9.3 timeout lo maneja el engine
  // pierna de impulso del CHOCH M1
  let start = br.index;
  while (start > 0) {
    const c = candlesM1[start];
    const inLeg = bull ? c.close >= c.open : c.close <= c.open;
    if (!inLeg) break;
    start--;
  }
  // bloque: última vela contraria antes del impulso
  for (let i = start; i >= Math.max(0, start - 3); i--) {
    const c = candlesM1[i];
    const opposite = bull ? c.close < c.open : c.close > c.open;
    if (opposite) {
      const top = c.high, bottom = c.low;
      const fib = cfg.retestFibPercent;                       // R10.1: 50% del bloque, lado proximal
      const limit = bull ? top - fib * (top - bottom) : bottom + fib * (top - bottom);
      return { m1ChochTime: br.time, block: { top, bottom, kind: 'ORDER_BLOCK' }, retestLimitPrice: limit };
    }
  }
  // fallback FVG M1 en la pierna
  for (let i = start; i < br.index; i++) {
    const a = candlesM1[i - 1], c = candlesM1[i + 1];
    if (!a || !c) continue;
    if (bull && c.low > a.high) {
      const top = c.low, bottom = a.high;
      const fib = cfg.retestFibPercent;
      return { m1ChochTime: br.time, block: { top, bottom, kind: 'FVG' }, retestLimitPrice: top - fib * (top - bottom) };
    }
    if (!bull && c.high < a.low) {
      const top = a.low, bottom = c.high;
      const fib = cfg.retestFibPercent;
      return { m1ChochTime: br.time, block: { top, bottom, kind: 'FVG' }, retestLimitPrice: bottom + fib * (top - bottom) };
    }
  }
  return null;
}

// R10.2: fill por touch en M1
export function retestTouched(candlesM1: Candle[], limit: number, dir: 'long' | 'short', afterTime: number): Candle | null {
  for (const c of candlesM1) {
    if (c.time <= afterTime) continue;
    if (dir === 'long' && c.low <= limit) return c;
    if (dir === 'short' && c.high >= limit) return c;
  }
  return null;
}
