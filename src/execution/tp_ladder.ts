// ============================================================
// src/execution/tp_ladder.ts
// P1 — TP LADDER con cierres parciales (aprobado por el propietario).
//
// Qué es: escalera de TPs derivada del TP ESTRUCTURAL del Strategy
// Engine (spec: TP = liquidez externa). TP1 = estructural; TP2/TP3
// proyecciones R derivadas; el agente cierra fracciones (50/30/20)
// a mercado al tocar cada nivel y mueve el SL a break-even tras el
// primer parcial (con EVIDENCIA de deal, no por precio).
//
// Filosofía idéntica a position_manager.ts / reconciler.ts:
// módulo DETERMINISTA, fail-closed y sin dependencias de MT5/DB —
// los datos entran por parámetro y toda acción sale por EJECUTORES
// INYECTABLES. El reconciler JAMÁS genera órdenes (invariante P0):
// este módulo vive en la capa de mantenimiento (settlement FASE L),
// no en el reconciliador.
//
// Contrato de degradación (fail-closed):
//  - Sin TP estructural válido → ladder INVÁLIDO → el trade se
//    comporta EXACTAMENTE como hoy (TP única 3R en el broker).
//  - Volumen insuficiente para partir en 3 → se degrada a menos
//    niveles; si no hay parciales posibles → ladder inválido.
//  - Agente caído → el broker TP (= tp3) sigue acotando el trade
//    (idéntico al comportamiento actual 1:3). El ladder es puro
//    upside: nunca puede empeorar el perfil base.
//  - Estado del ladder = DERIVADO de evidencia en disco
//    (execution_deals + execution_events): restart-safe, sin RAM.
//
// Invariantes:
//  (i)  Los niveles son monótonos en recompensa: tp1 < tp2 < tp3
//       (en R) siempre, para long y short.
//  (ii) El SL SOLO se mueve a favor (nunca atrás de BE).
//  (iii) Un nivel se considera CONSUMIDO solo por evidencia:
//       exit deal persistido O evento de éxito del executor.
//  (iv) Jamás lanza excepciones: los datos hostiles producen
//       'none' con razón explícita.
// ============================================================

// ── Tipos ───────────────────────────────────────────────────

/** Un nivel de la escalera. */
export interface LadderLevel {
  /** Etiqueta auditable: 'TP1' | 'TP2' | 'TP3'. */
  label: string;
  /** Precio objetivo del nivel. */
  price: number;
  /** Volumen a cerrar en este nivel (ya redondeado a volume_step). */
  volume: number;
  /** Fracción del volumen total que representa (informativa). */
  fraction: number;
}

/** Ladder derivado (o la razón por la que no es válido). */
export interface TpLadder {
  valid: boolean;
  reason: string;
  levels: LadderLevel[];
  /** SL tras el primer parcial (break-even = entrada). */
  beLevel: number;
  /** rr del TP estructural usado (informativo). */
  structuralRr: number;
}

export type LadderDirection = "BUY" | "SELL";

export interface LadderInputs {
  entry: number;
  sl: number;
  /** TP estructural del signal (null = no hay / no coherente → 3R). */
  structuralTp: number | null;
  direction: LadderDirection;
  /** Volumen total ejecutado (executions.executed_volume). */
  totalVolume: number;
  volumeStep: number;
  volumeMin: number;
}

export type LadderAction =
  | "none"
  | "partial_close"          // cerrar fracción (nivel intermedio)
  | "partial_close_full"     // cerrar TODO el volumen restante (runner final)
  | "partial_close_and_be";  // cerrar fracción + SL → BE (nivel 1)

export interface LadderVerdict {
  action: LadderAction;
  /** Índice del nivel disparado (0-based) o -1. */
  levelIndex: number;
  /** Volumen a cerrar (para acciones de cierre). */
  volume: number;
  /** Nuevo SL a aplicar (solo en partial_close_and_be). */
  newSl?: number;
  reason: string;
}

