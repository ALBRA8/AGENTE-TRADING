# INFORME FINAL — P0: EXECUTION TRUTH

> **Fecha**: 2026-10-16 · **Commit**: `bc3d24b` · **Estado del repo**: main = local HEAD
> **Referencia arquitectónica**: `docs/EXECUTION_TRUTH.md` · **Tests**: `tests/execution_truth.test.ts`
> **Garantía central cumplida**: el sistema puede responder siempre, con evidencia reconstruible,
> qué ocurrió con cada decisión de trading:
> `DECISION → EXECUTION_ID → ORDER TICKET → DEAL(S) → POSITION → EXIT DEAL(S) → REALIZED → RECONCILIACIÓN → EXPERIENCE`

---

## A. RESUMEN EJECUTIVO

El P0 convirtió la ejecución MT5 en una **verdad de ejecución reconstruible, determinista, idempotente,
fail-closed y restart-safe**. Antes, la "verdad" de un trade vivía en memoria volátil y en una tabla
`trade_performance` alimentada por `symbol+timestamp` (ambigüedad estructural: ORDER/DEAL/POSITION
confundidos, UNKNOWN interpretado, flotante tratado como resultado). Ahora existe una genealogía
completa con evidencia por entidad (`executions` → `execution_deals` → `execution_events`), un
`execution_id` interno pre-send que atraviesa todo el ciclo de vida, y un `ExecutionReconciler`
dedicado que reconstruye el estado desde las APIs de historia reales de MT5. La capa de settlement
fue degradada a mantenimiento/orquestación y el aprendizaje queda cerrado tras un gate único:
solo `CLOSED + COMPLETE` con PnL realizado por deals produce experiencia.

**Veredicto: P0 PASS WITH LIMITATIONS** (ver §K — las limitaciones son documentadas, no bloquean
ningún criterio de aceptación del P0).

## B. ALCANCE (lo que se hizo y lo que NO se hizo)

**Hecho**: bridge history endpoints sobre APIs reales; auth `X-AGT-Token` de extremo a extremo;
`execution_id` pre-send; modelo Order/Deal/Position separado; `ExecutionReconciler`; settlement
reescrito a 3 fases delegando en el reconciler; UNKNOWN como estado válido sin interpretación;
idempotencia y restart-safety probados; 30 escenarios §29 + especiales §30/§31/§32; migración no
destructiva; docs de arquitectura.

**Explícitamente NO hecho (reglas absolutas respetadas)**: no se rediseñó la arquitectura ni se
crearon nuevos agents/engines; no se tocó la máquina de estados S0–S9 ni la lógica de entrada/salida;
no se implementó retry automático para órdenes ambiguas; no se interpretó UNKNOWN como
LOSS/REJECTED/RETRY; no se usó `symbol+timestamp` como autoridad; no se rediseñó el risk engine
(solo cambió su fuente de datos).

## C. COMPONENTES (nuevos y modificados)

| Componente | Archivo | Cambio |
|---|---|---|
| **Estados canónicos** | `src/execution/types.ts` (NUEVO) | `execution_status` (10 estados §4 + EXPIRED §13) y `reconciliation_status` (4 estados) separados; mapas de evidencia MT5→canónico; `VOLUME_EPSILON` |
| **Registry (identidad)** | `src/execution/registry.ts` (NUEVO) | `execution_id` uuid v4 **pre-send**, broker-independiente, jamás derivado de tickets; `attachOrderTicket`, transiciones con eventos solo si cambian |
| **ExecutionReconciler** | `src/execution/reconciler.ts` (NUEVO) | `reconcileExecution()` determinista e idempotente: fast-path terminal; matching determinista de respuesta perdida (symbol+magic 234000+comentario `AGT-`+dir+volumen, precio solo en LIMIT/STOP); `position_ticket` SIEMPRE por evidencia; precedencia de clasificación; neto = bruto + commission + swap + fee; `reconcilePendingExecutions()` |
| **Persistencia** | `src/database/sqlite.ts` | Migración NO destructiva: `executions` (UNIQUE parcial `order_ticket` anti-duplicado), `execution_deals` (UNIQUE `deal_ticket`), `execution_events` append-only, `trade_orders.execution_id`; 12 helpers idempotentes (INSERT OR IGNORE, UPDATE por whitelist) |
| **Bridge history** | `bridge.py` (+208 L) | `GET /history/orders`, `/history/deals`, `/history/position/<ticket>` sobre `history_orders_get`/`history_deals_get` reales (variantes `ticket=`/`position=`/rango); serialización de `stateName/entryName/reasonName`; `check_bridge_token` fail-closed |
| **Cliente MT5** | `src/config/mt5bridge.ts` | `X-AGT-Token` en TODAS las llamadas (env `BRIDGE_TOKEN`, jamás hardcodeado/logueado); `getHistoryOrders/Deals/Position`; errores clasificables `BRIDGE_TIMEOUT`/`BRIDGE_UNREACHABLE`/`BRIDGE_HTTP_<status>` |
| **Ejecución** | `src/agent/tools/execute_trade_mt5.ts` | La execution NACE antes del envío; guard/HTTP 4xx = rechazo claro; timeout/5xx/transporte = UNKNOWN + PENDING_RECONCILIATION + reconciliación diferida 15s; decisión consumida; NUNCA retry |
| **Settlement** | `src/agent/settlement.ts` | 3 fases: (A) reconciliar vía reconciler, (B) liquidar SOLO CLOSED+COMPLETE (`outcome_source='mt5_reconciled:<eid>'`), (C) legado honesto con expiración. **ELIMINADA** la autoridad `trade_performance+symbol+timestamp` (§21) |
| **Tests** | `tests/execution_truth.test.ts` (NUEVO, 886 L) | 91 asserts: 30 escenarios §29 + §30 response-lost (8 pasos) + §31 UNKNOWN sin resultado + §32 idempotencia ×10 + restart con proceso hijo |
| **Docs** | `docs/EXECUTION_TRUTH.md` (NUEVO) | Modelo completo, invariantes, estados, reconciliación, gate de aprendizaje, entornos, seguridad |

