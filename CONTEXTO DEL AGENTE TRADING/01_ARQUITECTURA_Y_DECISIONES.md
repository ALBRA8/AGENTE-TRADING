# 01 — ARQUITECTURA Y DECISIONES CONGELADAS

## 1. Arquitectura global

`AGENTE-GENERAL` es el Seed/ADN universal y estable.

`AGENTE-TRADING` es el harness especialista de trading.

No se deben fusionar ahora ni crear un segundo agente completo dentro de Trading.

### General posee

Runtime, Reasoning, Memory, Evidence, Feedback, Learning, Audit, Security, HITL, Execution universal, Workflows, Skills, Capabilities, MCP/A2A, Recovery y capacidades universales.

### Trading posee

Strategy, experiencia de trading, counterfactuals, hipótesis, experimentos, validación, strategy versioning, promoción específica, SMC, MT5, riesgo, broker/data, backtesting y replay.

## 2. Clasificación arquitectónica

1. `TRADING_NATIVE`
2. `GENERAL_CAPABILITY`
3. `ADAPTER`
4. `SHARED_CONTRACT`
5. `TEMPORARY_BRIDGE`
6. `DUPLICATE`
7. `TRADING_EXTENSION`

## 3. Capabilities Trading propuestas

- `trading.market_analysis`
- `trading.structure_analysis`
- `trading.liquidity_analysis`
- `trading.poi_validation`
- `trading.strategy_evaluation`
- `trading.backtest`
- `trading.counterfactual_analysis`
- `trading.strategy_experiment`
- `trading.risk_calculation`
- `trading.order_execution`
- `trading.position_management`
- `trading.trade_reconciliation`

## 4. Principios de conocimiento

El conocimiento de trading debe ser modular, canónico y portable.

No duplicar motores universales del General.

El conocimiento derivado de los vídeos se consolida por capas antes de inyectarlo al agente, evitando enviarlo todo de golpe.

Arquitectura conceptual de conocimiento:

`TRADING_KNOWLEDGE/CORE`
`TRADING_KNOWLEDGE/LIQUIDITY`
`TRADING_KNOWLEDGE/POI`
`TRADING_KNOWLEDGE/ENTRY`
`TRADING_KNOWLEDGE/OPENTRADE`
`TRADING_KNOWLEDGE/RISK`
`TRADING_KNOWLEDGE/STRATEGIES/US30`

Las fuentes originales deben conservarse separadas del conocimiento consolidado cuando estén disponibles.

## 5. US30 V1

US30 V1 es una **semilla**, no una verdad absoluta.

El agente debe poder:

- analizar mercado;
- simular alternativas;
- aprender de operaciones ganadas y perdidas;
- aprender de oportunidades NO tomadas;
- construir counterfactuals;
- probar parámetros alternativos;
- comparar instrumentos;
- generalizar solamente con evidencia suficiente;
- mantener adaptaciones específicas de estrategia separadas del conocimiento general.

La seguridad y las restricciones de riesgo son no negociables.

## 6. Cadena mental base

`CONTEXTO → LIQUIDEZ → EVENTO → POI → REACCIÓN → CONFIRMACIÓN → RETEST → ENTRY`

Si falta una condición crítica: `NO TRADE`.

## 7. POI

Jerarquía:

`CONTEXTO → ESTRUCTURA → LIQUIDEZ → EVENTO/DESPLAZAMIENTO → ORIGEN → POI → REACCIÓN → CONFIRMACIÓN`

POI ≠ ENTRY.

`POI → PRICE ARRIVES → REACTION → CONFIRMATION → RETEST → TRIGGER → ENTRY`

Estados de POI:

- WATCH
- CONFIRMED
- EXECUTABLE
- INVALID

## 8. US30 conceptual

