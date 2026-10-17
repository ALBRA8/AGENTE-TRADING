# 04 — ESTADO ACTUAL Y PRÓXIMOS PASOS

## Estado actual

AGENTE-TRADING ya tiene una base importante de arquitectura, estrategia, riesgo, backtesting, aprendizaje y ejecución.

El último gran bloque cerrado es P0 Execution Truth.

## Componentes principales existentes

### Strategy

- `src/strategy/engine.ts`
- `h1-context.ts`
- `session-liquidity.ts`
- `poi-validator.ts`
- `m5-confirmation.ts`
- `m1-trigger.ts`
- `types.ts`
- `strategy.config.ts`
- `integration.ts`
- `runner.ts`

### Backtest

Existe un motor histórico con:

- no look-ahead;
- entrada tras confirmación;
- SL/TP;
- fricción;
- gap-through fills;
- ambigüedad same-candle conservadora;
- MAE/MFE;
- sizing por riesgo;
- manifest de reproducibilidad.

Pero el backtest legacy no debe convertirse en un segundo Strategy Engine.

Debe evolucionar posteriormente hacia adapters de simulación alrededor del Strategy Engine canónico.

### Walk-forward

Existe `walk_forward.ts`, pero hay deuda conocida:

- ventanas IS/OOS asimétricas;
- `optimizationMetric` tratado incorrectamente en una validación;
- riskPerTrade mezclado como parámetro de optimización;
- métricas de consistencia/CV inestables cerca de cero/negativo.

Fuera del alcance P0.

### Stress test

Existe stress testing, pero debe ganar reproducibilidad mediante seed y posteriormente replayar Strategy Engine bajo condiciones alteradas.

Fuera del alcance P0.

### Learning

`src/agent/self_improve.ts` tiene:

`experience → reflection → lesson`

y recurrencia/deduplicación.

Trading lessons requieren recurrencia antes de reutilización.

Esto es un puente genérico, no el futuro Strategy Evolution completo.

### Consolidation

Existe:

`EVENT → EPISODIC → PATTERN → CONSOLIDATION → VALIDATION → PROMOTION`

Pero la consolidación actual tiene una limitación importante: estadísticas por símbolo pueden mezclar patrones diferentes.

No arreglar esto dentro de P0.

### Trackrecord

Registra WAIT/REVIEW y razones de no entrada.

Es una base útil para futuros counterfactuals.

## Roadmap correcto

### FASE 1 — Validación real de P0

1. Configurar `BRIDGE_TOKEN` en entorno Windows/servidor.
2. Reiniciar `bridge.py`.
3. Ejecutar Trading en SHADOW.
4. Observar `execution_events`.
5. Verificar genealogía real:

`decision → execution → order → deal → position → exit deal → realized → reconciliation`

6. Confirmar respuesta perdida/ambiguidades cuando puedan probarse de forma segura.
7. Auditar P0 post-implementación.

### FASE 2 — No tocar todavía Strategy Evolution

Solo después de comprobar que los resultados reales son fiables.

### FASE 3 — Strategy Evolution

Cuando P0 esté validado:

ExperienceRecord
→ CounterfactualExperience
→ LearningCandidate
→ Hypothesis
→ Experiment
→ ValidationResult
→ StrategyVersion
→ Promotion

Siempre usando el Strategy Engine existente como autoridad.

## Estrategia de evolución

Ejemplo de hipótesis:

`SL 10 → SL 20`

No se acepta porque una operación funcionó.

Debe compararse contra baseline con:

- dataset definido;
- mismo periodo;
- IS/OOS;
- walk-forward;
- robustez;
- régimen;
- riesgo;
- costes de ejecución;
- criterios estadísticos.

## Integración futura con AGENTE-GENERAL

Trading debe entregar al General sus capacidades y experiencias mediante adapters/contracts, sin duplicar:

- memory;
- evidence;
- feedback;
- execution universal;
- workflow;
- permissions;
- audit;
- HITL.

## Cosas que NO hacer ahora

- no crear otro agente;
- no crear otro Strategy Engine;
- no crear otro Execution Engine;
- no rehacer pipeline completo;
- no rediseñar General;
- no activar dinero real solo porque P0 tiene tests verdes;
- no implementar Strategy Evolution antes de validar execution truth real;
- no convertir US30 V1 en verdad universal;
- no mezclar conocimiento de vídeos con código de estrategia sin versionarlo.
