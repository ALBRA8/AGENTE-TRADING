// ============================================================
// tests/e2e_pipeline.ts — PROMPT 06 §25: E2E OBLIGATORIO
// Pipeline completo (gates → debate → manager → planner → riesgo →
// policy → hard-gate → orden) SIN APIs externas:
//
//   · MOCK BRIDGE HTTP (node:http en 127.0.0.1:puerto aleatorio): health,
//     price, candles (zigzag alcista sintético de tests/risk_smc.test.ts),
//     symbol_info, account, positions, orders y POST /order que REGISTRA
//     cada envío en `ordersReceived` (el árbitro de "¿llegó al broker?").
//   · LLM_PROVIDER=mock (§16): fixtures deterministas de nvidia.ts.
//   · Tavily interceptado a nivel globalThis.fetch (respuesta vacía benigna
//     → gate news GREEN sin red).
//   · RELOJ CONGELADO (decisión documentada): checkMarketHours/analyzeMarket
//     usan `new Date()` SIN inyección (evaluateMarketHours es inyectable pero
//     los tools no lo están), así que la opción determinista más honesta es
//     sustituir el constructor global Date por uno cuyo `new Date()`/`now()`
//     devuelve SIEMPRE un MARTES 10:30 NY (2026-01-13 15:30 UTC) → killzone
//     NY activa y velas frescas por construcción. SQLite conserva su reloj
//     real: la ventana de 15 min del hard-gate escribe y lee con datetime()
//     de SQLite, coherente de punta a punta.
//
// Cubre: happy path (§25) + 10 escenarios de rechazo — cada uno debe
// terminar en NO TRADE (nada en ordersReceived del mock y/o orden no
// enviada): risk exceeded, stale data, missing SL, invalid size, daily
// loss, kill switch, approval missing, permission denied, broker
// unavailable y duplicate order (one-shot).
// ============================================================

import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";

// ── 0. Reloj congelado ANTES de cualquier import dinámico ──
const REAL_DATE = Date;
/** 2026-01-13 15:30 UTC = martes 10:30 America/New_York (EST, UTC-5) */
const FIXED_UTC_MS = REAL_DATE.UTC(2026, 0, 13, 15, 30, 0);

class FakeDate extends REAL_DATE {
  constructor(...args: unknown[]) {
    if (args.length === 0) {
      super(FIXED_UTC_MS);
    } else {
      super(...(args as any[]));
    }
  }
  static now(): number {
    return FIXED_UTC_MS;
  }
}
(globalThis as any).Date = FakeDate;

// ── Interceptación de Tavily (gate news GREEN sin APIs externas) ──
const realFetch: typeof globalThis.fetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url =
    typeof input === "string" ? input : (input?.url ?? String(input));
  if (String(url).includes("api.tavily.com")) {
    return new Response(
      JSON.stringify({
        results: [],
        answer: "Sin novedades macro de alto impacto (mock E2E)",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }
  return realFetch(input, init);
}) as typeof globalThis.fetch;

// ── Assert helper (fs.writeSync: inmune al quirk de salida de better-sqlite3) ──
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

// ── Mock Bridge HTTP ────────────────────────────────────────
type Candle = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  tickVolume: number;
  realVolume: number;
  spread: number;
};

const M5_MS = 5 * 60_000;
const END_SLOT = Math.floor(FIXED_UTC_MS / M5_MS) * M5_MS; // vela en curso abierta "ahora"

function candleTime(i: number, n: number): string {
  return new Date(END_SLOT - (n - 1 - i) * M5_MS).toISOString();
}

/** Vela sintética con cuerpo o->c y mechas simétricas (patrón risk_smc.test.ts) */
function mkCandle(i: number, o: number, c: number, tickVolume: number): Candle {
  return {
    time: candleTime(i, 90),
    open: o,
    high: Math.max(o, c) + 0.1,
    low: Math.min(o, c) - 0.1,
    close: c,
    tickVolume,
    realVolume: 0,
    spread: 2,
  };
}

/**
 * Serie alcista en zigzag determinista (copiada de tests/risk_smc.test.ts):
 * 10 velas de impulso (+0.3, volumen alto) + 6 de retroceso (−0.3, volumen
 * bajo), con micro-reversión en el giro para que el detector SMC real vea
 * swings limpios y BOS bullish.
 */
