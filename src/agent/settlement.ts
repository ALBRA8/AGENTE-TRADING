// ============================================================
// src/agent/settlement.ts — P0 EXECUTION TRUTH (§21)
// Settlement ya NO interpreta MT5: es una capa de MANTENIMIENTO y
// ORQUESTACIÓN. La verdad de ejecución la reconstruye el
// ExecutionReconciler (src/execution/reconciler.ts) desde la historia
// real de MT5 (deals como evidencia central).
//
// FASES:
//   A. RECONCILIAR: ejecuciones UNKNOWN/PENDING_RECONCILIATION → reconciler
//      (bridge caído ⇒ quedan UNKNOWN, jamás se inventa un resultado §18).
//   B. LIQUIDAR desde evidencia: decisiones EXECUTE cuya ejecución está
//      CLOSED + COMPLETE con realized_pnl derivado de deals reales
//      (profit+commission+swap+fee). ÚNICO camino al aprendizaje (§22/§35).
//   C. LEGADO: decisiones sin execution (pre-P0) — expiración honesta
//      (hueco de telemetría, nunca pérdida) y flotante como observación
//      provisional que NUNCA settlea ni genera lección (§16).
//
// ELIMINADO (§21): trade_performance + symbol + timestamp como autoridad
// de ejecución. trade_performance se conserva para otras funciones.
//
// Estados de outcome_settled:
//   0 = pendiente · 1 = settled con PnL REALIZADO reconciliado
//   2 = expirada sin datos (hueco de telemetría, no es pérdida)
//
// El bucle corre en background (startAgentMaintenance) y nunca lanza.
// ============================================================

import db, {
  getUnsettledExecuteDecisions,
  getOrderByDecisionId,
  getExecutionByDecisionId,
  getSettleableReconciledExecutions,
  getExecutionsForLadder,
  getExecutionDeals,
  getExecutionEvents,
  appendExecutionEvent,
  getStrategyContext,
  updateDecisionOutcome,
  bumpSettleAttempts,
  markDecisionExpired,
  type SettleableExecutionRow,
} from "../database/sqlite.js";
import { MT5Bridge } from "../config/mt5bridge.js";
import { reconcilePendingExecutions } from "../execution/reconciler.js";
import {
  processTpLadders,
  extractEngineStructuralTp,
  isTpLadderEnabled,
  type LadderDirection,
} from "../execution/tp_ladder.js";
import { reflectOnExperience } from "./self_improve.js";
import { consolidateMemory, type ConsolidationSummary } from "./consolidation.js";

const HORIZON_HOURS = Math.max(
  1,
  parseFloat(process.env.SETTLEMENT_HORIZON_HOURS ?? "24") || 24
);
const MAX_ATTEMPTS = 8;

export interface SettlementSummary {
  reconciled: number; // ejecuciones examinadas por el reconciliador
  resolved: number; // ejecuciones que cambiaron de estado con evidencia
  settled: number; // decisiones cerradas con PnL REALIZADO (deals MT5)
  estimated: number; // flotante provisional (observación, NUNCA settlea)
  expired: number; // huecos de telemetría (no son pérdidas)
  ladderActions: number; // P1: parciales + BE ejecutados por el TP Ladder
  details: string[];
}

/**
 * Procesa un lote de mantenimiento: reconcilia ejecuciones pendientes y
 * liquida decisiones cuya evidencia ya es CLOSED + COMPLETE.
 * Tolerante a fallos: cada decisión se procesa en su propio try/catch.
 */
export async function runSettlement(limit = 10): Promise<SettlementSummary> {
  const summary: SettlementSummary = {
    reconciled: 0,
    resolved: 0,
    settled: 0,
    estimated: 0,
    expired: 0,
    ladderActions: 0,
    details: [],
  };

  // Lock de concurrencia: el bucle, el endpoint /api/agent/settle y el tool
  // settleDecisions comparten este flag para no duplicar lecciones.
  if (maintenanceState.running) {
    summary.details.push("Settlement ya en curso — petición omitida (lock anti-duplicado)");
    return summary;
  }
  maintenanceState.running = true;

  try {
    const result = await runSettlementInner(limit, summary);
    // ── Task 10-c §3: consolidación de memoria DENTRO del mismo lock ──
    try {
      const cons = consolidateMemory();
      maintenanceState.lastConsolidationAt = new Date().toISOString();
      maintenanceState.lastConsolidation = cons;
    } catch (err) {
      console.warn(`[Settlement] consolidación falló (no crítico): ${(err as Error).message}`);
    }
    return result;
  } finally {
    maintenanceState.running = false;
  }
}

