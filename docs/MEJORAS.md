# SOP v3 — Pipeline Institucional + Auto-Mejora

Documentación de la mejora de arquitectura inspirada en TradingAgents (TauricResearch)
y en el skill self-improving-agent (ClawHub/pskoett). Stack: TypeScript puro, sin LangGraph.

## Flujo de decisión

```
runDecisionPipeline(asset)
│
├─ 1. FILTROS (paralelo, código determinista)
│     checkMarketHours · checkNews · checkDXY · checkRVOL · analyzeMarket
│     → Gates: GREEN / YELLOW / RED / UNKNOWN
│     → Gate RED (mercado cerrado, noticia de alto impacto) → ABORTED sin gastar tokens
│
├─ 2. DEBATE Bull vs Bear (modelo quick, 1 ronda)
│
├─ 3. RESEARCH MANAGER (modelo deep)
│     JSON: {bias, confidence, conditions[], rationale}
│
├─ 4. TRADE PLANNER (modelo deep) + LECCIONES inyectadas
│     JSON: {action, direction, stopLossPips, riskPct, setup, reasoning}
│     → JSON ilegible = REVIEW (nunca se degrada a algo operable)
│
├─ 5. COMITÉ DE RIESGO (3× modelo quick en paralelo)
│     Agresivo / Conservador / Neutral → veto si ≥2 votan VETO
│
└─ 6. GATE FINAL EN CÓDIGO → EXECUTE | WAIT | REVIEW | ABORTED
      + persistencia completa en decision_log (SQLite)
```

## Hard-Gate de ejecución (SOP v3)

`executeTradeMT5` ya NO confía en el LLM para respetar el SOP:

- Exige una decisión `EXECUTE` vigente (≤15 min) en `decision_log` para el símbolo.
- Rechaza órdenes en dirección contraria a la autorizada.
- Clampea el riesgo a `MAX_RISK_PCT` (default 1.0%) sin importar lo que pida el LLM.
- Valida sanidad del SL (positivo, razonable).
- Escape de emergencia: `PIPELINE_GATE=off` (solo debug).

## Auto-mejora (aprende de los errores)

Inspirado en el skill self-improving-agent: captura → dedupe → reflexión → reuso → promoción → triage.

| Componente | Archivo | Función |
|---|---|---|
| Captura automática de errores | `self_improve.ts` + `registry.ts` | Todo fallo de tool se registra en `agent_errors` con pattern_key |
| Dedupe por pattern_key | `sqlite.ts::saveLesson` | Ocurrencias se cuentan, no se duplican |
| Reflexión post-trade | `tools/reflect_on_trade.ts` | LLM (quick) destila 2-4 frases accionables con metadatos de mantenimiento (decay, revalidación) |
| Reuso antes de decidir | `self_improve.ts::buildLessonsContextBlock` | El planner recibe las lecciones relevantes del símbolo |
| Promoción | `sqlite.ts` + `loop.ts` | Lecciones ⭐ promovidas viajan SIEMPRE en el system prompt |
| Revalidación por causa | `reflect_on_trade` | Trade ganador que contradice una lección verificada → `unresolved` (no se expira por antigüedad) |
| Triage de errores recurrentes | `self_improve.ts::triageUnresolvedErrors` | ≥3 fallos del mismo patrón → lección operacional automática (cada 5 turnos) |

## Tiers de modelo (ahorro de costo)

| Tier | Uso | Variable .env | Default |
|---|---|---|---|
| `quick` | debate, riesgo, reflexión | `QUICK_MODEL` | meta/llama-3.3-70b-instruct |
| `deep` | manager, planner | `DEEP_MODEL` | nvidia/nemotron-3-super-120b-a12b |

## Nuevas tablas SQLite

- `decision_log` — traza completa de cada decisión (gates, reportes, debate, tokens, latencia, outcome)
- `agent_lessons` — lecciones con metadatos de mantenimiento (kind, pattern_key, decay, validation_status, promoted)
- `agent_errors` — errores automáticos de herramientas para triage

## Próximas fases (del plan aprobado)

