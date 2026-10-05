// ============================================================
// src/agent/self_improve.ts
// Módulo auto-mejorante (inspirado en el skill "self-improving-agent"
// de ClawHub + la reflexión de TradingAgents):
//   1. CAPTURA   → errores de herramientas (automático) y correcciones
//                  del usuario (manual) van a un log persistente.
//   2. DEDUPE    → pattern_key por tipo de fallo; se cuentan ocurrencias
//                  en vez de duplicar entradas.
//   3. REFLEXIÓN → una llamada LLM (tier quick) destila la lección en
//                  2-4 frases accionables con metadatos de mantenimiento
//                  (decay, revalidación, validación).
//   4. REUSO     → antes de una decisión, el pipeline recupera las
//                  lecciones relevantes ("review guidance before major tasks").
//   5. PROMOCIÓN → las lecciones verificadas e importantes viajan siempre
//                  en el system prompt (equivalente al workspace memory).
//   6. TRIAGE    → errores recurrentes (≥3 veces) se convierten en
//                  lecciones automáticamente y se marcan resueltos.
// ============================================================

import { callLLMByTier } from "../config/nvidia.js";
import {
  saveLesson,
  saveAutoError,
  getUnresolvedErrors,
  markErrorsResolved,
  getLessonsForContext,
  getPromotedLessons,
  setLessonValidation,
  searchLessons,
  type LessonRow,
} from "../database/sqlite.js";

// ── Clasificación de errores automáticos ────────────────────
export function classifyError(toolName: string, err: Error): {
  errorType: string;
  patternKey: string;
} {
  const msg = (err.message || "").toLowerCase();
  let errorType = "unknown";

  if (msg.includes("bridge") || msg.includes("econnrefused") || msg.includes("5001")) {
    errorType = "bridge_down";
  } else if (msg.includes("timeout") || msg.includes("etimedout")) {
    errorType = "api_timeout";
  } else if (msg.includes("tavily")) {
    errorType = "news_api";
  } else if (msg.includes("json") || msg.includes("parse")) {
    errorType = "parse_error";
  } else if (msg.includes("rate") || msg.includes("429") || msg.includes("503")) {
    errorType = "rate_limit";
  } else if (msg.includes("símbolo") || msg.includes("symbol") || msg.includes("market watch")) {
    errorType = "symbol_not_found";
  }

  const toolSlug = toolName.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  return { errorType, patternKey: `TOOL|${toolSlug}|${errorType}` };
}

/**
 * CAPTURA automática: se invoca desde el registry cuando un tool falla.
 * Nunca lanza — el auto-mejoramiento jamás debe romper el flujo principal.
 */
export function captureAutoError(
  toolName: string,
  err: Error,
  context?: Record<string, unknown>
): void {
  try {
    const { errorType, patternKey } = classifyError(toolName, err);
    saveAutoError({
      toolName,
      errorType,
      patternKey,
      message: err.message,
      contextJson: context ? JSON.stringify(context).slice(0, 1_500) : undefined,
    });
    console.warn(`[SelfImprove] 📥 Error capturado: ${patternKey}`);
  } catch (e) {
    console.warn(`[SelfImprove] No se pudo registrar el error: ${(e as Error).message}`);
  }
}

// ── Reflexión LLM ───────────────────────────────────────────
interface DistilledLesson {
  cause_key: string;      // slug corto del motivo (para pattern_key)
  kind: LessonRow["kind"];
  lesson: string;         // 2-4 frases accionables
  scope: string;          // límites de aplicabilidad
  importance: number;     // 1-3
  decay_type: "reality" | "decision" | "dependency" | "relevance" | "unknown";
  decay_rate: "fast" | "medium" | "slow" | "durable" | "unknown";
}

const REFLECTION_SYSTEM = `Eres el módulo de auto-mejora de un agente de trading institucional SMC.
Tu trabajo: convertir una experiencia (trade ganado/perdido, error operativo, corrección del usuario) en UNA lección reutilizable.

Reglas estrictas:
- La lección debe tener 2 a 4 frases de prosa plana. Concreta y accionable: qué hacer DISTINTO la próxima vez ante un escenario similar.
- Cita la cifra clave del resultado si existe (pips, PnL, RVOL, hora).
- No inventes datos que no estén en la descripción. Si falta contexto, dilo en scope.
- cause_key: slug en snake_case, 2-4 palabras, describe la CAUSA (ej: "entrada_fuera_killzone", "sin_confirmacion_rvol", "sl_demasiado_ajustado").
- decay_type: reality (hecho verificable del mercado) | dependency (comportamiento de bridge/API/modelo) | decision (regla del SOP) | relevance (aplicabilidad) | unknown.
- decay_rate: fast (volátil, revisar en cada uso) | medium (revisar en hitos) | slow | durable | unknown.
- Responde EXCLUSIVAMENTE con JSON válido.`;

