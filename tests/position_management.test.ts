// Tests de Task 11-a (node:test, providers FALSOS inyectados, sin MT5 ni red):
// - Gestor de posiciones (position_manager.ts): niveles TP1/TP2 (1R/2R),
//   regla de protección (BE al tocar nivel, default BE_AT_TP2 / modo
//   LOCK_TP1), SL nunca retrocede, fail-closed con datos incompletos y
//   executor inyectable tolerante a fallos por posición.
// - Tabla única de SL por activo (asset_risk_table.ts): matching por
//   subcadena de variantes de símbolos y null honesto para desconocidos.
// Estilo basado en tests/risk_smc.test.ts (asserts ✅ contables + setup de
// env ANTES de los imports dinámicos de ESM).
import { test, after } from "node:test";
import type { PositionSnapshot } from "../src/agent/position_manager.js";
import fs from "node:fs";

// El modo se lee al cargar el módulo: garantizar el default BE_AT_TP2
delete process.env.POSITION_PROTECTION_MODE;

// Imports dinámicos: los static de ESM se hoistean ANTES del setup de env
const {
  POSITION_PROTECTION_MODE,
  computeProtectionLevels,
  evaluateProtection,
  evaluateProtectionForMode,
  processOpenPositions,
} = await import("../src/agent/position_manager.js");
const { ASSET_SL_TABLE, getSlForSymbol } = await import("../src/config/asset_risk_table.js");

function assert(cond: boolean, msg: string) {
  // writeSync: inmune al buffer perdido (mismo patrón que risk_smc.test.ts).
  // El throw marca el test como fallido para el runner de node:test.
  const line = cond ? `   ✅ ${msg}\n` : `   ❌ FALLO: ${msg}\n`;
  fs.writeSync(1, line);
  if (!cond) throw new Error(`FALLO: ${msg}`);
}

// ── Fábricas de posiciones falsas (sin MT5 ni red) ──────────
// Long US30: 1R = 80 puntos → TP1 = 42080, TP2 = 42160
const longPos = (over: Partial<PositionSnapshot> = {}): PositionSnapshot => ({
  ticket: 1001,
  symbol: "US30",
  side: "long",
  entry: 42000,
  sl: 41920,
  tp: 42160,
  volume: 0.5,
  currentPrice: 42100,
  ...over,
});
// Short XAUUSD: 1R = 12 puntos → TP1 = 2388, TP2 = 2376
const shortPos = (over: Partial<PositionSnapshot> = {}): PositionSnapshot => ({
  ticket: 2001,
  symbol: "XAUUSD",
  side: "short",
  entry: 2400,
  sl: 2412,
  tp: 2376,
  volume: 0.1,
  currentPrice: 2390,
  ...over,
});

// ── 1. Niveles de protección TP1/TP2 ────────────────────────
test("position_manager · niveles TP1/TP2 (long y short)", () => {
  const lvl = computeProtectionLevels(longPos());
  assert(lvl !== null, "posición long con datos completos → niveles calculables");
  assert(lvl!.riskDistance === 80, `long: 1R = |42000-41920| = 80 (got ${lvl!.riskDistance})`);
  assert(lvl!.tp1 === 42080, `long: TP1 = entry + 1R = 42080 (got ${lvl!.tp1})`);
  assert(lvl!.tp2 === 42160, `long: TP2 = entry + 2R = 42160 (got ${lvl!.tp2})`);

  const lvlShort = computeProtectionLevels(shortPos());
  assert(lvlShort !== null && lvlShort.riskDistance === 12, `short: 1R = |2400-2412| = 12 (got ${lvlShort?.riskDistance})`);
  assert(lvlShort!.tp1 === 2388, `short: TP1 = entry − 1R = 2388 (got ${lvlShort!.tp1})`);
  assert(lvlShort!.tp2 === 2376, `short: TP2 = entry − 2R = 2376 (got ${lvlShort!.tp2})`);

  assert(computeProtectionLevels(longPos({ sl: 0 })) === null, "fail-closed: sl=0 → sin niveles (no hay 1R medible)");
  assert(computeProtectionLevels(longPos({ entry: 0 })) === null, "fail-closed: entry=0 → sin niveles");
  assert(computeProtectionLevels(longPos({ sl: 42000 })) === null, "fail-closed: sl === entry (1R=0) → sin niveles");
});

