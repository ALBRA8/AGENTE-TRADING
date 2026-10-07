// Test de Task 10-c (MemoryDV + Skills + Doctor) sin APIs externas:
// (a) gate de contexto: lección reflection times_seen=1 NO entra; =3 SÍ
// (b) promoteLessonGated: rechaza pending/sin evidencia; acepta verified+evidencia auditando en policy_events
// (c) consolidateMemory: times_seen≥5 + stats suficientes → verified; muestra insuficiente → pending
// (d) wilsonScore: caso conocido 8/10 → LB ≈ 0.490 (implementación propia, no copiada)
// (e) runDoctor sin bridge: 9 secciones, veredictos honestos, score 0-100
// (f) skills registry: 17 skills, PENDING honestas, renderSkillsMarkdown completo
process.env.NVIDIA_API_KEY = "nvapi-memory-test-not-real";
process.env.DB_PATH = "./data/memory_skills_test.db";
process.env.MT5_BRIDGE_URL = "http://127.0.0.1:9"; // puerto descarte: bridge "caído" determinista
delete process.env.AUTO_PROMOTE_LESSONS; // la auto-promoción debe estar OFF por defecto

// Imports dinámicos: los static de ESM se hoistean ANTES del setup de env
const { default: db, saveDecision, saveLesson, setLessonValidation } = await import("../src/database/sqlite.js");
const { buildLessonsContextBlock, getContextEligibleLessons } = await import("../src/agent/self_improve.js");
const { consolidateMemory, promoteLessonGated, wilsonScore, MIN_PATTERN_SEEN, MIN_SAMPLE } = await import("../src/agent/consolidation.js");
const { runDoctor, renderDoctorMarkdown } = await import("../src/agent/doctor.js");
const { SKILLS, getSkillsRegistry, renderSkillsMarkdown } = await import("../src/skills/registry.js");
const { searchLessonsTool } = await import("../src/agent/tools/search_lessons.js");

import fs from "node:fs";

let passed = 0;
function assert(cond: boolean, msg: string) {
  // writeSync: inmune al buffer perdido si el cleanup nativo de better-sqlite3
  // aborta el proceso al salir (mismo quirk que tests/smoke_phases.ts)
  const line = cond ? `✅ ${msg}\n` : `❌ FALLO: ${msg}\n`;
  fs.writeSync(1, line);
  if (!cond) process.exitCode = 1;
  else passed++;
}

const insertLesson = (opts: {
  patternKey: string;
  symbol?: string;
  source?: "reflection" | "user" | "auto_error";
  timesSeen?: number;
  lesson?: string;
  promoted?: number;
  evidenceJson?: string;
}) => {
  const { id } = saveLesson({
    kind: "insight",
    source: opts.source ?? "reflection",
    symbol: opts.symbol ?? null,
    patternKey: opts.patternKey,
    observation: `observación de prueba ${opts.patternKey}`,
    lesson: opts.lesson ?? `lección de prueba ${opts.patternKey}`,
    importance: 2,
  });
  db.prepare(
    `UPDATE agent_lessons SET times_seen = ?, promoted = COALESCE(?, promoted),
       evidence_json = COALESCE(?, evidence_json) WHERE id = ?`
  ).run(opts.timesSeen ?? 1, opts.promoted ?? null, opts.evidenceJson ?? null, id);
  return id;
};

