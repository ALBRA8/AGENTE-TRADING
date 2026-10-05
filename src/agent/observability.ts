// ============================================================
// src/agent/observability.ts
// Fase 5 – Observabilidad del agente:
//
//   Un único JSON con la foto completa del escritorio para el
//   dashboard (/api/agent/status), Telegram y reportes periódicos:
//     · Decisiones 24h/7d por tipo, tokens, latencia
//     · Settlement pendiente / expirado
//     · Lecciones y errores (auto-mejora)
//     · Config de seguridad (hard-gate, riesgo máximo, tiers)
//     · Salud de dependencias (bridge MT5, API key)
// ============================================================

import db, { getPromotedLessons } from "../database/sqlite.js";
import { MT5Bridge } from "../config/mt5bridge.js";
import { MODEL_TIERS } from "../config/nvidia.js";
import { maintenanceState } from "./settlement.js";

export interface AgentStatus {
  generatedAt: string;
  decisions: {
    last24h: number;
    last7d: number;
    last24hByAction: Record<string, number>;
    pendingSettlement: number;
    expiredNoData: number;
  };
  performance: {
    tokens24h: number;
    avgLatencyMs24h: number;
    settledWithPnl: number;
    wins: number;
    losses: number;
    winRate: number | null;
    totalPnl: number;
  };
  selfImprove: {
    lessonsTotal: number;
    lessonsVerified: number;
    lessonsPromoted: number;
    unresolvedErrorPatterns: number;
    lastTriageAt?: string;
    lastSettlementAt?: string;
    lastSettlementSummary?: string;
  };
  safety: {
    pipelineGate: boolean;
    maxRiskPct: number;
    settlementHorizonHours: number;
    models: { quick: string; deep: string };
  };
  dependencies: {
    mt5Bridge: boolean;
    nvidiaKey: boolean;
  };
}

