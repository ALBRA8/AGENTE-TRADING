// ============================================================
// src/agent/risk_controls.ts
// Kill-switches de cuenta (Task 8-a) — implementan en CÓDIGO las
// reglas del SOP que antes solo existían en el prompt:
//   - Pérdida diaria máxima: 1% del balance (MAX_DAILY_LOSS_PCT)
//   - Máximo de posiciones abiertas: 2 (MAX_OPEN_POSITIONS)
//   - Máximo de pérdidas consecutivas: 2 (MAX_CONSECUTIVE_LOSSES)
//   - Exposición total máxima: 3 lotes (MAX_TOTAL_EXPOSURE_LOTS)
//
// Filosofía FAIL-CLOSED: cualquier fuente que falle (bridge, DB,
// dato no numérico) genera una violación con la razón honesta y
// bloquea la ejecución. NUNCA se asume que "no hay problema".
//
// Todos los proveedores de datos son INYECTABLES para poder testear
// sin MT5 ni bridge: por defecto usan MT5Bridge + decision_log.
// ============================================================

import { MT5Bridge, type MT5AccountInfo, type MT5Position } from "../config/mt5bridge.js";
import { getTodayRealizedPnl, getConsecutiveLosses } from "../database/sqlite.js";

// ── Tipos ───────────────────────────────────────────────────

/** Fuentes de datos inyectables (sync o async). Defaults: MT5 + SQLite. */
export interface RiskProviders {
  account: () => MT5AccountInfo | Promise<MT5AccountInfo>;
  positions: () => MT5Position[] | Promise<MT5Position[]>;
  /** PnL realizado de HOY (negativo = perdiendo) — decision_log settled */
  pnlToday: () => number | Promise<number>;
  /** Racha actual de pérdidas consecutivas — decision_log settled */
  consecutiveLosses: () => number | Promise<number>;
}

export interface AccountRiskDetails {
  balance: number | null;
  equity: number | null;
  /** PnL realizado de hoy (negativo = pérdida) */
  dailyPnl: number | null;
  /** Límite de pérdida diaria en USD (referencia: balance de inicio de día) */
  dailyLossLimitUsd: number | null;
  dailyLossLimitPct: number;
  openPositions: number | null;
  maxOpenPositions: number;
  consecutiveLosses: number | null;
  maxConsecutiveLosses: number;
  /** Suma de volúmenes (lotes) de posiciones abiertas */
  totalExposureLots: number | null;
  maxTotalExposureLots: number;
  /** Razones honestas de las fuentes que fallaron */
  errors: string[];
  checkedAt: string;
}

export interface AccountRiskSnapshot {
  /** true = sin violaciones Y con datos suficientes para afirmarlo */
  ok: boolean;
  /**
   * true si al menos la cuenta MT5 se pudo leer (ancla de la evaluación).
   * evaluated=false → el estado real es UNKNOWN (el llamador debe bloquear
   * EXECUTE igual que con violaciones: fail-closed).
   */
  evaluated: boolean;
  violations: string[];
  details: AccountRiskDetails;
}

// ── Límites (leídos en CADA llamada para que tests/env apliquen al vuelo) ──

function envPositive(name: string, def: number): number {
  const v = parseFloat(process.env[name] ?? "");
  return Number.isFinite(v) && v > 0 ? v : def;
}

export interface AccountRiskLimits {
  maxDailyLossPct: number;
  maxOpenPositions: number;
  maxConsecutiveLosses: number;
  maxTotalExposureLots: number;
}

export function getRiskLimits(): AccountRiskLimits {
  return {
    maxDailyLossPct: envPositive("MAX_DAILY_LOSS_PCT", 1),
    maxOpenPositions: Math.round(envPositive("MAX_OPEN_POSITIONS", 2)),
    maxConsecutiveLosses: Math.round(envPositive("MAX_CONSECUTIVE_LOSSES", 2)),
    maxTotalExposureLots: envPositive("MAX_TOTAL_EXPOSURE_LOTS", 3),
  };
}

// ── Proveedores por defecto (MT5 real + decision_log) ───────

function defaultProviders(): RiskProviders {
  return {
    account: () => MT5Bridge.getAccount(),
    positions: () => MT5Bridge.getPositions(),
    pnlToday: () => getTodayRealizedPnl(),
    consecutiveLosses: () => getConsecutiveLosses(),
  };
}

// ── Evaluación principal ────────────────────────────────────

/**
 * Evalúa los kill-switches de la cuenta. Nunca lanza: los fallos de
 * fuente se convierten en violaciones honestas (fail-closed).
 *  - ok=true, evaluated=true  → gate GREEN
 *  - ok=false, evaluated=true → gate RED (violación real o fuente parcial caída)
 *  - evaluated=false          → gate UNKNOWN (cuenta ilegible: bloquear igual)
 */
