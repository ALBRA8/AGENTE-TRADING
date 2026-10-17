// ============================================================
// tests/tp_ladder.test.ts
// P1 — TP LADDER con cierres parciales (aprobado por el propietario).
//
// Cubre:
//   A. Niveles (computeLadderLevels): monotonía tp1<tp2<tp3, degradación 3R.
//   B. Volúmenes (computeLadder): 50/30/20, redistribución por volume_min,
//      colapso honesto a "sin ladder".
//   C. Siguiente acción (nextLadderAction): triggers por precio, BE tras
//      TP1 solo si mejora, dedupe por evidencia, fail-closed.
//   D. extractEngineStructuralTp: solo mode=source + dirección coherente.
//   E. processTpLadders: executors stub, fallo de red reintentable,
//      idempotencia ×5, sin posición (gap del broker).
//   F. Integración DB real (temporal): selección de candidatas,
//      deals/eventos como evidencia, settlement sin bridge ⇒ diferido.
//
// Ejecutar: npx tsx tests/tp_ladder.test.ts
// ============================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const THIS_FILE = fileURLToPath(import.meta.url);
const TMP_DIR = "/home/z/my-project/tmp";
const DB_FILE = path.join(TMP_DIR, "tp_ladder_test.db");

// DB_PATH ANTES de importar sqlite.js (convención del repo).
process.env.DB_PATH = DB_FILE;
// NVIDIA dummy: nvidia.ts solo valida presencia al importar (via settlement.js).
process.env.NVIDIA_API_KEY = "nvapi-tp-ladder-test-not-real";

let passed = 0;
let failed = 0;
function ok(cond: unknown, name: string, got?: unknown): void {
  if (cond) {
    passed++;
    console.log(`✅ ${name}${got !== undefined ? ` (got: ${String(got)})` : ""}`);
  } else {
    failed++;
    console.log(`❌ ${name}${got !== undefined ? ` (got: ${JSON.stringify(got)})` : ""}`);
    console.log(`   FALLO en ${THIS_FILE}`);
  }
}
function section(t: string): void {
  console.log(`\n—— ${t} ——`);
}

const {
  computeLadderLevels,
  computeLadder,
  nextLadderAction,
  ladderFinalTakeProfit,
  extractEngineStructuralTp,
  processTpLadders,
} = await import("../src/execution/tp_ladder.js");

// ════════════════════════════════════════════════════════════
// A. NIVELES
// ════════════════════════════════════════════════════════════
section("A · Niveles del ladder (computeLadderLevels)");

{
  // A1: long con estructural 1.8R → tp1=estructural, tp2=2R, tp3=3R
  const entry = 40000, sl = 39900, tp1 = 40180; // R=100, estructural 1.8R
  const r = computeLadderLevels(entry, sl, tp1, "BUY");
  ok(r.valid === true, "A1: estructural 1.8R → ladder válido");
  ok(Math.abs(r.tp1 - 40180) < 1e-9, "A1: tp1 = TP estructural", r.tp1);
  ok(Math.abs(r.tp2 - 40230) < 1e-9, "A1: tp2 = max(2R, tp1+0.5R) = 2.3R", r.tp2);
  ok(Math.abs(r.tp3 - 40300) < 1e-9, "A1: tp3 = 3R", r.tp3);
}

{
  // A2: short espejo
  const entry = 40000, sl = 40100, tp1 = 39820; // R=100, estructural 1.8R
  const r = computeLadderLevels(entry, sl, tp1, "SELL");
  ok(r.valid === true, "A2: short → ladder válido");
  ok(Math.abs(r.tp1 - 39820) < 1e-9, "A2: tp1 = estructural", r.tp1);
  ok(Math.abs(r.tp2 - 39770) < 1e-9, "A2: tp2 = entry − max(2R, tp1+0.5R) = 2.3R", r.tp2);
  ok(Math.abs(r.tp3 - 39700) < 1e-9, "A2: tp3 = entry−3R", r.tp3);
}

