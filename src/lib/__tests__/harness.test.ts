// ============================================================
// src/lib/__tests__/harness.test.ts
// ARNÉS — Suite de validación (Fase 10). Estilo del repo: asserts +
// exit code, sin framework. Ejecutar: npm run test:harness
//
// Verifica: fallback de bridges, registries, conocimiento del dominio
// (S0-S9 / B1-B18 / tabla de SL), GeneralAdapter y skills SOP.
// LLM_PROVIDER=mock (§16): la prueba de chat es DETERMINISTA y sin red.
// ============================================================

// DB_PATH antes de que cualquier import dinámico abra la BD (sop-skills
// → skills/registry.js → database/sqlite.js). BD de humo, no la real.
process.env.DB_PATH = "./data/harness-smoke.db";
// NIM sin red: mock provider determinista (fail-safe §16 exige no-LIVE).
process.env.LLM_PROVIDER = "mock";
if (!process.env.NVIDIA_API_KEY) process.env.NVIDIA_API_KEY = "nvapi-smoke-harness-key";
process.env.LIVE_TRADING = "false";

import assert from "node:assert/strict";
import fs from "node:fs";
import { BridgeRegistry, type IBridge, type BridgeResult, type BridgeHealth } from "../bridges/types.js";
import { SkillRegistry, type ISkillPlugin, type SkillContext } from "../harness/types.js";
import { KnowledgeRegistry, registerBuiltinKnowledge } from "../harness/knowledge-registry.js";
import { getSlForSymbol } from "../../config/asset_risk_table.js";
import { bootstrapHarness, DEFAULT_HARNESS_CONFIG } from "../../bootstrap.js";

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failures.push(name);
    console.error(`  ❌ ${name}\n     ${(e as Error).message}`);
  }
}

// ── Fakes deterministas para el BridgeRegistry ──────────────
function fakeBridge(
  type: string,
  opts: { available?: boolean; success?: boolean; fail?: boolean } = {}
): IBridge & { calls: string[] } {
  const state = { available: opts.available ?? true, success: opts.success ?? true };
  return {
    type,
    name: `Fake ${type}`,
    calls: [],
    async isAvailable() {
      return state.available;
    },
    async execute(operation: string): Promise<BridgeResult> {
      this.calls.push(operation);
      if (opts.fail) throw new Error(`fake ${type} explotó`);
      return { success: state.success, data: { from: type, op: operation }, source: type };
    },
    async healthCheck(): Promise<BridgeHealth> {
      return { available: state.available };
    },
  };
}

// ─────────────────────────────────────────────────────────────
console.log("\n🦺 ARNÉS — suite de validación\n");

await test("BridgeRegistry: prioridad primero y fallback si falla", async () => {
  const r = new BridgeRegistry();
  const a = fakeBridge("a");
  const b = fakeBridge("b");
  r.register(a, true);
  r.register(b);
  const out = await r.execute("chat", {});
  assert.equal(out.source, "a");
  // Ahora el prioritario no está disponible → toma el relevo b
  (a as unknown as { isAvailable: () => Promise<boolean> }).isAvailable = async () => false;
  const out2 = await r.execute("chat", {});
  assert.equal(out2.source, "b");
});

await test("BridgeRegistry: si el prioritario lanza, el siguiente responde", async () => {
  const r = new BridgeRegistry();
  r.register(fakeBridge("x", { fail: true }), true);
  r.register(fakeBridge("y"));
  const out = await r.execute("chat", {});
  assert.equal(out.source, "y");
});

await test("BridgeRegistry: sin bridges disponibles → error honesto", async () => {
  const r = new BridgeRegistry();
  r.register(fakeBridge("z", { available: false }));
  const out = await r.execute("chat", {});
  assert.equal(out.success, false);
  assert.equal(out.error, "No bridge available");
  assert.equal(out.source, "none");
});

await test("KnowledgeRegistry: 3 módulos del dominio registrados y válidos", () => {
  const k = new KnowledgeRegistry();
  registerBuiltinKnowledge(k);
  const health = k.healthCheck();
  assert.equal(health.total, 3);
  assert.equal(health.valid, 3);
  assert.deepEqual(health.invalid, []);
  assert.deepEqual(
    k.list().map((m) => m.id).sort(),
    ["asset-risk-table", "smc-blockers", "smc-engine-phases"]
  );
});

await test("Conocimiento: S0-S9 (10 fases) y B1-B18 completos", () => {
  const k = new KnowledgeRegistry();
  registerBuiltinKnowledge(k);
  const phases = k.get("smc-engine-phases")!.getContent() as { phases: unknown[] };
  assert.equal(phases.phases.length, 10);
  const blockers = k.get("smc-blockers")!.getContent() as { blockers: Array<{ id: string }> };
  assert.equal(blockers.blockers.length, 18);
  assert.equal(blockers.blockers[0].id, "B1");
  assert.equal(blockers.blockers[17].id, "B18");
});