## D. GENEALOGÍA Y CONTRATO DE DATOS

```
decision_log.decision_id (INTENCIÓN)
   → executions.execution_id (uuid v4 interno, NACE EN DISCO antes del send — crash-safe)
      → executions.order_ticket (intención del broker, history_orders_get)
         → execution_deals.deal_ticket ×N (EVIDENCIA CENTRAL, history_deals_get)
            → executions.position_ticket (= position_id del deal, NUNCA asumido == order)
               → exit_deal_tickets ×N (SL/TP/manual/stop-out)
                  → realized_pnl = Σ profit + commission + swap + fee (solo deals)
                     → reconciliación (COMPLETE | INCOMPLETE | UNRECONCILABLE)
                        → ExperienceRecord (SOLO si CLOSED + COMPLETE)
```

Invariantes blindadas: **ORDER ≠ DEAL ≠ POSITION** (columnas y tablas separadas) ·
**UNKNOWN ≠ LOSS/REJECTED/RETRY** · **FLOATING ≠ REALIZED** (flotante = observación,
`outcome_settled=0`) · **DECISION ≠ EXECUTION** (1 decisión → 0/1 execution → N deals).

## E. VERIFICACIÓN EJECUTADA (evidencia §42)

| Check | Resultado |
|---|---|
| Suite completa (`npm test`) | **EXIT 0 — 354 asserts**, 0 fallos (incluye EXECUTION TRUTH 91 + engine 122 + provider 54 + context 15 + E2E 38) |
| `tsc --noEmit` | Solo errores pre-existentes en `src/backtest/` (baseline exacto, **0 nuevos**) |
| `npm audit --audit-level=high` | **0 vulnerabilidades** |
| Patrón prohibido: `trade_performance` como autoridad | 0 usos (solo comentarios de eliminación) |
| Patrón prohibido: UNKNOWN→loss/retry | 0 — UNKNOWN permanece UNKNOWN |
| Patrón prohibido: token en logs | 0 — `BRIDGE_TOKEN` jamás impreso; bodies de error truncados a 500 chars sin headers |
| Patrón prohibido: flotante→settled | 0 — `settled` solo desde deals CLOSED |
| Auth history sin token | 401 fail-closed (testeado) |
| Restart-safety | Proceso hijo independiente reconcilia sin estado previo en RAM (exit 0) |

## F. COBERTURA DE LOS 30 ESCENARIOS (§29)

Cubierto en `tests/execution_truth.test.ts` (91 asserts, mock bridge con serialización idéntica a
`bridge.py`): order accepted/rejected · pendiente que se llena / se cancela / expira · fill total y
parcial con orden viva · SL / TP / manual / stop-out como causa del último exit deal · múltiples
deals de salida (1 position → 3 exits sin perder deals) · múltiples entry deals · bridge caído
(UNKNOWN intacto + intento contado) · respuesta perdida §30 (UNKNOWN → reconciliación → reconstruido,
0 duplicados) · UNKNOWN sin resultado inventado §31 · idempotencia ×10 §32 (snapshot semántico
idéntico: mismo estado, mismo PnL, mismos deals, mismos eventos) · restart con proceso hijo ·
ambigüedad de matching (0 o ≥2 candidatos ⇒ UNKNOWN, nunca adivinar) · deals duplicados bloqueados
por UNIQUE · historia temporalmente indisponible y luego recuperada · history sin token (401).