// ── 2. Trigger BE solo al tocar el nivel (default BE_AT_TP2) ─
test("position_manager · trigger BE solo al tocar el nivel (BE_AT_TP2 default)", () => {
  assert(POSITION_PROTECTION_MODE === "BE_AT_TP2", `modo por defecto = BE_AT_TP2 (env limpio) (got ${POSITION_PROTECTION_MODE})`);

  const below = evaluateProtection(longPos({ currentPrice: 42159.5 }));
  assert(below.action === "none", "long a 42159.5 (bajo TP2) → sin acción");
  assert(below.reason.includes("no ha tocado"), "reason honesta: nivel no tocado");

  const exact = evaluateProtection(longPos({ currentPrice: 42160 }));
  assert(exact.action === "move_sl_to_be", "long a 42160 (TP2 exacto) → mover SL a BE");
  assert(exact.reason.includes("42160"), "reason cita el nivel tocado (42160)");

  const beyond = evaluateProtection(longPos({ currentPrice: 42250 }));
  assert(beyond.action === "move_sl_to_be", "long a 42250 (más allá de TP2) → mover SL a BE");

  const shortBelow = evaluateProtection(shortPos({ currentPrice: 2376.5 }));
  assert(shortBelow.action === "none", "short a 2376.5 (sobre TP2) → sin acción");
  const shortExact = evaluateProtection(shortPos({ currentPrice: 2376 }));
  assert(shortExact.action === "move_sl_to_be", "short a 2376 (TP2 exacto) → mover SL a BE");
  const shortBeyond = evaluateProtection(shortPos({ currentPrice: 2350 }));
  assert(shortBeyond.action === "move_sl_to_be", "short a 2350 (más allá de TP2) → mover SL a BE");

  // En modo default el disparo es TP2: tocar TP1 NO basta
  const onlyTp1 = evaluateProtection(longPos({ currentPrice: 42080 }));
  assert(onlyTp1.action === "none", "BE_AT_TP2: precio tocó TP1 (42080) pero no TP2 → sin acción");
});

// ── 3. Modo alternativo LOCK_TP1 ────────────────────────────
test("position_manager · modo LOCK_TP1 dispara en TP1", () => {
  const atTp1 = evaluateProtectionForMode(longPos({ currentPrice: 42080 }), "LOCK_TP1");
  assert(atTp1.action === "move_sl_to_be", "LOCK_TP1: long a 42080 (TP1 exacto) → mover SL a BE");
  const justBelow = evaluateProtectionForMode(longPos({ currentPrice: 42079.9 }), "LOCK_TP1");
  assert(justBelow.action === "none", "LOCK_TP1: long a 42079.9 → sin acción");

  const shortAtTp1 = evaluateProtectionForMode(shortPos({ currentPrice: 2388 }), "LOCK_TP1");
  assert(shortAtTp1.action === "move_sl_to_be", "LOCK_TP1: short a 2388 (TP1 exacto) → mover SL a BE");
  const shortJustAbove = evaluateProtectionForMode(shortPos({ currentPrice: 2388.1 }), "LOCK_TP1");
  assert(shortJustAbove.action === "none", "LOCK_TP1: short a 2388.1 → sin acción");
});