async function runSettlementInner(limit: number, summary: SettlementSummary): Promise<SettlementSummary> {

  // ── FASE A: RECONCILIAR ejecuciones pendientes (única interpretación MT5) ──
  const bridgeAlive = await MT5Bridge.health().catch(() => false);
  if (bridgeAlive) {
    try {
      const recon = await reconcilePendingExecutions(limit);
      summary.reconciled = recon.reconciled;
      summary.resolved = recon.resolved;
      summary.details.push(...recon.details);
    } catch (err) {
      summary.details.push(`Reconciliación falló (no crítico): ${(err as Error).message}`);
    }
  } else {
    // §18: bridge caído ⇒ ejecuciones siguen UNKNOWN/PENDING — sin datos
    // falsos. La reconciliación se reintentará en el próximo ciclo.
    summary.details.push("Bridge MT5 caído: reconciliación diferida (estados UNKNOWN intactos)");
  }

  // ── FASE L: TP LADDER (P1) — parciales + BE desde evidencia ──
  // El reconciler JAMÁS genera órdenes (invariante P0): la gestión de la
  // escalera vive aquí, en la capa de mantenimiento. Estado derivado de
  // evidencia en disco (exit deals + eventos) ⇒ restart-safe e idempotente.
  // Bridge caído ⇒ diferido sin estado dañado: el TP del broker (= tp3)
  // sigue acotando el trade (degradación = comportamiento pre-P1).
  if (bridgeAlive) {
    try {
      await runTpLadderPass(summary);
    } catch (err) {
      summary.details.push(`TP Ladder falló (no crítico): ${(err as Error).message}`);
    }
  } else {
    summary.details.push("Bridge MT5 caído: TP Ladder diferido (el broker TP acota el trade)");
  }

  // ── FASE B: LIQUIDAR desde ejecuciones CLOSED + COMPLETE (P0 §21/§22) ──
  await settleFromReconciledExecutions(limit, summary);

  // ── FASE C: decisiones legadas sin execution (pre-P0) ──
  await handleLegacyDecisions(limit, bridgeAlive, summary);

  return summary;
}

// ── FASE B ──────────────────────────────────────────────────

/**
 * ÚNICO camino de liquidación LIVE: ejecución CLOSED + reconciliation
 * COMPLETE + realized_pnl derivado de deals reales. La idempotencia la
 * garantiza outcome_settled=0 en el SELECT (una vez settled, no vuelve).
 */
async function settleFromReconciledExecutions(limit: number, summary: SettlementSummary): Promise<void> {
  let rows: SettleableExecutionRow[];
  try {
    rows = getSettleableReconciledExecutions(limit);
  } catch (err) {
    summary.details.push(`Error buscando ejecuciones liquidables: ${(err as Error).message}`);
    return;
  }

  for (const row of rows) {
    try {
      const pnl = Number(row.realized_pnl);
      if (!Number.isFinite(pnl)) continue; // fail-closed: sin PnL no se settlea

      updateDecisionOutcome(row.decision_id!, pnl);
      db.prepare(`UPDATE decision_log SET outcome_source = ? WHERE id = ?`).run(
        `mt5_reconciled:${row.execution_id}`,
        row.decision_id!
      );
      summary.settled++;
      summary.details.push(
        `#${row.decision_id} ${row.d_symbol}: PnL realizado ${pnl > 0 ? "+" : ""}${pnl} USD ` +
        `(evidencia MT5: order ${row.order_ticket ?? "?"} → position ${row.position_ticket ?? "?"}, ` +
        `causa ${row.close_cause ?? "UNKNOWN"}) → lección desde ejecución reconciliada`
      );

      // Reflexión con LINEAGE completo (P0 §23): la lección nace SOLO de
      // evidencia REALIZED + RECONCILED — jamás de UNKNOWN/FLOATING.
      await reflectOnExperience({
        symbol: row.d_symbol,
        setup: `orden ${row.order_type ?? row.direction ?? ""} #${row.order_ticket ?? "?"} (execution ${row.execution_id.slice(0, 8)})`,
        outcomePnl: pnl,
        userNote:
          pnl >= 0
            ? `Trade cerrado en ganancia REAL (${pnl.toFixed(2)} USD, reconstruido de deals MT5) tras decisión #${row.decision_id}.`
            : `Trade cerrado en pérdida REAL (${pnl.toFixed(2)} USD, reconstruido de deals MT5) tras decisión #${row.decision_id}. Revisar si el filtro del SOP falló o si fue riesgo de mercado normal.`,
        source: "reflection",
        evidence: {
          decision_id: row.decision_id,
          execution_id: row.execution_id,
          order_ticket: row.order_ticket,
          position_ticket: row.position_ticket,
          close_cause: row.close_cause,
          realized_pnl: pnl,
          gross_pnl: row.gross_pnl,
          commission: row.commission,
          swap: row.swap,
          fee: row.fee,
          reconciliation_status: row.reconciliation_status,
          provenance: "REAL_TRADE",
        },
        truthLevel: "OBSERVED",
        memoryType: "EPISODIC",
        confidence: evidenceConfidence(pnl, row.risk_amount),
      }).catch(() => {});
    } catch (err) {
      summary.details.push(`#${row.decision_id}: error liquidando desde ejecución: ${(err as Error).message}`);
    }
  }
}