## G. RIESGOS RESIDUALES CONTROLADOS

1. **UNKNOWN > 12 intentos** → requiere revisión humana (por diseño: no se adivina). No hay UI de
   revisión; la revisión es manual vía SQLite/consulta.
2. **Matching de respuesta perdida** depende de magic + comentario `AGT-` intactos. Si un humano
   edita el comentario de la orden en MT5, el matching devolverá 0 o ≥2 candidatos → UNKNOWN (safe,
   no falso positivo).
3. **Reloj entre VPS y broker**: los rangos de historia usan tiempo del servidor; ventanas amplias
   mitigan skew, pero un skew extremo podría requerir ampliación de rango manual.
4. **DEMO/PAPER** no crea execution records (no hay ejecución real) — el contrato P0 aplica a
   LIVE/MT5 con bridge real arriba.

## H. DEUDA DOCUMENTADA (fuera de alcance P0)

- `saveBacktestRunManifest` ON CONFLICT (§34) · consolidación completa y Strategy Evolution (§40) ·
  TP 1:3 fijo heredado en `execute_trade_mt5.ts` (el TP estructural viaja en `strategy_context`) ·
  scheduler por cierre de vela M1 fuera del pipeline LLM · `trade_orders.ticket` legacy conserva
  significado ORDER-ticket solo por compatibilidad documentada.

## I. OPERACIÓN PARA EL PROPIETARIO

1. En el Windows con MT5: `BRIDGE_TOKEN=<secreto>` en el entorno del **bridge.py** y del **agente**
   (mismo valor). Sin token configurado en el bridge ⇒ endpoints denegados (fail-closed).
2. Levantar `bridge.py`; el agente debe estar arriba **antes** de activar LIVE.
3. Verificación de salud post-arranque: `GET /history/orders` con el header debe devolver 200 y el
   agente debe reconciliar 0 pendientes al inicio.
4. Si aparece una execution `UNKNOWN + PENDING_RECONCILIATION`: NO reenviar la orden; esperar al
   ciclo de reconciliación (techo 12 intentos) y revisar `executions`/`execution_events`.
5. Rotar el PAT de GitHub filtrado en el chat (pendiente del propietario).

## J. CRITERIOS DE ACEPTACIÓN — TABLA DE CUMPLIMIENTO

| # | Criterio | Estado |
|---|---|---|
| 1 | MT5 history disponible (APIs reales, nada inventado) | ✅ bridge.py `history_orders_get`/`history_deals_get` |
| 2 | `X-AGT-Token` correctamente implementado (ida y vuelta) | ✅ cliente + bridge, fail-closed, testeado 401 |
| 3 | `execution_id` implementado (pre-send, broker-independiente) | ✅ registry uuid v4 |
| 4 | Separación order/deal/position | ✅ tablas y columnas separadas + UNIQUE |
| 5 | `ExecutionReconciler` completo (determinista, sin look-ahead) | ✅ 538 L con precedencia documentada |
| 6 | Settlement delega al Reconciler | ✅ FASE A/B/C; autoridad §21 eliminada |
| 7 | UNKNOWN fail-closed (no interpretado) | ✅ §31 testado |
| 8 | Restart-safe + idempotente | ✅ proceso hijo + ×10 snapshot idéntico |
| 9 | 30 escenarios de test | ✅ 91 asserts + especiales §30/§31/§32 |
| 10 | Tests existentes siguen pasando | ✅ 354 asserts, EXIT 0 |
| 11 | Documentación actualizada | ✅ `docs/EXECUTION_TRUTH.md` |
| 12 | Reporte final A–K con veredicto | ✅ este documento |

## K. VEREDICTO

```
P0 PASS WITH LIMITATIONS
```

Todos los criterios de aceptación del P0 se cumplen con evidencia ejecutada (§J). Las limitaciones
(§G) son restricciones de diseño aceptadas — revisión humana para UNKNOWN crónico, dependencia del
comentario/magic para el matching de respuesta perdida, sin UI de revisión — y ninguna compromete
las invariantes de verdad: **ningún estado desconocido se convierte en un resultado falso, ninguna
orden se reenvía por ambigüedad, y ningún aprendizaje se produce sin evidencia MT5 reconciliada.**