// ── 4. SL nunca retrocede ───────────────────────────────────
test("position_manager · SL nunca retrocede (ya en BE o mejor → none)", () => {
  const atBe = evaluateProtection(longPos({ sl: 42000, currentPrice: 42160 }));
  assert(atBe.action === "none", "long ya en BE (sl=42000) tocando TP2 → none");
  assert(atBe.reason.includes("BE o mejor"), `reason: "ya está en BE o mejor" (got "${atBe.reason}")`);

  const better = evaluateProtection(longPos({ sl: 42100, currentPrice: 42300 }));
  assert(better.action === "none", "long con SL MEJOR que la entrada (sl=42100) → none");

  const shortBe = evaluateProtection(shortPos({ sl: 2400, currentPrice: 2376 }));
  assert(shortBe.action === "none", "short ya en BE (sl=2400) tocando TP2 → none");

  const shortBetter = evaluateProtection(shortPos({ sl: 2394, currentPrice: 2370 }));
  assert(shortBetter.action === "none", "short con SL MEJOR que la entrada (sl=2394) → none");

  // La acción propuesta SIEMPRE mueve el SL a favor (hacia la entrada):
  // para un long el nuevo SL (entry) es mayor que el actual; para short, menor.
  const move = evaluateProtection(longPos({ currentPrice: 42160 }));
  assert(
    move.action === "move_sl_to_be" && move.reason.includes("SL 41920") && move.reason.includes("break-even 42000"),
    "long: el SL solo se mueve de 41920 HACIA la entrada 42000 (a favor)"
  );
});

// ── 5. Fail-closed con datos incompletos ────────────────────
test("position_manager · fail-closed con datos incompletos (nunca lanza)", () => {
  const noSl = evaluateProtection(longPos({ sl: 0 }));
  assert(noSl.action === "none" && noSl.reason.includes("SL ausente"), `sl=0 → none con reason explícito (got "${noSl.reason}")`);

  const noEntry = evaluateProtection(longPos({ entry: 0 }));
  assert(noEntry.action === "none" && noEntry.reason.includes("entrada"), "entry=0 → none con reason explícito");

  const noPrice = evaluateProtection(longPos({ currentPrice: NaN }));
  assert(noPrice.action === "none" && noPrice.reason.includes("precio actual"), "currentPrice=NaN → none con reason explícito");

  const badSide = evaluateProtection(longPos({ side: "raro" as unknown as "long" }));
  assert(badSide.action === "none" && badSide.reason.includes("side inválido"), "side inválido → none con reason explícito");

  const ghost = evaluateProtection(null as unknown as PositionSnapshot);
  assert(ghost.action === "none", "posición null → none (no lanza)");

  const empty = evaluateProtection({} as unknown as PositionSnapshot);
  assert(empty.action === "none", "posición {} → none (no lanza)");

  const infPrice = evaluateProtection(longPos({ currentPrice: Infinity }));
  assert(infPrice.action === "none", "currentPrice=Infinity → none (no lanza)");
});

// ── 6. Executor inyectable tolerante a fallos por posición ──
test("position_manager · processOpenPositions: executor inyectable, fallo aislado", async () => {
  const calls: Array<{ ticket: number; sl: number; tp: number }> = [];
  const attempts: number[] = [];
  const FAILING_TICKET = 1002;
  const executor = async (ticket: number, sl: number, tp: number) => {
    attempts.push(ticket);
    if (ticket === FAILING_TICKET) throw new Error("bridge 500: modificación rechazada por MT5");
    calls.push({ ticket, sl, tp });
    return { success: true };
  };

  const positions = [
    longPos({ ticket: 1001, currentPrice: 42200 }),               // toca TP2 → move OK
    longPos({ ticket: FAILING_TICKET, currentPrice: 42170 }),     // toca TP2 → executor FALLA
    shortPos({ ticket: 2003, currentPrice: 2370 }),               // toca TP2 → move OK
    longPos({ ticket: 1004, currentPrice: 42100 }),               // no toca → none, sin executor
  ];

  const outcomes = await processOpenPositions(positions, executor);
  assert(Array.isArray(outcomes) && outcomes.length === 4, "4 posiciones → 4 outcomes (el barrido no se aborta)");

  assert(outcomes[0].applied === true && outcomes[0].action === "move_sl_to_be", "p1: SL movido a BE (applied=true)");
  assert(outcomes[1].applied === false && typeof outcomes[1].error === "string", "p2: fallo del executor tolerado y reportado (applied=false + error)");
  assert(outcomes[2].applied === true, "p3: la posición tras el fallo SÍ se procesa (no se aborta el resto)");
  assert(outcomes[3].action === "none" && outcomes[3].applied === false && outcomes[3].error === undefined, "p4: sin toque de nivel → none sin llamar al executor");

  assert(attempts.length === 3 && attempts[1] === FAILING_TICKET && attempts[2] === 2003, `3 intentos de executor y el fallo de p2 NO aborta: p3 se intenta después (got ${JSON.stringify(attempts)})`);
  assert(calls.length === 2, `2 modificaciones exitosas (p4 excluida, p2 falló) (got ${calls.length})`);
  assert(
    calls[0].ticket === 1001 && calls[0].sl === 42000 && calls[0].tp === 42160,
    "executor recibe (ticket, entry como SL-BE, tp sin cambios) para p1"
  );
  assert(calls[1].ticket === 2003 && calls[1].sl === 2400 && calls[1].tp === 2376, "p3 (short): SL→entry 2400, TP mantenido");
  assert(outcomes[1].reason.includes("Regla de protección"), "el outcome del fallo conserva la razón de la acción intentada");

  assert((await processOpenPositions([], executor)).length === 0, "cartera vacía → 0 outcomes");
  assert((await processOpenPositions(null as unknown as PositionSnapshot[], executor)).length === 0, "input no-lista → fail-closed vacío (no lanza)");
});