async function distillLesson(
  experience: string
): Promise<DistilledLesson | null> {
  try {
    const { content } = await callLLMByTier({
      tier: "quick",
      system: REFLECTION_SYSTEM,
      user: `Experiencia a destilar:\n${experience}\n\nDevuelve el JSON con las claves: cause_key, kind, lesson, scope, importance, decay_type, decay_rate.`,
      jsonMode: true,
      maxTokens: 700,
      temperature: 0.2,
    });

    const parsed = extractJson<Partial<DistilledLesson>>(content);
    if (!parsed || !parsed.lesson || !parsed.cause_key) return null;

    const validKinds = ["correction", "insight", "knowledge_gap", "best_practice", "error"];
    const kind = validKinds.includes(String(parsed.kind))
      ? (parsed.kind as LessonRow["kind"])
      : "insight";

    return {
      cause_key: String(parsed.cause_key)
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, "_")
        .slice(0, 60),
      kind,
      lesson: String(parsed.lesson).slice(0, 1_200),
      scope: String(parsed.scope ?? "").slice(0, 400),
      importance: Math.min(3, Math.max(1, Number(parsed.importance) || 2)),
      decay_type: (["reality", "decision", "dependency", "relevance"].includes(
        String(parsed.decay_type)
      )
        ? parsed.decay_type
        : "unknown") as DistilledLesson["decay_type"],
      decay_rate: (["fast", "medium", "slow", "durable"].includes(
        String(parsed.decay_rate)
      )
        ? parsed.decay_rate
        : "unknown") as DistilledLesson["decay_rate"],
    };
  } catch (err) {
    console.warn(`[SelfImprove] Reflexión falló: ${(err as Error).message}`);
    return null;
  }
}

// ── API pública ─────────────────────────────────────────────

/**
 * Reflexión post-trade / post-error (llamada por el tool reflectOnTrade).
 * Si el resultado contradice una lección verificada existente, la marca
 * como 'contradicted' (revalidación por causa, no por antigüedad).
 */
export async function reflectOnExperience(input: {
  symbol?: string;
  setup?: string;
  outcomePnl?: number | null;
  errorMade?: string;
  userNote?: string;
  source?: LessonRow["source"];
}): Promise<{ saved: boolean; deduped: boolean; lessonId?: number; lessonText?: string }> {
  const parts: string[] = [];
  if (input.symbol) parts.push(`Activo: ${input.symbol}`);
  if (input.setup) parts.push(`Setup: ${input.setup}`);
  if (input.outcomePnl !== undefined && input.outcomePnl !== null)
    parts.push(`Resultado PnL: ${input.outcomePnl > 0 ? "+" : ""}${input.outcomePnl} USD`);
  if (input.errorMade) parts.push(`Error identificado: ${input.errorMade}`);
  if (input.userNote) parts.push(`Notas del usuario: ${input.userNote}`);

  if (parts.length === 0) {
    return { saved: false, deduped: false };
  }

  const distilled = await distillLesson(parts.join("\n"));
  if (!distilled) return { saved: false, deduped: false };

  const symbolSlug = (input.symbol ?? "GENERAL").toUpperCase().replace(/[^A-Z0-9]+/g, "");
  const patternKey = `${symbolSlug}|${distilled.cause_key}`;

  const { id, deduped } = saveLesson({
    kind: distilled.kind,
    source: input.source ?? "reflection",
    symbol: input.symbol ?? null,
    patternKey,
    observation: parts.join(" | ").slice(0, 800),
    lesson: distilled.lesson,
    scope: distilled.scope,
    decayType: distilled.decay_type,
    decayRate: distilled.decay_rate,
    revalidateTrigger:
      distilled.decay_rate === "fast"
        ? "Revisar en cada análisis de este símbolo"
        : "Revisar si cambia el SOP, el bridge o el modelo",
    importance: distilled.importance,
  });

  // Revalidación por contradicción: si el trade fue GANADOR y existe una
  // lección verificada que decía lo contrario para esta causa, queda en duda.
  if (
    input.outcomePnl !== undefined &&
    input.outcomePnl !== null &&
    input.outcomePnl > 0
  ) {
    const related = searchLessons(distilled.cause_key.split("_")[0], input.symbol, 5);
    for (const l of related) {
      if (l.id !== id && l.validation_status === "verified" && l.lesson.toLowerCase().includes("evitar")) {
        setLessonValidation(l.id, "unresolved", `Trade ganador (${input.outcomePnl}) contradice parcialmente esta lección`);
      }
    }
  }

  console.log(`[SelfImprove] 🧠 Lección ${deduped ? "reforzada" : "nueva"}: ${patternKey}`);
  return { saved: true, deduped, lessonId: id, lessonText: distilled.lesson };
}