// ── FASE C: legado pre-P0 (sin executions) ──────────────────

async function handleLegacyDecisions(
  limit: number,
  bridgeAlive: boolean,
  summary: SettlementSummary
): Promise<void> {
  let pending: Awaited<ReturnType<typeof getUnsettledExecuteDecisions>>;
  try {
    pending = getUnsettledExecuteDecisions(HORIZON_HOURS, limit);
  } catch (err) {
    summary.details.push(`Error listando decisiones pendientes: ${(err as Error).message}`);
    return;
  }

  let positions: Awaited<ReturnType<typeof MT5Bridge.getPositions>> = [];
  if (bridgeAlive) {
    positions = await MT5Bridge.getPositions().catch(() => []);
  }

  for (const dec of pending) {
    try {
      // ¿Tiene execution del sistema P0? → la FASE A/B ya se encargan;
      // aquí solo gestionamos los casos sin execution (legado) o con
      // ejecución terminal SIN posición (no hubo trade: expiración honesta).
      const execution = getExecutionByDecisionId(dec.id);

      if (execution) {
        const terminalNoPosition =
          (execution.execution_status === "REJECTED" ||
            execution.execution_status === "CANCELLED" ||
            execution.execution_status === "EXPIRED") &&
          execution.reconciliation_status === "COMPLETE";
        if (terminalNoPosition) {
          // La ejecución terminó sin abrir posición: NO es pérdida ni
          // ganancia — es una decisión que no llegó a operar.
          markDecisionExpired(dec.id, `execution_${execution.execution_status.toLowerCase()}`);
          summary.expired++;
          summary.details.push(
            `#${dec.id} ${dec.symbol}: ejecución ${execution.execution_status} sin posición → cerrada honestamente (no hubo trade)`
          );
        } else if ((dec.settle_attempts ?? 0) + 1 >= MAX_ATTEMPTS) {
          // Ejecución viva/UNKNOWN tras todo el horizonte y los intentos:
          // hueco de telemetría, JAMÁS interpretado como pérdida (§18).
          markDecisionExpired(dec.id, "execution_unresolved_max_attempts");
          summary.expired++;
          summary.details.push(
            `#${dec.id} ${dec.symbol}: ejecución ${execution.execution_status} sin resolución tras ${MAX_ATTEMPTS} intentos → expirada sin inventar resultado`
          );
        } else {
          bumpSettleAttempts(dec.id);
        }
        continue;
      }

      const order = getOrderByDecisionId(dec.id);

      // ── LEGADO: EXECUTE sin orden vinculada → falta de seguimiento ──
      if (!order) {
        if ((dec.settle_attempts ?? 0) + 1 >= MAX_ATTEMPTS) {
          markDecisionExpired(dec.id, "no_execution");
          summary.expired++;
          summary.details.push(
            `#${dec.id} ${dec.symbol}: EXECUTE sin orden asociada → cerrada como sin seguimiento`
          );
        } else {
          bumpSettleAttempts(dec.id);
        }
        continue;
      }

      // ── LEGADO: orden pre-P0 (sin execution_id) ──
      // trade_performance YA NO es autoridad (P0 §21: eliminado). Solo queda
      // la observación provisional de flotante, que NUNCA settlea ni genera
      // lección (§16: floating ≠ realized), y la expiración honesta.
      if (bridgeAlive && order.ticket) {
        const live = positions.find((p) => p.ticket === order.ticket);
        if (live) {
          // Flotante = observación provisional. outcome_settled sigue en 0:
          // no produce REALIZED, ni EXPERIENCE, ni alimentación de riesgo.
          updateDecisionOutcome(dec.id, Number(live.profit.toFixed(2)));
          db.prepare(
            `UPDATE decision_log SET outcome_settled = 0, outcome_source = 'floating_estimate' WHERE id = ?`
          ).run(dec.id);
          summary.estimated++;
          summary.details.push(
            `#${dec.id} ${dec.symbol}: orden legada #${order.ticket} viva, flotante ${live.profit > 0 ? "+" : ""}${live.profit.toFixed(2)} USD (solo observación — NUNCA settlea)`
          );
          continue;
        }

        // Posición legada cerrada sin execution P0: la historia de MT5 solo
        // es accesible vía el reconciliador, y estos tickets no tienen
        // execution_id. Hueco de telemetría honesto tras los intentos.
        if ((dec.settle_attempts ?? 0) + 1 >= MAX_ATTEMPTS) {
          markDecisionExpired(dec.id, "legacy_position_closed_no_execution");
          summary.expired++;
          summary.details.push(
            `#${dec.id} ${dec.symbol}: orden legada #${order.ticket} cerrada sin execution P0 → expirada sin datos (no inventada)`
          );
        } else {
          bumpSettleAttempts(dec.id);
        }
        continue;
      }

      // ── Bridge muerto todo el horizonte: expiración honesta ──
      if ((dec.settle_attempts ?? 0) + 1 >= MAX_ATTEMPTS) {
        markDecisionExpired(dec.id, "bridge_unavailable");
        summary.expired++;
        summary.details.push(
          `#${dec.id} ${dec.symbol}: bridge MT5 no disponible durante todo el horizonte → expirada sin datos`
        );
      } else {
        bumpSettleAttempts(dec.id);
      }
    } catch (err) {
      summary.details.push(`#${dec.id} ${dec.symbol}: error de settlement: ${(err as Error).message}`);
      bumpSettleAttempts(dec.id);
    }
  }
}

