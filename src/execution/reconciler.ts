// ============================================================
// src/execution/reconciler.ts — P0 EXECUTION TRUTH
// ExecutionReconciler (§10/§11): reconstruye LA VERDAD DE EJECUCIÓN
// desde evidencia MT5 (live + historia).
//
// GARANTÍAS:
//   - determinista: mismo input (DB + MT5) → mismo estado final
//   - idempotente (§19): reconcile() xN produce el mismo estado, mismo
//     PnL, mismos deals (UNIQUE deal_ticket), mismos eventos (solo
//     transiciones), cero experiencias duplicadas
//   - fail-closed (§12/§18): sin evidencia suficiente ⇒ UNKNOWN +
//     PENDING_RECONCILIATION. NUNCA UNKNOWN=LOSS/REJECTED/RETRY.
//   - restart-safe (§20): solo lee DB + MT5; nada de memoria en proceso
//   - sin look-ahead: ventana temporal acotada por created_at/now
//   - NO genera órdenes, NO decide estrategia, NO toca el aprendizaje
//     (el gate REALIZED+RECONCILED vive en settlement.ts §22)
//   - NO asume ORDER TICKET = DEAL TICKET = POSITION TICKET (§6): el
//     position_ticket SIEMPRE viene de la evidencia (position_id).
// ============================================================

import {
  appendExecutionEvent,
  bumpReconAttempts,
  getExecutionDeals,
  getExecutionRow,
  insertExecutionDeal,
  updateExecutionRow,
  type ExecutionRow,
} from "../database/sqlite.js";
import { MT5Bridge, type MT5HistoryDeal, type MT5HistoryOrder } from "../config/mt5bridge.js";
import {
  dealEntryToRole,
  dealReasonToCloseCause,
  orderStateToStatus,
  VOLUME_EPSILON,
  type ExecutionStatus,
  type ReconciliationStatus,
} from "./types.js";

/** Magic usado por el bridge al enviar órdenes (bridge.py request_data). */
const AGENT_MAGIC = 234000;
/** Prefijo de comentario que identifica órdenes del agente (execute_trade_mt5). */
const AGENT_COMMENT_PREFIX = "AGT-";

export interface ReconcileResult {
  executionId: string;
  before: { executionStatus: string; reconciliationStatus: string };
  after: { executionStatus: string; reconciliationStatus: string };
  changed: boolean;
  realizedPnl: number | null;
  reason: string;
}

// ── Utilidades ──────────────────────────────────────────────