async function main() {
  fs.writeSync(1, `🧪 tests/memory_skills.test.ts — MIN_PATTERN_SEEN=${MIN_PATTERN_SEEN} MIN_SAMPLE=${MIN_SAMPLE}\n`);
  db.exec(`DELETE FROM agent_lessons; DELETE FROM decision_log; DELETE FROM policy_events; DELETE FROM trade_orders; DELETE FROM memory_fragments;`);

  // ── (a) GATE de contexto: 1 trade no influye en la siguiente decisión ──
  const weak = insertLesson({
    patternKey: "CTX|una_sola_operacion",
    symbol: "CTX",
    timesSeen: 1,
    lesson: "MARCADOR_WEAK_ctx_unica_operacion",
  });
  let block = buildLessonsContextBlock("CTX");
  assert(!block.includes("MARCADOR_WEAK_ctx_unica_operacion"), "(a) lección reflection times_seen=1 NO aparece en el contexto");
  assert(getContextEligibleLessons("CTX").length === 0, "(a) getContextEligibleLessons filtra la lección anecdótica");
  db.prepare(`UPDATE agent_lessons SET times_seen = 3 WHERE id = ?`).run(weak);
  block = buildLessonsContextBlock("CTX");
  assert(block.includes("MARCADOR_WEAK_ctx_unica_operacion"), "(a) la misma lección con times_seen=3 SÍ entra al contexto");

  const always = insertLesson({
    patternKey: "CTX|promovida_siempre",
    symbol: "CTX",
    timesSeen: 1,
    lesson: "MARCADOR_PROMOTED_ctx_siempre",
    promoted: 1,
  });
  assert(
    buildLessonsContextBlock("CTX").includes("MARCADOR_PROMOTED_ctx_siempre"),
    "(a) lección promovida SIEMPRE entra aunque times_seen=1"
  );

  // OPS (errores TOOL, triage ≥3 existente) no exige times_seen de la lección
  insertLesson({
    patternKey: "OPS|TOOL|runBacktest|parse_error",
    source: "auto_error",
    timesSeen: 1,
    lesson: "MARCADOR_OPS_tool_recurrente",
  });
  assert(getContextEligibleLessons().some((l) => l.lesson.includes("MARCADOR_OPS_tool_recurrente")), "(a) lección OPS (triage TOOL ≥3) mantiene su vía de entrada");

  // (a-extra) el tool searchLessons ya NO expone auto-validación ni auto-promoción
  const toolJson = JSON.stringify(searchLessonsTool.definition);
  assert(!toolJson.includes("promoteId") && !toolJson.includes("validateId"), "(a) searchLessons ya no expone promoteId/validateId al LLM");

  // ── (b) GATE de promoción con auditoría ──
  const noEv = insertLesson({ patternKey: "GATE|sin_evidencia", symbol: "GATE", timesSeen: 9 });
  let res = promoteLessonGated(noEv, "human:test", "intentar promover pendiente");
  assert(!res.ok && res.reason.includes("'pending'"), "(b) rechaza lección 'pending' (no verified)");

  setLessonValidation(noEv, "verified");
  res = promoteLessonGated(noEv, "human:test", "verified pero SIN evidencia");
  assert(!res.ok && res.reason.includes("sin evidencia"), "(b) rechaza lección verified sin evidence_json");

  db.prepare(`UPDATE agent_lessons SET evidence_json = ? WHERE id = ?`).run(
    JSON.stringify({ n: 12, wins: 11, wilson_lb: 0.6394, computed_at: new Date().toISOString() }),
    noEv
  );
  res = promoteLessonGated(noEv, "human:test", "verified + evidencia estadística");
  assert(res.ok, `(b) acepta verified+evidencia: ${res.reason}`);
  const promotedFlag = (db.prepare(`SELECT promoted FROM agent_lessons WHERE id = ?`).get(noEv) as { promoted: number }).promoted;
  assert(promotedFlag === 1, "(b) promoted=1 tras el gate");
  const ev = db
    .prepare(`SELECT actor, old_value, new_value, reason FROM policy_events WHERE event = ? ORDER BY id DESC LIMIT 1`)
    .get(`lesson_promotion:${noEv}`) as { actor: string; old_value: string; new_value: string; reason: string } | undefined;
  assert(!!ev && ev.actor === "human:test" && ev.old_value === "candidate" && ev.new_value === "promoted", "(b) promoción AUDITADA en policy_events (candidate→promoted)");
  res = promoteLessonGated(noEv, "human:test", "segunda vez");
  assert(!res.ok && res.reason.includes("idempotente"), "(b) re-promoción idempotente (sin evento duplicado)");
  assert(promoteLessonGated(999999, "human:test", "fantasma").ok === false, "(b) lección inexistente → rechazo");

  // ── (d) wilsonScore (antes de (c), valida la métrica que usa la consolidación) ──
  const w810 = wilsonScore(8, 10);
  assert(Math.abs(w810 - 0.4902) < 0.005, `(d) wilsonScore(8,10) = ${w810} ≈ 0.490 (LB 95%: 8/10 NO es 0.8)`);
  assert(wilsonScore(0, 10) === 0, "(d) wilsonScore(0,10) = 0");
  const w1010 = wilsonScore(10, 10);
  assert(w1010 > 0.7 && w1010 < 1, `(d) wilsonScore(10,10) = ${w1010} < 1 (perfecto con n=10 no es certeza)`);
  assert(wilsonScore(5, 0) === 0 && wilsonScore(-1, 10) === 0 && wilsonScore(12, 10) === w1010, "(d) degenerados: n=0 → 0; wins clampeados a [0,n]");
  assert(Math.abs(wilsonScore(30, 50) - 0.4618) < 0.005, `(d) wilsonScore(30,50) = ${wilsonScore(30, 50)} ≈ 0.462 (mitad con margen sigue < 0.5)`);

  // ── (c) consolidateMemory: EVENT→EPISODIC→PATTERN→VALIDATION ──
  // Suficiente: 12 trades settled del símbolo TSTOK, 11 ganados (wilson_lb ≈ 0.64 ≥ 0.5)
  const settle = (symbol: string, pnl: number) => {
    const id = saveDecision({ symbol, finalAction: "EXECUTE", direction: pnl >= 0 ? "BUY" : "SELL", confidence: 0.8 });
    db.prepare(
      `UPDATE decision_log SET outcome_settled = 1, outcome_pnl = ?, outcome_timestamp = datetime('now') WHERE id = ?`
    ).run(pnl, id);
  };
  for (let i = 0; i < 11; i++) settle("TSTOK", 50);
  settle("TSTOK", -40);
  const okLesson = insertLesson({
    patternKey: "TSTOK|patron_validable",
    symbol: "TSTOK",
    timesSeen: MIN_PATTERN_SEEN,
    lesson: "MARCADOR_TSTOK_patron_validado",
  });
  // Insuficiente: solo 3 trades settled → n < MIN_SAMPLE → pending honesto
  for (let i = 0; i < 3; i++) settle("TSTLOW", 25);
  const lowLesson = insertLesson({ patternKey: "TSTLOW|patron_sin_muestra", symbol: "TSTLOW", timesSeen: MIN_PATTERN_SEEN });

  // EPISODIC (lección de settlement con decision_id) y PROCEDURAL (OPS TOOL)
  insertLesson({
    patternKey: "TSTOK|leccion_settlement",
    symbol: "TSTOK",
    timesSeen: 1,
    evidenceJson: JSON.stringify({ decision_id: 1, symbol: "TSTOK", pnl: 50, outcome_source: "performance_log" }),
  });
  insertLesson({ patternKey: "OPS|TOOL|checkNews|rate_limit", source: "auto_error", timesSeen: 4 });

  const summary = consolidateMemory();
  fs.writeSync(1, `   ↳ resumen: ${JSON.stringify({ candidates: summary.candidates, verified: summary.verified, promoted: summary.promoted, skipped: summary.skipped })}\n`);
  assert(summary.verified >= 1, "(c) consolidateMemory verificó al menos el patrón con stats suficientes");
  assert(summary.promoted === 0, "(c) auto-promoción PROHIBIDA por defecto (AUTO_PROMOTE_LESSONS ausente)");

  const okRow = db.prepare(`SELECT * FROM agent_lessons WHERE id = ?`).get(okLesson) as any;
  assert(okRow.validation_status === "verified", "(c) lección TSTOK → 'verified'");
  const evStats = JSON.parse(okRow.evidence_json ?? "{}");
  assert(
    evStats.n === 12 && evStats.wins === 11 && typeof evStats.wilson_lb === "number" && typeof evStats.computed_at === "string",
    `(c) evidence_json citable: n=${evStats.n} wins=${evStats.wins} wilson_lb=${evStats.wilson_lb}`
  );
  assert(Math.abs(evStats.wilson_lb - wilsonScore(11, 12)) < 1e-9, "(c) wilson_lb de la evidencia coincide con wilsonScore(11,12)");
  assert(okRow.confidence === evStats.wilson_lb, "(c) confidence = wilson_lb (conservador)");
  assert(!!okRow.last_verified, "(c) last_verified marcado");
  assert(okRow.promoted === 0, "(c) verified espera promoteLessonGated humano (promoted sigue 0)");

  const lowRow = db.prepare(`SELECT * FROM agent_lessons WHERE id = ?`).get(lowLesson) as any;
  assert(lowRow.validation_status === "pending" && !lowRow.evidence_json, "(c) muestra insuficiente (n=3 < 10) → queda 'pending' sin evidencia");

  const epiRow = db.prepare(`SELECT memory_type FROM agent_lessons WHERE pattern_key = 'TSTOK|leccion_settlement'`).get() as any;
  assert(epiRow?.memory_type === "EPISODIC", "(c) lección de settlement con decision_id → memory_type='EPISODIC'");
  const procRow = db.prepare(`SELECT memory_type FROM agent_lessons WHERE pattern_key = 'OPS|TOOL|checkNews|rate_limit'`).get() as any;
  assert(procRow?.memory_type === "PROCEDURAL", "(c) lección OPS de errores TOOL → memory_type='PROCEDURAL'");

  // La lección verificada ya SÍ entra al contexto (verified + times_seen≥3)
  assert(getContextEligibleLessons("TSTOK").some((l) => l.id === okLesson), "(c) lección verificada elegible para contexto");

  const lastCons = db.prepare(`SELECT value FROM memory_fragments WHERE user_id='system' AND key='last_consolidation'`).get() as { value: string } | undefined;
  assert(!!lastCons, "(c) marca last_consolidation escrita en memory_fragments (la lee el Doctor)");

  // ── (e) Doctor SIN bridge: secciones presentes, veredictos honestos ──
  const report = await runDoctor();
  const expected = ["SYSTEM", "MARKET_DATA", "STRATEGY", "RISK", "EXECUTION", "SECURITY", "MEMORY", "SKILLS", "TESTING"];
  assert(
    JSON.stringify(report.sections.map((s) => s.name)) === JSON.stringify(expected),
    "(e) las 9 secciones están presentes y en orden"
  );
  assert(Number.isInteger(report.score) && report.score >= 0 && report.score <= 100, `(e) score ${report.score} ∈ [0,100]`);
  const md = report.sections.find((s) => s.name === "MARKET_DATA")!;
  assert(md.verdict === "WARN", "(e) bridge caído → MARKET_DATA WARN (no FAIL en modo demo)");
  assert(md.checks.some((c) => !c.ok && c.severity === "warn"), "(e) el check del bridge lleva severity 'warn' con detalle");
  const sys = report.sections.find((s) => s.name === "SYSTEM")!;
  assert(sys.verdict === "OK", "(e) SYSTEM OK (sqlite abre + integrity_check + node + key)");
  const memSec = report.sections.find((s) => s.name === "MEMORY")!;
  assert(memSec.checks.some((c) => c.ok && c.name === "consolidación de memoria"), "(e) MEMORY ve la consolidación recién corrida");
  assert(report.sections.every((s) => s.checks.every((c) => typeof c.detail === "string" && c.detail.length > 0)), "(e) todos los checks traen detalle honesto");
  const rendered = renderDoctorMarkdown(report);
  assert(rendered.includes(`${report.score}/100`) && expected.every((n) => rendered.includes(n)), "(e) renderDoctorMarkdown incluye score y las 9 secciones");

  // ── (f) Skills registry: 17 skills, PENDING honestas, render completo ──
  assert(SKILLS.length === 17, `(f) registry con 17 skills (got ${SKILLS.length})`);
  const pending = getSkillsRegistry().filter((s) => s.status === "PENDING").map((s) => s.identity);
  assert(
    JSON.stringify(pending.sort()) === JSON.stringify(["ANALYZE_LIQUIDITY", "VALIDATE_RETEST"]),
    "(f) PENDING honestas: VALIDATE_RETEST y ANALYZE_LIQUIDITY (no implementadas)"
  );
  const reg = getSkillsRegistry();
  const withRate = reg.filter((s) => s.success_rate !== null);
  // El setup de (c) dejó 15 trades settled (12 de TSTOK con 11 wins + 3 de TSTLOW)
  // (la métrica se publica redondeada a 4 decimales: tolerancia acorde)
  assert(
    withRate.length === 3 && withRate.every((s) => s.success_rate!.n === 15 && Math.abs(s.success_rate!.rate - 14 / 15) < 5e-4),
    "(f) success_rate calculada de decision_log settled (14/15 ≈ 0.9333) SOLO en las 3 skills ejecutables de trade"
  );
  assert(
    reg.find((s) => s.identity === "VERIFY_EXECUTION")!.success_rate === null,
    "(f) VERIFY_EXECUTION sin trade_orders verificados → 'sin datos'"
  );
  assert(reg.every((s) => s.procedure.reference.length > 0 || s.status === "PENDING"), "(f) cada skill ACTIVE apunta a una función existente");
  const table = renderSkillsMarkdown();
  assert(SKILLS.every((s) => table.includes(s.identity)), "(f) renderSkillsMarkdown incluye las 17 skills");
  assert(table.includes("PENDING") && table.includes("VALIDATE_RETEST"), "(f) el render marca las PENDING honestamente");

  // ── Cleanup ──
  const DB_PATH = "./data/memory_skills_test.db";
  for (const f of [DB_PATH, `${DB_PATH}-journal`, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
  }
  try { db.close(); } catch {}
  fs.writeSync(1, `\n🧪 Memory/Skills/Doctor test completo: ${passed} asserts verdes.\n`);
}

main().catch((err) => {
  fs.writeSync(2, `❌ ERROR FATAL: ${(err as Error).stack ?? err}\n`);
  process.exitCode = 1;
});