export async function getAccountRisk(
  providers?: Partial<RiskProviders>
): Promise<AccountRiskSnapshot> {
  const defaults = defaultProviders();
  const p: RiskProviders = {
    account: providers?.account ?? defaults.account,
    positions: providers?.positions ?? defaults.positions,
    pnlToday: providers?.pnlToday ?? defaults.pnlToday,
    consecutiveLosses: providers?.consecutiveLosses ?? defaults.consecutiveLosses,
  };
  const limits = getRiskLimits();

  const violations: string[] = [];
  const errors: string[] = [];

  let account: MT5AccountInfo | null = null;
  let positions: MT5Position[] | null = null;
  let pnlToday: number | null = null;
  let streak: number | null = null;

  // ── Recolectar fuentes (cada una aislada: un fallo no tumba las demás) ──
  try {
    account = await p.account();
    if (!account || !Number.isFinite(account.balance)) {
      throw new Error("respuesta de cuenta sin balance numérico");
    }
  } catch (err) {
    errors.push(`account: ${(err as Error).message}`);
    account = null;
  }

  try {
    positions = await p.positions();
    if (!Array.isArray(positions)) throw new Error("respuesta de posiciones no es una lista");
  } catch (err) {
    errors.push(`positions: ${(err as Error).message}`);
    positions = null;
  }

  try {
    const v = await p.pnlToday();
    pnlToday = Number(v);
    if (!Number.isFinite(pnlToday)) throw new Error(`PnL del día no numérico (${String(v)})`);
  } catch (err) {
    errors.push(`pnlToday: ${(err as Error).message}`);
    pnlToday = null;
  }

  try {
    const v = await p.consecutiveLosses();
    streak = Number(v);
    if (!Number.isFinite(streak) || streak < 0) {
      throw new Error(`racha de pérdidas inválida (${String(v)})`);
    }
  } catch (err) {
    errors.push(`consecutiveLosses: ${(err as Error).message}`);
    streak = null;
  }

  // La cuenta es el ancla: sin ella el estado de riesgo es UNKNOWN.
  const evaluated = account !== null;

  // ── Kill-switch 1: pérdida diaria máxima (% del balance de inicio de día) ──
  if (!account) {
    violations.push("Cuenta MT5 no disponible → riesgo de cuenta NO evaluable (fail-closed)");
  } else {
    if (account.balance <= 0) {
      violations.push(`Balance de cuenta ≤ 0 (${account.balance} ${account.currency})`);
    }
    if (pnlToday !== null) {
      // Balance de inicio de día ≈ balance actual − PnL realizado de hoy
      // (el balance MT5 ya incluye lo realizado hoy). Nunca negativo.
      const dayStartBalance = Math.max(0, account.balance - pnlToday);
      const dailyLimitUsd = dayStartBalance * (limits.maxDailyLossPct / 100);
      if (pnlToday < 0 && Math.abs(pnlToday) > dailyLimitUsd) {
        violations.push(
          `PÉRDIDA DIARIA MÁXIMA: ${Math.abs(pnlToday).toFixed(2)} ${account.currency} supera el límite del ${limits.maxDailyLossPct}% (${dailyLimitUsd.toFixed(2)})`
        );
      }
    } else {
      violations.push("PnL del día no disponible → límite diario NO verificable (fail-closed)");
    }
  }

  // ── Kill-switch 2 y 4: posiciones abiertas y exposición total ──
  if (positions === null) {
    violations.push("Posiciones MT5 no disponibles → no se puede validar límite de posiciones (fail-closed)");
  } else {
    if (positions.length > limits.maxOpenPositions) {
      violations.push(
        `MÁXIMO DE POSICIONES: ${positions.length} abiertas (límite ${limits.maxOpenPositions})`
      );
    }
    const totalLots = positions.reduce((acc, pos) => {
      const v = Number(pos.volume);
      return acc + (Number.isFinite(v) && v > 0 ? v : 0);
    }, 0);
    if (totalLots > limits.maxTotalExposureLots) {
      violations.push(
        `EXPOSICIÓN TOTAL MÁXIMA: ${totalLots.toFixed(2)} lotes abiertos (límite ${limits.maxTotalExposureLots})`
      );
    }
  }

  // ── Kill-switch 3: racha de pérdidas consecutivas ──
  if (streak === null) {
    violations.push("Racha de pérdidas no disponible (decision_log ilegible) → fail-closed");
  } else if (streak >= limits.maxConsecutiveLosses) {
    violations.push(
      `RACHA DE PÉRDIDAS: ${streak} pérdidas consecutivas (límite ${limits.maxConsecutiveLosses}) → trading suspendido hasta revisión`
    );
  }

  const details: AccountRiskDetails = {
    balance: account ? account.balance : null,
    equity: account ? account.equity : null,
    dailyPnl: pnlToday,
    dailyLossLimitUsd:
      account && pnlToday !== null
        ? Math.max(0, account.balance - pnlToday) * (limits.maxDailyLossPct / 100)
        : null,
    dailyLossLimitPct: limits.maxDailyLossPct,
    openPositions: positions ? positions.length : null,
    maxOpenPositions: limits.maxOpenPositions,
    consecutiveLosses: streak,
    maxConsecutiveLosses: limits.maxConsecutiveLosses,
    totalExposureLots: positions
      ? positions.reduce((acc, pos) => {
          const v = Number(pos.volume);
          return acc + (Number.isFinite(v) && v > 0 ? v : 0);
        }, 0)
      : null,
    maxTotalExposureLots: limits.maxTotalExposureLots,
    errors,
    checkedAt: new Date().toISOString(),
  };

  return {
    ok: violations.length === 0,
    evaluated,
    violations,
    details,
  };
}
