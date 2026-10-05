// ============================================================
// src/backtest/smc_detector.ts
// Detector de estructuras SMC: BOS, ChoCh, FVG, Order Blocks
// ============================================================

import {
  ProcessedCandle,
  SMCStructure,
  FVG,
  SwingPoint,
  SMCSetup,
} from "./types.js";

/** Procesa velas crudas a formato con cálculos */
export function processCandles(candles: any[]): ProcessedCandle[] {
  return candles.map((c, i) => {
    const open = c.open;
    const close = c.close;
    const high = c.high;
    const low = c.low;

    const up = close > open;
    const body = Math.abs(close - open);
    const wickTop = high - Math.max(open, close);
    const wickBottom = Math.min(open, close) - low;

    return {
      time: new Date(c.time),
      open,
      high,
      low,
      close,
      tickVolume: c.tickVolume || 0,
      up,
      body,
      wickTop,
      wickBottom,
      range: high - low,
    };
  });
}

/** Detecta Fair Value Gaps (imbalances) */
export function detectFVGs(candles: ProcessedCandle[]): FVG[] {
  const fvgs: FVG[] = [];

  // Bullish FVG: Low[current] > High[current-2]
  // Bearish FVG: High[current] < Low[current-2]
  for (let i = 2; i < candles.length; i++) {
    const prev2 = candles[i - 2];
    const prev1 = candles[i - 1];
    const current = candles[i];

    // Bullish FVG: current low > prev2 high (gap up)
    if (current.low > prev2.high) {
      const fvg: FVG = {
        startIndex: i - 2,
        endIndex: i,
        startTime: prev2.time,
        endTime: current.time,
        type: "BULLISH",
        top: current.low,
        bottom: prev2.high,
        isMitigated: false,
      };
      fvgs.push(fvg);
    }

    // Bearish FVG: current high < prev2 low (gap down)
    if (current.high < prev2.low) {
      const fvg: FVG = {
        startIndex: i - 2,
        endIndex: i,
        startTime: prev2.time,
        endTime: current.time,
        type: "BEARISH",
        top: prev2.low,
        bottom: current.high,
        isMitigated: false,
      };
      fvgs.push(fvg);
    }
  }

  // Mark mitigated FVGs
  for (const fvg of fvgs) {
    for (let i = fvg.endIndex; i < candles.length; i++) {
      if (fvg.type === "BULLISH") {
        // Mitigated if price goes into the gap
        if (candles[i].low <= fvg.top && candles[i].low >= fvg.bottom) {
          fvg.isMitigated = true;
          fvg.mitigationIndex = i;
          break;
        }
      } else {
        // Bearish FVG
        if (candles[i].high <= fvg.top && candles[i].high >= fvg.bottom) {
          fvg.isMitigated = true;
          fvg.mitigationIndex = i;
          break;
        }
      }
    }
  }

  return fvgs;
}

/** Detecta Swing Highs y Lows */
export function detectSwingPoints(
  candles: ProcessedCandle[],
  lookback: number = 5
): SwingPoint[] {
  const swings: SwingPoint[] = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    const current = candles[i];

    // Check for swing high
    const isSwingHigh = candles
      .slice(i - lookback, i)
      .every((c) => c.high < current.high) &&
      candles
      .slice(i + 1, i + lookback + 1)
      .every((c) => c.high < current.high);

    if (isSwingHigh) {
      swings.push({
        index: i,
        time: current.time,
        price: current.high,
        type: "HIGH",
      });
    }

    // Check for swing low
    const isSwingLow = candles
      .slice(i - lookback, i)
      .every((c) => c.low > current.low) &&
      candles
      .slice(i + 1, i + lookback + 1)
      .every((c) => c.low > current.low);

    if (isSwingLow) {
      swings.push({
        index: i,
        time: current.time,
        price: current.low,
        type: "LOW",
      });
    }
  }

  return swings;
}