await test("Conocimiento: tabla de SL resuelve alias de broker (fail-closed)", () => {
  assert.equal(getSlForSymbol("US30Cash"), 80);
  assert.equal(getSlForSymbol("XAUUSD.a"), 12);
  assert.equal(getSlForSymbol("BTCUSD.m"), 500);
  assert.equal(getSlForSymbol("SIMBOLO_RARO"), null);
});

await test("SkillRegistry: errores honestos en skill/operación desconocida", async () => {
  const r = new SkillRegistry();
  const skill: ISkillPlugin = {
    id: "fake-skill",
    name: "Fake",
    category: "analysis",
    operations: [{ id: "ping", name: "Ping", description: "…" }],
    async execute(op: string, _ctx: SkillContext) {
      return { success: true, data: { op } };
    },
  };
  r.register(skill);
  const ok = await r.execute("fake-skill", "ping", {} as SkillContext);
  assert.equal(ok.success, true);
  const noSkill = await r.execute("nope", "ping", {} as SkillContext);
  assert.equal(noSkill.success, false);
  assert.match(noSkill.error!, /Skill not found/);
  const noOp = await r.execute("fake-skill", "nope", {} as SkillContext);
  assert.match(noOp.error!, /not found in skill/);
});

// ── Bootstrap real (bridges reales; NIM en modo mock sin red) ──
const h = await bootstrapHarness({ ...DEFAULT_HARNESS_CONFIG });

await test("Bootstrap: chaleco AGENTE-GENERAL montado con stack real", () => {
  assert.equal(h.agent.id, "agente-general");
  assert.equal(h.agent.name, "AGENTE-GENERAL");
  assert.deepEqual(
    h.bridges.list().map((b) => b.type),
    ["nim", "zai-sdk", "mt5", "telegram"]
  );
  assert.equal(h.knowledge.list().length, 3);
  assert.equal(h.skills.list().length, 1);
  assert.equal(h.agent.canHandle("chat"), true);
  assert.equal(h.agent.canHandle("query-knowledge"), true);
  assert.equal(h.agent.canHandle("operar-en-mt5"), false);
});

await test("GeneralAdapter: query-knowledge devuelve el catálogo B1-B18", async () => {
  const out = await h.agent.execute("query-knowledge", { moduleId: "smc-blockers" });
  assert.equal(out.success, true);
  const blockers = (out.data as { blockers: unknown[] }).blockers;
  assert.equal(blockers.length, 18);
});

await test("GeneralAdapter: operación desconocida → error, nunca crash", async () => {
  const out = await h.agent.execute("hack-the-planet", {});
  assert.equal(out.success, false);
  assert.match(out.error!, /Unknown operation/);
});

await test("GeneralAdapter: chat por bridge NIM en modo mock (sin red)", async () => {
  const out = await h.agent.execute("chat", {
    tier: "quick",
    user: "POSTURA: TORO — analiza la estructura",
  });
  assert.equal(out.success, true);
  assert.equal(out.metadata && (out.metadata as { source?: string }).source, "nim");
  assert.match(String((out.data as { content: string }).content), /TORO/);
});

await test("GeneralAdapter: healthCheck sano (conocimiento válido + ≥1 bridge)", async () => {
  const health = await h.agent.healthCheck();
  assert.equal(health.healthy, true);
});

await test("Skills SOP: 17 contratos expuestos por el arnés (cero duplicación)", async () => {
  const listed = await h.agent.execute("execute-skill", {
    skillId: "sop-skills",
    operation: "list",
    params: {},
  });
  assert.equal(listed.success, true);
  const { count, skills } = listed.data as { count: number; skills: Array<{ identity: string }> };
  assert.ok(count >= 17, `esperadas ≥17 skills SOP, hay ${count}`);
  assert.ok(skills.length === count);
  // get por identity del propio listado (sin hardcodear nombres)
  const first = await h.agent.execute("execute-skill", {
    skillId: "sop-skills",
    operation: "get",
    params: { identity: skills[0].identity },
  });
  assert.equal(first.success, true);
  assert.equal((first.data as { identity: string }).identity, skills[0].identity);
});

await test("Skills SOP: contrato inexistente → error honesto", async () => {
  const out = await h.agent.execute("execute-skill", {
    skillId: "sop-skills",
    operation: "get",
    params: { identity: "NO_EXISTE" },
  });
  assert.equal(out.success, false);
});

await test("Shutdown: el cajero se va, el arnés queda montado", async () => {
  await h.agent.shutdown();
  const out = await h.agent.execute("chat", {});
  assert.equal(out.success, false);
  assert.match(out.error!, /not initialized/i);
});

// ── Cierre ──────────────────────────────────────────────────
console.log(`\n${passed} pruebas OK${failures.length ? `, ${failures.length} FALLOS: ${failures.join(", ")}` : ""}\n`);
if (failures.length) process.exit(1);

// Limpieza de la BD de humo (sqlite la dejó abierta; unlink en Linux es seguro)
for (const f of ["data/harness-smoke.db", "data/harness-smoke.db-wal", "data/harness-smoke.db-shm"]) {
  try {
    fs.unlinkSync(f);
  } catch {
    /* no existía */
  }
}
