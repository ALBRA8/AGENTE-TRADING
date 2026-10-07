// ============================================================
// src/agent/policy.ts
// POLICY ENGINE (PROMPT 06 §6/§9/§11/§12/§19) — gobernanza de
// autonomía por ENCIMA del pipeline y del hard-gate:
//
//   Modos:  PAPER | SIMULATION | BACKTEST | RECOMMENDATION |
//           MANUAL_APPROVAL | LIVE
//   Niveles: L0 OBSERVE … L5 SELF-IMPROVE (con TECHO configurable)
//   Kill switch GLOBAL: activo → NINGUNA orden real desde ninguna
//   interfaz (LLM, Telegram, dashboard, API), ni siquiera con
//   LIVE_TRADING=true y decisión EXECUTE vigente.
//
// Reglas:
//   - Por defecto: mode=PAPER, level=2 (ejecución simulada), techo=2.
//     → LIVE es IMPOSIBLE sin subir el techo a ≥4 explícitamente.
//   - LIVE exige: policy mode=LIVE + techo≥4 + nivel efectivo≥4 +
//     LIVE_TRADING=true (env, doble factor) + decision aprobada
//     (approval_status='approved' por humano).
//   - Todos los cambios de policy quedan en `policy_events`
//     (append-only, auditable: quién/cuándo/por qué).
//   - NUNCA se infiere autorización de la existencia de API keys,
//     de MT5 o del broker: la autorización es explícita y registrada.
// ============================================================

import db, { recordPolicyEvent, getLatestPolicyValues, getPolicyEventsHistory } from "../database/sqlite.js";

// Re-export para el dashboard (server.ts consume policy, no sqlite directo)
export { getPolicyEventsHistory };

// ── Tipos ───────────────────────────────────────────────────

export type PolicyMode =
  | "PAPER"
  | "SIMULATION"
  | "BACKTEST"
  | "RECOMMENDATION"
  | "MANUAL_APPROVAL"
  | "LIVE";

export type ApprovalStatus = "auto" | "pending" | "approved" | "rejected";

export interface PolicyState {
  mode: PolicyMode;
  autonomyLevel: number;      // L0..L5
  autonomyCeiling: number;    // techo duro (LIVE exige ≥4)
  killSwitch: boolean;
  killReason?: string;
  effectiveLevel: number;     // min(level, ceiling)
  liveTradingEnv: boolean;    // LIVE_TRADING=true (2º factor, no autoridad)
}

export interface ExecutionVerdict {
  allowed: boolean;
  reason: string;
  effectiveLevel: number;
}

const MODES: PolicyMode[] = [
  "PAPER", "SIMULATION", "BACKTEST", "RECOMMENDATION", "MANUAL_APPROVAL", "LIVE",
];

// ── Lectura de env con defaults seguros ─────────────────────

function envMode(): PolicyMode {
  const raw = (process.env.POLICY_MODE ?? "").trim().toUpperCase() as PolicyMode;
  return MODES.includes(raw) ? raw : "PAPER";
}

function envLevel(name: string, def: number): number {
  const v = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v >= 0 && v <= 5 ? v : def;
}

// ── Estado de policy (eventos append-only > env) ────────────

/** Política vigente: último evento de cada clave; fallback a env con defaults seguros. */
export function getPolicy(): PolicyState {
  const last = getLatestPolicyValues(["mode", "autonomy_level", "autonomy_ceiling", "kill_switch"]);

  const mode = (last.mode?.value as PolicyMode) ?? envMode();
  const autonomyLevel = last.autonomy_level ? parseInt(last.autonomy_level.value, 10) : envLevel("AUTONOMY_LEVEL", 2);
  const autonomyCeiling = last.autonomy_ceiling ? parseInt(last.autonomy_ceiling.value, 10) : envLevel("AUTONOMY_CEILING", 2);
  const killRaw = last.kill_switch?.value ?? (process.env.KILL_SWITCH ?? "").trim().toLowerCase();
  const killSwitch = ["on", "true", "1", "yes"].includes(killRaw);

  const level = Math.min(5, Math.max(0, Number.isFinite(autonomyLevel) ? autonomyLevel : 2));
  const ceiling = Math.min(5, Math.max(0, Number.isFinite(autonomyCeiling) ? autonomyCeiling : 2));

  return {
    mode,
    autonomyLevel: level,
    autonomyCeiling: ceiling,
    killSwitch,
    killReason: killSwitch ? last.kill_switch?.reason : undefined,
    effectiveLevel: Math.min(level, ceiling),
    liveTradingEnv: (process.env.LIVE_TRADING ?? "").trim().toLowerCase() === "true",
  };
}

// ── Aprobación de decisiones (§12) ──────────────────────────

/** Status de aprobación INICIAL para una decisión nueva según el modo. */
export function initialApprovalStatus(mode: PolicyMode = getPolicy().mode): ApprovalStatus {
  return mode === "LIVE" || mode === "MANUAL_APPROVAL" ? "pending" : "auto";
}

/**
 * Aprueba una decisión EXECUTE pendiente (solo humanos vía dashboard/Telegram).
 * Fail-closed: solo decisions EXECUTE, no consumidas y con approval_status='pending'.
 */
