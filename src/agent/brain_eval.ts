// ============================================================
// src/agent/brain_eval.ts
// Fase 4 – Evaluación del cerebro (patrón backtest de TradingAgents,
// aplicado a las decisiones REALES del pipeline):
//
//   Responde la pregunta de negocio: "¿este agente decide bien?"
//   con un Brain Score compuesto (0-100) y evidencia por componente:
//
//     · Disciplina (30)   → % de decisiones EXECUTE con filtros limpios
//     · Calibración (25)  → ¿la confianza predice el resultado?
//     · Seguimiento (15)  → % de EXECUTE que terminaron en orden real
//     · Aprendizaje (20)  → lecciones capturadas, verificadas, promovidas
//     · Operativa (10)    → errores recurrentes sin resolver
//
//   Guarda snapshots (brain_evaluations) para ver la tendencia del
//   score a lo largo del tiempo → el argumento de venta medible.
// ============================================================

import db, {
  getPromotedLessons,
  getUnresolvedErrors,
} from "../database/sqlite.js";
import { extractJson } from "./self_improve.js";

export interface BrainReport {
  score: number;
  components: {
    discipline: { score: number; max: number; detail: string };
    calibration: { score: number; max: number; detail: string };
    followThrough: { score: number; max: number; detail: string };
    learning: { score: number; max: number; detail: string };
    operational: { score: number; max: number; detail: string };
  };
  stats: {
    totalDecisions: number;
    byAction: Record<string, number>;
    gateHistogram: Record<string, number>;
    executes: number;
    settled: number;
    wins: number;
    losses: number;
    winRate: number | null;
    totalPnl: number;
    avgConfidenceWin: number | null;
    avgConfidenceLoss: number | null;
    followThroughRate: number | null;
    noExecution: number;
    lessons: { total: number; verified: number; pending: number; promoted: number; dedupedSeen: number };
    errors: { unresolvedPatterns: number; totalInstances: number };
    tokens: { total: number; avgPerDecision: number };
    latency: { avgMs: number };
  };
  verdict: string;
}

interface GateLike {
  name: string;
  status: string;
}

