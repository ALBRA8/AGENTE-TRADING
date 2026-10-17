# 03 — P0 EXECUTION TRUTH

## Estado

**P0 PASS — implementado en commit `bc3d24b7713950081b4113b483fe26f98c10b01a`.**

Objetivo: convertir la ejecución MT5 en una fuente de verdad reconstruible, determinista, idempotente, fail-closed y restart-safe.

## Contrato canónico

`decision_id → execution_id → order_ticket → deal_ticket(s) → position_ticket → exit_deal_ticket(s) → realized outcome → reconciliation → Experience`

## Identidad

`execution_id`:

- UUID v4;
- broker-independent;
- creado antes del envío;
- nunca derivado de tickets MT5;
- persistido en SQLite.

## Estados

- UNKNOWN
- REJECTED
- PENDING
- CANCELLED
- PARTIALLY_FILLED
- FILLED
- OPEN
- PARTIALLY_CLOSED
- CLOSED
- EXPIRED

Separación:

`execution_status`

vs.

`reconciliation_status`

## Regla de tickets

`ORDER TICKET ≠ DEAL TICKET ≠ POSITION TICKET`

Una decisión puede producir cero, una o múltiples ejecuciones/deals durante su ciclo de vida.

## Bridge MT5

Se añadieron capacidades históricas basadas en APIs reales de MetaTrader5:

- `/history/orders`
- `/history/deals`
- `/history/position/<ticket>`

Usan `history_orders_get` y `history_deals_get`.

Los endpoints históricos requieren `X-AGT-Token`.

## Cliente MT5

`src/config/mt5bridge.ts` envía `X-AGT-Token` en las llamadas necesarias y expone acceso a historia.

Errores clasificables incluyen:

- `BRIDGE_TIMEOUT`
- `BRIDGE_UNREACHABLE`
- `BRIDGE_HTTP_<status>`

## Persistencia

Se implementaron:

- `executions`
- `execution_deals`
- `execution_events`
- `trade_orders.execution_id`

con deduplicación de order/deal y helpers idempotentes.

El campo legacy `trade_orders.ticket` permanece como compatibilidad y representa ORDER ticket.

## ExecutionReconciler

Ubicación:

`src/execution/reconciler.ts`

Responsabilidades:

- reconstruir ejecución desde DB + MT5;
- resolver order ticket cuando la respuesta se pierde;
- consultar live + historia;
- persistir deals como evidencia;
- reconstruir position ticket desde evidencia;
- clasificar estado;
- calcular resultado realizado desde deals reales;
- ser idempotente;
- ser restart-safe;
- fail-closed;
- no generar órdenes;
- no decidir estrategia;
- no tocar directamente el aprendizaje.

## Matching de respuesta perdida

Cuando falta `order_ticket`, se busca de forma determinista mediante:

- symbol;
- magic `234000`;
- comentario con prefijo `AGT-`;
- dirección;
- volumen;
- precio para pendientes cuando aplica.

0 candidatos o múltiples candidatos ⇒ no adivinar.

Existe una dependencia operativa documentada: cambiar magic/prefijo requiere actualizar el matcher.

## Realized PnL

El resultado realizado se reconstruye desde deals reales:

`Σ(profit + commission + swap + fee)`

Se distingue de floating PnL.

`FLOATING PNL ≠ REALIZED PNL`

Floating puede observarse provisionalmente, pero no liquida ni crea aprendizaje REAL_TRADE.

## UNKNOWN

`UNKNOWN ≠ LOSS`

`UNKNOWN ≠ REJECTED`

`UNKNOWN ≠ RETRY`

Cuando falta evidencia:

`UNKNOWN + PENDING_RECONCILIATION`

No:

- win;
- loss;
- PnL inventado;
- experiencia;
- aprendizaje;
- retry ciego.

## Response lost

Escenario crítico:

`SEND ORDER → respuesta perdida → UNKNOWN → NO REENVÍO → consultar MT5 → reconstruir`

Esto está cubierto por tests.

## Pending

La desaparición de una pending order de `/orders` no implica cancelación.

Se consulta historia para distinguir:

- FILLED
- PARTIALLY_FILLED
- CANCELLED
- EXPIRED
- REJECTED
- UNKNOWN

## Position closure

Si una posición desaparece de `/positions`, se consulta historia.

Cuando existe evidencia suficiente se clasifica causa:

- SL
- TP
- manual
- stop-out
- otra causa identificable
- UNKNOWN

## Partial fills

Se soportan múltiples entry deals y múltiples exit deals.

No se sobrescribe el primer deal.

## Settlement

`src/agent/settlement.ts` quedó como mantenimiento/orquestación:

FASE A: reconciliar

FASE B: liquidar únicamente `CLOSED + COMPLETE`

FASE C: legado honesto

Se eliminó `trade_performance + symbol + timestamp` como autoridad de ejecución real.

## Learning boundary

Solo:

`REALIZED + RECONCILED + SUFFICIENT EVIDENCE`

puede producir `ExperienceRecord` con provenance `REAL_TRADE`.

## Idempotencia

Reconciliar una ejecución 1, 10 o más veces debe conservar el mismo snapshot semántico y no duplicar:

- deals;
- PnL;
- experiencias;
- aprendizaje;
- eventos de transición.

## Restart safety

Execution nace antes del envío y queda persistida.

El reconciliador reconstruye usando DB + MT5, sin depender de memoria del proceso anterior.

## Tests reportados

- 30 escenarios P0;
- response lost;
- UNKNOWN;
- reconcile ×10;
- restart con proceso hijo;
- 91 asserts nuevos;
- suite completa reportada: 354 tests/asserts verdes;
- npm audit: 0 vulnerabilidades reportadas;
- typecheck conserva errores preexistentes en `src/backtest/`, fuera del alcance P0.

## Deuda fuera de P0

- `saveBacktestRunManifest` con ON CONFLICT update;
- consolidación completa;
- Strategy Evolution;
- órdenes legacy anteriores a P0 sin execution_id;
- typecheck existente en backtest.

## Regla

No avanzar a Strategy Evolution basándose solamente en tests sintéticos. Primero validar P0 en MT5 real/SHADOW y observar `execution_events` durante un periodo suficiente.