/** Ejecutores inyectables (en producción: MT5Bridge.closePosition / modifyPosition). */
export type CloseExecutor = (ticket: number, volume: number) => Promise<unknown>;
export type SlExecutor = (ticket: number, sl: number, tp: number | undefined) => Promise<unknown>;

/** Instantánea mínima de la posición viva para el trigger. */
export interface LadderPositionSnapshot {
  ticket: number;
  volume: number;
  /** Precio actual de mercado (bid aprox. — ver limitación documentada). */
  currentPrice: number;
  /** SL actual de la posición. */
  sl: number;
  /** TP actual del broker. */
  tp: number;
}

/** Contexto de evidencia de UNA execution para decidir la siguiente acción. */
export interface LadderExecutionContext {
  executionId: string;
  direction: LadderDirection;
  entry: number;
  sl: number;
  /** Nº de exit deals ya persistidos (execution_deals, evidencia dura). */
  exitDeals: number;
  /** Máximo índice de nivel con evento de éxito (−1 si ninguno). */
  maxSuccessLevel: number;
  ladder: TpLadder;
  position: LadderPositionSnapshot | null;
}

/** Resultado de procesar una execution (para auditoría). */
export interface LadderOutcome {
  executionId: string;
  action: LadderAction;
  levelIndex: number;
  volume?: number;
  reason: string;
  applied: boolean;
  closed?: unknown;
  beApplied?: boolean;
  error?: string;
}

// ── Configuración ───────────────────────────────────────────

/** P1: flag por env. Default ACTIVADO (inerte sin TP estructural). 'off' desactiva. */
export function isTpLadderEnabled(): boolean {
  return String(process.env.TP_LADDER ?? "").trim().toLowerCase() !== "off";
}

const FRACTIONS = [0.5, 0.3, 0.2] as const;
/** Tolerancia para comparar volúmenes/precios (floats de MT5). */
const EPS = 1e-8;

// ── Núcleo puro: derivación de niveles ──────────────────────

/**
 * Niveles de la escalera (puros, sin I/O). Reglas:
 *  - tp1 = TP estructural (spec: liquidez externa); exige rr ≥ 1
 *    (si la liquidez objetivo no paga al menos 1R, no hay ladder).
 *  - tp2 = max(2R, tp1 + 0.5R) — monotonía garantizada.
 *  - tp3 = max(3R, tp2 + 0.5R) — ES el TP que va al broker.
 * Sin TP estructural válido: tp3 = 3R exacto (comportamiento actual).
 */
export function computeLadderLevels(
  entry: number,
  sl: number,
  structuralTp: number | null,
  direction: LadderDirection,
): { valid: boolean; reason: string; tp1: number; tp2: number; tp3: number; structuralRr: number } {
  const r = Math.abs(entry - sl);
  if (!Number.isFinite(entry) || !Number.isFinite(sl) || entry <= 0 || sl <= 0 || r <= EPS) {
    return { valid: false, reason: `datos base inválidos (entry=${entry}, sl=${sl})`, tp1: NaN, tp2: NaN, tp3: NaN, structuralRr: NaN };
  }
  const sign = direction === "BUY" ? 1 : -1;
  const off = (x: number) => entry + sign * x;

  // TP estructural válido: finito, en dirección de beneficio y rr ≥ 1.
  const tpOff = structuralTp !== null && Number.isFinite(structuralTp)
    ? (structuralTp - entry) * sign
    : NaN;
  const structuralRr = Number.isFinite(tpOff) ? tpOff / r : NaN;
  const structuralOk = Number.isFinite(structuralRr) && structuralRr >= 1 - EPS;

  if (!structuralOk) {
    // Sin ladder: TP final = 3R (comportamiento pre-P1, degradación exacta).
    const reason = structuralTp === null || !Number.isFinite(structuralTp)
      ? "sin TP estructural (strategy_context ausente) → TP única 3R"
      : `TP estructural no válido (rr=${structuralRr.toFixed(2)} < 1 o en contra) → TP única 3R`;
    return { valid: false, reason, tp1: NaN, tp2: NaN, tp3: off(3 * r), structuralRr };
  }

  const tp1 = structuralTp as number;
  const tp2Off = Math.max(2 * r, tpOff + 0.5 * r);
  const tp2 = off(tp2Off);
  const tp3Off = Math.max(3 * r, tp2Off + 0.5 * r);
  const tp3 = off(tp3Off);
  return { valid: true, reason: `ladder derivado (rr estructural ${structuralRr.toFixed(2)})`, tp1, tp2, tp3, structuralRr };
}