export function evaluateBrain(): BrainReport {
  // ── 1. Decisiones ──
  const rows = db
    .prepare(
      `SELECT id, final_action, direction, confidence, gates_json,
              outcome_pnl, outcome_settled, outcome_source, tokens_used, latency_ms
       FROM decision_log ORDER BY id ASC`
    )
    .all() as Array<{
    id: number;
    final_action: string;
    direction?: string | null;
    confidence?: number | null;
    gates_json?: string | null;
    outcome_pnl?: number | null;
    outcome_settled?: number;
    outcome_source?: string | null;
    tokens_used?: number;
    latency_ms?: number;
  }>;

  const byAction: Record<string, number> = {};
  const gateHistogram: Record<string, number> = {};
  let cleanExecutes = 0;
  let tokensTotal = 0;
  let latencyTotal = 0;

  const settledRows = rows.filter((r) => r.final_action === "EXECUTE" && r.outcome_settled === 1);
  for (const r of rows) {
    byAction[r.final_action] = (byAction[r.final_action] ?? 0) + 1;
    tokensTotal += r.tokens_used ?? 0;
    latencyTotal += r.latency_ms ?? 0;
    if (r.gates_json) {
      try {
        const gates = JSON.parse(r.gates_json) as GateLike[];
        for (const g of gates) gateHistogram[`${g.name}:${g.status}`] = (gateHistogram[`${g.name}:${g.status}`] ?? 0) + 1;
        if (r.final_action === "EXECUTE" && !gates.some((g) => g.status === "RED")) cleanExecutes++;
      } catch { /* gates_json corrupto no debe romper la evaluación */ }
    }
  }

  const executes = byAction["EXECUTE"] ?? 0;

  // ── 2. Resultados settled ──
  const wins = settledRows.filter((r) => (r.outcome_pnl ?? 0) > 0);
  const losses = settledRows.filter((r) => (r.outcome_pnl ?? 0) <= 0);
  const totalPnl = settledRows.reduce((a, r) => a + (r.outcome_pnl ?? 0), 0);
  const winRate = settledRows.length ? wins.length / settledRows.length : null;
  const avgConf = (arr: typeof settledRows) =>
    arr.length ? arr.reduce((a, r) => a + (r.confidence ?? 0), 0) / arr.length : null;
  const avgConfidenceWin = avgConf(wins);
  const avgConfidenceLoss = avgConf(losses);

  // ── 3. Seguimiento (follow-through) ──
  const withOrder = db
    .prepare(
      `SELECT COUNT(DISTINCT decision_id) as n FROM trade_orders WHERE decision_id IS NOT NULL`
    )
    .get() as { n: number };
  const noExecution = (db
    .prepare(`SELECT COUNT(*) as n FROM decision_log WHERE outcome_source = 'no_execution'`)
    .get() as { n: number }).n;
  const followThroughRate = executes ? Math.min(1, withOrder.n / executes) : null;

  // ── 4. Lecciones y errores ──
  const lessonStats = db
    .prepare(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN validation_status = 'verified' THEN 1 ELSE 0 END) as verified,
              SUM(CASE WHEN validation_status = 'pending' THEN 1 ELSE 0 END) as pending,
              SUM(times_seen) as seen
       FROM agent_lessons`
    )
    .get() as { total: number; verified: number | null; pending: number | null; seen: number | null };
  const promoted = getPromotedLessons(100).length;
  const unresolved = getUnresolvedErrors(100);
  const totalErrorInstances = unresolved.reduce((a, e) => a + e.times, 0);

  // ── 5. Componentes del score ──
  // Disciplina: todo EXECUTE debe salir con filtros sin rojo.
  const disciplineScore = executes === 0 ? 20 : 30 * (cleanExecutes / executes);

  // Calibración: la confianza de las ganancias debe superar la de las pérdidas.
  let calibrationScore: number;
  if (settledRows.length < 5) {
    calibrationScore = 12; // muestra insuficiente → neutral, no penaliza ni premia
  } else {
    const edge = (avgConfidenceWin ?? 0.5) - (avgConfidenceLoss ?? 0.5);
    calibrationScore = 25 * Math.max(0, Math.min(1, 0.5 + edge * 2.5));
  }

  // Seguimiento: decisiones EXECUTE convertidas en órdenes reales.
  const followThroughScore =
    followThroughRate === null ? 8 : 15 * followThroughRate;

  // Aprendizaje: volumen + consolidación + promoción.
  const totalLessons = lessonStats.total ?? 0;
  const verified = lessonStats.verified ?? 0;
  const seen = lessonStats.seen ?? totalLessons;
  const learningScore = Math.min(
    20,
    Math.min(8, totalLessons * 1.2) +
      Math.min(6, (verified ?? 0) * 2) +
      Math.min(4, Math.max(0, seen - totalLessons) * 0.5) +
      Math.min(2, promoted * 0.5)
  );

  // Operativa: errores recurrentes sin resolver restan.
  const operationalScore = Math.max(0, 10 - unresolved.length * 1.5);

  const score =
    Math.round(
      (disciplineScore + calibrationScore + followThroughScore + learningScore + operationalScore) * 10
    ) / 10;

  const report: BrainReport = {
    score,
    components: {
      discipline: {
        score: Math.round(disciplineScore * 10) / 10,
        max: 30,
        detail:
          executes === 0
            ? "Sin decisiones EXECUTE aún (se asume disciplina por defecto hasta que opere)"
            : `${cleanExecutes}/${executes} EXECUTE con filtros limpios (${((cleanExecutes / executes) * 100).toFixed(0)}%)`,
      },
      calibration: {
        score: Math.round(calibrationScore * 10) / 10,
        max: 25,
        detail:
          settledRows.length < 5
            ? `Muestra pequeña (${settledRows.length} settled) → score neutral`
            : `Conf. media ganancias ${(avgConfidenceWin ?? 0).toFixed(2)} vs pérdidas ${(avgConfidenceLoss ?? 0).toFixed(2)}`,
      },
      followThrough: {
        score: Math.round(followThroughScore * 10) / 10,
        max: 15,
        detail:
          followThroughRate === null
            ? "Sin decisiones EXECUTE aún"
            : `${withOrder.n}/${executes} decisiones ejecutadas como órdenes (${(followThroughRate * 100).toFixed(0)}%) · ${noExecution} abandonadas`,
      },
      learning: {
        score: Math.round(learningScore * 10) / 10,
        max: 20,
        detail: `${totalLessons} lecciones (${verified} verificadas, ${promoted} promovidas) · ${seen} observaciones consolidadas`,
      },
      operational: {
        score: Math.round(operationalScore * 10) / 10,
        max: 10,
        detail: `${unresolved.length} patrones de error sin resolver (${totalErrorInstances} instancias)`,
      },
    },
    stats: {
      totalDecisions: rows.length,
      byAction,
      gateHistogram,
      executes,
      settled: settledRows.length,
      wins: wins.length,
      losses: losses.length,
      winRate,
      totalPnl: Math.round(totalPnl * 100) / 100,
      avgConfidenceWin,
      avgConfidenceLoss,
      followThroughRate,
      noExecution,
      lessons: {
        total: totalLessons,
        verified: verified ?? 0,
        pending: lessonStats.pending ?? 0,
        promoted,
        dedupedSeen: seen,
      },
      errors: { unresolvedPatterns: unresolved.length, totalInstances: totalErrorInstances },
      tokens: { total: tokensTotal, avgPerDecision: rows.length ? Math.round(tokensTotal / rows.length) : 0 },
      latency: { avgMs: rows.length ? Math.round(latencyTotal / rows.length) : 0 },
    },
    verdict: "",
  };

  report.verdict = buildVerdict(report);
  return report;
}

function buildVerdict(r: BrainReport): string {
  if (r.stats.totalDecisions < 10)
    return "🧒 Cerebro en entrenamiento: pocas decisiones para juzgar. Deja que el pipeline corra en demo y vuelve a evaluar.";
  if (r.score >= 80)
    return "🏆 Cerebro institucional: disciplina, calibración y aprendizaje en niveles de venta.";
  if (r.score >= 60)
    return "📈 Cerebro competente: base sólida; revisa los componentes más débiles antes de escalar.";
  if (r.score >= 40)
    return "⚠️ Cerebro inconsistente: hay fugas de disciplina o de datos de settlement que corregir.";
  return "🚨 Cerebro en riesgo: múltiples componentes bajos; NO vender ni escalar hasta corregir.";
}

// ── Render markdown ─────────────────────────────────────────
export function renderBrainReport(r: BrainReport): string {
  const bar = (s: number, max: number) => {
    const filled = Math.round((s / max) * 10);
    return "█".repeat(filled) + "░".repeat(10 - filled);
  };
  const c = r.components;
  const wr = r.stats.winRate === null ? "—" : `${(r.stats.winRate * 100).toFixed(0)}%`;

  return [
    `## 🧠 Evaluación del Cerebro — Score: ${r.score}/100`,
    "",
    `> ${r.verdict}`,
    "",
    "| Componente | Puntos | Progreso |",
    "|---|---|---|",
    `| 🛡️ Disciplina | ${c.discipline.score}/${c.discipline.max} | \`${bar(c.discipline.score, c.discipline.max)}\` |`,
    `| 🎯 Calibración | ${c.calibration.score}/${c.calibration.max} | \`${bar(c.calibration.score, c.calibration.max)}\` |`,
    `| 📌 Seguimiento | ${c.followThrough.score}/${c.followThrough.max} | \`${bar(c.followThrough.score, c.followThrough.max)}\` |`,
    `| 🧬 Aprendizaje | ${c.learning.score}/${c.learning.max} | \`${bar(c.learning.score, c.learning.max)}\` |`,
    `| ⚙️ Operativa | ${c.operational.score}/${c.operational.max} | \`${bar(c.operational.score, c.operational.max)}\` |`,
    "",
    "### Detalle",
    `- **Disciplina**: ${c.discipline.detail}`,
    `- **Calibración**: ${c.calibration.detail}`,
    `- **Seguimiento**: ${c.followThrough.detail}`,
    `- **Aprendizaje**: ${c.learning.detail}`,
    `- **Operativa**: ${c.operational.detail}`,
    "",
    "### Números del escritorio",
    `| Métrica | Valor |`,
    `|---|---|`,
    `| Decisiones totales | ${r.stats.totalDecisions} |`,
    `| EXECUTE / WAIT / REVIEW / ABORTED | ${r.stats.byAction["EXECUTE"] ?? 0} / ${r.stats.byAction["WAIT"] ?? 0} / ${r.stats.byAction["REVIEW"] ?? 0} / ${r.stats.byAction["ABORTED"] ?? 0} |`,
    `| Settled con PnL | ${r.stats.settled} (W:${r.stats.wins} / L:${r.stats.losses} · WR ${wr}) |`,
    `| PnL acumulado | ${r.stats.totalPnl > 0 ? "+" : ""}${r.stats.totalPnl} USD |`,
    `| Tokens acumulados | ${r.stats.tokens.total} (≈${r.stats.tokens.avgPerDecision}/decisión) |`,
    `| Latencia media pipeline | ${(r.stats.latency.avgMs / 1000).toFixed(1)}s |`,
  ].join("\n");
}

/** Evalúa y persiste un snapshot para ver la tendencia. */
export function evaluateAndSnapshotBrain(): { report: BrainReport; markdown: string; snapshotId: number } {
  const report = evaluateBrain();
  const markdown = renderBrainReport(report);
  const res = db
    .prepare(`INSERT INTO brain_evaluations (score, report_json) VALUES (?, ?)`)
    .run(report.score, JSON.stringify(report));
  return { report, markdown, snapshotId: Number(res.lastInsertRowid) };
}

/** Tendencia: últimos N snapshots para ver si el cerebro mejora. */
export function getBrainTrend(limit = 10): Array<{ id: number; created_at: string; score: number }> {
  return db
    .prepare(`SELECT id, created_at, score FROM brain_evaluations ORDER BY id DESC LIMIT ?`)
    .all(limit) as Array<{ id: number; created_at: string; score: number }>;
}

// Re-export para tools que quieran parsear reportes viejos
export { extractJson };
