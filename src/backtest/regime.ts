// ============================================================
// src/backtest/regime.ts
// Market Regime Detection - Detecta Trending vs Ranging vs Volatile
// Ajusta la estrategia automáticamente según el régimen
// ============================================================

import type {
  RawCandle,
  MarketRegime,
  RegimeConfig,
  RegimeState,
  RegimeStats,
  BacktestConfig,
  Trade,
} from "./types.js";

interface RegimeDetectorOptions {
  adxPeriod: number;      // 14 velas
  atrPeriod: number;      // 14 velas
  adxThreshold: number;   // 25 = trending
  adxStrongTrend: number; // 40 = strong trend
  lookbackRegime: number; // Velas para confirmar cambio
  volatilityPercentile: number; // 80 para alta vol, 20 para baja
}

interface RegimeAnalyzerOptions {
  detector: RegimeDetectorOptions;
  // Estrategias por régimen
  strategies: {
    trending_up: RegimeStrategyConfig;
    trending_down: RegimeStrategyConfig;
    ranging: RegimeStrategyConfig;
    volatile: RegimeStrategyConfig;
    low_volatility: RegimeStrategyConfig;
  };
}

interface RegimeStrategyConfig {
  enabled: boolean;
  tpMultiplier: number;      // Ajuste al TP ratio base
  slMultiplier: number;        // Ajuste al SL
  minRvol: number;           // Volumen mínimo para operar
  requireFVG: boolean;        // Requerir FVG
  maxConcurrent: number;      // Máximo trades en este régimen
  positionSize: number;       // % del riesgo normal (0.5 = mitad)
}

export class RegimeAnalyzer {
  private detector: RegimeDetector;
  private currentRegime: RegimeState | null = null;
  private regimeHistory: RegimeState[] = [];
  private tradesByRegime: Map<MarketRegime, Trade[]> = new Map();

  constructor(private options: RegimeAnalyzerOptions) {
    this.detector = new RegimeDetector(options.detector);
    
    // Inicializar mapa de trades por régimen
    for (const regime of ["trending_up", "trending_down", "ranging", "volatile", "low_volatility"] as MarketRegime[]) {
      this.tradesByRegime.set(regime, []);
    }
  }

  /**
   * Analiza el régimen actual del mercado
   * Debe llamarse en cada nueva vela
   */
  analyze(candles: RawCandle[]): RegimeState {
    this.currentRegime = this.detector.detect(candles);
    this.regimeHistory.push(this.currentRegime);
    
    // Mantener historia limitada
    if (this.regimeHistory.length > 1000) {
      this.regimeHistory.shift();
    }
    
    return this.currentRegime;
  }

  /**
   * Determina si se debe operar en el régimen actual
   * y qué configuración usar
   */
  shouldTrade(currentRegime: RegimeState, baseConfig: BacktestConfig): {
    shouldTrade: boolean;
    adjustedConfig: Partial<BacktestConfig>;
    reason?: string;
  } {
    const strategy = this.options.strategies[currentRegime.regime];
    
    if (!strategy || !strategy.enabled) {
      return {
        shouldTrade: false,
        adjustedConfig: {},
        reason: `Régimen ${currentRegime.regime} deshabilitado`,
      };
    }

    // Ajustar configuración según el régimen
    const adjustedConfig: Partial<BacktestConfig> = {
      tpRatio: baseConfig.tpRatio * strategy.tpMultiplier,
      rvolThreshold: Math.max(strategy.minRvol, baseConfig.rvolThreshold),
      requireFVG: strategy.requireFVG,
      maxConcurrentTrades: Math.min(baseConfig.maxConcurrentTrades, strategy.maxConcurrent),
    };

    // Ajustar riesgo si es necesario
    if (strategy.positionSize !== 1.0) {
      // Nota: esto requiere ajuste en el simulador
      // Por ahora, lo marcamos
      adjustedConfig.riskPerTrade = baseConfig.riskPerTrade * strategy.positionSize;
    }

    return {
      shouldTrade: true,
      adjustedConfig,
    };
  }