- **Fase 2**: settlement automático (al cerrar el trade, reflexión sin pedirle al usuario)
- **Fase 4**: evaluación del pipeline sobre histórico con el backtest engine (hit-rate por decisión)
- **Fase 5**: progreso del pipeline en tiempo real por Telegram (webhook de onProgress)

---

# Fases 2, 4 y 5 — Settlement, Evaluación del Cerebro y Observabilidad

## Fase 2 — Settlement automático (`settlement.ts`)

Cada decisión EXECUTE queda "abierta" hasta que vence su horizonte (24h por defecto,
`SETTLEMENT_HORIZON_HOURS`). Entonces el settlement busca la evidencia del resultado
en cascada:

| Prioridad | Fuente | Resultado |
|---|---|---|
| 1 | `trade_performance` (log manual del usuario posterior a la decisión) | PnL real → settled |
| 2 | Posición viva en MT5 (ticket vinculado) | Profit flotante → estimación provisional |
| 3 | Posición cerrada sin PnL reportado | Reintenta hasta `MAX_ATTEMPTS=8` → expira sin datos |
| 4 | EXECUTE sin orden vinculada | Expira como `no_execution` (métrica de seguimiento) |

Estados de `outcome_settled`: `0` pendiente · `1` settled con PnL · `2` expirado sin datos.

Al cerrar con PnL real se dispara la **reflexión automática** (`self_improve.ts`):
el trade destila una lección sin que el usuario pida nada. El bucle corre en
background cada `SETTLEMENT_INTERVAL_MIN` minutos (default 60) vía
`startAgentMaintenance()` — idempotente y a prueba de fallos.

**Vínculo decisión ↔ orden**: `executeTradeMT5` ahora registra cada orden en la
tabla `trade_orders` con el `decision_id` de la decisión EXECUTE vigente que la
autorizó. Sin ese vínculo no hay trazabilidad de seguimiento.

## Fase 4 — Evaluación del Cerebro (`brain_eval.ts`)

Responde "¿este agente decide bien?" con un **Brain Score 0-100** compuesto:

| Componente | Máx | Qué mide |
|---|---|---|
| 🛡️ Disciplina | 30 | % de decisiones EXECUTE con filtros sin rojo (parse de gates_json) |
| 🎯 Calibración | 25 | ¿La confianza del manager predice el resultado? (conf. media en wins vs losses) |
| 📌 Seguimiento | 15 | % de EXECUTE que terminaron en orden real (anti-decisiones fantasma) |
| 🧬 Aprendizaje | 20 | Lecciones capturadas, verificadas, consolidadas y promovidas |
| ⚙️ Operativa | 10 | Patrones de error recurrentes sin resolver |

- Cada evaluación guarda un snapshot en `brain_evaluations` → **tendencia del score**
  (¿el cerebro mejora con las lecciones? → el argumento de venta medible).
- Veredicto automático por umbrales (80+ institucional, 60+ competente, <40 no escalar).
- Tool `evaluateBrain` + endpoint `GET /api/agent/brain`.

## Fase 5 — Observabilidad (`observability.ts`)

Un JSON con la foto completa del escritorio (`GET /api/agent/status`):

- Decisiones 24h/7d por tipo, tokens, latencia media del pipeline
- Settlement pendiente/expirado, PnL settled, win rate
- Lecciones (total/verificadas/promovidas) y errores sin resolver
- Config de seguridad (hard-gate on/off, riesgo máximo, modelos por tier)
- Salud de dependencias (bridge MT5, NVIDIA key) con chequeo real async

Endpoints nuevos en `server.ts`:

| Endpoint | Método | Función |
|---|---|---|
| `/api/agent/status` | GET | Foto de estado completo |
| `/api/agent/brain` | GET | Brain score + tendencia (guarda snapshot) |
| `/api/agent/decisions?limit=` | GET | Últimas decisiones auditadas |
| `/api/agent/settle` | POST | Forzar settlement manual |

Tools nuevos registrados: `settleDecisions`, `evaluateBrain`, `agentStatus`
(SOP v3.1 en `loop.ts`). Test: `tests/smoke_phases.ts` (15 asserts, sin APIs externas).
