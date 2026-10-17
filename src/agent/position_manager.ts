// ============================================================
// src/agent/position_manager.ts
// Gestor de posiciones determinista (Task 11-a) — la "Regla de
// protección" del manual operativo: cuando el precio toca el nivel
// TP2 de una posición abierta → mover el SL a precio de entrada
// (break-even). Modo alternativo 'LOCK_TP1': al tocar TP1 → SL a
// entrada.
//
// Filosofía idéntica a risk_controls.ts: módulo DETERMINISTA,
// fail-closed y sin dependencias de MT5/DB — todos los datos entran
// por parámetro y toda acción sale por un EXECUTOR INYECTABLE, para
// poder testear sin MT5 ni red. El llamador (pipeline/mantenimiento)
// conecta el executor con POST /modify_position del bridge.py.
//
// Invariantes (nunca se lanzan excepciones):
//  - (a) El SL SOLO puede moverse A FAVOR de la posición, nunca atrás:
//    si ya está en BE o mejor → 'none'.
//  - (b) El trigger SOLO dispara si currentPrice tocó el nivel
//    correspondiente (long: currentPrice >= nivel; short: <= nivel).
//  - (c) FAIL-CLOSED: si falta algún dato (sl=0, entry=0, side
//    inválido, precio no numérico) → action 'none' con reason
//    explícito. NUNCA se asume que "no hay nada que hacer" por datos
//    corruptos: la razón queda registrada.
// ============================================================

// ── Tipos ───────────────────────────────────────────────────

/** Modo de protección del manual:
 *  - 'BE_AT_TP2' (default): al tocar TP2 (2R) → SL a entrada.
 *  - 'LOCK_TP1': al tocar TP1 (1R) → SL a entrada. */
export type PositionProtectionMode = "BE_AT_TP2" | "LOCK_TP1";

/**
 * Modo activo, configurable por env POSITION_PROTECTION_MODE
 * (default 'BE_AT_TP2'; cualquier valor distinto de 'LOCK_TP1'
 * cae al default — fail-closed hacia el modo más exigente).
 */
export const POSITION_PROTECTION_MODE: PositionProtectionMode =
  String(process.env.POSITION_PROTECTION_MODE ?? "").trim().toUpperCase() === "LOCK_TP1"
    ? "LOCK_TP1"
    : "BE_AT_TP2";

/** Fotografía mínima de una posición abierta (inyectada, nunca fetch) */
export interface PositionSnapshot {
  ticket: number;
  symbol: string;
  side: "long" | "short";
  entry: number;
  sl: number;
  tp: number;
  volume: number;
  currentPrice: number;
}

/** Niveles derivados de la posición: 1R = |entry − sl| */
export interface ProtectionLevels {
  /** Distancia actual del SL = |entry − sl| (1R) */
  riskDistance: number;
  /** entry ± 1R según side */
  tp1: number;
  /** entry ± 2R según side */
  tp2: number;
}

export type ProtectionAction = "none" | "move_sl_to_be";

export interface ProtectionVerdict {
  action: ProtectionAction;
  /** Razón honesta y explícita (incluye los casos fail-closed) */
  reason: string;
}

/** Executor inyectable: aplica la modificación SL/TP de una posición.
 *  En producción apunta a POST /modify_position del bridge; en tests,
 *  a un doble falso. Un throw del executor se tolera por posición. */
export type SltpExecutor = (
  ticket: number,
  sl: number,
  tp: number
) => Promise<unknown>;

export interface ProtectionOutcome extends ProtectionVerdict {
  ticket: number;
  symbol: string;
  /** true si la modificación llegó al executor sin error */
  applied: boolean;
  /** Mensaje del error tolerado (executor falló para esta posición) */
  error?: string;
}

// ── Niveles de protección (1R/2R según side) ────────────────

/**
 * Calcula TP1/TP2 a partir del SL ACTUAL de la posición:
 * distancia = |entry − sl|; TP1 = entry ± 1R; TP2 = entry ± 2R.
 * Devuelve null si los datos no permiten medir 1R (fail-closed,
 * nunca lanza).
 */
export function computeProtectionLevels(
  pos: PositionSnapshot
): ProtectionLevels | null {
  const entry = Number(pos?.entry);
  const sl = Number(pos?.sl);
  if (!Number.isFinite(entry) || entry <= 0) return null;
  if (!Number.isFinite(sl) || sl <= 0) return null; // sin SL no hay 1R medible
  const riskDistance = Math.abs(entry - sl);
  if (!Number.isFinite(riskDistance) || riskDistance <= 0) return null; // sl === entry
  const sign = pos.side === "short" ? -1 : 1;
  return {
    riskDistance,
    tp1: entry + sign * riskDistance,
    tp2: entry + sign * 2 * riskDistance,
  };
}

// ── Evaluación de la regla de protección ────────────────────

function failClosed(reason: string): ProtectionVerdict {
  return { action: "none", reason };
}