  /**
   * Registra un trade bajo el régimen actual
   */
  registerTrade(trade: Trade): void {
    if (!this.currentRegime) return;
    
    const trades = this.tradesByRegime.get(this.currentRegime.regime);
    if (trades) {
      trades.push(trade);
    }
  }

  /**
   * Analiza estadísticas por régimen
   * Cuál régimen funciona mejor para tu estrategia
   */
  generateStats(): RegimeStats {
    const byRegime: RegimeStats["byRegime"] = {
      trending_up: { trades: 0, winRate: 0, profitFactor: 0, avgReturn: 0 },
      trending_down: { trades: 0, winRate: 0, profitFactor: 0, avgReturn: 0 },
      ranging: { trades: 0, winRate: 0, profitFactor: 0, avgReturn: 0 },
      volatile: { trades: 0, winRate: 0, profitFactor: 0, avgReturn: 0 },
      low_volatility: { trades: 0, winRate: 0, profitFactor: 0, avgReturn: 0 },
    };

    let bestRegime: MarketRegime = "ranging";
    let worstRegime: MarketRegime = "ranging";
    let bestScore = -Infinity;
    let worstScore = Infinity;

    for (const [regime, trades] of this.tradesByRegime) {
      if (trades.length === 0) continue;

      const wins = trades.filter((t) => t.result === "win").length;
      const winsVal = trades.filter((t) => t.result === "win");
      const lossesVal = trades.filter((t) => t.result !== "win");
      
      const winRate = (wins / trades.length) * 100;
      const grossWin = winsVal.reduce((a, t) => a + t.netPnL, 0);
      const grossLoss = Math.abs(lossesVal.reduce((a, t) => a + t.netPnL, 0));
      const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0;
      const avgReturn = trades.reduce((a, t) => a + t.netPnL, 0) / trades.length;

      byRegime[regime] = {
        trades: trades.length,
        winRate,
        profitFactor,
        avgReturn,
      };

      // Score compuesto para ranking
      const score = winRate * 0.3 + Math.min(profitFactor, 5) * 20 + avgReturn * 0.5;
      
      if (score > bestScore) {
        bestScore = score;
        bestRegime = regime;
      }
      if (score < worstScore) {
        worstScore = score;
        worstRegime = regime;
      }
    }

    // Analizar transiciones
    const transitions: RegimeStats["regimeTransitions"] = [];
    for (let i = 1; i < this.regimeHistory.length; i++) {
      const from = this.regimeHistory[i - 1].regime;
      const to = this.regimeHistory[i].regime;
      
      if (from !== to) {
        // Buscar trades después de esta transición
        const transitionTrades = this.tradesByRegime.get(to) || [];
        const recentTrades = transitionTrades.slice(-10); // Últimos 10 trades
        const avgReturn = recentTrades.length > 0 
          ? recentTrades.reduce((a, t) => a + t.netPnL, 0) / recentTrades.length 
          : 0;

        const existing = transitions.find((t) => t.from === from && t.to === to);
        if (existing) {
          existing.count++;
        } else {
          transitions.push({ from, to, count: 1, avgReturnAfter: avgReturn });
        }
      }
    }

    return {
      byRegime,
      bestRegime,
      worstRegime,
      regimeTransitions: transitions,
    };
  }

