// ============================================================
// src/execution/types.ts — P0 EXECUTION TRUTH
// Estados canónicos de ejecución (P0 §4) y mapeos de evidencia MT5.
//
// REGLAS (P0 §0):
//   - UNKNOWN es un estado VÁLIDO: ausencia temporal de información NO
//     se convierte en resultado falso (nunca UNKNOWN = LOSS/REJECTED/RETRY).
//   - ORDER TICKET ≠ DEAL TICKET ≠ POSITION TICKET (nunca se unifican).
//   - execution_status (qué ocurrió) se separa de
//     reconciliation_status (cuánta evidencia tenemos).
// ============================================================

/**
 * Estado de la EJECUCIÓN en el broker, reconstruido desde evidencia MT5.
 * Lista canónica del P0 §4 + EXPIRED (exigido por §13: una pendiente que
 * expira se DETERMINA desde la historia, no se asume cancelada).
 */
export type ExecutionStatus =
  | "UNKNOWN" // sin evidencia suficiente (respuesta perdida, bridge caído…)
  | "REJECTED" // rechazo CLARO por MT5 (state/retcode explícito)
  | "PENDING" // orden pendiente viva, sin fills aún
  | "CANCELLED" // cancelación CLARA (pendiente retirada sin fills)
  | "EXPIRED" // pendiente expirada por time-in-force (evidencia ORDER_STATE_EXPIRED)
  | "PARTIALLY_FILLED" // orden pendiente parcialmente llenada, sigue viva
  | "FILLED" // llenada completa (pre-reconciliación; el reconciler la refina a OPEN/CLOSED)
  | "OPEN" // posición viva sin cierres
  | "PARTIALLY_CLOSED" // posición viva con cierres parciales
  | "CLOSED"; // posición totalmente cerrada (SL/TP/manual/stop-out)

/**
 * Estado de la RECONCILIACIÓN: ¿cuánta evidencia MT5 respalda el estado?
 * CLOSED + INCOMPLETE es posible: la posición cerró pero faltan deals.
 */
export type ReconciliationStatus =
  | "PENDING_RECONCILIATION" // pendiente de reconstruir (incluye UNKNOWN inicial)
  | "COMPLETE" // genealogía completa y consistente (order+deals+posición)
  | "INCOMPLETE" // evidencia parcial (p.ej. order FILLED sin deals aún)
  | "UNRECONCILABLE"; // evidencia contradictoria — requiere intervención humana

/**
 * Causa de cierre SOLO cuando hay evidencia suficiente (P0 §8/§14):
 * se deriva del deal_reason REAL del último deal de salida. Nunca se infiere.
 */
export type CloseCause =
  | "SL_CLOSE" // DEAL_REASON_SL
  | "TP_CLOSE" // DEAL_REASON_TP
  | "MANUAL_CLOSE" // DEAL_REASON_CLIENT / MOBILE / WEB / EXPERT
  | "STOP_OUT" // DEAL_REASON_SO (forced close identificable)
  | "OTHER" // ROLLOVER / VMARGIN / SPLIT u otros
  | "UNKNOWN"; // sin evidencia suficiente

// ── Mapeos de evidencia MT5 → estados canónicos ──────────────

/**
 * ORDER_STATE de MT5 (nombre canónico del bridge) → ExecutionStatus.
 * MAPA DE EVIDENCIA, no de interpretación: cada entrada es un estado real
 * que MT5 reporta en history_orders_get().state.
 */
export function orderStateToStatus(stateName: string): ExecutionStatus {
  switch (stateName) {
    case "STARTED":
    case "PLACED":
      return "PENDING";
    case "CANCELED":
      return "CANCELLED";
    case "EXPIRED":
      return "EXPIRED";
    case "PARTIAL":
      return "PARTIALLY_FILLED";
    case "FILLED":
      return "FILLED";
    case "REJECTED":
      return "REJECTED";
    case "CALCULATED":
    case "MODIFY":
    default:
      return "UNKNOWN";
  }
}

/** DEAL_REASON de MT5 → causa de cierre (solo evidencia, P0 §8/§14). */
export function dealReasonToCloseCause(reasonName: string | null | undefined): CloseCause {
  switch (reasonName) {
    case "SL":
      return "SL_CLOSE";
    case "TP":
      return "TP_CLOSE";
    case "SO":
      return "STOP_OUT";
    case "CLIENT":
    case "MOBILE":
    case "WEB":
    case "EXPERT":
      return "MANUAL_CLOSE";
    case "ROLLOVER":
    case "VMARGIN":
    case "SPLIT":
      return "OTHER";
    default:
      return "UNKNOWN";
  }
}

/** DEAL_ENTRY de MT5 → rol del deal (0 IN, 1 OUT, 2 INOUT, 3 OUT_BY). */
export function dealEntryToRole(entryName: string | null | undefined): "entry" | "exit" {
  if (entryName === "OUT" || entryName === "OUT_BY") return "exit";
  // INOUT (reversal) cierra la posición previa: tratado como exit — si el
  // volumen no concilia, el reconciler marca INCOMPLETE (fail-closed).
  if (entryName === "INOUT") return "exit";
  return "entry";
}

/** Estados terminales: la ejecución ya no puede cambiar por sí sola. */
export function isTerminalExecutionStatus(s: ExecutionStatus): boolean {
  return s === "CLOSED" || s === "REJECTED" || s === "CANCELLED" || s === "EXPIRED";
}

/** Tolerancia numérica para conciliar volúmenes (partial fills). */
export const VOLUME_EPSILON = 1e-8;