{
  // A3: estructural 2.5R → monotonía: tp2=max(2R, tp1+0.5R)=3R, tp3=max(3R,3.5R)=3.5R
  const r = computeLadderLevels(40000, 39900, 40250, "BUY");
  ok(r.valid === true, "A3: estructural 2.5R válido");
  ok(Math.abs(r.tp2 - 40300) < 1e-9, "A3: tp2 = max(2R, tp1+0.5R) = 3R", r.tp2);
  ok(Math.abs(r.tp3 - 40350) < 1e-9, "A3: tp3 = max(3R, tp2+0.5R) = 3.5R", r.tp3);
  ok(r.tp1 < r.tp2 && r.tp2 < r.tp3, "A3: monotonía tp1<tp2<tp3");
}

{
  // A4: estructural < 1R → inválido, degradación a 3R exacto
  const r = computeLadderLevels(40000, 39900, 40050, "BUY"); // 0.5R
  ok(r.valid === false, "A4: estructural 0.5R → ladder inválido");
  ok(Math.abs(r.tp3 - 40300) < 1e-9, "A4: degradación tp3 = 3R", r.tp3);
  ok(/rr/i.test(r.reason), "A4: razón auditable menciona rr", r.reason);
}

{
  // A5: estructural en contra de la dirección → inválido
  const r = computeLadderLevels(40000, 39900, 39950, "BUY"); // TP por debajo de la entrada en un long
  ok(r.valid === false, "A5: TP en contra → inválido");
}

{
  // A6: datos base hostiles → inválido sin lanzar
  ok(computeLadderLevels(0, 39900, 40180, "BUY").valid === false, "A6a: entry=0 → inválido");
  ok(computeLadderLevels(40000, 0, 40180, "BUY").valid === false, "A6b: sl=0 → inválido");
  ok(computeLadderLevels(NaN, 39900, 40180, "BUY").valid === false, "A6c: entry NaN → inválido");
  ok(computeLadderLevels(40000, 40000, 40180, "BUY").valid === false, "A6d: sl==entry → inválido");
}

{
  // A7: sin estructural (null) → tp3 = 3R exacto (degradación = pre-P1)
  const r = computeLadderLevels(40000, 39900, null, "BUY");
  ok(r.valid === false, "A7: null → sin ladder");
  ok(Math.abs(r.tp3 - 40300) < 1e-9, "A7: tp3 = 3R (idéntico a comportamiento pre-P1)", r.tp3);
  ok(Math.abs(ladderFinalTakeProfit(40000, 39900, null, "BUY") - 40300) < 1e-9, "A7: ladderFinalTakeProfit = 3R");
  ok(Math.abs(ladderFinalTakeProfit(40000, 39900, 40180, "BUY") - 40300) < 1e-9, "A7: con estructural 1.8R el broker TP sigue siendo 3R");
}

// ════════════════════════════════════════════════════════════
// B. VOLÚMENES
// ════════════════════════════════════════════════════════════
section("B · Volúmenes (computeLadder)");

{
  const l = computeLadder({ entry: 40000, sl: 39900, structuralTp: 40180, direction: "BUY", totalVolume: 1.0, volumeStep: 0.01, volumeMin: 0.01 });
  ok(l.valid === true && l.levels.length === 3, "B1: 1.0 lote → 3 niveles");
  ok(Math.abs(l.levels[0].volume - 0.5) < 1e-9 && Math.abs(l.levels[1].volume - 0.3) < 1e-9 && Math.abs(l.levels[2].volume - 0.2) < 1e-9, "B1: 0.5/0.3/0.2", l.levels.map((x: { volume: number }) => x.volume).join("/"));
  ok(Math.abs(l.levels.reduce((s: number, x: { volume: number }) => s + x.volume, 0) - 1.0) < 1e-9, "B1: la suma conserva el volumen total");
  ok(Math.abs(l.beLevel - 40000) < 1e-9, "B1: BE = entrada");
}