  /**
   * Predice el siguiente régimen probable
   * Basado en duración promedio y momentum
   */
  predictNextRegime(): {
    regime: MarketRegime;
    confidence: number;
    expectedDuration: number;
  } {
    if (!this.currentRegime) {
      return { regime: "ranging", confidence: 0.3, expectedDuration: 20 };
    }

    // Analizar duraciones históricas de este régimen
    const regimeDurations: number[] = [];
    let currentDuration = 0;
    
    for (const state of this.regimeHistory) {
      if (state.regime === this.currentRegime.regime) {
        currentDuration++;
      } else {
        if (currentDuration > 0) {
          regimeDurations.push(currentDuration);
          currentDuration = 0;
        }
      }
    }

    const avgDuration = regimeDurations.length > 0
      ? regimeDurations.reduce((a, b) => a + b, 0) / regimeDurations.length
      : 30;

    const remaining = Math.max(0, avgDuration - this.currentRegime.duration);
    const probabilityOfChange = 1 - (remaining / avgDuration);

    if (probabilityOfChange < 0.3) {
      // Probable que continúe
      return {
        regime: this.currentRegime.regime,
        confidence: 1 - probabilityOfChange,
        expectedDuration: remaining,
      };
    }

    // Calcular probabilidades de transición
    const transitions = this.regimeHistory.reduce((acc, state, i) => {
      if (i === 0) return acc;
      const prev = this.regimeHistory[i - 1].regime;
      const curr = state.regime;
      
      if (prev === this.currentRegime.regime) {
        acc[curr] = (acc[curr] || 0) + 1;
      }
      return acc;
    }, {} as Record<MarketRegime, number>);

    const total = Object.values(transitions).reduce((a, b) => a + b, 0);
    let maxProb = 0;
    let nextRegime: MarketRegime = this.currentRegime.regime;

    for (const [regime, count] of Object.entries(transitions)) {
      const prob = count / total;
      if (prob > maxProb) {
        maxProb = prob;
        nextRegime = regime as MarketRegime;
      }
    }

    return {
      regime: nextRegime,
      confidence: maxProb,
      expectedDuration: 30, // Default
    };
  }

  /**
   * Obtiene resumen visual del estado actual
   */
  getCurrentSummary(): string {
    if (!this.currentRegime) return "No hay datos de régimen disponibles";

    const { regime, adx, atr, volatility, trendDirection, duration } = this.currentRegime;
    
    const emoji: Record<MarketRegime, string> = {
      trending_up: "📈",
      trending_down: "📉",
      ranging: "↔️",
      volatile: "⚡",
      low_volatility: "😴",
    };

    const names: Record<MarketRegime, string> = {
      trending_up: "Tendencia Alcista",
      trending_down: "Tendencia Bajista",
      ranging: "Rango/Consolidación",
      volatile: "Alta Volatilidad",
      low_volatility: "Baja Volatilidad",
    };

    return `
${emoji[regime]} ${names[regime]}
   ADX: ${adx.toFixed(1)} | ATR: ${atr.toFixed(2)} | Vol: ${(volatility * 100).toFixed(2)}%
   Dirección: ${trendDirection} | Duración: ${duration} velas
   Confianza: ${(this.currentRegime.confidence * 100).toFixed(0)}%
    `.trim();
  }
}

// ============================================================
// Detector de Régimen Interno
// ============================================================

class RegimeDetector {
  constructor(private options: RegimeDetectorOptions) {}

  detect(candles: RawCandle[]): RegimeState {
    const prices = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);

    // Calcular ADX
    const adx = this.calculateADX(candles, this.options.adxPeriod);

    // Calcular ATR
    const atr = this.calculateATR(candles, this.options.atrPeriod);

    // Calcular volatilidad como % del precio
    const volatility = atr / prices[prices.length - 1];

    // Determinar dirección de tendencia
    const ema20 = this.calculateEMA(prices, 20);
    const ema50 = this.calculateEMA(prices, 50);
    const trendDirection =
      ema20 > ema50 ? "up" : ema20 < ema50 ? "down" : "neutral";

    // Clasificar régimen
    let regime: MarketRegime;
    let confidence = 0.5;

    if (adx > this.options.adxStrongTrend) {
      // Tendencia fuerte
      regime = trendDirection === "up" ? "trending_up" : "trending_down";
      confidence = Math.min(0.95, adx / 100);
    } else if (adx > this.options.adxThreshold) {
      // Tendencia débil
      regime = trendDirection === "up" ? "trending_up" : "trending_down";
      confidence = adx / this.options.adxStrongTrend;
    } else {
      // Sin tendencia clara - verificar rango o volatilidad
      const isVolatile = this.isVolatile(candles);
      const isLowVol = this.isLowVolatility(candles);

      if (isVolatile) {
        regime = "volatile";
        confidence = volatility / 0.05; // Normalize to ~5%
      } else if (isLowVol) {
        regime = "low_volatility";
        confidence = 1 - volatility / 0.01;
      } else {
        regime = "ranging";
        confidence = 1 - adx / this.options.adxThreshold;
      }
    }

