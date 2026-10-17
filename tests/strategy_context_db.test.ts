// ============================================================
// tests/strategy_context_db.test.ts — SE-DATA (se-data-2)
// Migración idempotente decision_log.strategy_context (B11/R11.2) +
// roundtrip saveStrategyContext/getStrategyContext + integridad.
//
// La BD es SIEMPRE temporal en /home/z/my-project/tmp — jamás la BD real
// del repo (data/opengravity.db): DB_PATH se fija por env ANTES de importar
// sqlite.js (los static imports de ESM se hoistean antes del setup).
//
// La idempotencia se prueba de verdad con DOS procesos hijo contra el MISMO
// fichero: si la migración re-ejecutara el ALTER, el segundo proceso moriría
// con "duplicate column name". Los hijos reusan el loader de tsx vía
// process.execArgv (verificado: npx tsx inyecta --require preflight + --import
// loader.mjs en execArgv).
// Ejecutar: npx tsx tests/strategy_context_db.test.ts
// ============================================================
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const THIS_FILE = fileURLToPath(import.meta.url);
const TMP_DIR = "/home/z/my-project/tmp"; // fuera del repo, nunca la BD real
const DB_FILE = path.join(TMP_DIR, "strategy_context_test.db");

function installKeepAlive(dbInst: { prepare: (...a: unknown[]) => unknown }): void {
  // Mitigación del quirk nativo (better-sqlite3 + GC, ver tests/backtest_validity.test.ts):
  // retener TODA referencia a statements para que nunca los finalice el GC
  // a mitad de run (SIGABRT determinista-evitable).
  const keep: unknown[] = [];
  const original = dbInst.prepare.bind(dbInst);
  (dbInst as unknown as { prepare: unknown }).prepare = (...args: unknown[]) => {
    const stmt = original(...args);
    keep.push(stmt);
    return stmt;
  };
}

// ── Modo HIJO: abre la BD (ejecuta schema + migraciones) y verifica la columna ──
if (process.env.SCTX_CHILD === "1") {
  const { default: db } = await import("../src/database/sqlite.js");
  installKeepAlive(db);
  const cols = (db.pragma("table_info(decision_log)") as Array<{ name: string }>).map(
    (c) => c.name
  );
  if (!cols.includes("strategy_context")) {
    fs.writeSync(2, "❌ hijo: decision_log.strategy_context NO existe tras la migración\n");
    process.exit(1);
  }
  fs.writeSync(1, `✅ hijo: migración OK, strategy_context presente (db=${process.env.DB_PATH})\n`);
  process.exit(0);
}

// ── Modo PADRE ─────────────────────────────────────────────
let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string): void {
  const line = cond ? `✅ ${msg}\n` : `❌ FALLO: ${msg}\n`;
  fs.writeSync(1, line);
  if (cond) passed++;
  else {
    failed++;
    process.exitCode = 1;
  }
}
function expectThrow(fn: () => void, msg: string): void {
  try {
    fn();
    assert(false, `${msg} (no lanzó)`);
  } catch (err) {
    assert(err instanceof Error, `${msg} (Error: ${(err as Error).message.slice(0, 80)})`);
  }
}

// BD temporal limpia al empezar (también -wal/-shm para determinismo)
fs.mkdirSync(TMP_DIR, { recursive: true });
for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
  fs.rmSync(f, { force: true });
}

// Los hijos heredan el loader de tsx vía execArgv (probe verificado)
const childEnv = { ...process.env, DB_PATH: DB_FILE, SCTX_CHILD: "1" };
const spawnChild = () =>
  spawnSync(process.execPath, [...process.execArgv, THIS_FILE], {
    env: childEnv,
    encoding: "utf8",
  });

// 1) Migración sobre BD NUEVA: el ALTER añade strategy_context
const run1 = spawnChild();
assert(
  run1.status === 0,
  `1. proceso 1 (BD nueva): migración añade strategy_context, exit 0 (got ${run1.status})` +
    (run1.status === 0 ? "" : `\n--- stdout:\n${run1.stdout}\n--- stderr:\n${run1.stderr}`)
);

// 2) IDEMPOTENCIA REAL: segundo proceso contra el MISMO fichero. Si el ALTER
//    se re-ejecutara, SQLite lanzaría "duplicate column name" y moriría.
const run2 = spawnChild();
assert(
  run2.status === 0,
  `2. proceso 2 (misma BD): migración re-ejecutada es idempotente, exit 0 (got ${run2.status})` +
    (run2.status === 0 ? "" : `\n--- stdout:\n${run2.stdout}\n--- stderr:\n${run2.stderr}`)
);