/** SQLite UTC "YYYY-MM-DD HH:MM:SS" → epoch segundos. */
function sqliteUtcToEpoch(s: string): number {
  const t = Date.parse(s.includes("T") ? s : s.replace(" ", "T") + "Z");
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function directionMatches(orderType: string, direction: string): boolean {
  const t = (orderType ?? "").toUpperCase();
  const d = (direction ?? "").toUpperCase();
  if (d === "LONG" || d === "BUY") return t.startsWith("BUY");
  if (d === "SHORT" || d === "SELL") return t.startsWith("SELL");
  return false;
}

// ── Persistencia de deals (evidencia, idempotente §19) ──────

function persistDealsAsEvidence(
  executionId: string,
  orderTicket: number,
  deals: MT5HistoryDeal[]
): { entryCount: number; exitCount: number; newDeals: number } {
  let entryCount = 0;
  let exitCount = 0;
  let newDeals = 0;
  for (const d of deals) {
    const role = dealEntryToRole(d.entryName);
    if (role === "entry") entryCount++;
    else exitCount++;
    const inserted = insertExecutionDeal({
      executionId,
      dealTicket: d.ticket,
      orderTicket: d.order || orderTicket,
      positionTicket: d.positionId || null,
      role,
      symbol: d.symbol ?? null,
      direction: d.type ?? null,
      volume: d.volume,
      price: d.price,
      profit: d.profit,
      commission: d.commission,
      swap: d.swap,
      fee: d.fee,
      dealEntry: d.entry,
      dealReason: d.reason,
      closeCause: role === "exit" ? dealReasonToCloseCause(d.reasonName) : null,
      dealTime: d.time,
      timeMsc: d.timeMsc,
      rawJson: JSON.stringify(d),
    });
    if (inserted) newDeals++;
  }
  return { entryCount, exitCount, newDeals };
}

// ── P0 §12: resolución de order_ticket tras respuesta perdida ──

/**
 * Búsqueda DETERMINISTA en la historia: la orden del agente se identifica
 * por símbolo + magic + prefijo de comentario + dirección + volumen (+ precio
 * si la petición fue LIMIT/STOP). Solo UN candidato único ⇒ attach.
 * 0 o ≥2 candidatos ⇒ null (fail-closed: NO se adivina).
 */
async function findOrderTicketForUnknownExecution(exec: ExecutionRow): Promise<number | null> {
  const createdEpoch = sqliteUtcToEpoch(exec.created_at);
  const fromEpoch = createdEpoch - 120; // tolerancia mínima de reloj
  const toEpoch = Math.floor(Date.now() / 1000) + 60;

  const orders = await MT5Bridge.getHistoryOrders({ fromEpoch, toEpoch });
  const candidates = orders.filter((o) => {
    if (o.symbol !== exec.symbol) return false;
    if (o.magic !== AGENT_MAGIC) return false;
    if (!(o.comment ?? "").startsWith(AGENT_COMMENT_PREFIX)) return false;
    if (!directionMatches(o.type, exec.direction)) return false;
    if (
      exec.requested_volume !== null &&
      exec.requested_volume !== undefined &&
      Math.abs(o.volumeInitial - exec.requested_volume) > Math.max(VOLUME_EPSILON, exec.requested_volume * 1e-6)
    ) {
      return false;
    }
    // El precio SOLO concilia para pendientes (LIMIT/STOP): en órdenes a
    // mercado el precio de fill REAL puede desviarse del solicitado — usarlo
    // como filtro rompería el matching (fail-closed sin falsos negativos).
    const isPendingType = /LIMIT|STOP/.test((exec.order_type ?? "").toUpperCase());
    if (
      isPendingType &&
      exec.requested_price !== null && exec.requested_price !== undefined && exec.requested_price > 0 &&
      Math.abs(o.priceOpen - exec.requested_price) > Math.max(Math.abs(o.priceOpen) * 0.001, 1e-8)
    ) {
      return false;
    }
    return true;
  });

  const uniqueTickets = [...new Set(candidates.map((c) => c.ticket))];
  return uniqueTickets.length === 1 ? uniqueTickets[0] : null;
}

// ── Cálculo de resultado realizado (§16/§17, solo evidencia) ──

interface DealTotals {
  executedVolume: number;
  closedVolume: number;
  grossPnl: number;
  commission: number;
  swap: number;
  fee: number;
  netRealized: number;
  firstEntryTime: string | null;
  lastExitTime: string | null;
  lastExitCause: ReturnType<typeof dealReasonToCloseCause>;
}

function computeDealTotals(
  deals: Array<{
    role: "entry" | "exit";
    volume: number | null;
    profit: number | null;
    commission: number | null;
    swap: number | null;
    fee: number | null;
    close_cause: string | null;
    deal_time: string | null;
  }>
): DealTotals {
  const t: DealTotals = {
    executedVolume: 0,
    closedVolume: 0,
    grossPnl: 0,
    commission: 0,
    swap: 0,
    fee: 0,
    netRealized: 0,
    firstEntryTime: null,
    lastExitTime: null,
    lastExitCause: "UNKNOWN",
  };
  // Orden determinista por deal_time para first/last (los deals llegan ordenados).
  for (const d of deals) {
    const vol = Number(d.volume ?? 0);
    const profit = Number(d.profit ?? 0);
    const commission = Number(d.commission ?? 0);
    const swap = Number(d.swap ?? 0);
    const fee = Number(d.fee ?? 0);
    if (d.role === "entry") {
      t.executedVolume += vol;
      if (!t.firstEntryTime && d.deal_time) t.firstEntryTime = d.deal_time;
    } else {
      t.closedVolume += vol;
      if (d.deal_time) t.lastExitTime = d.deal_time;
      if (d.close_cause && d.close_cause !== "UNKNOWN") t.lastExitCause = d.close_cause as DealTotals["lastExitCause"];
    }
    // Costes de TODOS los deals (entry+exit) y profit de los exit forman el
    // realizado neto — igual que el historial de MT5 (P0 §17).
    t.grossPnl += profit;
    t.commission += commission;
    t.swap += swap;
    t.fee += fee;
    t.netRealized += profit + commission + swap + fee;
  }
  return t;
}

// ── RECONCILIADOR ───────────────────────────────────────────

/**
 * reconstruye la verdad de una execution. Seguro de llamar N veces.
 * Nunca lanza hacia el llamador de mantenimiento: los errores se registran
 * en la propia execution (recon_attempts / last_recon_error).
 */
export async function reconcileExecution(executionId: string): Promise<ReconcileResult> {
  const exec = getExecutionRow(executionId);
  if (!exec) {
    throw new Error(`[ExecutionReconciler] execution ${executionId} no existe`);
  }

  const before = {
    executionStatus: exec.execution_status,
    reconciliationStatus: exec.reconciliation_status,
  };
  const unchanged = (reason: string, realized: number | null = exec.realized_pnl): ReconcileResult => ({
    executionId,
    before,
    after: before,
    changed: false,
    realizedPnl: realized,
    reason,
  });

  // ── Fast-path idempotente: terminal + COMPLETE ⇒ nada que hacer (§19) ──
  const terminal = ["CLOSED", "REJECTED", "CANCELLED", "EXPIRED"] as string[];
  if (terminal.includes(exec.execution_status) && exec.reconciliation_status === "COMPLETE") {
    return unchanged("terminal_execution_already_complete");
  }

  // ── Bridge caído: UNKNOWN legítimo, sin inventar nada (§18) ──
  const bridgeAlive = await MT5Bridge.health().catch(() => false);
  if (!bridgeAlive) {
    bumpReconAttempts(executionId, "bridge_unavailable");
    return unchanged("bridge_unavailable");
  }

  try {
    return await reconcileInner(exec, executionId, before);
  } catch (err) {
    bumpReconAttempts(executionId, (err as Error).message);
    return unchanged(`reconcile_error: ${(err as Error).message}`);
  }
}

async function reconcileInner(
  exec: ExecutionRow,
  executionId: string,
  before: { executionStatus: string; reconciliationStatus: string }
): Promise<ReconcileResult> {
  let orderTicket = exec.order_ticket;
  let matchedFromHistory = false;

  // ── 1. Resolver ORDER TICKET si falta (P0 §12: respuesta perdida) ──
  if (!orderTicket) {
    const found = await findOrderTicketForUnknownExecution(exec);
    if (found === null) {
      // Sin evidencia suficiente ⇒ UNKNOWN + PENDING_RECONCILIATION (fail-closed).
      // NO se interpreta como rechazo ni como pérdida. Se reintenta después.
      bumpReconAttempts(executionId, "order_not_uniquely_identified_in_history");
      return {
        executionId,
        before,
        after: before,
        changed: false,
        realizedPnl: exec.realized_pnl,
        reason: "order_not_uniquely_identified_in_history (0 o >1 candidatos)",
      };
    }
    orderTicket = found;
    matchedFromHistory = true;
    updateExecutionRow(executionId, { order_ticket: found });
    appendExecutionEvent(executionId, "order_matched_from_history", {
      toStatus: exec.execution_status,
      reconStatus: exec.reconciliation_status,
      reason: `order_ticket ${found} identificado por evidencia (symbol+magic+comment+volume+price)`,
      evidenceJson: JSON.stringify({ order_ticket: found }),
    });
  }

  // ── 2. Orden en historia (intención del broker) ──
  const createdEpoch = sqliteUtcToEpoch(exec.created_at);
  const histOrders = await MT5Bridge.getHistoryOrders({
    ticket: orderTicket,
    fromEpoch: createdEpoch - 86_400,
    toEpoch: Math.floor(Date.now() / 1000) + 3_600,
  });
  const histOrder: MT5HistoryOrder | undefined = histOrders.find((o) => o.ticket === orderTicket);

  // ── 2b. ¿Orden pendiente VIVA (aún no en historia)? ──
  if (!histOrder) {
    const livePending = await MT5Bridge.getPendingOrders().catch(() => []);
    const live = livePending.find((o) => o.ticket === orderTicket);
    if (live) {
      // Evidencia sólida de que sigue pendiente: no expiró, no se canceló
      // (P0 §13: la desaparición de /orders NO se interpreta; aquí SIGUE).
      const next = "PENDING" as ExecutionStatus;
      updateExecutionRow(executionId, {
        execution_status: next,
        recon_attempts: 0, // progreso: el techo de intentos solo aplica a fallos
      });
      appendExecutionEvent(executionId, "order_live_pending", {
        fromStatus: before.executionStatus,
        toStatus: next,
        reconStatus: "PENDING_RECONCILIATION",
        reason: "orden pendiente viva en /orders (aún sin historia)",
      });
      return {
        executionId,
        before,
        after: { executionStatus: next, reconciliationStatus: "PENDING_RECONCILIATION" },
        changed: before.executionStatus !== next,
        realizedPnl: null,
        reason: "orden pendiente viva",
      };
    }
    // Ni historia ni live: evidencia insuficiente (§13 — NO asumir cancelada).
    bumpReconAttempts(executionId, `order_ticket ${orderTicket} sin evidencia live ni historia`);
    return {
      executionId,
      before,
      after: before,
      changed: false,
      realizedPnl: exec.realized_pnl,
      reason: "order sin evidencia (live+historia)",
    };
  }

  // ── 3. POSITION TICKET desde EVIDENCIA (nunca == order ticket por asunción) ──
  let positionTicket = exec.position_ticket ?? (histOrder.positionId > 0 ? histOrder.positionId : null);

  // ── 4. Deals de la posición (evidencia central §2) ──
  let deals: MT5HistoryDeal[] = [];
  if (positionTicket) {
    const pos = await MT5Bridge.getHistoryPosition(positionTicket);
    if (pos) deals = pos.deals;
  }
  if (deals.length === 0) {
    // Fallback por ORDEN: deals cuyo campo order == order_ticket (API real).
    const windowDeals = await MT5Bridge.getHistoryDeals({
      fromEpoch: createdEpoch - 86_400,
      toEpoch: Math.floor(Date.now() / 1000) + 3_600,
    });
    deals = windowDeals.filter((d) => d.order === orderTicket);
  }
  if (deals.length > 0 && !positionTicket) {
    // position_ticket derivado de EVIDENCIA (position_id del deal real)
    const pid = deals.find((d) => d.positionId > 0)?.positionId;
    if (pid) {
      positionTicket = pid;
    }
  }

  const ev = persistDealsAsEvidence(executionId, orderTicket, deals);

  // ── 5. Estado de la ORDEN desde historia ──
  const orderStatus = orderStateToStatus(histOrder.stateName);
  const totals = computeDealTotals(getExecutionDeals(executionId));

  // ── 6. Posición viva (check live) ──
  const livePositions = await MT5Bridge.getPositions().catch(() => [] as Array<{ ticket: number }>);
  const livePosition = positionTicket
    ? livePositions.find((p) => p.ticket === positionTicket)
    : undefined;

  // ── 7. Clasificación canónica (§4/§8/§13/§14) ──
  // Orden de precedencia (cada regla = evidencia, nunca interpretación):
  //   1. rechazo claro sin fills
  //   2. cierre total con evidencia de deals (aunque la orden diga otra cosa)
  //   3. cancel/expir claro sin fills (P0 §13: viene de la HISTORIA)
  //   4. orden pendiente PARCIALMENTE llenada y aún viva
  //   5. posición viva → OPEN / PARTIALLY_CLOSED (§14: nunca asumir pérdida)
  //   6-8. cualquier hueco ⇒ UNKNOWN + INCOMPLETE (fail-closed)
  let nextStatus: ExecutionStatus;
  let nextRecon: ReconciliationStatus;
  let closeCause: string | null = null;
  let closedAt: string | null = null;
  let openedAt: string | null = null;
  let realized: number | null = null;
  let reason: string;

  if (orderStatus === "REJECTED" && totals.executedVolume <= VOLUME_EPSILON) {
    nextStatus = "REJECTED";
    nextRecon = "COMPLETE";
    reason = `order state REJECTED (retcode ${histOrder.retcode}) sin fills`;
  } else if (
    totals.executedVolume > VOLUME_EPSILON &&
    totals.closedVolume >= totals.executedVolume - VOLUME_EPSILON
  ) {
    // Posición TOTALMENTE cerrada CON evidencia completa de deals.
    nextStatus = "CLOSED";
    nextRecon = "COMPLETE";
    closeCause = totals.lastExitCause;
    closedAt = totals.lastExitTime;
    openedAt = totals.firstEntryTime;
    realized = round2(totals.netRealized);
    reason = `cerrada por evidencia: ${ev.exitCount} exit deal(s), causa ${closeCause}`;
  } else if (
    (orderStatus === "CANCELLED" || orderStatus === "EXPIRED") &&
    totals.executedVolume <= VOLUME_EPSILON
  ) {
    // P0 §13: la determinación viene de la HISTORIA (no de la desaparición).
    nextStatus = orderStatus; // CANCELLED | EXPIRED
    nextRecon = "COMPLETE";
    reason = `order state ${histOrder.stateName} sin fills (evidencia de historia)`;
  } else if (orderStatus === "PARTIALLY_FILLED") {
    // Orden pendiente aún viva con fill parcial (histórico state PARTIAL).
    nextStatus = "PARTIALLY_FILLED";
    nextRecon = "PENDING_RECONCILIATION";
    openedAt = totals.firstEntryTime;
    realized = round2(totals.netRealized);
    reason = `orden parcialmente llenada (${totals.executedVolume}/${histOrder.volumeInitial})`;
  } else if (livePosition) {
    // Posición VIVA: OPEN o PARTIALLY_CLOSED (§14: nunca asumir pérdida).
    nextStatus = totals.closedVolume > VOLUME_EPSILON ? "PARTIALLY_CLOSED" : "OPEN";
    nextRecon = "PENDING_RECONCILIATION"; // sigue evolucionando hasta terminal
    openedAt = totals.firstEntryTime;
    realized = round2(totals.netRealized); // realizado HASTA AHORA (evidencia)
    reason = `posición ${positionTicket} viva (deals: ${ev.entryCount} entry / ${ev.exitCount} exit)`;
  } else if (orderStatus === "FILLED" && totals.executedVolume <= VOLUME_EPSILON) {
    // Order FILLED pero deals aún no visibles: evidencia INCOMPLETA (§27/§28).
    nextStatus = "UNKNOWN";
    nextRecon = "INCOMPLETE";
    reason = "order FILLED sin deals en historia (lag de sincronización) — sin inventar fills";
  } else if (totals.executedVolume > VOLUME_EPSILON) {
    // Posición no viva, cierre sin evidencia completa: fail-closed (§14).
    nextStatus = "UNKNOWN";
    nextRecon = "INCOMPLETE";
    reason = `ejecutado ${totals.executedVolume} vs cerrado ${totals.closedVolume} sin posición viva — evidencia insuficiente`;
  } else {
    nextStatus = "UNKNOWN";
    nextRecon = "INCOMPLETE";
    reason = `sin evidencia suficiente (order state ${histOrder.stateName}, 0 deals)`;
  }

  // ── 8. Persistencia IDEMPOTENTE: recomputar, nunca acumular (§19) ──
  const patch: Record<string, unknown> = {
    execution_status: nextStatus,
    reconciliation_status: nextRecon,
    position_ticket: positionTicket ?? null,
    executed_volume: totals.executedVolume > 0 ? totals.executedVolume : null,
    closed_volume: totals.closedVolume > 0 ? totals.closedVolume : null,
    realized_pnl: realized,
    gross_pnl: totals.grossPnl !== 0 ? round2(totals.grossPnl) : null,
    commission: totals.commission !== 0 ? round2(totals.commission) : null,
    swap: totals.swap !== 0 ? round2(totals.swap) : null,
    fee: totals.fee !== 0 ? round2(totals.fee) : null,
    close_cause: closeCause,
    opened_at: openedAt,
    closed_at: closedAt,
    reconciled_at: new Date().toISOString().replace("T", " ").slice(0, 19),
    recon_attempts: nextRecon === "PENDING_RECONCILIATION" ? 0 : exec.recon_attempts, // progreso resetea el techo
  };
  if (matchedFromHistory) patch.order_ticket = orderTicket;
  updateExecutionRow(executionId, patch);

  const from = before.executionStatus;
  if (from !== nextStatus || before.reconciliationStatus !== nextRecon) {
    appendExecutionEvent(executionId, "execution_reconciled", {
      fromStatus: from,
      toStatus: nextStatus,
      reconStatus: nextRecon,
      reason,
      evidenceJson: JSON.stringify({
        order_ticket: orderTicket,
        position_ticket: positionTicket,
        order_state: histOrder.stateName,
        entry_deals: ev.entryCount,
        exit_deals: ev.exitCount,
        new_deals: ev.newDeals,
        executed_volume: totals.executedVolume,
        closed_volume: totals.closedVolume,
        realized_pnl: realized,
        close_cause: closeCause,
      }),
    });
  }

  return {
    executionId,
    before,
    after: { executionStatus: nextStatus, reconciliationStatus: nextRecon },
    changed: from !== nextStatus || before.reconciliationStatus !== nextRecon,
    realizedPnl: realized,
    reason,
  };
}

/**
 * Reconcilia TODAS las ejecuciones pendientes (mantenimiento/settlement).
 * Tolerante a fallos: cada execution en su propio try/catch.
 */
export async function reconcilePendingExecutions(
  limit = 10
): Promise<{ reconciled: number; resolved: number; details: string[] }> {
  const { getExecutionsPendingReconciliation } = await import("../database/sqlite.js");
  const pending = getExecutionsPendingReconciliation(limit);
  const details: string[] = [];
  let resolved = 0;
  for (const p of pending) {
    try {
      const r = await reconcileExecution(p.execution_id);
      if (r.changed) {
        resolved++;
        details.push(
          `${p.execution_id.slice(0, 8)}…: ${r.before.executionStatus} → ${r.after.executionStatus} (${r.reason})`
        );
      }
    } catch (err) {
      details.push(`${p.execution_id.slice(0, 8)}…: error: ${(err as Error).message}`);
    }
  }
  return { reconciled: pending.length, resolved, details };
}