// ── 7. Tabla única de SL por activo ─────────────────────────
test("asset_risk_table · matching de variantes de símbolos y null honesto", () => {
  assert(ASSET_SL_TABLE["US30"].sl === 80 && ASSET_SL_TABLE["US30"].unit === "puntos", "tabla: US30 = 80 puntos");
  assert(ASSET_SL_TABLE["NAS100"].sl === 20, "tabla: NAS100 = 20 pips");
  assert(ASSET_SL_TABLE["XAUUSD"].sl === 12, "tabla: XAUUSD = 12 puntos");
  assert(ASSET_SL_TABLE["GBPJPY"].sl === 20, "tabla: GBPJPY = 20 pips (JPY 0.01)");
  assert(ASSET_SL_TABLE["BTCUSD"].sl === 500, "tabla: BTCUSD = 500 USD");

  assert(getSlForSymbol("US30") === 80, "US30 → 80");
  assert(getSlForSymbol("US30Cash") === 80, "variante US30Cash → 80");
  assert(getSlForSymbol("us30.v") === 80, "variante us30.v (case-insensitive) → 80");
  assert(getSlForSymbol("NAS100.cash") === 20, "variante NAS100.cash → 20");
  assert(getSlForSymbol("USTEC") === 20, "alias USTEC → 20");
  assert(getSlForSymbol("XAUUSD.a") === 12, "variante XAUUSD.a → 12");
  assert(getSlForSymbol("GOLD") === 12, "alias GOLD → 12");
  assert(getSlForSymbol("gold.v") === 12, "variante gold.v (case-insensitive) → 12");
  assert(getSlForSymbol("GBPJPY") === 20, "GBPJPY → 20");
  assert(getSlForSymbol("GBPJPY.v") === 20, "variante GBPJPY.v → 20");
  assert(getSlForSymbol("BTCUSD.m") === 500, "variante BTCUSD.m → 500");
  assert(getSlForSymbol("BITCOIN") === 500, "alias BITCOIN → 500");

  assert(getSlForSymbol("SPX500") === null, "desconocido SPX500 → null (fail-closed, no adivina)");
  assert(getSlForSymbol("EURUSD") === null, "desconocido EURUSD → null");
  assert(getSlForSymbol("SIMBOLO_RARO") === null, "desconocido SIMBOLO_RARO → null");
  assert(getSlForSymbol("") === null, "símbolo vacío → null");
  assert(getSlForSymbol(undefined as unknown as string) === null, "undefined → null (no lanza)");
});

after(() => {
  fs.writeSync(1, "\n🧪 Position management test completo (node:test).\n");
});