export function approveDecision(decisionId: number, actor: string): boolean {
  const res = db
    .prepare(
      `UPDATE decision_log SET approval_status = 'approved'
       WHERE id = ? AND final_action = 'EXECUTE'
         AND consumed_at IS NULL
         AND approval_status = 'pending'`
    )
    .run(decisionId);
  if (res.changes > 0) {
    recordPolicyEvent(actor, `approval:${decisionId}`, "pending", "approved", "Aprobación humana de decisión EXECUTE");
  }
  return res.changes > 0;
}

// ── Veredicto de ejecución (la POLICY decide si está permitido) ──

/**
 * ¿Puede esta decisión EXECUTE convertirse en orden?
 * Se evalúa: kill switch → nivel efectivo → modo → aprobación.
 * Fail-closed: cualquier duda = NO.
 */
export function assertExecutionForDecision(
  approvalStatus: string | null | undefined,
  policy: PolicyState = getPolicy()
): ExecutionVerdict {
  if (policy.killSwitch) {
    return {
      allowed: false,
      reason: `KILL SWITCH ACTIVO${policy.killReason ? `: ${policy.killReason}` : ""} → ninguna orden (§9)`,
      effectiveLevel: policy.effectiveLevel,
    };
  }
  if (policy.mode === "RECOMMENDATION") {
    return { allowed: false, reason: "Modo RECOMMENDATION: solo análisis y recomendaciones, sin ejecución", effectiveLevel: policy.effectiveLevel };
  }
  if (policy.effectiveLevel < 2) {
    return {
      allowed: false,
      reason: `Nivel de autonomía efectivo L${policy.effectiveLevel} < L2 (mínimo para ejecutar simulaciones)`,
      effectiveLevel: policy.effectiveLevel,
    };
  }
  if (policy.mode === "LIVE") {
    // Doble factor explícito: policy LIVE + env LIVE_TRADING (nunca se infiere)
    if (!policy.liveTradingEnv) {
      return { allowed: false, reason: "Modo LIVE en policy pero LIVE_TRADING != true (falta el segundo factor explícito)", effectiveLevel: policy.effectiveLevel };
    }
    if (policy.effectiveLevel < 4) {
      return { allowed: false, reason: `Modo LIVE exige nivel efectivo ≥ L4 (hay L${policy.effectiveLevel}; techo L${policy.autonomyCeiling})`, effectiveLevel: policy.effectiveLevel };
    }
    if (approvalStatus !== "approved") {
      return { allowed: false, reason: `Orden LIVE sin aprobación humana (approval_status='${approvalStatus ?? "null"}') → requiere approve en dashboard/Telegram (§12)`, effectiveLevel: policy.effectiveLevel };
    }
    return { allowed: true, reason: "LIVE autorizado: policy=LIVE · L4+ · LIVE_TRADING=true · decisión aprobada", effectiveLevel: policy.effectiveLevel };
  }
  if (policy.mode === "MANUAL_APPROVAL") {
    if (approvalStatus !== "approved") {
      return { allowed: false, reason: `Modo MANUAL_APPROVAL: orden en espera de aprobación humana (status='${approvalStatus ?? "null"}')`, effectiveLevel: policy.effectiveLevel };
    }
    return { allowed: true, reason: "Ejecución aprobada manualmente", effectiveLevel: policy.effectiveLevel };
  }
  // PAPER / SIMULATION / BACKTEST: ejecución simulada permitida (L2+)
  return { allowed: true, reason: `Modo ${policy.mode}: ejecución SIMULADA permitida (L${policy.effectiveLevel})`, effectiveLevel: policy.effectiveLevel };
}

// ── Setters (siempre registrados; API/Telegram/UI) ──────────

export function setPolicyMode(actor: string, mode: PolicyMode, reason: string): PolicyState {
  if (!MODES.includes(mode)) throw new Error(`Modo inválido: ${mode}`);
  const before = getPolicy();
  if (mode === "LIVE" && before.autonomyCeiling < 4) {
    throw new Error("Para LIVE primero sube el techo de autonomía a ≥ L4 (set_ceiling 4) — es el freno de dos llaves (§19)");
  }
  recordPolicyEvent(actor, "mode", before.mode, mode, reason);
  return getPolicy();
}

export function setAutonomyLevel(actor: string, level: number, reason: string): PolicyState {
  if (!Number.isFinite(level) || level < 0 || level > 5) throw new Error("Nivel debe estar entre 0 y 5");
  const before = getPolicy();
  recordPolicyEvent(actor, "autonomy_level", String(before.autonomyLevel), String(level), reason);
  return getPolicy();
}

export function setAutonomyCeiling(actor: string, ceiling: number, reason: string): PolicyState {
  if (!Number.isFinite(ceiling) || ceiling < 0 || ceiling > 5) throw new Error("Techo debe estar entre 0 y 5");
  const before = getPolicy();
  recordPolicyEvent(actor, "autonomy_ceiling", String(before.autonomyCeiling), String(ceiling), reason);
  return getPolicy();
}

export function setKillSwitch(actor: string, on: boolean, reason: string): PolicyState {
  const before = getPolicy();
  recordPolicyEvent(actor, "kill_switch", before.killSwitch ? "on" : "off", on ? "on" : "off", reason);
  return getPolicy();
}

/** Resumen plano para endpoints/UI/Telegram (sin secretos). */
export function getPolicySummary(): PolicyState & { modes: PolicyMode[] } {
  return { ...getPolicy(), modes: MODES };
}
