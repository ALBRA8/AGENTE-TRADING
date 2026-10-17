// B2/B6/B7 — BOS válido (D-3), construcción y validación de POI (D-8, D-9, D-10)
import type { Bias, Candle, POI, StrategyConfig } from './types.js';
import { detectBodyBreaks, findSwings } from './h1-context.js';

const M15_MS = 15 * 60_000;

// D-3: BOS válido = ruptura con cuerpo + (a) vela contraria en el origen del impulso + (b) toma de liquidez interna previa
export interface ValidBOS { index: number; time: number; level: number; dir: 'bull' | 'bear'; liquidityTaken: boolean }

export function detectValidBOS(candlesM15: Candle[], cfg: StrategyConfig, bias: Bias): ValidBOS | null {
  const breaks = detectBodyBreaks(candlesM15, cfg.swingLookback).filter(b => b.dir === (bias === 'bull' ? 'bull' : 'bear'));
  if (breaks.length === 0) return null;
  const microSwings = findSwings(candlesM15, 1);
  for (let b = breaks.length - 1; b >= 0; b--) {
    const br = breaks[b];
    // (a) origen: caminar hacia atrás por la pierna de impulso (velas a favor) hasta la vela contraria previa
    let start = br.index;
    while (start > 0) {
      const c = candlesM15[start];
      const bullishLeg = br.dir === 'bull' ? c.close >= c.open : c.close <= c.open;
      if (!bullishLeg) break;
      start--;
    }
    if (start === br.index) continue; // sin pierna: desplazamiento de una vela, no POI fiable
    // (b) toma de liquidez interna en la ventana previa a la ruptura: mecha más allá de un micro-swing
    let liquidityTaken = false;
    const from = Math.max(0, br.index - cfg.liquidityWindow);
    for (let k = from; k < br.index && !liquidityTaken; k++) {
      for (const s of microSwings) {
        if (s.index >= br.index) continue;
        if (br.dir === 'bull' && candlesM15[k].low < s.price && s.kind === 'low') liquidityTaken = true; // D-4
        if (br.dir === 'bear' && candlesM15[k].high > s.price && s.kind === 'high') liquidityTaken = true;
      }
    }
    return { index: br.index, time: br.time, level: br.level, dir: br.dir, liquidityTaken }; // R6.5: la más reciente
  }
  return null;
}

// D-8: caja = última vela contraria completa antes del desplazamiento; fallback FVG de la pierna
export function buildPOI(candlesM15: Candle[], bos: ValidBOS): POI | null {
  let start = bos.index;
  while (start > 0) {
    const c = candlesM15[start];
    const inLeg = bos.dir === 'bull' ? c.close >= c.open : c.close <= c.open;
    if (!inLeg) break;
    start--;
  }
  // última vela contraria antes del impulso
  for (let i = start; i >= Math.max(0, start - 3); i--) {
    const c = candlesM15[i];
    const opposite = bos.dir === 'bull' ? c.close < c.open : c.close > c.open;
    if (opposite) {
      return { kind: 'ORDER_BLOCK', top: c.high, bottom: c.low, originBarTime: c.time, m15BosTime: bos.time, liquidityTakenBeforeBos: bos.liquidityTaken };
    }
  }
  // fallback FVG en la pierna (3 velas): hueco entre vela[i-1].high y vela[i+1].low (bull)
  for (let i = start; i < bos.index; i++) {
    const a = candlesM15[i - 1], c = candlesM15[i + 1];
    if (!a || !c) continue;
    if (bos.dir === 'bull' && c.low > a.high) return { kind: 'FVG', top: c.low, bottom: a.high, originBarTime: c.time, m15BosTime: bos.time, liquidityTakenBeforeBos: bos.liquidityTaken };
    if (bos.dir === 'bear' && c.high < a.low) return { kind: 'FVG', top: a.low, bottom: c.high, originBarTime: c.time, m15BosTime: bos.time, liquidityTakenBeforeBos: bos.liquidityTaken };
  }
  return null;
}

// R6.4/D-10: no mitigada (ningún cierre dentro de la caja tras el origen) y no expirada
export function isPOIValid(poi: POI, candlesM15: Candle[], now: number, cfg: StrategyConfig): boolean {
  if (now - poi.originBarTime > cfg.poiMaxAgeBarsM15 * M15_MS) return false; // R15.4 expiración
  for (const c of candlesM15) {
    if (c.time <= poi.originBarTime) continue;
    if (c.close < poi.top && c.close > poi.bottom) return false; // cierre dentro = mitigación
  }
  return true;
}

// R7.1: el precio retornó a la caja (solapamiento) tras el BOS
export function hasReturnedToPOI(candles: Candle[], poi: POI, afterTime: number): Candle | null {
  for (const c of candles) {
    if (c.time <= afterTime) continue;
    if (c.low <= poi.top && c.high >= poi.bottom) return c;
  }
  return null;
}

// R15.1: cierre más allá del extremo remoto de la caja
export function isInvalidatedBeyondPOI(candles: Candle[], poi: POI, dir: 'long' | 'short', afterTime: number): boolean {
  for (const c of candles) {
    if (c.time <= afterTime) continue;
    if (dir === 'long' && c.close < poi.bottom) return true;
    if (dir === 'short' && c.close > poi.top) return true;
  }
  return false;
}
