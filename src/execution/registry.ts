// ============================================================
// src/execution/registry.ts — P0 EXECUTION TRUTH
// Identidad interna de ejecución, broker-independent (P0 §3).
//
// Genealogía garantizada:
//   decision_id → execution_id (uuid v4, NUNCA derivado de tickets MT5)
//   → order_ticket → deal_tickets → position_ticket → close_deal_tickets
//
// La execution NACE ANTES del envío (pre-send): si el proceso muere justo
// después de enviar, la fila UNKNOWN + PENDING_RECONCILIATION ya está en
// SQLite → el reconciliador puede reconstruir tras reinicio (§20).
//
// Este módulo NO decide estrategias, NO genera órdenes y NO interpreta MT5:
// solo registra identidad y estados canónicos (§10).
// ============================================================

import { randomUUID } from "node:crypto";
import {
  appendExecutionEvent,
  createExecutionRow,
  getExecutionRow,
  updateExecutionRow,
  type ExecutionRow,
} from "../database/sqlite.js";
import type { ExecutionStatus, ReconciliationStatus } from "./types.js";

export interface CreateExecutionInput {
  decisionId?: number | null;
  correlationId?: string | null;
  parentExecutionId?: string | null;
  symbol: string;
  direction: string;
  orderType?: string | null;
  requestedVolume?: number | null;
  requestedPrice?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  riskAmount?: number | null;
}

/**
 * Crea la execution ANTES de enviar nada al broker.
 * Estado inicial: UNKNOWN + PENDING_RECONCILIATION (honesto: todavía no
 * sabemos qué ocurrirá). Idempotente: el mismo executionId nunca duplica.
 */
export function createExecutionForDecision(input: CreateExecutionInput): ExecutionRow {
  const executionId = randomUUID();
  createExecutionRow({
    executionId,
    decisionId: input.decisionId ?? null,
    correlationId: input.correlationId ?? null,
    parentExecutionId: input.parentExecutionId ?? null,
    symbol: input.symbol,
    direction: input.direction,
    orderType: input.orderType ?? null,
    requestedVolume: input.requestedVolume ?? null,
    requestedPrice: input.requestedPrice ?? null,
    stopLoss: input.stopLoss ?? null,
    takeProfit: input.takeProfit ?? null,
    riskAmount: input.riskAmount ?? null,
    executionStatus: "UNKNOWN",
    reconciliationStatus: "PENDING_RECONCILIATION",
  });
  appendExecutionEvent(executionId, "execution_created", {
    toStatus: "UNKNOWN",
    reconStatus: "PENDING_RECONCILIATION",
    reason: "pre-send identity (fail-closed §3/§20)",
  });
  const row = getExecutionRow(executionId);
  if (!row) throw new Error(`[ExecutionRegistry] fallo al crear execution (decision ${input.decisionId ?? "?"})`);
  return row;
}

function transition(
  executionId: string,
  toStatus: ExecutionStatus,
  recon: ReconciliationStatus,
  event: string,
  reason: string,
  extraPatch?: Record<string, unknown>
): void {
  const row = getExecutionRow(executionId);
  const from = row?.execution_status ?? "UNKNOWN";
  updateExecutionRow(executionId, {
    execution_status: toStatus,
    reconciliation_status: recon,
    ...extraPatch,
  });
  // Evento SOLO si hay transición real (idempotencia de observabilidad §19)
  if (from !== toStatus || row?.reconciliation_status !== recon) {
    appendExecutionEvent(executionId, event, {
      fromStatus: from,
      toStatus,
      reconStatus: recon,
      reason,
    });
  }
}

/** Respuesta clara del broker: adjunta el ORDER TICKET (≠ position ≠ deal). */
export function attachExecutionOrderTicket(
  executionId: string,
  orderTicket: number,
  preliminary: "PENDING" | "FILLED",
  reason: string
): void {
  transition(executionId, preliminary, "PENDING_RECONCILIATION", "order_ticket_attached", reason, {
    order_ticket: orderTicket,
  });
}

/** Rechazo CLARO (MT5 devolvió retcode/state de rechazo o 4xx del bridge). */
export function markExecutionRejected(executionId: string, reason: string): void {
  transition(executionId, "REJECTED", "COMPLETE", "execution_rejected", reason);
}

/** Cancelado ANTES de salir del proceso (p.ej. EXECUTION GUARD) — nunca enviado. */
export function markExecutionCancelledBeforeSend(executionId: string, reason: string): void {
  transition(executionId, "CANCELLED", "COMPLETE", "execution_cancelled_before_send", reason);
}

/** Expirada según evidencia de historia (ORDER_STATE_EXPIRED, sin fills). */
export function markExecutionExpired(executionId: string, reason: string): void {
  transition(executionId, "EXPIRED", "COMPLETE", "execution_expired", reason);
}

/**
 * P0 §12 CASO CRÍTICO: resultado ambiguo (timeout, conexión perdida, 5xx).
 * → UNKNOWN + PENDING_RECONCILIATION. NUNCA retry, NUNCA interpretación.
 * La decisión queda consumida; solo la reconciliación resuelve.
 */
export function markExecutionUnknown(executionId: string, reason: string): void {
  transition(executionId, "UNKNOWN", "PENDING_RECONCILIATION", "execution_unknown", reason);
}

/**
 * Programa reconciliación post-ambiente (fire-and-forget, sin retry ciego de
 * la ORDEN: lo único que se reintenta es la LECTURA de evidencia).
 */
export function scheduleReconciliation(
  executionId: string,
  reconciler: (executionId: string) => Promise<unknown>,
  delayMs = 15_000
): void {
  setTimeout(() => {
    void reconciler(executionId).catch((err: Error) => {
      console.warn(
        `[ExecutionRegistry] reconciliación diferida falló para ${executionId}: ${err.message}`
      );
    });
  }, delayMs).unref?.();
}