{
  // B2: 0.06 con min 0.01 — 0.018 hace floor a 0.01 (≥ min) → se mantienen 3 niveles
  const l = computeLadder({ entry: 40000, sl: 39900, structuralTp: 40180, direction: "BUY", totalVolume: 0.06, volumeStep: 0.01, volumeMin: 0.01 });
  ok(l.valid === true && l.levels.length === 3, "B2: 0.06 → 3 niveles (0.01 ≥ min)", l.levels.length);
  ok(Math.abs(l.levels[0].volume - 0.03) < 1e-9 && Math.abs(l.levels[1].volume - 0.01) < 1e-9 && Math.abs(l.levels[2].volume - 0.02) < 1e-9, "B2: 0.03/0.01/0.02", l.levels.map((x: { volume: number }) => x.volume).join("/"));
}

{
  // B2b: degradación real — 0.02 con min 0.01 → nivel 2 (0.006→0) cede al runner
  const l = computeLadder({ entry: 40000, sl: 39900, structuralTp: 40180, direction: "BUY", totalVolume: 0.02, volumeStep: 0.01, volumeMin: 0.01 });
  ok(l.valid === true && l.levels.length === 2, "B2b: degradación a 2 niveles", l.levels.length);
  ok(Math.abs(l.levels[0].volume - 0.01) < 1e-9 && Math.abs(l.levels[1].volume - 0.01) < 1e-9, "B2b: 0.01/0.01", l.levels.map((x: { volume: number }) => x.volume).join("/"));
}

{
  // B3: colapso honesto — 0.01 con min 0.01 → sin parciales posibles
  const l = computeLadder({ entry: 40000, sl: 39900, structuralTp: 40180, direction: "BUY", totalVolume: 0.01, volumeStep: 0.01, volumeMin: 0.01 });
  ok(l.valid === false, "B3: volumen insuficiente → ladder inválido");
  ok(/volumen/i.test(l.reason), "B3: razón menciona volumen", l.reason);
}

{
  // B4: step grueso — short coherente (sl por ENCIMA de la entrada)
  const l = computeLadder({ entry: 40000, sl: 40100, structuralTp: 39820, direction: "SELL", totalVolume: 10, volumeStep: 1, volumeMin: 1 });
  ok(l.valid === true && l.levels.length === 3, "B4: step=1 → 5/3/2");
  ok(Math.abs(l.levels[0].volume - 5) < 1e-9 && Math.abs(l.levels[1].volume - 3) < 1e-9 && Math.abs(l.levels[2].volume - 2) < 1e-9, "B4: 5/3/2", l.levels.map((x: { volume: number }) => x.volume).join("/"));
}

// ════════════════════════════════════════════════════════════
// C. SIGUIENTE ACCIÓN
// ════════════════════════════════════════════════════════════
section("C · Siguiente acción (nextLadderAction)");

const LADDER3 = computeLadder({ entry: 40000, sl: 39900, structuralTp: 40180, direction: "BUY", totalVolume: 1.0, volumeStep: 0.01, volumeMin: 0.01 });
const LADDER3S = computeLadder({ entry: 40000, sl: 40100, structuralTp: 39820, direction: "SELL", totalVolume: 1.0, volumeStep: 0.01, volumeMin: 0.01 });

{
  const v = nextLadderAction({
    executionId: "x", direction: "BUY", entry: 40000, sl: 39900,
    exitDeals: 0, maxSuccessLevel: -1, ladder: LADDER3,
    position: { ticket: 777, volume: 1.0, currentPrice: 40100, sl: 39900, tp: 40300 },
  });
  ok(v.action === "none", "C1: precio no tocó tp1 → none", v.reason);
}