// 3) El padre abre la MISMA BD para el roundtrip completo
process.env.DB_PATH = DB_FILE; // ANTES del import dinámico
const { default: db } = await import("../src/database/sqlite.js");
installKeepAlive(db);
const { saveDecision, getStrategyContext, saveStrategyContext } = await import(
  "../src/database/sqlite.js"
);

const cols = (db.pragma("table_info(decision_log)") as Array<{ name: string }>).map((c) => c.name);
assert(cols.includes("strategy_context"), "3. pragma table_info(decision_log) incluye strategy_context");
const colType = (
  db.pragma("table_info(decision_log)") as Array<{ name: string; type: string }>
).find((c) => c.name === "strategy_context")?.type;
assert(colType === "TEXT", `3b. tipo de la columna = TEXT (got ${colType})`);

// 4) Integridad con decision_log: decisiones reales del pipeline siguen operativas
const id1 = saveDecision({
  symbol: "US30",
  timeframe: "M5",
  finalAction: "EXECUTE",
  direction: "long",
  riskPct: 0.5,
  confidence: 0.82,
});
const id2 = saveDecision({ symbol: "US30", finalAction: "WAIT" });
assert(id1 > 0 && id2 > 0 && id1 !== id2, `4. decision_log operativa: ids ${id1}/${id2}`);

// 5) Roundtrip del contexto OpenTrade (schema §2.2 openTradeContext)
const openTradeContext = {
  pillars: {
    h1: "bull: BOS H1 alcista 2026-10-15T12:00Z sobre swing 41890",
    m15: "BOS válido M15 con toma de liquidez interna; POI ORDER_BLOCK 42150.0-42120.5",
    m1: "ChoCh M1 + retest del bloque FVG 42133.0-42140.0",
  },
  liquiditySweep: "sweep london_low 42118.5 a las 08:03 ET, cierre de vuelta en 2 velas",
  confirmation: "ChoCh M5 dentro de la caja a las 08:11 ET",
  tfsUsed: ["H1", "M15", "M5", "M1"],
  degraded: false,
  session: "NY_KILLZONE",
  sl: { price: 42105.0, structuralRef: "choch_low", pips: 14.2 },
  tp: { price: 42180.0, liquidityRef: "london_high", rr: 2.6 },
};
const ctxJson = JSON.stringify(openTradeContext);
saveStrategyContext(id1, ctxJson);
assert(getStrategyContext(id1) === ctxJson, "5. roundtrip exacto: get === JSON guardado");

const back = getStrategyContext(id1);
assert(
  back !== null && JSON.stringify(JSON.parse(back)) === JSON.stringify(openTradeContext),
  "5b. roundtrip semántico: JSON.parse recompone el objeto openTradeContext"
);

// 6) Integridad: la fila de decisión no se toca (solo la nueva columna)
const row = db
  .prepare(`SELECT symbol, final_action, direction, risk_pct, outcome_settled FROM decision_log WHERE id = ?`)
  .get(id1) as { symbol: string; final_action: string; direction: string | null; risk_pct: number | null; outcome_settled: number };
assert(
  row.symbol === "US30" && row.final_action === "EXECUTE" && row.direction === "long" &&
    row.risk_pct === 0.5 && row.outcome_settled === 0,
  "6. fila decision_log intacta tras escribir el contexto (migración aditiva)"
);

// 7) Decisión sin contexto ⇒ null (no confunde con vacío)
assert(getStrategyContext(id2) === null, "7. decisión sin contexto ⇒ null");
assert(getStrategyContext(424242) === null, "7b. decisión inexistente ⇒ null (sin throw)");

// 8) Fail-closed: JSON inválido y decisión inexistente se rechazan
expectThrow(() => saveStrategyContext(id1, "{no-json"), "8. saveStrategyContext rechaza JSON inválido");
expectThrow(() => saveStrategyContext(424242, ctxJson), "8b. saveStrategyContext rechaza decisión inexistente");
assert(getStrategyContext(id1) === ctxJson, "8c. el rechazo NO corrompió el contexto previo");

// 9) Re-save = upsert (contexto enriquecido en S7→S8)
const ctxJson2 = JSON.stringify({ ...openTradeContext, degraded: true, entry: { type: "LIMIT", price: 42136.5 } });
saveStrategyContext(id1, ctxJson2);
assert(getStrategyContext(id1) === ctxJson2, "9. re-save sobrescribe el contexto (upsert)");

// 10) Nada se duplicó: exactamente 2 decisiones en la BD de prueba
const n = (db.prepare(`SELECT COUNT(*) AS n FROM decision_log`).get() as { n: number }).n;
assert(n === 2, `10. integridad: 2 decisiones exactamente (got ${n})`);

fs.writeSync(1, `\n${failed === 0 ? "🟢" : "🔴"} strategy_context_db: ${passed} asserts OK, ${failed} fallos\n`);
process.exit(failed === 0 ? 0 : 1);