function buildRisingCandles(n: number): Candle[] {
  const candles: Candle[] = [];
  let price = 100;
  let o = price;
  for (let i = 0; i < n; i++) {
    const phase = i % 16;
    const impulse = phase < 10;
    if (i > 0) o = impulse ? price + 0.05 : price - 0.05;
    price = price + (impulse ? 0.3 : -0.3);
    const vol = impulse ? 2000 : 600;
    candles.push(mkCandle(i, o, price, vol));
  }
  // Última vela (en curso) con volumen muy alto → RVOL ≥ 1.5 GREEN determinista
  candles[candles.length - 1].tickVolume = 4000;
  return candles;
}

const BASE_CANDLES: Candle[] = buildRisingCandles(90);
const LAST_PRICE = BASE_CANDLES[BASE_CANDLES.length - 1].close;

const mockState = {
  stale: false, // escenario 2: velas de hace 2 días
  volumeMin: 0.01, // escenario 4: subir a 5 → below_min
};

const ordersReceived: any[] = [];

function currentCandles(): Candle[] {
  if (!mockState.stale) return BASE_CANDLES;
  return BASE_CANDLES.map((c) => ({
    ...c,
    time: new Date(Date.parse(c.time) - 2 * 86_400_000).toISOString(),
  }));
}

function symbolInfoPayload() {
  return {
    name: "US30",
    digits: 2,
    point: 0.01,
    trade_tick_value: 1,
    trade_tick_size: 0.01,
    volume_min: mockState.volumeMin,
    volume_max: 100,
    volume_step: 0.01,
    contract_size: 1,
    currency_profit: "USD",
    description: "Dow Jones E2E mock",
  };
}

const TICK = {
  symbol: "US30",
  bid: LAST_PRICE - 0.01,
  ask: LAST_PRICE + 0.01, // tiny spread: 0.02 ≤ MAX_SPREAD_PCT del guard
  spread: 0.02,
  digits: 2,
  time: new Date(FIXED_UTC_MS).toISOString(), // NUEVO (reloj congelado)
};

const ACCOUNT = {
  login: 505001,
  balance: 10000,
  equity: 10000,
  margin: 0,
  freeMargin: 10000,
  currency: "USD",
  leverage: 100,
  server: "E2E-Mock-Server",
};

const server = http.createServer((req, res) => {
  const respond = (code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const path = (req.url ?? "/").split("?")[0];
  const candlesMatch = path.match(/^\/candles\/([^/]+)\/([^/]+)\/(\d+)$/);

  if (req.method === "POST" && path === "/order") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: any = {};
      try {
        body = JSON.parse(raw);
      } catch {}
      ordersReceived.push({ ...body, receivedAt: new Date().toISOString() });
      respond(200, {
        success: true,
        ticket: 777,
        retcode: 10009,
        volume: body.volume,
        price: body.price,
        symbol: body.symbol,
        type: body.type,
        comment: "mock",
      });
    });
    return;
  }

  if (path === "/health") return respond(200, { status: "ok" });
  if (path.startsWith("/price/"))
    return respond(200, { ...TICK, symbol: path.slice("/price/".length) });
  if (candlesMatch) {
    const count = Math.max(1, parseInt(candlesMatch[3], 10) || 1);
    return respond(200, { candles: currentCandles().slice(-count) });
  }
  if (path.startsWith("/symbol_info/")) {
    const info = symbolInfoPayload();
    info.name = path.slice("/symbol_info/".length);
    return respond(200, info);
  }
  if (path === "/account") return respond(200, ACCOUNT);
  if (path === "/positions") return respond(200, { positions: [] });
  if (path === "/orders") return respond(200, { orders: [] });
  return respond(404, { error: `ruta no servida por el mock: ${path}` });
});

function startMock(): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

