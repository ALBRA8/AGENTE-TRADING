// ============================================================
// src/agent/execution_guard.ts
// EXECUTION GUARD INDEPENDIENTE (PROMPT 06 §5/§9/§11/§13) —
// la ÚLTIMA frontera antes del broker. Se invoca DESDE DENTRO de
// MT5Bridge.placeOrder (no del tool que el LLM invoca): cualquier
// camino hacia MT5 (LLM, dashboard, Telegram, futuros MCP/A2A)
// pasa por aquí, y aquí NADA se puede saltar.
//
// Fail-closed TOTAL: si un check no se puede completar → la orden
// se rechaza. Los checks re-validan en el punto de envío lo que la
// decisión pudo haber dejado caducar hace 14 minutos:
//   1. Kill switch global (policy)
//   2. Autorización LIVE explícita (policy LIVE + L4 + env + aprobación)
//   3. Whitelist de símbolos
//   4. Volumen finito, >0, ≤ MAX_LOT
//   5. SL/TP presentes y del lado correcto
//   6. Tick fresco + spread máximo (datos vivos, no de la decisión)
//   7. Sanidad de precio de entrada vs tick
//   8. Re-evaluación de kill-switches de cuenta EN EL ENVÍO
//   9. Dedup: una decisión ya ordenada no se re-ordena
// ============================================================

import { getPolicy, assertExecutionForDecision } from "./policy.js";
import { getAccountRisk } from "./risk_controls.js";
import db from "../database/sqlite.js";
import type { MT5OrderRequest, MT5Tick } from "../config/mt5bridge.js";

export interface GuardCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface GuardContext {
  decisionId?: number | null;
  approvalStatus?: string | null;
}

export interface GuardVerdict {
  allowed: boolean;
  reason?: string;
  checks: GuardCheck[];
}

function envFloat(name: string, def: number): number {
  const v = parseFloat(process.env[name] ?? "");
  return Number.isFinite(v) && v > 0 ? v : def;
}