`H1 → CONTEXTO MACRO → LONDON / NEW YORK → LIQUIDITY → LIQUIDITY TAKE → POI M15 → RETRACEMENT → CHOCH / CONFIRMACIÓN M1-M5 → RETEST → ENTRY → STRUCTURAL SL → EXTERNAL LIQUIDITY / TARGET → MANAGEMENT`

## 9. Evidence / Provenance

Fuentes de experiencia:

- REAL_TRADE
- COUNTERFACTUAL
- BACKTEST
- EXPERIMENT
- OBSERVATION
- EXTERNAL_SOURCE

Provenance:

- REAL
- COUNTERFACTUAL
- BACKTEST
- SIMULATED
- EXPERIMENT
- OBSERVATION

Etiquetas de conocimiento:

- OBSERVED
- EXPLICIT
- CONSOLIDATED
- INFERRED
- STRATEGY_RULE
- COMMON_RULE
- UNKNOWN
- CONFLICT

## 10. OpenTrade

`PRE-CHECK → VALIDATE SETUP → VALIDATE RISK → CALCULATE POSITION → PLACE ORDER → VERIFY EXECUTION → MONITOR → MANAGE → CLOSE → RECORD`

Debe ser fail-closed.

## 11. No-trade

Razones conocidas:

- falta de contexto;
- liquidez no identificable;
- POI débil/incompatible;
- falta de confirmación;
- estructura contradictoria;
- riesgo no calculable;
- límites diarios;
- sesión inválida;
- condiciones no adecuadas;
- setup incompleto.

## 12. Loop adaptativo

`ESTRATEGIA BASE → OBSERVAR → ANALIZAR → SIMULAR/BACKTEST → GANÓ/PERDIÓ/NO ENTRÓ → DETECTAR PATRONES → PROPONER MODIFICACIÓN → TEST A/B → VALIDACIÓN → ¿MEJORA REAL? → DESCARTAR/APRENDER → NUEVA VERSIÓN`

Una operación no valida una regla. Una pérdida no invalida una estrategia.

## 13. Strategy Engine

Existe un único Strategy Engine central en:

`src/strategy/engine.ts`

Estados S0-S9.

Es una función pura, sin I/O, que trabaja sobre velas M1 cerradas.

Cadena principal:

S2 sweep → BOS/POI
S3 POI_WAIT → return/invalidation/timeout
S4 IN_POI → M5 CHOCH
S5 CONFIRMED → M1 trigger
S6 TRIGGER_WAIT → SL/TP/RR/order
S7 ORDER_LIVE → retest/fill
S8 MANAGED → SL/TP/BE
S9 CLOSED

Es la autoridad única para:

LIVE / SHADOW / BACKTEST / COUNTERFACTUAL / EXPERIMENT.

No crear otro Strategy Engine.

## 14. Strategy Config

La configuración estratégica debe terminar separada de:

- RiskPolicy
- ExecutionModel
- ExperimentConfig

Objetivo:

`StrategyVersion → immutable StrategyConfig → Strategy Engine → StrategySignal`

## 15. Evolución futura

Entidades previstas:

- ExperienceRecord
- CounterfactualExperience
- LearningCandidate
- Hypothesis
- Experiment
- ValidationResult
- StrategyVersion
- Promotion

Pero **Strategy Evolution queda congelado hasta que Execution Truth sea fiable en entorno real**.

## 16. General Memory

Trading NO debe crear otro memory engine.

Debe usar el sistema universal y enriquecer metadata con:

strategy_id/version, symbol, timeframe, pattern_key, setup_signature, market_regime, context, liquidity, POI, confirmation, entry, SL, TP, risk, etc.

## 17. Decisiones importantes

- No sobrecargar AGENTE-GENERAL con lógica de trading.
- No duplicar sistemas universales.
- No crear otro execution engine.
- No crear otro strategy engine.
- No iniciar Strategy Evolution antes de asegurar verdad de ejecución.
- Preservar el conocimiento de vídeos como activo persistente y versionable.
