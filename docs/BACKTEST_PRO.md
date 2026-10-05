# Backtesting Profesional - Documentación

Sistema de backtesting de nivel institucional con Smart Money Concepts (SMC) para trading automatizado.

## 🎯 Características

### Métricas Institucionales
- **Sharpe Ratio** - Rendimiento ajustado por riesgo
- **Sortino Ratio** - Sharpe pero solo penaliza downside
- **Calmar Ratio** - Retorno anualizado / Max Drawdown
- **Maximum Drawdown (MDD)** - Peor racha perdedora en %
- **Profit Factor** - Ganancias brutas / Pérdidas brutas
- **SQN (System Quality Number)** - Calidad del sistema
- **Expectancy** - Ev por trade en R
- **Recovery Factor** - Ganancia total / Max Drawdown

### Simulación Monte Carlo
- 10,000 simulaciones de secuencias random
- Probability of Profit
- Risk of Ruin (prob. de perder 50%)
- Percentiles P5, P25, P50, P75, P95
- Worst case / Best case scenarios

### Detección SMC Automática
- **BOS** (Break of Structure) - continuación
- **ChoCh** (Change of Character) - reversión
- **FVG** (Fair Value Gaps) - imbalances
- **Swing Points** - Highs/Lows identification
- **Rel Volume** - filtro de volumen relativo

## 🚀 Uso Rápido

### Modo Report (trades pasados)
```javascript
runBacktestPro({
  mode: "report",
  period: "week" // "week" | "month" | "all"
})
```

### Modo Simulation (simulación PRO)
```javascript
runBacktestPro({
  mode: "simulation",
  asset: "US30",
  timeframe: "M15",
  candleCount: 1000,
  initialBalance: 10000,
  riskPerTrade: 1.0,
  tpRatio: 3.0,
  requireFVG: true,
  requireKillzone: false,
  generateHTML: true
})
```

## 📊 Estructura del Módulo

```
src/backtest/
├── index.ts            # Exports públicos
├── types.ts            # Tipos TypeScript
├── smc_detector.ts     # BOS, ChoCh, FVG detector
├── simulator.ts        # Motor de simulación
├── metrics.ts          # Cálculo de métricas institucionales
├── report_generator.ts # Generador HTML
└── engine.ts           # Orquestador principal

src/agent/tools/
└── run_backtest_pro.ts # Tool para el agente
```

## 🔧 Configuración

### BacktestConfig
```typescript
{
  asset: string;              // US30, NAS100, BTCUSD
  timeframe: "M1" | "M5" | "M15" | "H1" | "H4";
  startDate: Date;
  endDate: Date;
  initialBalance: number;      // 10000
  riskPerTrade: number;        // 1.0 (%)
  rvolThreshold: number;       // 1.2 (1.2x vol promedio)
  slMultiplier: number;        // 1.0
  tpRatio: number;             // 3.0 (1:3 RR)
  maxSlPips: number;           // 15 (SL dinámico por activo)
  requireFVG: boolean;         // true/false
  requireKillzone: boolean;   // true/false
  allowHedging: boolean;       // false
  maxConcurrentTrades: number; // 1
}
```

### BacktestResult
```typescript
{
  config: BacktestConfig;
  trades: Trade[];              // Lista de trades simulados
  equityCurve: EquityPoint[];   // Curva de equity
  metrics: PerformanceMetrics;  // Métricas calculadas
  monteCarlo: MonteCarloResult; // Resultado Monte Carlo
  benchmarks: {                 // Comparativo Buy & Hold
    buyHold: number;
    buyHoldDrawdown: number;
  };
  timeExecuted: Date;
}
```

## 📈 Interpretación de Métricas

### Buen Sistema (backtest exitoso)
| Métrica | Umbral Mínimo | Óptimo |
|---------|--------------|--------|
| Win Rate | > 45% | > 55% |
| Profit Factor | > 1.3 | > 1.8 |
| Sharpe Ratio | > 1.0 | > 1.5 |
| SQN | > 1.6 | > 2.5 |
| Risk of Ruin | < 5% | < 1% |
| Max Drawdown | < 20% | < 15% |

