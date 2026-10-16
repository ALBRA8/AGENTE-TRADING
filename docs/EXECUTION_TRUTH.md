# P0 — EXECUTION TRUTH: Verdad de Ejecución MT5

> **Estado**: IMPLEMENTADO (P0) · **Fecha**: 2026-10-16 · **Spec**: prompt P0 §0–§44
> **Garantía central**: el sistema puede responder con evidencia reconstruible:
> `DECISION → EXECUTION_ID → ORDER TICKET → DEAL(S) → POSITION → EXIT DEAL(S) → REALIZED → RECONCILIACIÓN → EXPERIENCE`

---

## 1. Modelo conceptual y genealogía

```
decision_log (decisión = INTENCIÓN del razonamiento)
      │ decision_id
      ▼
executions (execution_id = uuid v4 interno, broker-independent, NUNCA derivado de tickets MT5)
      │ se crea ANTES de enviar la orden al broker (pre-send, crash-safe)
      ▼
ORDER TICKET        (intención del broker — history_orders_get)
      ▼
DEAL TICKET(S)      (EVIDENCIA CENTRAL de ejecución — history_deals_get)
      │ N entry deals (1 order → N fills)
      ▼
POSITION TICKET     (estado agregado = position_id de los deals, NUNCA asumido == order ticket)
      ▼
EXIT DEAL(S)        (N cierres: SL / TP / manual / stop-out, 1 position → N exit deals)
      ▼
REALIZED OUTCOME    (Σ profit+commission+swap+fee de deals reales — jamás flotante)
      ▼
EXPERIENCE          (solo si CLOSED + COMPLETE — gate de aprendizaje)
```

**Invariantes (P0 §0/§2/§24)**:

| Regla | Implementación |
|---|---|
| ORDER TICKET ≠ DEAL TICKET ≠ POSITION TICKET | columnas separadas `executions.order_ticket` / `position_ticket`; deals con `deal_ticket` + referencias propias (UNIQUE por deal) |
| UNKNOWN ≠ LOSS / REJECTED / RETRY | `UNKNOWN` es estado canónico válido; sin evidencia no se calcula PnL ni se libera ni se reenvía |
| FLOATING PNL ≠ REALIZED PNL | el flotante solo es observación (`outcome_source='floating_estimate'`, `outcome_settled=0`); nunca produce experiencia ni alimenta riesgo |
| DECISION ≠ EXECUTION | 1 decisión → 0/1 execution → 1 order → N deals → 1 position → N exit deals |
| 1 decision ≠ 1 trade | la máquina de estados admite partial fills, múltiples deals y múltiples eventos de ciclo de vida |

---

## 2. Componentes

| Componente | Ubicación | Responsabilidad (y lo que NO hace) |
|---|---|---|
| **Registry** | `src/execution/registry.ts` | Identidad: `execution_id` pre-send (uuid v4), attach de order ticket, marcado REJECTED/CANCELLED/UNKNOWN. NO interpreta MT5, NO genera órdenes. |
| **ExecutionReconciler** | `src/execution/reconciler.ts` | RECONSTRUIR la verdad: carga execution → consulta live + historia MT5 → reconstruye orders/deals/posición → calcula estado + PnL realizado → persiste idempotente. Determinista, fail-closed, restart-safe, sin look-ahead, sin generar órdenes. NO es un motor de trading. |
| **Persistencia** | `src/database/sqlite.ts` (tablas `executions`, `execution_deals`, `execution_events` + columna `trade_orders.execution_id`) | Migración NO destructiva e idempotente (patrón `pragma table_info`). `trade_orders.ticket` legacy = ORDER ticket, solo compatibilidad documentada. |
| **Bridge history** | `bridge.py` | Endpoints sobre APIs REALES de MT5: `GET /history/orders`, `GET /history/deals`, `GET /history/position/<ticket>` (`history_orders_get`, `history_deals_get` con variantes `ticket=`/`position=`/rango). Protegidos con `X-AGT-Token` (fail-closed). Nada inventado. |
| **Cliente MT5** | `src/config/mt5bridge.ts` | `X-AGT-Token` en TODAS las llamadas (env `BRIDGE_TOKEN`, jamás hardcodeado/logueado). Métodos `getHistoryOrders/getHistoryDeals/getHistoryPosition`. Errores clasificables: `BRIDGE_TIMEOUT`, `BRIDGE_UNREACHABLE`, `BRIDGE_HTTP_<status>`. |
| **Settlement** | `src/agent/settlement.ts` | Capa de MANTENIMIENTO/ORQUESTACIÓN: (A) reconcilia ejecuciones pendientes vía reconciler, (B) liquida decisiones con ejecución CLOSED+COMPLETE, (C) gestiona legado pre-P0 con expiración honesta. YA NO interpreta MT5 ni usa `trade_performance`+symbol+timestamp como autoridad. |