{
  const v = nextLadderAction({
    executionId: "x", direction: "BUY", entry: 40000, sl: 39900,
    exitDeals: 0, maxSuccessLevel: -1, ladder: LADDER3,
    position: { ticket: 777, volume: 1.0, currentPrice: 40180, sl: 39900, tp: 40300 },
  });
  ok(v.action === "partial_close_and_be", "C2: tp1 tocado → parcial + BE", v.action);
  ok(Math.abs(v.volume - 0.5) < 1e-9, "C2: cierra 0.5 (50%)", v.volume);
  ok(Math.abs((v.newSl ?? 0) - 40000) < 1e-9, "C2: SL→BE (40000)", v.newSl);
}

{
  // C3: SL ya en BE → parcial SIN mover SL (nunca atrás)
  const v = nextLadderAction({
    executionId: "x", direction: "BUY", entry: 40000, sl: 39900,
    exitDeals: 0, maxSuccessLevel: -1, ladder: LADDER3,
    position: { ticket: 777, volume: 1.0, currentPrice: 40190, sl: 40000, tp: 40300 },
  });
  ok(v.action === "partial_close", "C3: SL ya en BE → solo parcial", v.action);
  ok(v.newSl === undefined, "C3: no re-aplica BE");
}

{
  // C4: SL mejor que BE → tampoco se toca
  const v = nextLadderAction({
    executionId: "x", direction: "BUY", entry: 40000, sl: 39900,
    exitDeals: 0, maxSuccessLevel: -1, ladder: LADDER3,
    position: { ticket: 777, volume: 1.0, currentPrice: 40190, sl: 40150, tp: 40300 },
  });
  ok(v.action === "partial_close" && v.newSl === undefined, "C4: SL en beneficio → intacto");
}

{
  const v = nextLadderAction({
    executionId: "x", direction: "BUY", entry: 40000, sl: 39900,
    exitDeals: 1, maxSuccessLevel: 0, ladder: LADDER3,
    position: { ticket: 777, volume: 0.5, currentPrice: 40230, sl: 40000, tp: 40300 },
  });
  ok(v.action === "partial_close" && Math.abs(v.volume - 0.3) < 1e-9, "C5: 1 exit deal + tp2 → cierra 0.3", `${v.action} ${v.volume}`);
}

{
  const v = nextLadderAction({
    executionId: "x", direction: "BUY", entry: 40000, sl: 39900,
    exitDeals: 2, maxSuccessLevel: 1, ladder: LADDER3,
    position: { ticket: 777, volume: 0.2, currentPrice: 40300, sl: 40000, tp: 40300 },
  });
  ok(v.action === "partial_close_full" && Math.abs(v.volume - 0.2) < 1e-9, "C6: 2 exits + tp3 → cierre total del runner", `${v.action} ${v.volume}`);
}

{
  const v = nextLadderAction({
    executionId: "x", direction: "BUY", entry: 40000, sl: 39900,
    exitDeals: 3, maxSuccessLevel: 2, ladder: LADDER3,
    position: { ticket: 777, volume: 0.2, currentPrice: 40350, sl: 40000, tp: 40300 },
  });
  ok(v.action === "none", "C7: 3 exits → todos consumidos (runner lo cierra el broker)", v.reason);
}

{
  // C8: dedupe por evento de éxito — deal aún no visible pero TP1 ya ejecutado
  const v = nextLadderAction({
    executionId: "x", direction: "BUY", entry: 40000, sl: 39900,
    exitDeals: 0, maxSuccessLevel: 0, ladder: LADDER3,
    position: { ticket: 777, volume: 1.0, currentPrice: 40185, sl: 39900, tp: 40300 },
  });
  ok(v.action === "none", "C8: TP1 con éxito pendiente de deal → NO reenvía (dedupe)", v.reason);
}