### Señales de Alerta
- Profit Factor < 1.1 (insostenible)
- SQN < 0.9 (sistema débil)
- Risk of Ruin > 10% (muy peligroso)
- Sharpe < 0.5 (no trading realmente)

## 🎨 Reporte HTML

El reporte incluye:
1. **Dashboard de métricas** - KPIs principales
2. **Curva de Equity** - Gráfico de crecimiento
3. **Análisis por Setup** (BOS vs ChoCh)
4. **Win Rate por Hora** (heatmap temporal)
5. **Métricas detalladas** - Tablas completas
6. **Monte Carlo** - Análisis de robustez
7. **Lista de Trades** - Top 50 trades

## 🧪 Ejemplo de Uso Avanzado

```typescript
import { BacktestEngine } from "./backtest";
import { MT5Bridge } from "./config/mt5bridge";

async function runBacktestAvanzado() {
  // Obtener datos
  const candles = await MT5Bridge.getCandles("US30", "M15", 2000);

  // Configurar backtest
  const config = {
    asset: "US30",
    timeframe: "M15",
    startDate: new Date(candles[0].time),
    endDate: new Date(candles[candles.length - 1].time),
    initialBalance: 25000,
    riskPerTrade: 1.0,
    rvolThreshold: 1.5,       // Solo setups con 1.5x volumen
    slMultiplier: 1.0,
    tpRatio: 3.0,             // 1:3 Risk/Reward
    maxSlPips: 12,           // US30: Max 12 pips SL
    requireFVG: true,         // Solo con imbalance
    requireKillzone: true,   // Solo NY Killzone (8-12 EST)
    allowHedging: false,
    maxConcurrentTrades: 1,
  };

  // Ejecutar
  const engine = new BacktestEngine({
    enableMonteCarlo: true,
    monteCarloIterations: 10000,
  });

  const result = await engine.runBacktest(candles, config);

  // Generar reporte
  const reportPath = engine.generateReport(result, true);
  console.log(`Reporte: ${reportPath}`);

  // Usar métricas
  if (result.metrics.sqn > 2.0) {
    console.log("Sistema válido para trading real");
  }
}
```

## 🔄 Integración con Tools

La tool `runBacktestPro` está disponible en el agente:

```typescript
// En tu agente config
tools: [
  runBacktestPro,
  // ...otros tools
]
```

El agente puede:
1. Ejecutar backtest sobre diferentes períodos
2. Comparar configuraciones (A/B testing)
3. Sugerir optimizaciones basado en métricas
4. Validar sistemas antes de ir live

## 🎯 Características Avanzadas

### 1. Walk-Forward Analysis (Anti-Overfitting)

El estándar oro para validar que tu estrategia no está curve-fitted:

```typescript
import { WalkForwardAnalyzer } from "./backtest";
import { MT5Bridge } from "./config/mt5bridge";

const wfa = new WalkForwardAnalyzer();

const result = await wfa.runWFA(candles, config, {
  trainWindow: "6M",      // 6 meses de entrenamiento
  testWindow: "2M",       // 2 meses de prueba
  overlap: 0.5,           // 50% overlap entre ventanas
  optimizationMetric: "sqn", // Optimizar por SQN
  minAcceptableMetric: 1.6, // Umbral de validación
  paramGrid: {
    tpRatio: [2, 2.5, 3, 3.5, 4],
    requireFVG: [true, false],
    rvolThreshold: [1.0, 1.2, 1.5],
    riskPerTrade: [0.5, 1.0, 1.5],
  },
});

console.log(result.summary.robustnessScore); // 0-1
console.log(result.recommendation);          // ✅ ROBUSTO
```

**Output:**
- Robustness Score: 0-1 (0.8+ = sistema robusto)
- Consistency Score: Train vs Test correlation
- Parameter Stability: Cuán estables son los parámetros óptimos
- Recomendación final: Listo para live / Revisar / No usar

---

### 2. Portfolio Backtesting (Multi-Asset)

Backtestea múltiples activos simultáneamente con correlación:

