// ============================================================
// src/agent/settlement.ts
// Fase 2 – Settlement automático (patrón TradingAgents):
//
//   Cada decisión EXECUTE queda "abierta" hasta que su horizonte
//   vence (default 24h). Entonces este módulo:
//     1. Busca la orden real vinculada (trade_orders).
//     2. Intenta obtener el resultado con la evidencia disponible:
//        a. log manual del usuario (trade_performance) → fuente fiable
//        b. posición viva en MT5 (profit flotante) → estimación provisional
//        c. posición cerrada sin datos → hueco de telemetría (expired)
//     3. Con resultado real → llama a la reflexión (self_improve) para
//        destilar una lección y reforzar/contradecir lecciones previas.
//     4. Persistencia: outcome_pnl, outcome_settled, outcome_source.
//
//   Estados de outcome_settled:
//     0 = pendiente · 1 = settled con PnL · 2 = expirada sin datos
//
//   El bucle corre en background (startAgentMaintenance) y nunca
//   lanza: un fallo de settlement jamás rompe el trading.
// ============================================================

import db, {
  getUnsettledExecuteDecisions,
  getOrderByDecisionId,
  updateDecisionOutcome,
  bumpSettleAttempts,
  markDecisionExpired,
} from "../database/sqlite.js";
import { MT5Bridge } from "../config/mt5bridge.js";
import { reflectOnExperience } from "./self_improve.js";
import { consolidateMemory, type ConsolidationSummary } from "./consolidation.js";

const HORIZON_HOURS = Math.max(
  1,
  parseFloat(process.env.SETTLEMENT_HORIZON_HOURS ?? "24") || 24
);
const MAX_ATTEMPTS = 8;

export interface SettlementSummary {
  settled: number; // con PnL real
  estimated: number; // profit flotante (provisional)
  expired: number; // sin datos
  details: string[];
}

/**
 * Procesa un lote de decisiones EXECUTE vencidas.
 * Diseñado para ser tolerante a fallos: cada decisión se procesa
 * en su propio try/catch.
 */