    return {
      regime,
      adx,
      atr,
      volatility,
      trendDirection,
      confidence: Math.min(1, Math.max(0, confidence)),
      since: new Date(candles[candles.length - 1].time),
      duration: this.getRegimeDuration(regime),
    };
  }

  private getRegimeDuration(currentRegime: MarketRegime): number {
    // Esto normalmente llevaría tracking del historial
    // Por simplicidad, retornamos valor estimado por tipo de régimen
    const typicalDurations: Record<MarketRegime, number> = {
      trending_up: 30,
      trending_down: 30,
      ranging: 50,
      volatile: 15,
      low_volatility: 40,
    };
    return typicalDurations[currentRegime];
  }

  private calculateADX(candles: RawCandle[], period: number): number {
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const closes = candles.map((c) => c.close);

    // Calcular +DM y -DM
    const plusDM: number[] = [];
    const minusDM: number[] = [];
    const tr: number[] = [];

    for (let i = 1; i < candles.length; i++) {
      const upMove = highs[i] - highs[i - 1];
      const downMove = lows[i - 1] - lows[i];

      plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
      minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);

      // True Range
      const tr1 = highs[i] - lows[i];
      const tr2 = Math.abs(highs[i] - closes[i - 1]);
      const tr3 = Math.abs(lows[i] - closes[i - 1]);
      tr.push(Math.max(tr1, tr2, tr3));
    }

    if (tr.length < period) return 25;

    // Suavizar con EMA
    const smoothedTR = this.calculateEMAFloat(tr, period);
    const smoothedPlusDM = this.calculateEMAFloat(plusDM, period);
    const smoothedMinusDM = this.calculateEMAFloat(minusDM, period);

    // Calcular +DI y -DI
    const plusDI = (smoothedPlusDM / smoothedTR) * 100;
    const minusDI = (smoothedMinusDM / smoothedTR) * 100;

    // Calcular DX y ADX
    const dx = (Math.abs(plusDI - minusDI) / (plusDI + minusDI)) * 100;
    
    return dx; // Simplificado, normalmente se suaviza de nuevo
  }

  private calculateATR(candles: RawCandle[], period: number): number {
    const tr: number[] = [];

    for (let i = 1; i < candles.length; i++) {
      const highLow = candles[i].high - candles[i].low;
      const highClose = Math.abs(candles[i].high - candles[i - 1].close);
      const lowClose = Math.abs(candles[i].low - candles[i - 1].close);
      tr.push(Math.max(highLow, highClose, lowClose));
    }

    if (tr.length < period) return candles[candles.length - 1].high - candles[candles.length - 1].low;

    // Simple SMA de TR
    const sum = tr.slice(-period).reduce((a, b) => a + b, 0);
    return sum / period;
  }

  private calculateEMA(prices: number[], period: number): number {
    if (prices.length < period * 2) {
      return prices[prices.length - 1];
    }

    const multiplier = 2 / (period + 1);
    let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;

    for (let i = period; i < prices.length; i++) {
      ema = (prices[i] - ema) * multiplier + ema;
    }

    return ema;
  }

  private calculateEMAFloat(values: number[], period: number): number {
    if (values.length < period) return values[values.length - 1];
    
    const multiplier = 2 / (period + 1);
    let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;

    for (let i = period; i < values.length; i++) {
      ema = (values[i] - ema) * multiplier + ema;
    }

    return ema;
  }

  private isVolatile(candles: RawCandle[]): boolean {
    const atr = this.calculateATR(candles, 14);
    const price = candles[candles.length - 1].close;
    const atrPercent = atr / price;

    // ATR > 5% del precio = volatile
    return atrPercent > 0.05;
  }

  private isLowVolatility(candles: RawCandle[]): boolean {
    const atr = this.calculateATR(candles, 14);
    const price = candles[candles.length - 1].close;
    const atrPercent = atr / price;

    // ATR < 1% del precio = low vol
    return atrPercent < 0.01;
  }
}

export { RegimeDetector };