---

## 3. Estados canónicos (P0 §4)

**`execution_status`** (qué ocurrió): `UNKNOWN` · `REJECTED` · `PENDING` · `CANCELLED` · `EXPIRED` · `PARTIALLY_FILLED` · `FILLED` · `OPEN` · `PARTIALLY_CLOSED` · `CLOSED`

**`reconciliation_status`** (cuánta evidencia hay): `PENDING_RECONCILIATION` · `COMPLETE` · `INCOMPLETE` · `UNRECONCILABLE`

Combinaciones legítimas: `CLOSED + COMPLETE` (evidencia total), `CLOSED + INCOMPLETE` (cerró pero faltan deals), `UNKNOWN + PENDING_RECONCILIATION` (esperando evidencia). La ausencia temporal de información **nunca** se convierte en un resultado falso.

**Causa de cierre** (`close_cause`, solo con evidencia): `SL_CLOSE`/`TP_CLOSE`/`MANUAL_CLOSE`(CLIENT/MOBILE/WEB/EXPERT)/`STOP_OUT`(SO)/`OTHER`(ROLLOVER/VMARGIN/SPLIT)/`UNKNOWN` — derivada del `deal_reason` REAL del último exit deal.

**PnL** (P0 §16/§17, solo evidencia de deals): `gross_pnl = Σ profit` · costes = `Σ commission + swap + fee` (entry y exit) · `realized_pnl = gross + costes` (neto). `commission`/`swap`/`fee` se preservan por separado. El flotante jamás entra aquí.

---

## 4. Reconciliación: cómo se reconstruye cada escenario (P0 §11)

`reconcileExecution(execution_id)` — seguro de llamar N veces:

1. Carga execution; fast-path si terminal+COMPLETE (idempotencia).
2. Bridge caído ⇒ termina con UNKNOWN intacto + intento contado (techo 12).
3. Si falta `order_ticket` (respuesta perdida): búsqueda determinista en `/history/orders` por **símbolo + magic 234000 + comentario `AGT-` + dirección + volumen (+ precio solo en LIMIT/STOP)**. Exactamente 1 candidato ⇒ attach; 0 o ≥2 ⇒ permanece UNKNOWN (no se adivina).
4. Historia de la orden (`ticket=`): estado → REJECTED/CANCELLED/EXPIRED/PARTIAL/FILLED.
5. `position_ticket` SIEMPRE desde evidencia (`position_id` de la orden/deal).
6. Deals de la posición (`/history/position/<t>` o fallback por `deal.order == order_ticket`) → persistidos con `INSERT OR IGNORE` (UNIQUE `deal_ticket`).
7. Clasificación con precedencia: rechazo claro → cierre total con deals → cancel/expir sin fills → parcial con orden viva → posición viva (OPEN/PARTIALLY_CLOSED) → cualquier hueco ⇒ UNKNOWN+INCOMPLETE.
8. Persistencia: UPDATE por whitelist (recomputa, nunca acumula) + eventos solo en transiciones reales.

