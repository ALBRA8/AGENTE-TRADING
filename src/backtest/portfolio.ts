// ============================================================
// src/backtest/portfolio.ts
// Portfolio Backtesting - Multi-asset con correlación
// Permite backtestear US30 + NAS100 + DXY simultáneamente
// ============================================================

import type {
  PortfolioConfig,
  PortfolioResult,
  PortfolioPosition,
  BacktestConfig,
  BacktestResult,
  RawCandle,
  Trade,
} from "./types.js";
import { BacktestEngine } from "./engine.js";

interface AssetData {
  asset: string;
  candles: RawCandle[];
  result?: BacktestResult;
  returns: number[]; // Retornos por período para correlación
}

export class PortfolioBacktester {
  private engine: BacktestEngine;
  private config: PortfolioConfig;
  private assetData: Map<string, AssetData> = new Map();

  constructor(config: PortfolioConfig) {
    this.config = config;
    this.engine = new BacktestEngine({ enableMonteCarlo: false });
  }

  /**
   * Agrega datos de un asset al portfolio
   */
  addAsset(asset: string, candles: RawCandle[]): void {
    // Calcular retornos para correlación
    const returns: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const ret = (candles[i].close - candles[i - 1].close) / candles[i - 1].close;
      returns.push(ret);
    }