export async function runSettlement(limit = 10): Promise<SettlementSummary> {
  const summary: SettlementSummary = { settled: 0, estimated: 0, expired: 0, details: [] };

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
    // Tras cerrar outcomes corremos el pipeline EVENT→…→PROMOTION. Un fallo
    // de consolidación jamás tumba el settlement (log honesto, sin relanzar).
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

  let pending: Awaited<ReturnType<typeof getUnsettledExecuteDecisions>>;
  try {
    pending = getUnsettledExecuteDecisions(HORIZON_HOURS, limit);
  } catch (err) {
    summary.details.push(`Error listando decisiones pendientes: ${(err as Error).message}`);
    return summary;
  }

  if (pending.length === 0) return summary;

  const bridgeAlive = await MT5Bridge.health().catch(() => false);
  let positions: Awaited<ReturnType<typeof MT5Bridge.getPositions>> = [];
  if (bridgeAlive) {
    positions = await MT5Bridge.getPositions().catch(() => []);
  }

  for (const dec of pending) {
    try {
      const order = getOrderByDecisionId(dec.id);

      // ── Caso 1: EXECUTE sin orden vinculada → falta de seguimiento ──
      if (!order) {
        // Le damos una oportunidad extra: quizá la orden se colocó con el
        // gate en off o por otra vía; tras MAX_ATTEMPTS lo damos por cerrado.
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

      // ── Caso 2: PnL reportado manualmente en trade_performance ──
      const manual = db
        .prepare(
          `SELECT result_pl, error_made, setup_detected FROM trade_performance
           WHERE asset = ? COLLATE NOCASE
             AND timestamp >= ?
           ORDER BY timestamp DESC LIMIT 1`
        )
        .get(dec.symbol, dec.created_at) as
        | { result_pl: number | null; error_made?: string; setup_detected?: string }
        | undefined;

      if (manual && typeof manual.result_pl === "number" && Number.isFinite(manual.result_pl)) {
        await settleWithPnl(dec, order, manual.result_pl, "performance_log", false);
        summary.settled++;
        summary.details.push(
          `#${dec.id} ${dec.symbol}: PnL ${manual.result_pl > 0 ? "+" : ""}${manual.result_pl} USD (log manual) → lección generada`
        );
        continue;
      }

      // ── Caso 3: bridge vivo → posición viva con profit flotante ──
      if (bridgeAlive && order.ticket) {
        const live = positions.find((p) => p.ticket === order.ticket);
        if (live) {
          // Posición sigue abierta tras el horizonte: estimamos con el
          // flotante pero NO la cerramos (el mercado decide, no el settlement).
          updateDecisionOutcome(dec.id, Number(live.profit.toFixed(2)));
          db.prepare(
            `UPDATE decision_log SET outcome_settled = 0, outcome_source = 'floating_estimate' WHERE id = ?`
          ).run(dec.id);
          summary.estimated++;
          summary.details.push(
            `#${dec.id} ${dec.symbol}: posición #${order.ticket} viva, flotante ${live.profit > 0 ? "+" : ""}${live.profit.toFixed(2)} USD (provisional)`
          );
          continue;
        }

        // Posición ya no está abierta: cerrada por SL/TP/manual.
        // Sin endpoint de history el PnL realizado no está disponible;
        // pedimos al usuario el dato vía reflexión (queda pendiente hasta
        // que lo reporte o venza el máximo de intentos).
        if ((dec.settle_attempts ?? 0) + 1 >= MAX_ATTEMPTS) {
          markDecisionExpired(dec.id, "position_closed_no_data");
          summary.expired++;
          summary.details.push(
            `#${dec.id} ${dec.symbol}: posición #${order.ticket} cerrada pero sin PnL reportado → expirada sin datos`
          );
        } else {
          bumpSettleAttempts(dec.id);
        }
        continue;
      }

      // ── Caso 4: bridge muerto → reintentar con límite ──
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

  return summary;
}

/**
 * Confianza honesta de la evidencia (MemoryDV §9): magnitud del PnL cerrado
 * respecto al riesgo planeado de la orden (R múltiplo normalizado a [0,1]).
 * Sin riesgo conocido → 0.5 (presencia de PnL real, magnitud desconocida).
 */
function evidenceConfidence(pnl: number, riskAmount?: number | null): number {
  const risk = Number(riskAmount);
  if (!Number.isFinite(risk) || risk <= 0) return 0.5;
  const c = Math.abs(pnl) / risk;
  return Math.round(Math.min(1, Math.max(0.05, c)) * 1_000) / 1_000;
}

/**
 * Cierra una decisión con PnL real y dispara la reflexión automática.
 * La reflexión es best-effort: si falla, el outcome ya quedó guardado.
 *
 * Task 10-c (MemoryDV §9): la lección nace CON evidencia citable
 * (decision_id, símbolo, PnL, fuente del outcome) y truth_level='OBSERVED'
 * — el PnL cerrado es un hecho observado, no una inferencia del LLM.
 */
async function settleWithPnl(
  dec: { id: number; symbol: string; direction?: string | null; risk_pct?: number | null; confidence?: number | null },
  order: { ticket?: number | null; volume?: number | null; direction?: string; risk_amount?: number | null },
  pnl: number,
  source: string,
  _provisional: boolean
): Promise<void> {
  updateDecisionOutcome(dec.id, Number(pnl.toFixed(2)));
  db.prepare(`UPDATE decision_log SET outcome_source = ? WHERE id = ?`).run(source, dec.id);

  // Reflexión automática (patrón TradingAgents: settlement → reflector)
  await reflectOnExperience({
    symbol: dec.symbol,
    setup: order ? `orden #${order.ticket ?? "?"} ${order.direction ?? dec.direction ?? ""}`.trim() : undefined,
    outcomePnl: pnl,
    userNote:
      pnl >= 0
        ? `Trade cerrado en ganancia (${pnl.toFixed(2)} USD) tras decisión #${dec.id} con confianza ${(dec.confidence ?? 0) * 100 | 0}%.`
        : `Trade cerrado en pérdida (${pnl.toFixed(2)} USD) tras decisión #${dec.id} con confianza ${(dec.confidence ?? 0) * 100 | 0}%. Revisar si el filtro del SOP falló o si fue riesgo de mercado normal.`,
    source: "reflection",
    // ── MemoryDV: evidencia + verdad observada + tipo episódico ──
    evidence: {
      decision_id: dec.id,
      symbol: dec.symbol,
      pnl: Number(pnl.toFixed(2)),
      outcome_source: source,
    },
    truthLevel: "OBSERVED",
    memoryType: "EPISODIC",
    confidence: evidenceConfidence(pnl, order?.risk_amount),
  }).catch(() => {});
}

// ── Bucle de mantenimiento del agente (Fase 2 + 5 + consolidación §3) ──
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
 * Arranca el bucle de settlement + triage en background.
 * Idempotente: llamarlo dos veces no duplica intervalos.
 */
export function startAgentMaintenance(): void {
  if (maintenanceStarted) return;
  maintenanceStarted = true;

  const intervalMin = Math.max(5, parseFloat(process.env.SETTLEMENT_INTERVAL_MIN ?? "60") || 60);

  const tick = async () => {
    // El lock de concurrencia vive dentro de runSettlement (compartido con
    // el endpoint y el tool); la consolidación §3 corre DENTRO de ese lock
    // (ver runSettlement). Aquí solo registramos el resultado.
    try {
      const summary = await runSettlement(10);
      maintenanceState.lastSettlementAt = new Date().toISOString();
      maintenanceState.lastSettlement = summary;
      if (summary.settled + summary.expired > 0) {
        console.log(
          `[Settlement] ✅ ${summary.settled} settled · ${summary.estimated} estimados · ${summary.expired} expirados`
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
    `[Settlement] 🔄 Bucle de settlement activo (horizonte ${HORIZON_HOURS}h, cada ${intervalMin}min)`
  );
}