/**
 * Confianza honesta de la evidencia (MemoryDV §9): magnitud del PnL cerrado
 * respecto al riesgo planeado (R múltiplo normalizado a [0,1]).
 * Sin riesgo conocido → 0.5 (presencia de PnL real, magnitud desconocida).
 */
function evidenceConfidence(pnl: number, riskAmount?: number | null): number {
  const risk = Number(riskAmount);
  if (!Number.isFinite(risk) || risk <= 0) return 0.5;
  const c = Math.abs(pnl) / risk;
  return Math.round(Math.min(1, Math.max(0.05, c)) * 1_000) / 1_000;
}

// ── FASE L: TP LADDER (P1) ──────────────────────────────────
/**
 * Gestión de la escalera de TPs para ejecuciones con posición viva
 * (P1 aprobado por el propietario). Núcleo determinista en
 * src/execution/tp_ladder.ts; aquí solo la orquestación:
 *   1. Candidatas: ejecuciones FILLED/OPEN/PARTIALLY_* con position_ticket.
 *   2. TP estructural desde decision_log.strategy_context (solo modo
 *      source y dirección coherente — extractEngineStructuralTp).
 *   3. Evidencia: exit deals (hard) + eventos TP_LADDER_PARTIAL (éxito
 *      del executor pendiente de deal) ⇒ nivel consumido sin RAM.
 *   4. Acciones vía MT5Bridge (close_position / modify_position); el
 *      evento de éxito SOLO se persiste si el executor confirma — un
 *      fallo de red se reintenta en el próximo ciclo (fail-closed).
 */