{
  // C9: short — trigger con ask ≤ tp1
  const vHit = nextLadderAction({
    executionId: "x", direction: "SELL", entry: 40000, sl: 40100,
    exitDeals: 0, maxSuccessLevel: -1, ladder: LADDER3S,
    position: { ticket: 778, volume: 1.0, currentPrice: 39820, sl: 40100, tp: 39700 },
  });
  ok(vHit.action === "partial_close_and_be" && Math.abs((vHit.newSl ?? 0) - 40000) < 1e-9, "C9: short tp1 → parcial + BE", vHit.action);
  const vNo = nextLadderAction({
    executionId: "x", direction: "SELL", entry: 40000, sl: 40100,
    exitDeals: 0, maxSuccessLevel: -1, ladder: LADDER3S,
    position: { ticket: 778, volume: 1.0, currentPrice: 39900, sl: 40100, tp: 39700 },
  });
  ok(vNo.action === "none", "C9: short sin tocar → none", vNo.reason);
}

{
  // C10: fail-closed ante datos hostiles
  ok(nextLadderAction({ executionId: "x", direction: "BUY", entry: 40000, sl: 39900, exitDeals: 0, maxSuccessLevel: -1, ladder: { valid: false, reason: "x", levels: [], beLevel: 40000, structuralRr: NaN }, position: { ticket: 777, volume: 1, currentPrice: 40200, sl: 39900, tp: 40300 } }).action === "none", "C10a: ladder inválido → none");
  ok(nextLadderAction({ executionId: "x", direction: "BUY", entry: 40000, sl: 39900, exitDeals: 0, maxSuccessLevel: -1, ladder: LADDER3, position: null }).action === "none", "C10b: sin posición → none");
  ok(nextLadderAction({ executionId: "x", direction: "BUY", entry: 40000, sl: 39900, exitDeals: 0, maxSuccessLevel: -1, ladder: LADDER3, position: { ticket: 777, volume: 1, currentPrice: NaN, sl: 39900, tp: 40300 } }).action === "none", "C10c: precio NaN → none");
  ok(nextLadderAction({ executionId: "x", direction: "BUY", entry: 40000, sl: 39900, exitDeals: 0, maxSuccessLevel: -1, ladder: LADDER3, position: { ticket: 777, volume: 0, currentPrice: 40200, sl: 39900, tp: 40300 } }).action === "none", "C10d: volumen 0 → none");
}

{
  // C11: volumen vivo menor que el nivel → cierre TOTAL de lo que queda
  const v = nextLadderAction({
    executionId: "x", direction: "BUY", entry: 40000, sl: 39900,
    exitDeals: 1, maxSuccessLevel: 0, ladder: LADDER3,
    position: { ticket: 777, volume: 0.25, currentPrice: 40230, sl: 40000, tp: 40300 },
  });
  ok(v.action === "partial_close_full" && Math.abs(v.volume - 0.25) < 1e-9, "C11: vivo 0.25 < nivel 0.3 → cierra TODO el resto", `${v.action} ${v.volume}`);
}

// ════════════════════════════════════════════════════════════
// D. TP ESTRUCTURAL DESDE strategy_context
// ════════════════════════════════════════════════════════════
section("D · extractEngineStructuralTp (coherencia de origen)");

{
  const json = JSON.stringify({ engine: "STRATEGY_ENGINE_V1.0", mode: "source", signal: { direction: "long", tp: { price: 40180, liquidityRef: "london_high", rr: 1.8 } } });
  ok(extractEngineStructuralTp(json, "BUY") === 40180, "D1: source + long + BUY → 40180");
  ok(extractEngineStructuralTp(json, "SELL") === null, "D2: dirección distinta → null (contaminación bloqueada)");
  const shadow = JSON.stringify({ mode: "shadow", signal: { direction: "long", tp: { price: 40180 } } });
  ok(extractEngineStructuralTp(shadow, "BUY") === null, "D3: modo shadow → null (el plan es del LLM)");
  ok(extractEngineStructuralTp(null, "BUY") === null, "D4: sin contexto → null");
  ok(extractEngineStructuralTp("{json roto", "BUY") === null, "D5: JSON hostil → null (fail-closed)");
  const sinTp = JSON.stringify({ mode: "source", signal: { direction: "long", tp: null } });
  ok(extractEngineStructuralTp(sinTp, "BUY") === null, "D6: signal sin TP → null");
}