**P0 §12 CASO CRÍTICO (response lost)**: send → MT5 acepta → respuesta perdida → `UNKNOWN + PENDING_RECONCILIATION` → **sin retry, sin liberar decisión** → reconciliación (diferida 15s + bucle de mantenimiento) → la historia revela order/deal → estado reconstruido → 0 órdenes duplicadas, 0 experiencias duplicadas.

**P0 §13/§14**: una pendiente que desaparece de `/orders` NO se da por cancelada — se consulta historia (CANCELED/EXPIRED/FILLED/PARTIAL/REJECTED). Una posición que desaparece de `/positions` NO se da por pérdida — se reconstruye por deals (SL/TP/MANUAL/STOP_OUT/OTHER/UNKNOWN).

---

## 5. UNKNOWN, idempotencia y restart-safety

- **UNKNOWN (§18)**: sin evidencia suficiente el sistema NO marca loss/win, NO genera ExperienceRecord REAL_TRADE, NO actualiza aprendizaje, NO hace retry, NO envía orden equivalente. Queda `UNKNOWN + PENDING_RECONCILIATION` y reintenta la LECTURA de evidencia en cada ciclo (techo 12 intentos → revisión humana).
- **Idempotencia (§19)**: `reconcile()` ×N ⇒ mismo estado, mismo PnL, mismos deals (`UNIQUE deal_ticket`), mismos eventos (solo transiciones), misma liquidación (`outcome_settled=1` excluye), cero experiencias duplicadas.
- **Restart-safety (§20)**: el reconciliador solo lee SQLite + MT5. La execution nace pre-send en disco: si el proceso muere tras enviar, el arranque reconstruye sin memoria en proceso. Probado con proceso hijo independiente.

---

## 6. Gate de aprendizaje (P0 §22/§35)

```
REALIZED (deals MT5) + RECONCILED (COMPLETE) + decisión sin cerrar
      ↓ (única consulta: getSettleableReconciledExecutions)
outcome_settled=1 + outcome_source='mt5_reconciled:<execution_id>'
      ↓
ExperienceRecord (evidencia con execution_id, order/position tickets, close_cause, costs)
```

Nunca crean experiencia REAL_TRADE: UNKNOWN, FLOATING, UNRECONCILED, INCOMPLETE, logs manuales (`trade_performance`).

**Riesgo diario (§25)**: `getTodayRealizedPnl()`/`getConsecutiveLosses()` se alimentan de `decision_log.outcome_*`, que a partir del P0 SOLO se escriben con PnL realizado reconciliado (o expiraciones honestas). El risk engine no se rediseñó.

---

## 7. Entornos (P0 §28)

- **LIVE/MT5**: contrato completo P0 (registry + reconciler + settlement nuevo).
- **DEMO/PAPER** (`LIVE_TRADING≠true`): sin execution record (no hay ejecución real); contrato anterior intacto.
- **SHADOW/BACKTEST/COUNTERFACTUAL/EXPERIMENT**: sin cambios.

---

## 8. Seguridad (P0 §36)

- `BRIDGE_TOKEN` por env; header `X-AGT-Token` en todas las llamadas (incluidas las históricas); sin hardcodear; sin imprimir en logs; sin exponer en errores (los bodies de error se truncan a 500 chars y jamás incluyen headers).
- Endpoints `/history/*` y `/order` exigen token (fail-closed: sin `BRIDGE_TOKEN` configurado ⇒ denegado).
- `execution_events` y logs estructurados registran execution_id/decision_id/tickets/estados/razones — sin secretos.

## 9. Cobertura de pruebas

`tests/execution_truth.test.ts` — **91 asserts, 0 fallos** contra mock bridge (serialización idéntica a bridge.py): los 30 escenarios §29 + especiales §30 (response-lost, 8 pasos), §31 (UNKNOWN sin resultado inventado), §32 (idempotencia ×10) + restart con proceso hijo (§14/§29). Suite completa del repo: verde (354 asserts, EXIT 0).