    this.assetData.set(asset, {
      asset,
      candles,
      returns,
    });
  }

  /**
   * Ejecuta backtest en cada asset y calcula métricas de portfolio
   */
  async runPortfolioBacktest(
    baseConfig: BacktestConfig
  ): Promise<{
    individual: PortfolioResult[];
    portfolio: {
      totalReturn: number;
      portfolioDrawdown: number;
      correlationMatrix: Record<string, Record<string, number>>;
      diversificationBenefit: number; // % de reducción de drawdown
      efficientFrontier: Array<{ return: number; risk: number; weights: Record<string, number> }>;
    };
  }> {
    console.log(`\n📊 Portfolio Backtest`);
    console.log(`   Assets: ${Array.from(this.assetData.keys()).join(", ")}`);
    console.log(`   Strategy: Equal Weight = ${this.config.equalWeight}\n`);

    // Paso 1: Backtest individual de cada asset
    const individualResults: PortfolioResult[] = [];

    for (const [asset, data] of this.assetData) {
      if (data.candles.length === 0) continue;

      console.log(`   [${asset}] Running backtest...`);
      
      const config: BacktestConfig = {
        ...baseConfig,
        asset,
        startDate: new Date(data.candles[0].time),
        endDate: new Date(data.candles[data.candles.length - 1].time),
      };

      const result = await this.engine.runBacktest(data.candles, config);
      data.result = result;

      individualResults.push({
        asset,
        trades: result.trades,
        metrics: result.metrics,
        correlationWithPrimary: 0, // Se calcula después
        contributionToPortfolio: 0, // Se calcula después
        riskContribution: 0, // Se calcula después
      });
    }

    // Paso 2: Calcular matriz de correlación
    console.log("   Calculando correlaciones...");
    const correlationMatrix = this.calculateCorrelationMatrix();

    // Actualizar correlaciones en resultados individuales
    for (const r of individualResults) {
      r.correlationWithPrimary =
        correlationMatrix[r.asset]?.[this.config.primary] ?? 0;
    }

    // Paso 3: Simular portfolio combinado
    console.log("   Simulando portfolio combinado...");
    const portfolioSimulation = this.simulatePortfolio(individualResults);

    // Paso 4: Calcular efficient frontier
    console.log("   Calculando efficient frontier...");
    const efficientFrontier = this.calculateEfficientFrontier(individualResults);

    // Calcular diversification benefit
    const avgIndividualDD =
      individualResults.reduce((a, r) => a + r.metrics.maxDrawdown, 0) /
      individualResults.length;
    const portfolioDD = portfolioSimulation.portfolioDrawdown;
    const diversificationBenefit =
      avgIndividualDD > 0 ? (avgIndividualDD - portfolioDD) / avgIndividualDD : 0;

    // Actualizar contribuciones
    const totalReturn = portfolioSimulation.totalReturn;
    for (const r of individualResults) {
      const weight = this.getAssetWeight(r.asset);
      r.contributionToPortfolio = totalReturn !== 0 
        ? ((r.metrics.totalReturn * weight) / 100 / totalReturn) * 100 
        : 0;
      r.riskContribution =
        ((r.metrics.maxDrawdown * weight) / portfolioSimulation.portfolioDrawdown) * 100;
    }

    return {
      individual: individualResults,
      portfolio: {
        totalReturn: portfolioSimulation.totalReturn,
        portfolioDrawdown: portfolioSimulation.portfolioDrawdown,
        correlationMatrix,
        diversificationBenefit,
        efficientFrontier,
      },
    };
  }

  /**
   * Calcula matriz de correlación entre todos los assets
   */
  private calculateCorrelationMatrix(): Record<string, Record<string, number>> {
    const assets = Array.from(this.assetData.keys());
    const matrix: Record<string, Record<string, number>> = {};

    for (const a1 of assets) {
      matrix[a1] = {};
      for (const a2 of assets) {
        if (a1 === a2) {
          matrix[a1][a2] = 1;
        } else {
          const data1 = this.assetData.get(a1)!;
          const data2 = this.assetData.get(a2)!;
          matrix[a1][a2] = this.calculateCorrelation(data1.returns, data2.returns);
        }
      }
    }

    return matrix;
  }

  /**
   * Calcula correlación de Pearson entre dos series
   */
  private calculateCorrelation(x: number[], y: number[]): number {
    const n = Math.min(x.length, y.length);
    if (n < 2) return 0;

    const xSlice = x.slice(0, n);
    const ySlice = y.slice(0, n);

    const meanX = xSlice.reduce((a, b) => a + b, 0) / n;
    const meanY = ySlice.reduce((a, b) => a + b, 0) / n;

    let numerator = 0;
    let denomX = 0;
    let denomY = 0;

    for (let i = 0; i < n; i++) {
      const dx = xSlice[i] - meanX;
      const dy = ySlice[i] - meanY;
      numerator += dx * dy;
      denomX += dx * dx;
      denomY += dy * dy;
    }

    const denominator = Math.sqrt(denomX * denomY);
    return denominator === 0 ? 0 : numerator / denominator;
  }

  /**
   * Simula el portfolio combinado
   */
  private simulatePortfolio(
    results: PortfolioResult[]
  ): { totalReturn: number; portfolioDrawdown: number } {
    // Simular equity curve del portfolio
    let portfolioEquity = 100;
    let peak = 100;
    let maxDrawdown = 0;

    // Usar equity curves de cada asset con pesos
    const assetWeights: Record<string, number> = {};
    let totalWeight = 0;

    for (const r of results) {
      const weight = this.getAssetWeight(r.asset);
      assetWeights[r.asset] = weight;
      totalWeight += weight;
    }

    // Normalizar pesos
    for (const asset in assetWeights) {
      assetWeights[asset] /= totalWeight;
    }

    // Timeline de trades de todos los assets
    const allTrades: (Trade & { asset: string })[] = [];
    for (const r of results) {
      for (const t of r.trades) {
        allTrades.push({ ...t, asset: r.asset });
      }
    }

    // Ordenar por fecha de cierre
    allTrades.sort((a, b) => a.exitTime.getTime() - b.exitTime.getTime());

    // Simular
    for (const trade of allTrades) {
      const weight = assetWeights[trade.asset] ?? 0;
      const pnlPercent = (trade.netPnL / trade.initialBalance) * 100;
      const weightedPnL = pnlPercent * weight;

      portfolioEquity *= 1 + weightedPnL / 100;

      if (portfolioEquity > peak) {
        peak = portfolioEquity;
      }

      const drawdown = ((peak - portfolioEquity) / peak) * 100;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }

    const totalReturn = ((portfolioEquity - 100) / 100) * 100;

    return {
      totalReturn,
      portfolioDrawdown: maxDrawdown,
    };
  }

  /**
   * Obtiene peso de un asset según configuración
   */
  private getAssetWeight(asset: string): number {
    if (this.config.equalWeight) {
      return 100 / this.config.assets.length;
    }
    // Si hay weights custom, implementar aquí
    return 100 / this.config.assets.length;
  }

  /**
   * Calcula efficient frontier para optimización de portfolio
   * Punto óptimo: máximo sharpe ratio
   */
  private calculateEfficientFrontier(
    results: PortfolioResult[]
  ): Array<{ return: number; risk: number; weights: Record<string, number> }> {
    const frontier: Array<{ return: number; risk: number; weights: Record<string, number> }> = [];
    const assets = results.map((r) => r.asset);

    // Generar combinaciones de pesos (simplified: step 10%)
    const steps = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];

    for (let i = 0; i < steps.length; i++) {
      for (let j = 0; j < steps.length; j++) {
        if (Math.abs(steps[i] + steps[j] - 1.0) < 0.01) {
          // Peso para primer asset, segundo asset, resto dividido
          const weights: Record<string, number> = {};
          
          if (assets.length >= 2) {
            weights[assets[0]] = steps[i];
            weights[assets[1]] = steps[j];
            
            if (assets.length > 2) {
              const remaining = 1 - steps[i] - steps[j];
              const perAsset = remaining / (assets.length - 2);
              for (let k = 2; k < assets.length; k++) {
                weights[assets[k]] = perAsset;
              }
            }
          } else if (assets.length === 1) {
            weights[assets[0]] = 1.0;
          }

          // Calcular retorno esperado y riesgo del portfolio
          let portfolioReturn = 0;
          let portfolioRisk = 0;

          for (const r of results) {
            const w = weights[r.asset] ?? 0;
            portfolioReturn += (r.metrics.totalReturn * w) / 100;
            portfolioRisk += Math.pow(r.metrics.maxDrawdown * w / 100, 2);
          }
          portfolioRisk = Math.sqrt(portfolioRisk);

          frontier.push({
            return: portfolioReturn,
            risk: portfolioRisk,
            weights,
          });
        }
      }
    }

    // Ordenar por retorno ascendente
    frontier.sort((a, b) => a.return - b.return);

    return frontier;
  }

  /**
   * Identifica si un trade debe ser skipped por alta correlación
   */
  shouldSkipByCorrelation(
    asset: string,
    correlationMatrix: Record<string, Record<string, number>>
  ): boolean {
    for (const other of this.config.assets) {
      if (other === asset) continue;
      
      const corr = correlationMatrix[asset]?.[other] ?? 0;
      if (corr > this.config.correlationThreshold) {
        return true;
      }
    }
    return false;
  }

  /**
   * Genera recomendación de allocación óptima
   */
  getOptimalAllocation(
    results: PortfolioResult[]
  ): { allocation: Record<string, number>; expectedReturn: number; expectedRisk: number } {
    // Encontrar portfolio con mejor Sharpe (simplificado como return/risk)
    let bestRatio = -Infinity;
    let bestAllocation: Record<string, number> = {};
    let bestReturn = 0;
    let bestRisk = 0;

    const frontier = this.calculateEfficientFrontier(results);

    for (const point of frontier) {
      if (point.risk > 0) {
        const ratio = point.return / point.risk;
        if (ratio > bestRatio) {
          bestRatio = ratio;
          bestAllocation = point.weights;
          bestReturn = point.return;
          bestRisk = point.risk;
        }
      }
    }

    return {
      allocation: bestAllocation,
      expectedReturn: bestReturn,
      expectedRisk: bestRisk,
    };
  }
}