// ════════════════════════════════════════════════════════════
// E. ORQUESTACIÓN (processTpLadders con executors stub)
// ════════════════════════════════════════════════════════════
section("E · processTpLadders (executors inyectables)");

{
  const closes: Array<[number, number]> = [];
  const sls: Array<[number, number]> = [];
  const events: Array<{ id: string; level: number }> = [];
  const outcomes = await processTpLadders({
    candidates: [{
      executionId: "e1", direction: "BUY", entry: 40000, sl: 39900, structuralTp: 40180,
      totalVolume: 1.0, exitDeals: 0, maxSuccessLevel: -1, positionTicket: 777,
    }],
    positions: new Map([[777, { ticket: 777, volume: 1.0, currentPrice: 40180, sl: 39900, tp: 40300 }]]),
    volumeRules: new Map([["US30", { volumeMin: 0.01, volumeStep: 0.01 }]]),
    symbolByExecution: new Map([["e1", "US30"]]),
    closeExecutor: async (t, v) => { closes.push([t, v]); return { ok: true }; },
    slExecutor: async (t, sl) => { sls.push([t, sl]); return { ok: true }; },
    recordEvent: (id, level) => { events.push({ id, level }); },
  });
  ok(outcomes.length === 1 && outcomes[0].applied === true, "E1: acción aplicada");
  ok(outcomes[0].action === "partial_close_and_be", "E1: parcial + BE", outcomes[0].action);
  ok(closes.length === 1 && closes[0][0] === 777 && Math.abs(closes[0][1] - 0.5) < 1e-9, "E1: close(777, 0.5)", JSON.stringify(closes));
  ok(sls.length === 1 && Math.abs(sls[0][1] - 40000) < 1e-9, "E1: modify(777, sl=40000)", JSON.stringify(sls));
  ok(events.length === 1 && events[0].id === "e1" && events[0].level === 0, "E1: evento de éxito grabado SOLO tras confirmación");
}

{
  // E2: fallo del closeExecutor (bridge caído) → sin evento, reintenta luego
  const events: unknown[] = [];
  const outcomes = await processTpLadders({
    candidates: [{
      executionId: "e2", direction: "BUY", entry: 40000, sl: 39900, structuralTp: 40180,
      totalVolume: 1.0, exitDeals: 0, maxSuccessLevel: -1, positionTicket: 888,
    }],
    positions: new Map([[888, { ticket: 888, volume: 1.0, currentPrice: 40180, sl: 39900, tp: 40300 }]]),
    volumeRules: new Map([["US30", { volumeMin: 0.01, volumeStep: 0.01 }]]),
    symbolByExecution: new Map([["e2", "US30"]]),
    closeExecutor: async () => { throw new Error("MT5 Bridge no disponible"); },
    slExecutor: async () => { throw new Error("no debería llegar aquí"); },
    recordEvent: () => { events.push(1); },
  });
  ok(outcomes.length === 1 && outcomes[0].applied === false && outcomes[0].error !== undefined, "E2: error tolerado, no lanza");
  ok(events.length === 0, "E2: SIN evento de éxito (el fallo se reintenta en el próximo ciclo)");
}

{
  // E3: idempotencia ×5 — mismo contexto consumido ⇒ cero acciones extra
  let calls = 0;
  for (let i = 0; i < 5; i++) {
    await processTpLadders({
      candidates: [{
        executionId: "e3", direction: "BUY", entry: 40000, sl: 39900, structuralTp: 40180,
        totalVolume: 1.0, exitDeals: 3, maxSuccessLevel: 2, positionTicket: 999,
      }],
      positions: new Map([[999, { ticket: 999, volume: 0.2, currentPrice: 40350, sl: 40000, tp: 40300 }]]),
      volumeRules: new Map([["US30", { volumeMin: 0.01, volumeStep: 0.01 }]]),
      symbolByExecution: new Map([["e3", "US30"]]),
      closeExecutor: async () => { calls++; return {}; },
      slExecutor: async () => {},
      recordEvent: () => {},
    });
  }
  ok(calls === 0, "E3: 5 ciclos con ladder consumido → 0 cierres (idempotente)", calls);
}