/** Redondea volumen hacia abajo al step del símbolo (fail-closed ante step<=0). */
function floorToStep(volume: number, step: number): number {
  if (!Number.isFinite(step) || step <= EPS) return volume;
  return Math.floor(volume / step + EPS) * step;
}

/**
 * Deriva el ladder completo (niveles + volúmenes 50/30/20 con
 * redistribución por volume_min). Fail-closed: si no hay parciales
 * posibles, ladder inválido con razón explícita.
 */
export function computeLadder(inputs: LadderInputs): TpLadder {
  const { entry, sl, structuralTp, direction, totalVolume, volumeStep, volumeMin } = inputs;
  const invalid = (reason: string): TpLadder =>
    ({ valid: false, reason, levels: [], beLevel: entry, structuralRr: NaN });

  if (!Number.isFinite(totalVolume) || totalVolume <= EPS) return invalid(`volumen total inválido (${totalVolume})`);
  if (!Number.isFinite(volumeMin) || volumeMin <= 0) return invalid(`volume_min inválido (${volumeMin})`);

  const lv = computeLadderLevels(entry, sl, structuralTp, direction);
  if (!lv.valid) return invalid(lv.reason);

  const beLevel = entry;
  // Reparto: floor al step para los dos primeros; el resto al runner
  // (también floor al step: el polvo flotante jamás sale al broker).
  const raw = FRACTIONS.map((f) => totalVolume * f);
  const v1 = floorToStep(raw[0], volumeStep);
  const v2 = floorToStep(raw[1], volumeStep);
  let v3 = floorToStep(totalVolume - v1 - v2, volumeStep);
  if (v3 < EPS) return invalid("volumen total no alcanza para 3 niveles tras el redondeo al step");

  // Redistribución por volume_min: un nivel por debajo del mínimo
  // cede su volumen al siguiente (el runner absorbe al final).
  let volumes = [v1, v2, v3];
  for (let i = 0; i < volumes.length - 1; i++) {
    if (volumes[i] + EPS < volumeMin) {
      volumes[i + 1] += volumes[i];
      volumes[i] = 0;
    }
  }
  volumes = volumes.filter((v) => v > EPS);
  if (volumes.length === 0) return invalid("sin volúmenes operables tras la redistribución");
  // El último (runner) también debe cumplir el mínimo; si no, absorbe
  // hacia atrás (el nivel anterior se queda TODO y el ladder se acorta).
  if (volumes[volumes.length - 1] + EPS < volumeMin && volumes.length > 1) {
    const runner = volumes.pop() as number;
    volumes[volumes.length - 1] += runner;
  }
  // Con un solo nivel NO hay parciales posibles (cerrar el 100% a
  // mercado en TP1 = TP única): comportamiento base sin ladder.
  if (volumes.length < 2) {
    return invalid(
      `volumen total ${totalVolume} insuficiente para ≥2 parciales (volume_min=${volumeMin}) → TP única ${lv.tp3}`,
    );
  }

  const prices = [lv.tp1, lv.tp2, lv.tp3].slice(0, volumes.length);
  const labels = ["TP1", "TP2", "TP3"].slice(0, volumes.length);
  const levels: LadderLevel[] = prices.map((price, i) => ({
    label: labels[i],
    price,
    volume: volumes[i],
    fraction: volumes[i] / totalVolume,
  }));

  return {
    valid: true,
    reason: lv.reason,
    levels,
    beLevel,
    structuralRr: lv.structuralRr,
  };
}

/**
 * TP FINAL que va al broker (= tp3 del ladder, o 3R sin estructural).
 * Única fuente de verdad compartida con execute_trade_mt5.
 */