/** Detecta BOS y ChoCh basado en ruptura de estructura */
export function detectStructureShifts(
  candles: ProcessedCandle[],
  swings: SwingPoint[],
  volumes: number[]
): SMCSetup[] {
  const setups: SMCSetup[] = [];

  if (swings.length < 4) return setups;

  for (let i = 3; i < swings.length; i++) {
    const s0 = swings[i - 3]; // previo previo
    const s1 = swings[i - 2]; // previo
    const s2 = swings[i - 1]; // reciente
    const s3 = swings[i]; // actual

    // Calcular RVOL para este movimiento
    const recentVolume = volumes.slice(s2.index - 5, s2.index + 1);
    const avgVolume = recentVolume.reduce((a, b) => a + b, 0) / recentVolume.length || 1;
    const currentVolume = volumes[s2.index] || avgVolume;
    const rvol = avgVolume > 0 ? currentVolume / avgVolume : 1;

    // ALCISTA: Break of Structure (BOS)
    // Precio rompe High anterior después de un Low más alto (HL)
    if (
      s0.type === "LOW" &&
      s1.type === "HIGH" &&
      s2.type === "LOW" &&
      s3.type === "HIGH"
    ) {
      // HL formado (s2 > s0)
      const isHigherLow = s2.price > s0.price;
      // BOS: s3 rompe s1
      const isBOS = s3.price > s1.price;

      if (isHigherLow && isBOS) {
        setups.push({
          index: s3.index,
          time: s3.time,
          type: SMCStructure.BOS,
          direction: "BULLISH",
          price: s3.price,
          confidence: Math.min(rvol / 2, 1),
          swingPoints: [s0, s1, s2, s3],
          rvol,
        });
      }
    }

    // BAJISTA: Break of Structure (BOS)
    // Precio rompe Low anterior después de un High más bajo (LH)
    if (
      s0.type === "HIGH" &&
      s1.type === "LOW" &&
      s2.type === "HIGH" &&
      s3.type === "LOW"
    ) {
      // LH formado (s2 < s0)
      const isLowerHigh = s2.price < s0.price;
      // BOS: s3 rompe s1
      const isBOS = s3.price < s1.price;

      if (isLowerHigh && isBOS) {
        setups.push({
          index: s3.index,
          time: s3.time,
          type: SMCStructure.BOS,
          direction: "BEARISH",
          price: s3.price,
          confidence: Math.min(rvol / 2, 1),
          swingPoints: [s0, s1, s2, s3],
          rvol,
        });
      }
    }

    // Change of Character (ChoCh) - Reversión
    // ALCISTA: ChoCh en tendencia bajista
    if (
      s0.type === "HIGH" && // Secuencia en tendencia bajista
      s1.type === "LOW" &&
      s2.type === "HIGH" &&
      s3.type === "LOW"
    ) {
      // ChoCh alcista: s3 rompe s1 hacia abajo
      const isChoCh = s3.price < s1.price;
      // Verificar que estaba bajista (LH + LL)
      const wasBearish = s2.price < s0.price;

      if (isChoCh && wasBearish) {
        setups.push({
          index: s3.index,
          time: s3.time,
          type: SMCStructure.ChoCh,
          direction: "BULLISH", // Reversión a alcista
          price: s3.price,
          confidence: Math.min(rvol / 2, 1) * 0.8, // Baja confianza por ser reversión
          swingPoints: [s0, s1, s2, s3],
          rvol,
        });
      }
    }

    // ChoCh BAJISTA
    if (
      s0.type === "LOW" && // Secuencia en tendencia alcista
      s1.type === "HIGH" &&
      s2.type === "LOW" &&
      s3.type === "HIGH"
    ) {
      // ChoCh bajista: s3 rompe s1 hacia arriba
      const isChoCh = s3.price > s1.price;
      // Verificar que estaba alcista (HH + HL)
      const wasBullish = s2.price > s0.price;

      if (isChoCh && wasBullish) {
        setups.push({
          index: s3.index,
          time: s3.time,
          type: SMCStructure.ChoCh,
          direction: "BEARISH", // Reversión a bajista
          price: s3.price,
          confidence: Math.min(rvol / 2, 1) * 0.8,
          swingPoints: [s0, s1, s2, s3],
          rvol,
        });
      }
    }
  }

  return setups;
}

/** Asocia FVGs a setups válidos */
export function associateFVGsWithSetups(
  setups: SMCSetup[],
  fvgs: FVG[]
): SMCSetup[] {
  return setups.map((setup) => {
    // Buscar un FVG no mitigado que esté atrás del setup
    const relevantFVG = fvgs.find(
      (fvg) =>
        !fvg.isMitigated &&
        fvg.endIndex < setup.index &&
        fvg.endIndex >= setup.index - 10 && // En las últimas 10 velas
        ((setup.direction === "BULLISH" && fvg.type === "BULLISH") ||
          (setup.direction === "BEARISH" && fvg.type === "BEARISH"))
    );

    if (relevantFVG) {
      return { ...setup, fvg: relevantFVG };
    }
    return setup;
  });
}

/** Valida si un setup está en Killzone de NY (8-12 AM EST) */
export function isNYKillzone(date: Date): boolean {
  // Convertir a EST
  const utcHour = date.getUTCHours();
  const estHour = (utcHour - 5 + 24) % 24; // EST = UTC-5
  return estHour >= 8 && estHour <= 12;
}

/** Valida si un setup es operable según filtros */
export function isValidSetup(
  setup: SMCSetup,
  config: {
    requireFVG?: boolean;
    requireKillzone?: boolean;
    rvolThreshold?: number;
  },
  date: Date
): boolean {
  if (config.requireFVG && !setup.fvg) return false;
  if (config.requireKillzone && !isNYKillzone(date)) return false;
  if (config.rvolThreshold && setup.rvol < config.rvolThreshold) return false;
  return true;
}