{
  // E4: gap del broker — posición ya no existe (TP cerró todo) → none honesto
  const outcomes = await processTpLadders({
    candidates: [{
      executionId: "e4", direction: "BUY", entry: 40000, sl: 39900, structuralTp: 40180,
      totalVolume: 1.0, exitDeals: 0, maxSuccessLevel: -1, positionTicket: 111,
    }],
    positions: new Map(), // el broker la cerró
    volumeRules: new Map([["US30", { volumeMin: 0.01, volumeStep: 0.01 }]]),
    symbolByExecution: new Map([["e4", "US30"]]),
    closeExecutor: async () => { throw new Error("NUNCA"); },
    slExecutor: async () => {},
    recordEvent: () => {},
  });
  ok(outcomes.length === 1 && outcomes[0].action === "none" && /posición/i.test(outcomes[0].reason), "E4: sin posición viva → none (reconciliación decidirá)", outcomes[0].reason);
}

{
  // E5: reglas de volumen faltantes → fail-closed explícito
  const outcomes = await processTpLadders({
    candidates: [{
      executionId: "e5", direction: "BUY", entry: 40000, sl: 39900, structuralTp: 40180,
      totalVolume: 1.0, exitDeals: 0, maxSuccessLevel: -1, positionTicket: 222,
    }],
    positions: new Map([[222, { ticket: 222, volume: 1, currentPrice: 40200, sl: 39900, tp: 40300 }]]),
    volumeRules: new Map(), // symbol_info no disponible
    symbolByExecution: new Map([["e5", "UNKNOWN_SYMBOL"]]),
    closeExecutor: async () => { throw new Error("NUNCA"); },
    slExecutor: async () => {},
    recordEvent: () => {},
  });
  ok(outcomes[0].action === "none" && /fail-closed/.test(outcomes[0].reason), "E5: sin volume rules → fail-closed", outcomes[0].reason);
}

// ════════════════════════════════════════════════════════════
// F. INTEGRACIÓN DB REAL (temporal)
// ════════════════════════════════════════════════════════════
section("F · Integración con SQLite temporal");

if (fs.existsSync(DB_FILE)) fs.rmSync(DB_FILE);
fs.mkdirSync(TMP_DIR, { recursive: true });

const { createExecutionForDecision, attachExecutionOrderTicket } = await import("../src/execution/registry.js");
const { default: db } = await import("../src/database/sqlite.js");
const sqlite = await import("../src/database/sqlite.js");

{
  // F1: selección de candidatas — solo FILLED/OPEN/PARTIALLY_* con ticket
  const eOpen = createExecutionForDecision({ symbol: "US30", direction: "BUY", orderType: "BUY_LIMIT", requestedVolume: 1.0, requestedPrice: 40000, stopLoss: 39900, takeProfit: 40300 });
  const eClosed = createExecutionForDecision({ symbol: "US30", direction: "SELL", orderType: "SELL_LIMIT", requestedVolume: 1.0, requestedPrice: 40000, stopLoss: 40100, takeProfit: 39700 });
  const eNoTicket = createExecutionForDecision({ symbol: "US30", direction: "BUY", orderType: "BUY_LIMIT", requestedVolume: 1.0, requestedPrice: 40000, stopLoss: 39900, takeProfit: 40300 });

  attachExecutionOrderTicket(eOpen.execution_id, 900001, 10009);
  attachExecutionOrderTicket(eClosed.execution_id, 900002, 10009);
  attachExecutionOrderTicket(eNoTicket.execution_id, 900003, 10008);

  // Abrimos eOpen (FILLED+posición), cerramos eClosed (CLOSED), eNoTicket queda UNKNOWN sin posición
  db.prepare(`UPDATE executions SET execution_status='FILLED', position_ticket=777, executed_volume=1.0 WHERE execution_id=?`).run(eOpen.execution_id);
  db.prepare(`UPDATE executions SET execution_status='CLOSED', position_ticket=778, executed_volume=1.0 WHERE execution_id=?`).run(eClosed.execution_id);

  const cands = sqlite.getExecutionsForLadder(25);
  ok(cands.length === 1, "F1: solo la FILLED con posición es candidata", cands.map((c: { execution_id: string }) => c.execution_id).join(","));
  ok(cands[0]?.execution_id === eOpen.execution_id, "F1: es eOpen");
  ok(cands[0]?.position_ticket === 777, "F1: position_ticket = 777");
}