```typescript
import { PortfolioBacktester } from "./backtest";

const portfolio = new PortfolioBacktester({
  assets: ["US30", "NAS100", "SPX500"],
  primary: "US30",
  equalWeight: true,
  maxPositionSize: 40,          // Max 40% en un asset
  correlationThreshold: 0.8,    // Skip si correl > 80%
});

// Agregar datos de cada asset
portfolio.addAsset("US30", candlesUS30);
portfolio.addAsset("NAS100", candlesNAS100);
portfolio.addAsset("SPX500", candlesSPX);

// Correr backtest
const result = await portfolio.runPortfolioBacktest(config);

// Resultados individuales por asset
for (const asset of result.individual) {
  console.log(`${asset.asset}: ${asset.metrics.winRate.toFixed(1)}% WR`);
}

// Metricas de portfolio combinado
console.log(`Drawdown Portfolio: ${result.portfolio.portfolioDrawdown.toFixed(2)}%`);
console.log(`Beneficio Diversificación: ${(result.portfolio.diversificationBenefit * 100).toFixed(1)}%`);
```

**Matriz de Correlación:**
- Detecta qué assets se mueven juntos
- Evita duplicar exposición
- Mejora ratios riesgo/retorno

**Efficient Frontier:**
- Encontrar combinación óptima de assets
- Maximizar Sharpe Ratio
- Allocación óptima de capital

---

### 3. Regime Detection (Adaptativo)

Detecta el régimen del mercado y ajusta la estrategia:

```typescript
import { RegimeAnalyzer } from "./backtest";

const analyzer = new RegimeAnalyzer({
  detector: {
    adxPeriod: 14,
    atrPeriod: 14,
    adxThreshold: 25,     // ADX > 25 = trending
    adxStrongTrend: 40,   // ADX > 40 = strong trend
    lookbackRegime: 10,
    volatilityPercentile: 80,
  },
  strategies: {
    trending_up: {
      enabled: true,
      tpMultiplier: 1.2,      // TPs más agresivos
      requireFVG: false,     // FVG less important
      positionSize: 1.2,    // Aumentar size
    },
    trending_down: {
      enabled: true,
      tpMultiplier: 1.1,
      requireFVG: false,
      positionSize: 1.0,
    },
    ranging: {
      enabled: true,
      tpMultiplier: 0.8,      // TPs conservadores
      requireFVG: true,     // Requerir imbalance
      positionSize: 0.6,    // Reducir size
    },
    volatile: {
      enabled: false,         // NO operar
    },
    low_volatility: {
      enabled: true,
      tpMultiplier: 0.9,
      requireFVG: true,
      positionSize: 0.8,
    },
  },
});

// En cada vela nueva
const regime = analyzer.analyze(candles);
console.log(analyzer.getCurrentSummary());
// 📈 Tendencia Alcista
//    ADX: 32.5 | ATR: 45.2 | Vol: 0.85%
//    Dirección: up | Duración: 15 velas

// Verificar si operar
const decision = analyzer.shouldTrade(regime, config);
if (decision.shouldTrade) {
  console.log("Operar con:", decision.adjustedConfig);
} else {
  console.log("Skip:", decision.reason);
}
```

**Régimes Detectados:**
- Trending Up / Down: Tendencias claras
- Ranging: Consolidación
- Volatile: Alta volatilidad (evitar)
- Low Volatility: Rango estrecho

**Estadísticas por Régimen:**
```typescript
const stats = analyzer.generateStats();
console.log(`Mejor régimen: ${stats.bestRegime}`);
console.log(`Peor régimen: ${stats.worstRegime}`);

// Solo operar en el mejor régimen?
if (currentRegime === stats.bestRegime) {
  executeTrade();
}
```

---

## 📋 Checklist Pre-Live (Actualizado)

Antes de usar una estrategia en real:

### Básico
- [x] Backtest en >= 6 meses de datos
- [x] Win Rate > 50% ó Profit Factor > 1.5
- [x] SQN > 1.6
- [x] Risk of Ruin < 5%
- [x] Max Drawdown < 20%

### Avanzado
- [x] **Walk-Forward Analysis**: Robustness Score > 0.8
- [x] **Consistency Score**: Train vs Test > 70%
- [x] **Parameter Stability**: CV < 30%
- [ ] **Multi-Asset**: Validar correlaciones
- [x] **Regime Analysis**: Funciona en > 3 régimenes
- [ ] **Forward Test**: 1 semana en demo