export function ladderFinalTakeProfit(
  entry: number,
  sl: number,
  structuralTp: number | null,
  direction: LadderDirection,
): number {
  return computeLadderLevels(entry, sl, structuralTp, direction).tp3;
}

/**
 * Extrae el TP estructural del JSON de decision_log.strategy_context.
 * SOLO en modo 'source' (el plan ejecutado ES el del engine — su TP es
 * coherente con el entry/sl de la escalera). En SHADOW el signal es
 * observación de OTRO plan (el LLM decidió): usar su TP contaminaría la
 * escalera → null. Exige dirección coincidente (long↔BUY / short↔SELL).
 * Fail-closed: JSON hostil/ilegible → null (sin TP estructural).
 */
export function extractEngineStructuralTp(
  raw: string | null,
  direction: LadderDirection,
): number | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      mode?: string;
      signal?: { direction?: string; tp?: { price?: number } | null } | null;
    };
    if (parsed.mode !== "source") return null;
    const sigDir = String(parsed.signal?.direction ?? "").toLowerCase();
    if (sigDir !== (direction === "BUY" ? "long" : "short")) return null;
    const price = Number(parsed.signal?.tp?.price);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

// ── Núcleo puro: siguiente acción ───────────────────────────

/**
 * Decide la siguiente acción del ladder para UNA execution.
 * Puro y determinista: mismo contexto ⇒ mismo veredicto.
 */
export function nextLadderAction(ctx: LadderExecutionContext): LadderVerdict {
  const none = (reason: string): LadderVerdict => ({ action: "none", levelIndex: -1, volume: 0, reason });
  const { ladder, position, direction, entry } = ctx;

  if (!ladder.valid || ladder.levels.length < 2) return none(`ladder inválido: ${ladder.reason}`);
  if (!position || !(position.ticket > 0)) return none("sin posición viva con ticket");
  const vol = Number(position.volume);
  if (!Number.isFinite(vol) || vol <= EPS) return none("volumen de posición inválido");

  // Nivel pendiente = niveles consumidos por EVIDENCIA (invariante iii).
  const consumed = Math.max(ctx.exitDeals, ctx.maxSuccessLevel + 1);
  if (consumed >= ladder.levels.length) {
    return none("todos los niveles consumidos (runner lo cierra el TP del broker)");
  }
  const level = ladder.levels[consumed];
  if (!Number.isFinite(level.price) || level.price <= 0) return none(`precio del nivel ${level.label} inválido`);

  // Trigger por precio (long: bid ≥ nivel; short: ask ≤ nivel).
  const px = Number(position.currentPrice);
  if (!Number.isFinite(px) || px <= 0) return none("precio actual inválido");
  const touched = direction === "BUY" ? px >= level.price - EPS : px <= level.price + EPS;
  if (!touched) return none(`nivel ${level.label} (${level.price}) no tocado (precio ${px})`);

  // Volumen a cerrar: el del nivel, acotado por el volumen vivo.
  // Si lo que queda ≤ lo que pide el nivel → cierre TOTAL (runner final
  // o posición reducida externamente): no dejar polvo por debajo del min.
  const isFinal = consumed === ladder.levels.length - 1;
  let closeVolume = level.volume;
  let action: LadderAction = isFinal ? "partial_close_full" : "partial_close";
  if (vol + EPS < closeVolume || Math.abs(vol - closeVolume) <= EPS) {
    closeVolume = vol;
    action = "partial_close_full";
  }

  // BE tras el PRIMER parcial (nivel TP1), solo si mejora el SL
  // (invariante ii: nunca atrás) y con SL actual legible.
  const curSl = Number(position.sl);
  const wantsBe = consumed === 0;
  if (wantsBe && Number.isFinite(curSl) && curSl > EPS) {
    const beImproves = direction === "BUY" ? curSl < entry - EPS : curSl > entry + EPS;
    if (beImproves) {
      return { action: "partial_close_and_be", levelIndex: consumed, volume: closeVolume, newSl: entry, reason: `${level.label} tocado → parcial ${closeVolume} + SL→BE (${entry})` };
    }
  }
  return { action, levelIndex: consumed, volume: closeVolume, reason: `${level.label} tocado → ${action} ${closeVolume}` };
}