async function stopMock(): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), 1500);
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// ── DB temporal limpia ANTES de importar sqlite ──
const DB_PATH = "./data/e2e_test.db";
for (const f of [DB_PATH, `${DB_PATH}-journal`, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
  try {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  } catch {}
}

async function main() {
  // ── Arranque del mock + env ANTES de los imports dinámicos ──
  const PORT = await startMock();
  process.env.MT5_BRIDGE_URL = `http://127.0.0.1:${PORT}`;
  process.env.NVIDIA_API_KEY = "nvapi-e2e-dummy-not-real";
  process.env.LLM_PROVIDER = "mock";
  process.env.DB_PATH = DB_PATH;
  process.env.POLICY_MODE = "PAPER";
  process.env.KILL_SWITCH = "off";
  process.env.AUTONOMY_LEVEL = "2";
  process.env.AUTONOMY_CEILING = "2";
  process.env.ALLOWED_SYMBOLS = "US30,NAS100,XAUUSD,BTCUSD,GBPJPY";
  process.env.TAVILY_API_KEY = "tvly-e2e-dummy"; // el fetch a Tavily se intercepta
  delete process.env.LIVE_TRADING;
  delete process.env.MAX_DAILY_LOSS_PCT;

  // Imports dinámicos: los env deben estar asentados ANTES (los módulos leen
  // MT5_BRIDGE_URL/DB_PATH/TAVILY_API_KEY a nivel de módulo).
  const { default: db, saveDecision, getDecisionById, getOrderByDecisionId, claimDecision, getTodayRealizedPnl } =
    await import("../src/database/sqlite.js");
  const { runDecisionPipeline } = await import("../src/agent/pipeline.js");
  const { executeTradeMT5 } = await import("../src/agent/tools/execute_trade_mt5.js");
  const { evaluateMarketHours } = await import("../src/agent/tools/check_market_hours.js");
  const { isMockProvider, callLLMByTier } = await import("../src/config/nvidia.js");
  const {
    setKillSwitch,
    setPolicyMode,
    setAutonomyLevel,
    setAutonomyCeiling,
    initialApprovalStatus,
    getPolicy,
  } = await import("../src/agent/policy.js");

  fs.writeSync(1, `\n🧪 E2E §25 — mock bridge en ${process.env.MT5_BRIDGE_URL} · DB ${DB_PATH}\n\n`);

  // ── Sanidad del entorno simulado ──
  assert(isMockProvider(), "provider mock activo (LLM_PROVIDER=mock, §16)");
  const vh = evaluateMarketHours("US30", new Date());
  assert(
    vh.nyWeekday === "Tue" && vh.nyHour === 10 && vh.isNYKillzone,
    `reloj congelado → martes 10:30 NY killzone activa (got ${vh.nyWeekday} ${vh.nyHour}:00)`
  );
  const candles200 = await realFetch(`${process.env.MT5_BRIDGE_URL}/candles/US30/M5/200`).then((r) => r.json() as any);
  assert(candles200.candles.length === 90, `mock bridge sirve 90 velas zigzag (got ${candles200.candles.length})`);

  // Fail-safe §16: el mock jamás convive con trading real
  process.env.LIVE_TRADING = "true";
  let mockThrew = "";
  try {
    await callLLMByTier({ tier: "quick", system: "x", user: "y" });
  } catch (err) {
    mockThrew = (err as Error).message;
  }
  assert(
    mockThrew.includes("PROHIBIDO"),
    "fail-safe §16: LLM_PROVIDER=mock + LIVE_TRADING=true → error (no fixtures)"
  );
  delete process.env.LIVE_TRADING;

  // Helpers de escenario
  const settleFixture = (id: number, pnl: number) =>
    db
      .prepare(
        `UPDATE decision_log SET outcome_settled = 1, outcome_pnl = ?, outcome_timestamp = datetime('now') WHERE id = ?`
      )
      .run(pnl, id);
  const deleteDecisionRow = (id: number) =>
    db.prepare(`DELETE FROM decision_log WHERE id = ?`).run(id);

  // ═══════════════════════════════════════════════════════════
  // b. HAPPY PATH (§25)
  // ═══════════════════════════════════════════════════════════
  fs.writeSync(1, "── HAPPY PATH ──\n");
  const happy = await runDecisionPipeline({ userId: "e2e", symbol: "US30", timeframe: "M5" });
  assert(happy.finalAction === "EXECUTE", `pipeline happy path → EXECUTE (got ${happy.finalAction})`);
  assert(happy.markdown.includes("DECISIÓN FINAL: EXECUTE"), "markdown anuncia DECISIÓN FINAL: EXECUTE");
  const happyDec = getDecisionById(happy.decisionId);
  assert(
    !!happyDec && happyDec.final_action === "EXECUTE" && !!happyDec.policy_result,
    `decisión #${happy.decisionId} persistida con policy_result no nulo (${happyDec?.policy_result?.slice(0, 60)})`
  );
  assert(happyDec?.approval_status === "auto", "approval_status 'auto' en PAPER (§12)");
  const happyResp = await executeTradeMT5.execute({
    symbol: "US30",
    direction: "BUY",
    stopLossPips: 15,
    comment: "e2e",
  });
  assert(happyResp.includes("[DEMO]"), "respuesta [DEMO]: PAPER no envía la orden al broker (§10)");
  const happyOrder = getOrderByDecisionId(happy.decisionId);
  assert(happyOrder?.status === "demo", `trade_orders con status "demo" (got ${happyOrder?.status})`);
  assert(ordersReceived.length === 0, "§10: paper no toca el broker — ordersReceived VACÍO");
  assert(getTodayRealizedPnl() === 0, "orden demo no contamina el PnL del día");

  // ═══════════════════════════════════════════════════════════
  // c. ESCENARIOS DE RECHAZO
  // ═══════════════════════════════════════════════════════════

  // ── 1. RISK EXCEEDED: pérdida del día dispara el guard EN EL ENVÍO ──
  fs.writeSync(1, "\n── Rechazo 1 · risk exceeded (guard account_risk) ──\n");
  const r1Fixture = saveDecision({ symbol: "US30", finalAction: "EXECUTE", direction: "BUY", stopLossPips: 15, riskPct: 0.5, reasoning: "fixture e2e r1" });
  settleFixture(r1Fixture, -1000); // −1000 hoy sobre balance 10000
  process.env.LIVE_TRADING = "true"; // para que la orden llegue HASTA el guard
  const r1Dec = saveDecision({
    symbol: "US30", timeframe: "M5", finalAction: "EXECUTE", direction: "BUY",
    stopLossPips: 15, riskPct: 0.5, approvalStatus: initialApprovalStatus(), reasoning: "e2e r1",
  });
  const r1Resp = await executeTradeMT5.execute({ symbol: "US30", direction: "BUY", stopLossPips: 15, comment: "e2e-r1" });
  assert(
    r1Resp.includes("GUARD RECHAZÓ") && r1Resp.includes("PÉRDIDA DIARIA"),
    "guard bloquea EN EL PUNTO DE ENVÍO por pérdida diaria (§5 check 8)"
  );
  assert(ordersReceived.length === 0, "rechazo 1: NADA llegó al broker");
  delete process.env.LIVE_TRADING;
  deleteDecisionRow(r1Fixture);
  deleteDecisionRow(r1Dec);

  // ── 2. STALE DATA: velas de hace 2 días → price_feed/rvol UNKNOWN → no EXECUTE ──
  fs.writeSync(1, "\n── Rechazo 2 · stale data ──\n");
  mockState.stale = true;
  const r2 = await runDecisionPipeline({ userId: "e2e", symbol: "US30", timeframe: "M5" });
  assert(r2.finalAction === "WAIT", `velas stale → WAIT por filtros críticos UNKNOWN (got ${r2.finalAction})`);
  assert(
    r2.markdown.includes("price_feed") && r2.markdown.includes("Filtros críticos sin datos"),
    "gate price_feed/rvol UNKNOWN auditado en el markdown (fail-closed §6)"
  );
  mockState.stale = false;

  // ── 3. MISSING SL: orden sin SL (stopLossPips 0) → sanidad del tool ──
  fs.writeSync(1, "\n── Rechazo 3 · missing SL ──\n");
  saveDecision({
    symbol: "US30", timeframe: "M5", finalAction: "EXECUTE", direction: "BUY",
    stopLossPips: null, riskPct: 0.5, approvalStatus: initialApprovalStatus(), reasoning: "e2e r3",
  });
  const r3Resp = await executeTradeMT5.execute({ symbol: "US30", direction: "BUY", stopLossPips: 0, comment: "e2e-r3" });
  assert(r3Resp.includes("SL inválido"), "sanidad del tool rechaza stopLossPips=0 (§25) y libera la decisión");
  assert(ordersReceived.length === 0, "rechazo 3: NADA llegó al broker");

  // ── 4. INVALID SIZE: volume_min 5 del broker vs riesgo del plan → below_min ──
  fs.writeSync(1, "\n── Rechazo 4 · invalid size (below_min) ──\n");
  mockState.volumeMin = 5;
  saveDecision({
    symbol: "US30", timeframe: "M5", finalAction: "EXECUTE", direction: "BUY",
    stopLossPips: 15, riskPct: 0.5, approvalStatus: initialApprovalStatus(), reasoning: "e2e r4",
  });
  const r4Resp = await executeTradeMT5.execute({ symbol: "US30", direction: "BUY", stopLossPips: 15, comment: "e2e-r4" });
  assert(
    r4Resp.includes("lotaje mínimo"),
    "sizing below_min: ni el lote mínimo respeta el riesgo del plan → BLOQUEADA"
  );
  assert(ordersReceived.length === 0, "rechazo 4: NADA llegó al broker");
  mockState.volumeMin = 0.01;

  // ── 5. DAILY LOSS EXCEEDED: MAX_DAILY_LOSS_PCT=0.001 + pnl −200 → gate RED → ABORTED ──
  fs.writeSync(1, "\n── Rechazo 5 · daily loss exceeded (gate account_risk del pipeline) ──\n");
  process.env.MAX_DAILY_LOSS_PCT = "0.001";
  const r5Fixture = saveDecision({ symbol: "US30", finalAction: "EXECUTE", direction: "BUY", stopLossPips: 15, riskPct: 0.5, reasoning: "fixture e2e r5" });
  settleFixture(r5Fixture, -200);
  const r5 = await runDecisionPipeline({ userId: "e2e", symbol: "US30", timeframe: "M5" });
  assert(r5.finalAction === "ABORTED", `gate account_risk RED → pipeline ABORTA antes de gastar tokens (got ${r5.finalAction})`);
  assert(r5.markdown.includes("ABORTED") && r5.markdown.includes("account_risk"), "abort motivado por account_risk");
  delete process.env.MAX_DAILY_LOSS_PCT;
  deleteDecisionRow(r5Fixture);

  // ── 6. KILL SWITCH: pipeline degrada EXECUTE→WAIT y el tool bloquea por policy ──
  fs.writeSync(1, "\n── Rechazo 6 · kill switch activo ──\n");
  setKillSwitch("e2e:test", true, "escenario 6 del E2E §25");
  const r6 = await runDecisionPipeline({ userId: "e2e", symbol: "US30", timeframe: "M5" });
  assert(r6.finalAction === "WAIT", `kill switch → POLICY degrada EXECUTE→WAIT (got ${r6.finalAction})`);
  assert((getDecisionById(r6.decisionId)?.policy_result ?? "").includes("BLOCKED"), "policy_result BLOCKED auditado");
  saveDecision({
    symbol: "US30", timeframe: "M5", finalAction: "EXECUTE", direction: "BUY",
    stopLossPips: 15, riskPct: 0.5, approvalStatus: initialApprovalStatus(), reasoning: "e2e r6",
  });
  const r6Resp = await executeTradeMT5.execute({ symbol: "US30", direction: "BUY", stopLossPips: 15, comment: "e2e-r6" });
  assert(r6Resp.includes("KILL SWITCH ACTIVO"), "tool bloqueado por policy con kill switch activo (§9)");
  assert(ordersReceived.length === 0, "rechazo 6: NADA llegó al broker");
  setKillSwitch("e2e:test", false, "fin del escenario 6");

  // ── 7. APPROVAL MISSING: LIVE sin aprobación humana → policy block ──
  fs.writeSync(1, "\n── Rechazo 7 · approval missing (LIVE sin humano) ──\n");
  process.env.LIVE_TRADING = "true";
  process.env.POLICY_MODE = "LIVE";
  setAutonomyCeiling("e2e:test", 4, "escenario 7 del E2E §25");
  setAutonomyLevel("e2e:test", 4, "escenario 7 del E2E §25");
  const r7Dec = saveDecision({
    symbol: "US30", timeframe: "M5", finalAction: "EXECUTE", direction: "BUY",
    stopLossPips: 15, riskPct: 0.5,
    approvalStatus: initialApprovalStatus("LIVE"), // 'pending' — nadie aprobó
    reasoning: "e2e r7",
  });
  const r7Resp = await executeTradeMT5.execute({ symbol: "US30", direction: "BUY", stopLossPips: 15, comment: "e2e-r7" });
  assert(
    r7Resp.includes("POLICY") && r7Resp.includes("sin aprobación humana"),
    "LIVE con approval_status='pending' → BLOQUEADA por policy (§12 doble factor)"
  );
  assert(ordersReceived.length === 0, "rechazo 7: NADA llegó al broker (ni en LIVE sin aprobar)");
  // Restaurar: env fuera + eventos de policy limpiados (append-only → DELETE de test)
  delete process.env.LIVE_TRADING;
  delete process.env.POLICY_MODE;
  db.exec(`DELETE FROM policy_events`);
  assert(getPolicy().mode === "PAPER" && getPolicy().effectiveLevel === 2, "policy restaurada a PAPER L2 tras el escenario 7");

  // ── 8. PERMISSION DENIED: techo L2 → setPolicyMode("LIVE") THROWS ──
  fs.writeSync(1, "\n── Rechazo 8 · permission denied (techo de autonomía) ──\n");
  process.env.AUTONOMY_CEILING = "2";
  let r8Err = "";
  try {
    setPolicyMode("e2e:test", "LIVE", "escenario 8 del E2E §25");
  } catch (err) {
    r8Err = (err as Error).message;
  }
  assert(r8Err.includes("techo"), `setPolicyMode LIVE con techo L2 lanza: "${r8Err.slice(0, 70)}"`);
  assert(getPolicy().mode === "PAPER", "el modo NO cambió (el freno de dos llaves §19 sostiene)");
  delete process.env.AUTONOMY_CEILING;

  // ── 9. BROKER UNAVAILABLE: mock caído → health false → NO TRADE ──
  fs.writeSync(1, "\n── Rechazo 9 · broker unavailable ──\n");
  saveDecision({
    symbol: "US30", timeframe: "M5", finalAction: "EXECUTE", direction: "BUY",
    stopLossPips: 15, riskPct: 0.5, approvalStatus: initialApprovalStatus(), reasoning: "e2e r9",
  });
  await stopMock();
  const r9Resp = await executeTradeMT5.execute({ symbol: "US30", direction: "BUY", stopLossPips: 15, comment: "e2e-r9" });
  assert(r9Resp.includes("Bridge no disponible"), "health check false → el tool responde bridge caído y NO envía");
  assert(ordersReceived.length === 0, "rechazo 9: NADA llegó al broker");
  await startMock(); // reinicio: la decisión fue liberada, el mock vuelve a estar vivo

  // ── 10. DUPLICATE ORDER: decisión ya consumida → one-shot ──
  fs.writeSync(1, "\n── Rechazo 10 · duplicate order (one-shot) ──\n");
  const r10Dec = saveDecision({
    symbol: "US30", timeframe: "M5", finalAction: "EXECUTE", direction: "BUY",
    stopLossPips: 15, riskPct: 0.5, approvalStatus: initialApprovalStatus(), reasoning: "e2e r10",
  });
  assert(claimDecision(r10Dec) === true, "decisión EXECUTE reclamada manualmente (consumida)");
  const r10Resp = await executeTradeMT5.execute({ symbol: "US30", direction: "BUY", stopLossPips: 15, comment: "e2e-r10" });
  assert(
    r10Resp.includes("HARD-GATE") && r10Resp.includes("sin consumir"),
    "decisión ya consumida → hard-gate one-shot NO devuelve autorización (una decisión = una orden)"
  );
  assert(
    (getDecisionById(r10Dec)?.consumed_at ?? null) !== null,
    "la decisión #r10 sigue consumida (no se re-libera en el intento duplicado)"
  );
  assert(ordersReceived.length === 0, "rechazo 10: NADA llegó al broker");

  // ── Veredicto global de las 11 ejecuciones contra el broker ──
  assert(ordersReceived.length === 0, "§25: en TODO el E2E el mock bridge no recibió NI UNA orden");

  // ── Limpieza final ──
  db.exec(`DELETE FROM policy_events`);
  for (const f of [DB_PATH, `${DB_PATH}-journal`, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {}
  }
  try {
    db.close();
  } catch {}
  await stopMock();

  fs.writeSync(
    1,
    `\n════════════════════════════════════════\n` +
      `🧪 E2E §25 PASS: ${passed} asserts verdes, ${failed} fallos.\n` +
      `   Happy path EXECUTE→[DEMO] + 10 rechazos = NO TRADE (0 órdenes al broker).\n` +
      `   DB temporal eliminada (${DB_PATH}).\n` +
      `════════════════════════════════════════\n`
  );
}

main().catch((err) => {
  fs.writeSync(2, `❌ ERROR FATAL E2E: ${(err as Error).stack ?? err}\n`);
  process.exitCode = 1;
});