function defaultWhitelist(): string[] {
  return (process.env.ALLOWED_SYMBOLS ?? "US30,NAS100,XAUUSD,BTCUSD,GBPJPY")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

/**
 * Veredicto del guard. `tick` y `accountOk` se pasan ya resueltos por el
 * llamador (placeOrder obtiene tick; account risk se re-evalúa aquí mismo).
 */
export async function assertOrderAllowed(
  order: MT5OrderRequest,
  ctx: GuardContext,
  tick: MT5Tick
): Promise<GuardVerdict> {
  const checks: GuardCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const firstFail = () => checks.find((c) => !c.ok)?.detail;

  // ── 1. Kill switch global (§9): activo → NO LIVE ORDERS, sin excepciones ──
  const policy = getPolicy();
  add("kill_switch", !policy.killSwitch, policy.killSwitch ? `ACTIVO${policy.killReason ? `: ${policy.killReason}` : ""}` : "inactivo");

  // ── 2. Autorización de trading REAL (§11): nunca se infiere ──
  // El envío real solo procede con LIVE_TRADING=true (env) Y policy que lo
  // permita (modo LIVE con L4 + aprobación). Sin env → nada sale a MT5.
  // La aprobación de la decisión se verifica aquí como segunda llave.
  const verdict = assertExecutionForDecision(ctx.approvalStatus ?? null, policy);
  const realTradingAuthorized = policy.liveTradingEnv && verdict.allowed;
  add(
    "live_authorization",
    realTradingAuthorized,
    policy.liveTradingEnv
      ? verdict.reason
      : "LIVE_TRADING != true → envío real no autorizado (modo DEMO por diseño)"
  );

  // ── 3. Whitelist de símbolos ──
  const whitelist = defaultWhitelist();
  const symbol = String(order.symbol ?? "").toUpperCase();
  add("symbol_whitelist", whitelist.includes(symbol), whitelist.includes(symbol) ? symbol : `${symbol} fuera de ALLOWED_SYMBOLS [${whitelist.join(",")}]`);

  // ── 4. Volumen ──
  const maxLot = envFloat("MAX_LOT", 10);
  const vol = Number(order.volume);
  const volumeOk = Number.isFinite(vol) && vol > 0 && vol <= maxLot;
  add("volume", volumeOk, volumeOk ? `${vol} lotes (≤ ${maxLot})` : `volumen inválido o > MAX_LOT=${maxLot}: ${order.volume}`);

  // ── 5. SL/TP presentes y del lado correcto (protege contra payload corrupto) ──
  const isBuy = order.type.startsWith("BUY");
  const entry = Number(order.price ?? (isBuy ? tick.ask : tick.bid));
  const sl = Number(order.stopLoss);
  const tp = Number(order.takeProfit);
  const stopsOk =
    Number.isFinite(entry) && entry > 0 &&
    Number.isFinite(sl) && sl > 0 &&
    Number.isFinite(tp) && tp > 0 &&
    (isBuy ? sl < entry && tp > entry : sl > entry && tp < entry);
  add("sl_tp_sides", stopsOk, stopsOk ? `entry ${entry} · SL ${sl} · TP ${tp} (${isBuy ? "BUY" : "SELL"})` : `SL/TP ausentes o del lado incorrecto (entry=${order.price ?? entry}, sl=${order.stopLoss}, tp=${order.takeProfit})`);

  // ── 6. Datos VIVOS: tick fresco + spread máximo (§5: mercado abierto, spread) ──
  const tickAgeMs = tick.time ? Date.now() - Date.parse(tick.time) : Number.POSITIVE_INFINITY;
  const maxTickAgeMs = envFloat("MAX_TICK_AGE_S", 120) * 1000;
  const freshTick = Number.isFinite(tickAgeMs) && tickAgeMs >= -5_000 && tickAgeMs <= maxTickAgeMs;
  add("tick_fresh", freshTick, freshTick ? `tick de hace ${Math.round(tickAgeMs / 1000)}s` : `tick STALE (${Number.isFinite(tickAgeMs) ? `${Math.round(tickAgeMs / 1000)}s` : "sin timestamp"} > ${envFloat("MAX_TICK_AGE_S", 120)}s) — mercado cerrado o feed muerto`);

  const mid = (tick.ask + tick.bid) / 2;
  const spreadAbs = Math.abs(tick.ask - tick.bid);
  const maxSpreadAbs = mid * envFloat("MAX_SPREAD_PCT", 0.0005);
  const spreadOk = Number.isFinite(spreadAbs) && spreadAbs <= maxSpreadAbs;
  add("spread", spreadOk, spreadOk ? `spread ${spreadAbs.toFixed(5)} ≤ ${(maxSpreadAbs).toFixed(5)} (${(envFloat("MAX_SPREAD_PCT", 0.0005) * 100).toFixed(3)}% del precio)` : `spread ${spreadAbs.toFixed(5)} > máximo ${maxSpreadAbs.toFixed(5)} — liquidez hostil`);

  // ── 7. Sanidad del precio de entrada (para LIMIT): a máxima 2× distancia SL ──
  let entrySane = true;
  let entryDetail = `entry ${order.price} coincide con tick`;
  if (order.price && Number.isFinite(order.price)) {
    const slDist = Math.abs(entry - sl);
    const maxAway = Math.max(slDist * 2, mid * 0.002);
    const away = Math.abs(order.price - mid);
    entrySane = away <= maxAway;
    entryDetail = entrySane ? `entry a ${away.toFixed(5)} del tick (≤ ${maxAway.toFixed(5)})` : `entry a ${away.toFixed(5)} del tick actual — más de 2× la distancia del SL (${maxAway.toFixed(5)}): precio imposible o datos viejos`;
  }
  add("entry_sanity", entrySane, entryDetail);

  // ── 8. Re-evaluación de kill-switches de cuenta EN EL PUNTO DE ENVÍO ──
  // La ventana de validez de la decisión es de 15 min: una violación de
  // pérdida diaria/racha DURANTE esa ventana debe bloquear el envío.
  let accountOk = false;
  let accountDetail = "no evaluado";
  try {
    const snap = await getAccountRisk();
    accountOk = snap.evaluated && snap.ok;
    accountDetail = snap.ok
      ? `cuenta OK en el envío (equity ${snap.details.equity}, PnL hoy ${snap.details.dailyPnl})`
      : `kill-switch de cuenta: ${snap.violations.join(" · ") || "no evaluable (fail-closed)"}`;
  } catch (err) {
    accountOk = false;
    accountDetail = `error evaluando riesgo de cuenta (fail-closed): ${(err as Error).message}`;
  }
  add("account_risk_at_send", accountOk, accountDetail);

  // ── 9. Dedup: la decisión ya produjo una orden real → no duplicar ──
  if (ctx.decisionId) {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM trade_orders
         WHERE decision_id = ? AND status IN ('placed', 'verified', 'divergence')`
      )
      .get(ctx.decisionId) as { n: number };
    add("no_duplicate", row.n === 0, row.n === 0 ? `decisión #${ctx.decisionId} sin órdenes previas` : `la decisión #${ctx.decisionId} ya tiene ${row.n} orden(es) — one-shot`);
  } else {
    add("no_duplicate", true, "sin decisionId (orden manual) — el gate del tool es quien exige decisión");
  }

  const failed = checks.find((c) => !c.ok);
  return failed
    ? { allowed: false, reason: `[${failed.name}] ${failed.detail}`, checks }
    : { allowed: true, checks };
}