{
  // F2: evidencia — deals exit y eventos definen el nivel consumido
  const e = createExecutionForDecision({ symbol: "XAUUSD", direction: "BUY", orderType: "BUY_LIMIT", requestedVolume: 0.3, requestedPrice: 2400, stopLoss: 2388, takeProfit: 2421.6 });
  db.prepare(`UPDATE executions SET execution_status='OPEN', position_ticket=555, executed_volume=0.3 WHERE execution_id=?`).run(e.execution_id);
  const inserted1 = sqlite.insertExecutionDeal({ executionId: e.execution_id, dealTicket: 555001, positionTicket: 555, role: "entry", symbol: "XAUUSD", direction: "buy", volume: 0.3, price: 2400, profit: 0 });
  const inserted2 = sqlite.insertExecutionDeal({ executionId: e.execution_id, dealTicket: 555002, positionTicket: 555, role: "exit", symbol: "XAUUSD", direction: "sell", volume: 0.15, price: 2421.6, profit: 3.24, closeCause: "TP_CLOSE" });
  ok(inserted1 === true && inserted2 === true, "F2: deals insertados");
  ok(sqlite.getExecutionDeals(e.execution_id).filter((d: { role: string }) => d.role === "exit").length === 1, "F2: 1 exit deal persistido");

  sqlite.appendExecutionEvent(e.execution_id, "TP_LADDER_PARTIAL", { reason: "nivel 0", evidenceJson: JSON.stringify({ level: 0, volume: 0.15 }) });
  const evs = sqlite.getExecutionEvents(e.execution_id);
  ok(evs.some((ev: { event: string }) => ev.event === "TP_LADDER_PARTIAL"), "F2: evento TP_LADDER_PARTIAL persistido");

  // Idempotencia del deal: INSERT OR IGNORE por UNIQUE(deal_ticket)
  const dup = sqlite.insertExecutionDeal({ executionId: e.execution_id, dealTicket: 555002, positionTicket: 555, role: "exit", symbol: "XAUUSD", direction: "sell", volume: 0.15, price: 2421.6, profit: 3.24 });
  ok(dup === false, "F2: deal duplicado rechazado (UNIQUE)");
}

{
  // F3: settlement sin bridge → TP Ladder diferido fail-closed (nada se rompe)
  const { runSettlement } = await import("../src/agent/settlement.js");
  const summary = await runSettlement(5);
  ok(typeof summary.ladderActions === "number" && summary.ladderActions === 0, "F3: sin bridge → ladderActions = 0", summary.ladderActions);
  ok(summary.details.some((d: string) => /TP Ladder diferido/.test(d)), "F3: detalle 'TP Ladder diferido' presente (broker TP acota)", summary.details.find((d: string) => /Ladder/.test(d)));
}

// ── Resumen ─────────────────────────────────────────────────
console.log(`\n════════════════════════════════════════════`);
console.log(`🪜 TP LADDER: ${passed} asserts OK, ${failed} fallos`);
if (fs.existsSync(DB_FILE)) fs.rmSync(DB_FILE);
process.exit(failed > 0 ? 1 : 0);