/**
 * REUSO: bloque de lecciones para inyectar en el pipeline antes de decidir.
 */
export function buildLessonsContextBlock(symbol?: string): string {
  const lessons = getLessonsForContext(symbol, 8);
  if (lessons.length === 0) return "";

  const lines = lessons.map((l, i) => {
    const tag =
      l.validation_status === "verified"
        ? "✅verificada"
        : l.validation_status === "unresolved"
        ? "⚠️en duda"
        : "📌pendiente";
    const seen = l.times_seen > 1 ? ` (visto ${l.times_seen}x)` : "";
    return `${i + 1}. [${tag}]${seen} ${l.lesson}`;
  });

  return [
    "## 🧠 Lecciones aprendidas (memoria de errores previos)",
    "Estas lecciones vienen de trades y errores reales anteriores. Úsalas para validar o frenar el plan actual:",
    ...lines,
  ].join("\n");
}

/**
 * PROMOCIÓN: lecciones que siempre viajan en el system prompt.
 */
export function buildPromotedLessonsBlock(): string {
  const lessons = getPromotedLessons();
  if (lessons.length === 0) return "";
  return [
    "## Lecciones promovidas (reglas de oro aprendidas de errores)",
    ...lessons.map((l) => `- ${l.lesson}`),
  ].join("\n");
}

/**
 * TRIAGE: procesa errores automáticos recurrentes (≥3 ocurrencias del
 * mismo pattern_key) y los convierte en lecciones. Equivale al
 * "agents can later process these into fixes" del skill original.
 */
export async function triageUnresolvedErrors(): Promise<number> {
  const unresolved = getUnresolvedErrors(50);
  let created = 0;

  for (const errGroup of unresolved) {
    if (errGroup.times < 3) continue; // solo lo recurrente
    if (errGroup.pattern_key.startsWith("TOOL|")) {
      // Los fallos de herramientas recurrentes son problemas de dependencia:
      // se registran como knowledge_gap operacional, no como lección de trading.
      const { id, deduped } = saveLesson({
        kind: "knowledge_gap",
        source: "auto_error",
        symbol: null,
        patternKey: `OPS|${errGroup.pattern_key}`,
        observation: `La herramienta ${errGroup.tool_name ?? "desconocida"} falló ${errGroup.times} veces (${errGroup.error_type}). Último error: ${errGroup.message.slice(0, 200)}`,
        lesson: `La herramienta '${errGroup.tool_name}' presenta fallos recurrentes de tipo ${errGroup.error_type} (${errGroup.times} ocurrencias). Ante un fallo similar: degrada el filtro a UNKNOWN, avísale al usuario y no bloquees el análisis por ese dato; si es el bridge de MT5, NO permitas ejecución de órdenes.`,
        scope: "Operativa de herramientas del agente",
        decayType: "dependency",
        decayRate: "medium",
        revalidateTrigger: `Revisar cuando se actualice ${errGroup.tool_name} o el bridge`,
        importance: errGroup.times >= 5 ? 3 : 2,
      });
      if (!deduped) created++;
    }
    markErrorsResolved(errGroup.pattern_key);
  }

  if (created > 0) {
    console.log(`[SelfImprove] 🔧 Triage: ${created} lección(es) operacional(es) creada(s)`);
  }
  return created;
}

// ── Utilidad: extracción tolerante de JSON ──────────────────
export function extractJson<T>(text: string): T | null {
  if (!text) return null;
  // Intento 1: JSON directo
  try {
    return JSON.parse(text.trim()) as T;
  } catch {
    /* sigue */
  }
  // Intento 2: primer bloque { ... } balanceado
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as T;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
