# 02 — CONOCIMIENTO DE VÍDEOS Y TRADING

## Propósito

Este archivo preserva el conocimiento de trading que ya fue extraído, discutido y consolidado durante el trabajo de esta conversación/proyecto.

**Importante:** no se inventan transcripciones ni nombres de vídeos que no estén disponibles en el contexto persistido. Lo que se conserva aquí es el conocimiento derivado que ya fue establecido en el proyecto.

## Estado de las fuentes

Se trabajó con un conjunto de vídeos/fuentes de formación de trading y se decidió no inyectarlos de forma desordenada al agente.

La estrategia acordada fue:

1. conservar las fuentes originales;
2. extraer conocimiento;
3. deduplicar conceptos comunes;
4. separar conocimiento consolidado de hipótesis;
5. marcar conflictos entre fuentes;
6. mantener US30 como primera estrategia consumidora;
7. producir una base portable de `TRADING KNOWLEDGE`.

## Fundación TRADING DOMAIN KNOWLEDGE V1

Áreas consolidadas:

00_CORE
01_MARKET_STRUCTURE
02_LIQUIDITY
03_STRUCTURE_EVENTS
04_ZONES_OF_INTEREST
05_TIMEFRAME_MODEL
06_SESSION_CONTEXT
07_ENTRY_LOGIC
08_OPENTRADE
09_RISK_MANAGEMENT
10_STRATEGIES
11_REASONING
12_INVALIDATION
13_TRADE_MANAGEMENT
14_EVIDENCE

## Core

Conceptos principales:

- market structure;
- swings;
- BOS;
- CHOCH;
- liquidity;
- sweep;
- POI;
- Order Block;
- Breaker;
- FVG;
- mitigation;
- polarity;
- multi-timeframe analysis;
- sessions;
- confirmation;
- invalidation;
- risk;
- trade management.

## Liquidity

La liquidez se analiza como contexto y evento, no como señal aislada.

La secuencia de razonamiento trabaja alrededor de:

`CONTEXT → LIQUIDITY → EVENT → POI → REACTION → CONFIRMATION → RETEST → ENTRY`

## Structure Events

Eventos relevantes:

- BOS;
- CHOCH;
- liquidity sweep/take;
- displacement;
- structural effect;
- return/mitigation.

## POI

Tipos contemplados:

- Order Block;
- Breaker;
- FVG;
- otras zonas derivadas de contexto/estructura cuando exista evidencia.

Un POI no es una entrada automática.

Debe atravesar:

`POI → PRICE ARRIVES → REACTION → CONFIRMATION → RETEST → TRIGGER → ENTRY`

Campos estructurados:

- type;
- timeframe;
- context;
- liquidity_event;
- displacement;
- structural_effect;
- mitigation;
- polarity;
- execution_pending_confirmation;
- invalidation;
- status.

## Multi-timeframe

La lógica trabaja con jerarquía temporal.

Para US30 V1 se consolidó conceptualmente:

H1 = contexto macro
M15 = POI / estructura operativa
M5 = confirmación estructural
M1 = trigger/ejecución

No significa que estos parámetros sean verdades universales; son la base actual de US30 V1 y deben poder evolucionar mediante evidencia.

## Sesiones

Se reconoce la importancia del contexto temporal, especialmente London y New York para US30.

La sesión no debe convertirse en una regla absoluta fuera de su estrategia/versionado.

## Entrada

La entrada necesita contexto, evento, POI, reacción y confirmación.

Un setup incompleto produce `NO TRADE`.

## Invalidation

La invalidación es parte de la definición del setup, no una corrección posterior.

La estrategia debe saber cuándo dejar de esperar un POI/confirmación.

## Risk

Principios:

- riesgo calculable antes de ejecutar;
- SL estructural;
- límites de pérdida diaria;
- límites de exposición;
- fail-closed;
- no override de restricciones duras por una señal positiva.

## No Trade

El agente debe aprender también de las operaciones que **no tomó**.

Esto llevó a separar conceptualmente:

REAL_TRADE
vs.
COUNTERFACTUAL

Un setup que no se ejecutó no debe convertirse artificialmente en una operación real.

## Counterfactuals

Un counterfactual representa una oportunidad hipotética observada y seguida sin ejecución real.

Estados previstos:

DETECTED → TRACKING → RESOLVED

con ramas:

INVALID / AMBIGUOUS

Nunca usar datos futuros para decidir que una oportunidad habría sido buena antes de su resolución temporal.

## Experiencia

`ExperienceRecord` debe distinguir procedencia:

REAL_TRADE
COUNTERFACTUAL
BACKTEST
EXPERIMENT
OBSERVATION

## Evidence

Las afirmaciones del conocimiento deben conservar su nivel de certeza.

Etiquetas:

OBSERVED
EXPLICIT
CONSOLIDATED
INFERRED
STRATEGY_RULE
COMMON_RULE
UNKNOWN
CONFLICT

Esto permite combinar diferentes vídeos sin convertir todas sus enseñanzas en reglas universales.

## US30 V1 — cadena consolidada

`H1 → CONTEXTO MACRO → LONDON / NEW YORK → LIQUIDITY → LIQUIDITY TAKE → POI M15 → RETRACEMENT → CHOCH / CONFIRMACIÓN M1-M5 → RETEST → ENTRY → STRUCTURAL SL → EXTERNAL LIQUIDITY / TARGET → MANAGEMENT`

## Lección metodológica de los vídeos

El objetivo no es copiar literalmente una metodología de un vídeo.

El objetivo es extraer:

- conceptos;
- relaciones;
- condiciones;
- invalidaciones;
- patrones repetibles;
- diferencias entre estrategias;
- evidencia;
- hipótesis comprobables.

El agente debe poder descubrir posteriormente si una regla funciona, en qué régimen funciona, cuándo falla y si es específica de un instrumento o generalizable.

## Pendiente de preservación de fuentes originales

Si en futuras conversaciones aparecen los archivos/transcripciones originales de los vídeos, deben incorporarse como **fuentes originales**, sin sobrescribir este conocimiento consolidado.

No se deben inventar nombres, timestamps o transcripciones ausentes.