// ── Orquestación (mantenimiento, Settlement FASE L) ─────────

export interface ProcessLadderArgs {
  /** Executions candidatas (abiertas, con ticket y ladder derivable). */
  candidates: Array<{
    executionId: string;
    direction: LadderDirection;
    entry: number;
    sl: number;
    structuralTp: number | null;
    totalVolume: number;
    exitDeals: number;
    maxSuccessLevel: number;
    /** Position ticket vivo (executions.position_ticket — evidencia P0). */
    positionTicket: number;
  }>;
  /** Posiciones vivas indexadas por position ticket. */
  positions: Map<number, LadderPositionSnapshot>;
  /** volume_min/step por símbolo (fail-closed si falta el símbolo). */
  volumeRules: Map<string, { volumeMin: number; volumeStep: number }>;
  symbolByExecution: Map<string, string>;
  closeExecutor: CloseExecutor;
  slExecutor: SlExecutor;
  /** Persiste el evento de éxito (append-only). Falla → solo log. */
  recordEvent: (executionId: string, levelIndex: number, payload: Record<string, unknown>) => void;
}

/**
 * Procesa todas las candidates y devuelve outcomes. NUNCA lanza:
 * el fallo de UNA execution no bloquea las demás (patrón
 * processOpenPositions). Solo persiste evento cuando el executor
 * confirma éxito — un fallo de red se reintenta en el próximo ciclo.
 */
export async function processTpLadders(args: ProcessLadderArgs): Promise<LadderOutcome[]> {
  const outcomes: LadderOutcome[] = [];
  if (!Array.isArray(args.candidates)) return outcomes;

  for (const c of args.candidates) {
    const base = { executionId: c.executionId, action: "none" as LadderAction, levelIndex: -1, reason: "", applied: false };
    try {
      const rules = args.volumeRules.get(args.symbolByExecution.get(c.executionId) ?? "");
      if (!rules) {
        outcomes.push({ ...base, reason: "reglas de volumen del símbolo no disponibles → fail-closed" });
        continue;
      }
      const ladder = computeLadder({
        entry: c.entry, sl: c.sl, structuralTp: c.structuralTp, direction: c.direction,
        totalVolume: c.totalVolume, volumeStep: rules.volumeStep, volumeMin: rules.volumeMin,
      });
      // Posición viva por el ticket registrado en la execution (evidencia P0).
      const posForExec = c.positionTicket > 0 ? args.positions.get(c.positionTicket) ?? null : null;
      const ctx: LadderExecutionContext = {
        executionId: c.executionId, direction: c.direction, entry: c.entry, sl: c.sl,
        exitDeals: c.exitDeals, maxSuccessLevel: c.maxSuccessLevel, ladder, position: posForExec,
      };

      const verdict = nextLadderAction(ctx);
      if (verdict.action === "none") {
        outcomes.push({ ...base, reason: verdict.reason });
        continue;
      }

      const ticket = c.positionTicket;
      const closed = await args.closeExecutor(ticket, verdict.volume);
      let beApplied = false;
      if (verdict.action === "partial_close_and_be" && verdict.newSl !== undefined) {
        await args.slExecutor(ticket, verdict.newSl, undefined);
        beApplied = true;
      }
      args.recordEvent(c.executionId, verdict.levelIndex, {
        level: verdict.levelIndex, volume: verdict.volume, action: verdict.action, newSl: verdict.newSl ?? null,
      });
      outcomes.push({ ...base, action: verdict.action, levelIndex: verdict.levelIndex, volume: verdict.volume, reason: verdict.reason, applied: true, closed, beApplied });
    } catch (err) {
      // Tolerado: el fallo de ESTA execution no bloquea el resto; sin
      // evento persistido → el próximo ciclo reintenta (fail-closed).
      outcomes.push({ ...base, reason: "error procesando ladder", error: (err as Error)?.message ?? String(err) });
    }
  }
  return outcomes;
}