/**
 * Regla de protección para un modo explícito (núcleo puro, testeable
 * para ambos modos sin tocar env). Nunca lanza.
 */
export function evaluateProtectionForMode(
  pos: PositionSnapshot,
  mode: PositionProtectionMode
): ProtectionVerdict {
  if (!pos || typeof pos !== "object") {
    return failClosed("posición ilegible (no es un objeto) → fail-closed");
  }
  if (pos.side !== "long" && pos.side !== "short") {
    return failClosed(
      `side inválido (${String(pos.side)}) → protección no evaluable (fail-closed)`
    );
  }
  const side = pos.side;
  const entry = Number(pos.entry);
  if (!Number.isFinite(entry) || entry <= 0) {
    return failClosed(`entrada ausente o inválida (entry=${String(pos.entry)}) → fail-closed`);
  }
  const sl = Number(pos.sl);
  if (!Number.isFinite(sl) || sl <= 0) {
    return failClosed(`SL ausente o inválido (sl=${String(pos.sl)}) → sin 1R medible (fail-closed)`);
  }
  const currentPrice = Number(pos.currentPrice);
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    return failClosed(
      `precio actual inválido (currentPrice=${String(pos.currentPrice)}) → fail-closed`
    );
  }

  // Regla (a): el SL nunca retrocede — si ya está en BE o mejor, nada que
  // hacer (incondicional: cubre también el caso degenerado sl === entry,
  // donde 1R = 0 y los niveles no son medibles).
  const slAtOrBetter = side === "long" ? sl >= entry : sl <= entry;
  if (slAtOrBetter) {
    return {
      action: "none",
      reason: `el SL (${sl}) ya está en BE o mejor que la entrada (${entry}) → nada que mejorar`,
    };
  }

  const levels = computeProtectionLevels(pos);
  if (!levels) {
    return failClosed("niveles 1R/2R no calculables con los datos de la posición → fail-closed");
  }

  // Regla (b): el trigger SOLO dispara si el precio TOCÓ el nivel del modo
  const triggerLevel = mode === "LOCK_TP1" ? levels.tp1 : levels.tp2;
  const touched = side === "long" ? currentPrice >= triggerLevel : currentPrice <= triggerLevel;
  if (!touched) {
    return {
      action: "none",
      reason: `precio ${currentPrice} no ha tocado el nivel de protección ${triggerLevel} (modo ${mode}) → sin acción`,
    };
  }

  return {
    action: "move_sl_to_be",
    reason: `Regla de protección (${mode}): precio ${currentPrice} tocó ${triggerLevel} → SL ${sl} movido a break-even ${entry}`,
  };
}

/** Regla de protección con el modo configurado (POSITION_PROTECTION_MODE) */
export function evaluateProtection(pos: PositionSnapshot): ProtectionVerdict {
  return evaluateProtectionForMode(pos, POSITION_PROTECTION_MODE);
}

// ── Aplicación sobre la cartera abierta ─────────────────────

/**
 * Evalúa cada posición y aplica las acciones vía el executor inyectable:
 * mover el SL a entrada (break-even) manteniendo el TP tal cual.
 * Tolerante a errores POR POSICIÓN: un fallo del executor (o un dato
 * corrupto) no aborta el resto — cada resultado se reporta honestamente
 * en el outcome (applied=false + error).
 */
export async function processOpenPositions(
  positions: PositionSnapshot[],
  executor: SltpExecutor
): Promise<ProtectionOutcome[]> {
  if (!Array.isArray(positions)) return [];
  const outcomes: ProtectionOutcome[] = [];

  for (const pos of positions) {
    const ticket = pos && typeof pos === "object" ? Number(pos.ticket) || 0 : 0;
    const symbol = pos && typeof pos === "object" ? String(pos.symbol ?? "") : "";
    try {
      const verdict = evaluateProtection(pos);
      if (verdict.action !== "move_sl_to_be") {
        outcomes.push({ ticket, symbol, ...verdict, applied: false });
        continue;
      }
      try {
        // SL → break-even (entry); el TP se mantiene sin cambios.
        await executor(ticket, Number(pos.entry), Number(pos.tp));
        outcomes.push({ ticket, symbol, ...verdict, applied: true });
      } catch (err) {
        // Tolerado: el fallo de ESTA posición no bloquea las demás.
        outcomes.push({
          ticket,
          symbol,
          ...verdict,
          applied: false,
          error: (err as Error)?.message ?? String(err),
        });
      }
    } catch (err) {
      // evaluateProtection es fail-closed y jamás debería lanzar; si lo
      // hace (dato hostil imprevisto), la posición queda registrada sin
      // abortar el barrido del resto de la cartera.
      outcomes.push({
        ticket,
        symbol,
        action: "none",
        reason: "error inesperado evaluando la protección → fail-closed",
        applied: false,
        error: (err as Error)?.message ?? String(err),
      });
    }
  }

  return outcomes;
}