export function getAgentStatus(_withBridgeCheck = true): AgentStatus {
  const q24 = db
    .prepare(
      `SELECT COUNT(*) as n,
              SUM(CASE WHEN final_action='EXECUTE' THEN 1 ELSE 0 END) as exec_,
              SUM(CASE WHEN final_action='WAIT' THEN 1 ELSE 0 END) as wait_,
              SUM(CASE WHEN final_action='REVIEW' THEN 1 ELSE 0 END) as rev_,
              SUM(CASE WHEN final_action='ABORTED' THEN 1 ELSE 0 END) as abort_,
              SUM(tokens_used) as tokens,
              AVG(latency_ms) as lat
       FROM decision_log WHERE created_at >= datetime('now', '-1 day')`
    )
    .get() as { n: number; exec_: number; wait_: number; rev_: number; abort_: number; tokens: number | null; lat: number | null };

  const q7 = db
    .prepare(
      `SELECT COUNT(*) as n FROM decision_log WHERE created_at >= datetime('now', '-7 day')`
    )
    .get() as { n: number };

  const qPend = db
    .prepare(
      `SELECT SUM(CASE WHEN outcome_settled = 0 THEN 1 ELSE 0 END) as pending,
              SUM(CASE WHEN outcome_settled = 2 THEN 1 ELSE 0 END) as expired,
              SUM(CASE WHEN outcome_settled = 1 THEN 1 ELSE 0 END) as settled,
              SUM(CASE WHEN outcome_settled = 1 AND outcome_pnl > 0 THEN 1 ELSE 0 END) as wins,
              SUM(CASE WHEN outcome_settled = 1 AND outcome_pnl <= 0 THEN 1 ELSE 0 END) as losses,
              SUM(CASE WHEN outcome_settled = 1 THEN outcome_pnl ELSE 0 END) as pnl
       FROM decision_log WHERE final_action = 'EXECUTE'`
    )
    .get() as { pending: number | null; expired: number | null; settled: number | null; wins: number | null; losses: number | null; pnl: number | null };

  const qLessons = db
    .prepare(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN validation_status='verified' THEN 1 ELSE 0 END) as verified
       FROM agent_lessons`
    )
    .get() as { total: number; verified: number | null };

  const qErrors = db
    .prepare(`SELECT COUNT(DISTINCT pattern_key) as n FROM agent_errors WHERE resolved = 0`)
    .get() as { n: number };

  const settled = qPend.settled ?? 0;
  const wins = qPend.wins ?? 0;

  return {
    generatedAt: new Date().toISOString(),
    decisions: {
      last24h: q24.n,
      last7d: q7.n,
      last24hByAction: {
        EXECUTE: q24.exec_ ?? 0,
        WAIT: q24.wait_ ?? 0,
        REVIEW: q24.rev_ ?? 0,
        ABORTED: q24.abort_ ?? 0,
      },
      pendingSettlement: qPend.pending ?? 0,
      expiredNoData: qPend.expired ?? 0,
    },
    performance: {
      tokens24h: q24.tokens ?? 0,
      avgLatencyMs24h: Math.round(q24.lat ?? 0),
      settledWithPnl: settled,
      wins,
      losses: qPend.losses ?? 0,
      winRate: settled ? wins / settled : null,
      totalPnl: Math.round((qPend.pnl ?? 0) * 100) / 100,
    },
    selfImprove: {
      lessonsTotal: qLessons.total,
      lessonsVerified: qLessons.verified ?? 0,
      lessonsPromoted: getPromotedLessons(100).length,
      unresolvedErrorPatterns: qErrors.n,
      lastTriageAt: maintenanceState.lastTriageAt,
      lastSettlementAt: maintenanceState.lastSettlementAt,
      lastSettlementSummary: maintenanceState.lastSettlement
        ? `${maintenanceState.lastSettlement.settled} settled · ${maintenanceState.lastSettlement.estimated} estimados · ${maintenanceState.lastSettlement.expired} expirados`
        : undefined,
    },
    safety: {
      pipelineGate: (process.env.PIPELINE_GATE ?? "on").toLowerCase() !== "off",
      maxRiskPct: Math.min(2, Math.max(0.1, parseFloat(process.env.MAX_RISK_PCT ?? "1.0")) || 1.0),
      settlementHorizonHours: Math.max(1, parseFloat(process.env.SETTLEMENT_HORIZON_HOURS ?? "24") || 24),
      models: { quick: MODEL_TIERS.quick, deep: MODEL_TIERS.deep },
    },
    dependencies: {
      mt5Bridge: false, // valor placeholder; getAgentStatusAsync lo llena con chequeo real
      nvidiaKey: Boolean(process.env.NVIDIA_API_KEY && !process.env.NVIDIA_API_KEY.startsWith("nvapi-xxx")),
    },
  };
}

/** Igual que getAgentStatus pero con chequeo real del bridge (async). */
export async function getAgentStatusAsync(): Promise<AgentStatus> {
  const status = getAgentStatus(false);
  status.dependencies.mt5Bridge = await MT5Bridge.health().catch(() => false);
  return status;
}

/** Bloque markdown compacto para Telegram / chat. */
export function renderStatusMarkdown(s: AgentStatus): string {
  const wr = s.performance.winRate === null ? "—" : `${(s.performance.winRate * 100).toFixed(0)}%`;
  return [
    `## 📡 Estado del Agente`,
    ``,
    `**Últimas 24h**: ${s.decisions.last24h} decisiones (🚀${s.decisions.last24hByAction.EXECUTE} · ⏳${s.decisions.last24hByAction.WAIT} · 🔍${s.decisions.last24hByAction.REVIEW} · 🛑${s.decisions.last24hByAction.ABORTED})`,
    `**Settlement**: ${s.decisions.pendingSettlement} pendientes · ${s.decisions.expiredNoData} sin datos`,
    `**PnL settled**: ${s.performance.totalPnl > 0 ? "+" : ""}${s.performance.totalPnl} USD · WR ${wr}`,
    `**Auto-mejora**: ${s.selfImprove.lessonsTotal} lecciones (${s.selfImprove.lessonsVerified} verificadas, ${s.selfImprove.lessonsPromoted} promovidas) · ${s.selfImprove.unresolvedErrorPatterns} errores sin resolver`,
    `**Seguridad**: hard-gate ${s.safety.pipelineGate ? "🟢 ON" : "🔴 OFF"} · riesgo máx ${s.safety.maxRiskPct}%`,
    `**Dependencias**: bridge MT5 ${s.dependencies.mt5Bridge ? "🟢" : "🔴"} · NVIDIA key ${s.dependencies.nvidiaKey ? "🟢" : "🔴"}`,
  ].join("\n");
}