### Criterios Anti-Overfitting
- [x] > 5 ventanas train/test en WFA
- [x] < 20% de ventanas fallan el test
- [x] Parámetros estables entre ventanas
- [x] No optimizar en todo el dataset

---

**Comparación con TradingAgents:**

| Feature | TradingAgents | Tu Sistema |
|---------|--------------|------------|
| Datos | Sintéticos | Reales MT5 |
| Validación | &Cross; | Walk-Forward ✓ |
| Multi-Asset | &Cross; | Portfolio ✓ |
| Regime Adaptivo | &Cross; | Regime Detection ✓ |
| **Stress Testing** | &Cross; | **Basado en eventos históricos** ✓ |
| Métricas | Básicas | Institucionales ✓ |
| Monte Carlo | &Cross; | 10k simulaciones ✓ |
| Reporte | Texto | HTML profesional ✓ |

Tu sistema tiene **profesional hedge fund quality**. TradingAgents es un buen experimento pero para trading real necesitas estas validaciones anti-overfitting.

---

## 🎲 Stress Testing (Anti-Fragilidad)

El estándar bancario para prevenir wipeouts catastróficos.

### Escenarios Realistas

Basados en eventos históricos reales:

```typescript
const scenarios = [
  { id: "flash_crash_2010", name: "Flash Crash May 2010", 
    gap: -0.09, slippage: 0.03, recovery: 48 },
  
  { id: "brexit_2016", name: "Brexit Gap", 
    gap: -0.08, spread: 10x, liquidity: 0.20 },
  
  { id: "covid_crash_2020", name: "COVID Market Crash", 
    vol: 8x, slippage: 0.04, recovery: 240 },
  
  { id: "russell_rebalance", name: "Index Rebalance", 
    liquidity: 0.15, delay: 3000ms },
  
  { id: "vix_spike_2018", name: "Volatility Event 2018", 
    vol: 6x, slippage: 0.025, delay: 5000ms },
];
```

### Uso

```typescript
const stress = new StressTestEngine(scenarios);

const result = await stress.runStressTest(candles, config);

console.log(result.summary);
// {
//   worstScenario: "Flash Crash 2010",
//   worstDrawdown: 45.2%,        // vs 15% baseline
//   survivalRate: 87%,           // % scenarios que no mueren
//   recommendedBuffer: 65%        // Capital extra necesario
// }
```

### Tool Integration

```typescript
// Desde el agente
runBacktestPro({ 
  mode: "stress",
  asset: "US30",
  stressScenarios: ["flash_crash", "brexit", "covid"], // o "all"
  enableRandomScenarios: true // Agregar eventos aleatorios
})
```

**Output:**
```
🧪 STRESS TEST COMPLETO

Peor Escenario: Flash Crash May 2010
Max DD (estrés): 42.8% (vs 15.2% baseline)
Tasa Supervivencia: 87%

⚠️ Buffer Recomendado: +65%

Si operas $10,000 → Considera $6,500 extra
Capital total: $16,500

VEREDICTO: 🟢 SISTEMA RESISTENTE
```

---

## 🧠 Filosofía Anti-Fragilidad

> *"No basta con que el sistema resista el estrés, debe beneficiarse de él."*

### Checklist Final Pre-Live

✅ **Métricas básicas**: WR>50%, PF>1.5, SQN>1.6, MaxDD<20%  
✅ **Walk-Forward**: Robustness Score >0.8, Consistency >70%  
✅ **Portfolio**: Correlaciones validadas, diversificación >10%  
✅ **Regime**: Funciona en >3 regimes, evita peor regime  
🔴 **Stress Testing**: Survival Rate ≥80%, Buffer <100%

**El orden importa:**  
1. Primero: Métricas básicas (¿funciona?)  
2. Segundo: WFA (¿no está curve-fitted?)  
3. Tercero: Portfolio (¿escala?)  
4. Cuarto: Regime (¿es adaptable?)  
5. **Final: Stress (¿sobrevive eventos extremos?)**

Si superas todas las pruebas → **Listo para live con gestión de riesgo**