async function runTpLadderPass(summary: SettlementSummary): Promise<void> {
  if (!isTpLadderEnabled()) return;
  const rows = getExecutionsForLadder(25);
  if (rows.length === 0) return;

  const positions = await MT5Bridge.getPositions().catch(() => []);
  const posMap = new Map(
    positions.map((p) => [
      Number(p.ticket),
      {
        ticket: Number(p.ticket),
        volume: Number(p.volume),
        currentPrice: Number(p.currentPrice),
        sl: Number(p.sl),
        tp: Number(p.tp),
      },
    ]),
  );

  const volumeRules = new Map<string, { volumeMin: number; volumeStep: number }>();
  const symbolByExecution = new Map<string, string>();
  const candidates: Array<{
    executionId: string; direction: LadderDirection; entry: number; sl: number;
    structuralTp: number | null; totalVolume: number; exitDeals: number;
    maxSuccessLevel: number; positionTicket: number;
  }> = [];

  for (const e of rows) {
    const dir: LadderDirection = String(e.direction).toUpperCase() === "SELL" ? "SELL" : "BUY";
    const structuralTp = e.decision_id
      ? extractEngineStructuralTp(getStrategyContext(e.decision_id), dir)
      : null;

    // Entrada de evidencia: primer deal entry (fill real); fallback precio solicitado.
    const deals = getExecutionDeals(e.execution_id);
    const entryDeal = deals.find((d) => d.role === "entry" && Number(d.price) > 0);
    const entry = Number(entryDeal?.price ?? e.requested_price ?? 0);
    const exitDeals = deals.filter((d) => d.role === "exit").length;

    // Niveles consumidos por eventos de éxito (deal aún no visible).
    const maxSuccessLevel = getExecutionEvents(e.execution_id)
      .filter((ev) => ev.event === "TP_LADDER_PARTIAL" && ev.evidence_json)
      .reduce((max, ev) => {
        try {
          return Math.max(max, Number((JSON.parse(ev.evidence_json as string) as { level?: number }).level) || 0);
        } catch {
          return max;
        }
      }, -1);

    candidates.push({
      executionId: e.execution_id,
      direction: dir,
      entry,
      sl: Number(e.stop_loss ?? 0),
      structuralTp,
      totalVolume: Number(e.executed_volume ?? 0),
      exitDeals,
      maxSuccessLevel,
      positionTicket: Number(e.position_ticket),
    });
    symbolByExecution.set(e.execution_id, e.symbol);

    if (!volumeRules.has(e.symbol)) {
      const info = await MT5Bridge.getSymbolInfo(e.symbol).catch(() => null);
      volumeRules.set(e.symbol, {
        volumeMin: info && info.volumeMin > 0 ? info.volumeMin : 0.01,
        volumeStep: info && info.volumeStep > 0 ? info.volumeStep : 0.01,
      });
    }
  }
  if (candidates.length === 0) return;

  const outcomes = await processTpLadders({
    candidates,
    positions: posMap,
    volumeRules,
    symbolByExecution,
    closeExecutor: (ticket, volume) => MT5Bridge.closePosition(ticket, volume),
    slExecutor: (ticket, sl) => MT5Bridge.modifyPosition(ticket, sl),
    recordEvent: (executionId, levelIndex, payload) => {
      try {
        appendExecutionEvent(executionId, "TP_LADDER_PARTIAL", {
          reason: `nivel ${levelIndex} ejecutado (P1 ladder)`,
          evidenceJson: JSON.stringify(payload),
        });
      } catch {
        // La observabilidad jamás debe romper la gestión del ladder.
      }
    },
  });

  summary.ladderActions = outcomes.filter((o) => o.applied).length;
  for (const o of outcomes) {
    if (o.applied) summary.details.push(`TP Ladder ${o.executionId}: ${o.reason}`);
    else if (o.error) {
      summary.details.push(`TP Ladder ${o.executionId} error (reintenta próximo ciclo): ${o.error}`);
    }
  }
}

// ── Bucle de mantenimiento del agente (settlement + reconciliación) ──
interface MaintenanceState {
  lastSettlementAt?: string;
  lastSettlement?: SettlementSummary;
  lastConsolidationAt?: string;
  lastConsolidation?: ConsolidationSummary;
  /** @deprecated aún leído por observability.ts (Task 8); mantener por compat */
  lastTriageAt?: string;
  running: boolean;
}

export const maintenanceState: MaintenanceState = { running: false };

let maintenanceStarted = false;

/**
 * Arranca el bucle de settlement + reconciliación en background.
 * Idempotente: llamarlo dos veces no duplica intervalos.
 */
export function startAgentMaintenance(): void {
  if (maintenanceStarted) return;
  maintenanceStarted = true;

  const intervalMin = Math.max(5, parseFloat(process.env.SETTLEMENT_INTERVAL_MIN ?? "60") || 60);

  const tick = async () => {
    try {
      const summary = await runSettlement(10);
      maintenanceState.lastSettlementAt = new Date().toISOString();
      maintenanceState.lastSettlement = summary;
      if (summary.settled + summary.expired + summary.resolved > 0) {
        console.log(
          `[Settlement] ✅ ${summary.resolved} ejecuciones resueltas de ${summary.reconciled} · ${summary.settled} settled (real) · ${summary.estimated} flotantes · ${summary.expired} expiradas`
        );
      }
    } catch (err) {
      console.warn(`[Settlement] fallo silencioso: ${(err as Error).message}`);
    }
  };

  // Primer pase a los 45s de arrancar (deja que el bot arranque primero)
  setTimeout(() => void tick(), 45_000);
  setInterval(() => void tick(), intervalMin * 60_000);
  console.log(
    `[Settlement] 🔄 Bucle activo (reconciliación P0 + settlement, horizonte ${HORIZON_HOURS}h, cada ${intervalMin}min)`
  );
}
