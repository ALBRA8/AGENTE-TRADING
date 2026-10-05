// ============================================================
// src/agent/pipeline.ts
// Pipeline de decisión multi-rol (patrón TradingAgents, en TS puro):
//
//   [Analistas en paralelo]  → checkMarketHours / checkNews / checkDXY /
//                              checkRVOL / analyzeMarket (tools existentes)
//          + GATES DUROS en código (mercado cerrado o noticia roja → ABORT)
//   [Debate Bull vs Bear]    → 1 ronda, tier quick
//   [Research Manager]       → tier deep, JSON {bias, confidence, conditions}
//   [Trade Planner]          → tier deep, JSON {action, direction, sl, risk}
//                              + inyección de lecciones (auto-mejora)
//   [Trío de riesgo]         → 3 llamadas quick en paralelo {OK|VETO}
//   [Gate final en CÓDIGO]   → EXECUTE | WAIT | REVIEW | ABORTED
//   [Persistencia]           → decision_log con traza completa
//
// Reglas de oro heredadas de TradingAgents:
//   - Si el JSON del planner no se puede parsear → REVIEW (nunca degradar a
//     una decisión operable: "una decisión ilegible no es un WAIT activo").
//   - Los números (precio, RVOL) vienen de código determinista, no del LLM.
//   - Ningún EXECUTE sobrevive a un gate rojo, lo diga quien lo diga.
// ============================================================

import { executeToolByName } from "./registry.js";
import { callLLMByTier } from "../config/nvidia.js";
import { captureAutoError, buildLessonsContextBlock, extractJson } from "./self_improve.js";
import { saveDecision } from "../database/sqlite.js";
import { getAccountRisk } from "./risk_controls.js";
import { MT5Bridge } from "../config/mt5bridge.js";

// ── Tipos ───────────────────────────────────────────────────
export type GateStatus = "GREEN" | "YELLOW" | "RED" | "UNKNOWN";
export type FinalAction = "EXECUTE" | "WAIT" | "REVIEW" | "ABORTED";

export interface Gate {
  name: string;
  status: GateStatus;
  detail: string;
}

interface ManagerVerdict {
  bias: "BULLISH" | "BEARISH" | "NEUTRAL";
  confidence: number;
  conditions: string[];
  rationale: string;
}

interface TradePlan {
  action: "EXECUTE" | "WAIT" | "REVIEW";
  direction?: "BUY" | "SELL";
  stopLossPips?: number;
  riskPct?: number;
  setup?: string;
  reasoning?: string;
}

interface RiskOpinion {
  verdict: "OK" | "VETO";
  concern: string;
}

export interface PipelineResult {
  symbol: string;
  timeframe: string;
  finalAction: FinalAction;
  decisionId: number;
  markdown: string;
}

interface PipelineOptions {
  userId?: string;
  symbol: string;
  timeframe?: "H1" | "M15" | "M5" | "M1";
  onProgress?: (msg: string) => void;
}

// ── Utilidades ──────────────────────────────────────────────────────────
function coerceNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const cleaned = v.replace(/[^0-9.\-]/g, "");
    const n = parseFloat(cleaned);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function gate(status: GateStatus, name: string, detail: string): Gate {
  return { name, status, detail };
}

async function runTool(
  name: string,
  args: Record<string, unknown>,
  onProgress?: PipelineOptions["onProgress"]
): Promise<string> {
  try {
    const result = await executeToolByName(name, args);
    return result;
  } catch (err) {
    captureAutoError(name, err as Error, args);
    return `⚠️ Filtro ${name} no disponible: ${(err as Error).message}. Tratar dato como UNKNOWN, no inventar valores.`;
  }
}

// ── Limpieza de pendientes obsoletos (Task 8-a, audit C5) ──
// Las órdenes del agente llevan comment "AGT-<DIR>-<SIMBOLO>-<decisión>".
// Una pendiente colocada hace >15 min está apoyada en una decisión
// EXPIRADA: se cancela. Fallo de cancelación → log honesto, jamás tumba
// el pipeline (la limpieza es best-effort, el gate es lo que bloquea).
const PENDING_STALE_MS = 15 * 60 * 1000;

/** Extrae {dir, symbol} de un comment "AGT-BUY-US30-42" (o null si no encaja) */
function parseAgentOrderComment(comment: string): { dir: "BUY" | "SELL"; symbol: string } | null {
  if (!comment.startsWith("AGT-")) return null;
  const parts = comment.split("-");
  const dir = parts[1]?.toUpperCase();
  const symbol = parts[2]?.toUpperCase();
  if ((dir === "BUY" || dir === "SELL") && symbol) return { dir, symbol };
  return null;
}

async function cleanupStalePendingOrders(onProgress?: PipelineOptions["onProgress"]): Promise<string[]> {
  const cancelled: string[] = [];
  try {
    const pendings = await MT5Bridge.getPendingOrders();
    const now = Date.now();
    for (const o of pendings) {
      try {
        if (!parseAgentOrderComment(String(o.comment ?? ""))) continue;
        const placed = o.time ? Date.parse(o.time) : NaN;
        if (!Number.isFinite(placed)) continue; // sin hora no hay evidencia para cancelar
        if (now - placed <= PENDING_STALE_MS) continue;
        const ok = await MT5Bridge.cancelOrder(o.ticket);
        if (ok) {
          cancelled.push(`#${o.ticket} ${o.symbol} (${o.comment}) — pendiente >15 min`);
        } else {
          console.warn(`[Pipeline] MT5 rechazó la cancelación del pendiente obsoleto #${o.ticket}`);
        }
      } catch (err) {
        console.warn(`[Pipeline] No se pudo cancelar pendiente #${o.ticket}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    console.warn(`[Pipeline] Limpieza de pendientes omitida (bridge no disponible): ${(err as Error).message}`);
  }
  if (cancelled.length) {
    onProgress?.(`🧹 ${cancelled.length} pendiente(s) obsoleto(s) cancelado(s) en MT5`);
  }
  return cancelled;
}

/**
 * Tras decidir un bias con dirección explícita, las pendientes del agente
 * en dirección OPUESTA para el mismo símbolo quedan en contra de la
 * decisión vigente (y su EXECUTE original ya quedó invalidado por la
 * regla de decisión-más-reciente): se cancelan.
 */
async function cancelOppositePendings(symbol: string, direction: "BUY" | "SELL"): Promise<string[]> {
  const cancelled: string[] = [];
  try {
    const pendings = await MT5Bridge.getPendingOrders();
    for (const o of pendings) {
      try {
        const parsed = parseAgentOrderComment(String(o.comment ?? ""));
        if (!parsed || parsed.symbol !== symbol || parsed.dir === direction) continue;
        const ok = await MT5Bridge.cancelOrder(o.ticket);
        if (ok) {
          cancelled.push(`#${o.ticket} ${o.symbol} ${parsed.dir} — opuesta al bias ${direction}`);
        } else {
          console.warn(`[Pipeline] MT5 rechazó la cancelación del pendiente #${o.ticket}`);
        }
      } catch (err) {
        console.warn(`[Pipeline] No se pudo cancelar pendiente #${o.ticket}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    console.warn(`[Pipeline] Cancelación de pendientes opuestas omitida (bridge no disponible): ${(err as Error).message}`);
  }
  return cancelled;
}

// ── Gate account_risk (Task 8-a): kill-switches de cuenta ──
// GREEN = límites respetados con datos verificables.
// RED   = violación real O fuente parcial caída (fail-closed).
// UNKNOWN = cuenta ilegible (bloquea EXECUTE igual que los demás).
async function stageAccountRisk(): Promise<Gate> {
  try {
    const snap = await getAccountRisk();
    if (!snap.evaluated) {
      return gate(
        "UNKNOWN",
        "account_risk",
        `Riesgo de cuenta NO evaluable: ${snap.violations.join(" · ") || "cuenta MT5 no disponible"}`
      );
    }
    if (snap.ok) {
      const d = snap.details;
      return gate(
        "GREEN",
        "account_risk",
        `Cuenta sana: ${d.openPositions}/${d.maxOpenPositions} posiciones · exposición ${d.totalExposureLots?.toFixed(2) ?? "0"}/${d.maxTotalExposureLots} lotes · PnL hoy ${d.dailyPnl?.toFixed(2) ?? "n/d"} (límite pérdida ${d.dailyLossLimitPct}%) · racha pérdidas ${d.consecutiveLosses}/${d.maxConsecutiveLosses}`
      );
    }
    return gate("RED", "account_risk", `Kill-switch de cuenta: ${snap.violations.join(" · ")}`);
  } catch (err) {
    return gate("UNKNOWN", "account_risk", `No se pudo evaluar el riesgo de cuenta: ${(err as Error).message}`);
  }
}

// ── Etapa 1: analistas en paralelo + gates deterministas ────
async function stageAnalysts(symbol: string, timeframe: string, onProgress?: PipelineOptions["onProgress"]) {
  onProgress?.(`🔎 Fase 1/6 · Consultando filtros (horario, noticias, DXY, RVOL, SMC)…`);

  const [hours, news, dxy, rvol, smc] = await Promise.all([
    runTool("checkMarketHours", { asset: symbol }, onProgress),
    runTool("checkNews", { asset: symbol }, onProgress),
    runTool("checkDXY", { asset: symbol }, onProgress),
    runTool("checkRVOL", { asset: symbol, timeframe }, onProgress),
    runTool("analyzeMarket", { asset: symbol, timeframe }, onProgress),
  ]);

  const gates: Gate[] = [];

  // Gate de horario (determinista sobre la salida del tool)
  // Fail-closed: solo GREEN si el tool marca killzone/óptimo explícitos;
  // NO DISPONIBLE u output no reconocido → UNKNOWN (bloquea EXECUTE).
  if (
    hours.includes("🔴 RED — pipeline debe ABORTAR") ||
    hours.includes("🔴 CIERRE DE MERCADO") ||
    hours.includes("Cierre de Mercado") && hours.includes("FIN DE SEMANA") ||
    hours.includes("❌ NO RECOMENDADO")
  ) {
    gates.push(gate("RED", "market_hours", hours.split("\n").find((l) => l.includes("Estado") || l.includes("NO RECOMENDADO") || l.includes("CIERRE"))?.trim() ?? hours.slice(0, 160)));
  } else if (hours.includes("no disponible") || hours.includes("⚠️ Error")) {
    gates.push(gate("UNKNOWN", "market_hours", "Filtro de horario no disponible → no se puede confirmar sesión"));
  } else if (hours.includes("⚠️ PRECAUCIÓN")) {
    gates.push(gate("YELLOW", "market_hours", hours.split("\n").find((l) => l.includes("Estado"))?.trim() ?? "Fuera de killzone principal"));
  } else {
    gates.push(gate("GREEN", "market_hours", hours.split("\n").find((l) => l.includes("Sesiones") || l.includes("Killzone"))?.trim() ?? "Sesión operable"));
  }

  // Gate de noticias (fail-closed: sin filtro operativo → UNKNOWN)
  if (news.includes("🔴 BLOQUEADO")) {
    gates.push(gate("RED", "news", news.split("\n").find((l) => l.includes("BLOQUEADO"))?.trim() ?? "Evento de alto impacto"));
  } else if (news.includes("🟡 PRECAUCIÓN")) {
    gates.push(gate("YELLOW", "news", "Riesgo moderado → riesgo reducido a 0.25% y doble confirmación"));
  } else if (news.includes("⚠️ Error") || news.includes("NO DISPONIBLE")) {
    gates.push(gate("UNKNOWN", "news", "Tavily no disponible → sin filtro de noticias (bloquea EXECUTE)"));
  } else {
    gates.push(gate("GREEN", "news", "Sin eventos de alto impacto"));
  }

  // Gate de RVOL (volumen institucional)
  if (rvol.includes("RECHAZADO") || rvol.includes("❌")) {
    gates.push(gate("YELLOW", "rvol", rvol.split("\n").find((l) => l.includes("Validación"))?.trim() ?? "Volumen sin respaldo institucional"));
  } else if (rvol.includes("✅")) {
    gates.push(gate("GREEN", "rvol", rvol.split("\n").find((l) => l.includes("Validación"))?.trim() ?? "RVOL validado"));
  } else {
    gates.push(gate("UNKNOWN", "rvol", "RVOL no disponible"));
  }

  // Gate DXY (correlación) — sin feed real → UNKNOWN (no simular divergencia)
  if (dxy.includes("Divergencia")) {
    gates.push(gate("YELLOW", "dxy", "Divergencia DXY → exigir doble confirmación de ChoCh"));
  } else if (dxy.includes("NO DISPONIBLE") || dxy.includes("NO VERIFICADA")) {
    gates.push(gate("UNKNOWN", "dxy", "Correlación DXY sin feed real → no verificada"));
  } else {
    gates.push(gate("GREEN", "dxy", dxy.includes("Correlación Sana") ? "Correlación DXY sana" : "DXY sin señal relevante"));
  }

  // Gate de datos SMC (informativo; precio real viene del bridge)
  gates.push(
    smc.includes("Error de Bridge") || smc.includes("Error de Datos")
      ? gate("UNKNOWN", "price_feed", "Precio real no disponible desde el bridge")
      : gate("GREEN", "price_feed", "Precio real disponible vía MT5")
  );

  return { gates, reports: { hours, news, dxy, rvol, smc } };
}

// ── Etapa 2: debate Bull vs Bear (tier quick) ───────────────
async function stageDebate(
  symbol: string,
  reports: Record<string, string>,
  onProgress?: PipelineOptions["onProgress"]
): Promise<{ bull: string; bear: string; tokens: number }> {
  onProgress?.(`⚖️ Fase 2/6 · Debate institucional Bull vs Bear…`);

  const reportsBlock = Object.entries(reports)
    .map(([k, v]) => `### ${k.toUpperCase()}\n${v}`)
    .join("\n\n");

  const baseSystem = `Eres un analista institucional de trading SMC participando en un debate estructurado sobre ${symbol}.
Tu rol es defender UNA postura con los datos dados, sin inventar cifras que no aparezcan en los reportes.
Máximo 180 palabras. Estructura: 3 argumentos a favor de tu postura anclados a los reportes + 1 riesgo que admite tu postura.`;

  const bull = await callLLMByTier({
    tier: "quick",
    system: baseSystem,
    user: `POSTURA: TORO (a favor de la continuación alcista / compra).\n\nREPORTES:\n${reportsBlock}\n\nArgumenta a favor del escenario alcista.`,
    maxTokens: 700,
    temperature: 0.5,
  });

  const bear = await callLLMByTier({
    tier: "quick",
    system: baseSystem,
    user: `POSTURA: OSO (escenario bajista / venta o abstención).\n\nREPORTES:\n${reportsBlock}\n\nARGUMENTO DEL TORO (refútalo punto por punto donde puedas):\n${bull.content}\n\nArgumenta en contra de entrar largo o a favor del escenario bajista.`,
    maxTokens: 700,
    temperature: 0.5,
  });

  return { bull: bull.content, bear: bear.content, tokens: bull.tokensUsed + bear.tokensUsed };
}

// ── Etapa 3: Research Manager (tier deep, JSON) ─────────────
async function stageManager(
  symbol: string,
  reports: Record<string, string>,
  debate: { bull: string; bear: string },
  tokensSoFar: number
): Promise<{ verdict: ManagerVerdict | null; tokens: number }> {
  const { content, tokensUsed } = await callLLMByTier({
    tier: "deep",
    system: `Eres el Research Manager de un escritorio de trading institucional SMC.
Sintetiza el debate entre el analista toro y el oso junto con los reportes técnicos, de noticias, macro y volumen.
Tu veredicto debe ser honesto: NEUTRAL y confianza baja es una respuesta válida y frecuente.
Responde EXCLUSIVAMENTE con JSON válido con esta forma exacta:
{"bias":"BULLISH|BEARISH|NEUTRAL","confidence":0.0_a_1.0,"conditions":["condición que debería cumplirse para operar"],"rationale":"2-3 frases"}`,
    user: `REPORTES:\n${Object.entries(reports).map(([k, v]) => `### ${k.toUpperCase()}\n${v}`).join("\n\n")}\n\nDEBATE:\n[TORO]\n${debate.bull}\n\n[OSO]\n${debate.bear}`,
    jsonMode: true,
    maxTokens: 900,
    temperature: 0.3,
  });

  const parsed = extractJson<Partial<ManagerVerdict>>(content);
  if (!parsed || !parsed.bias || !["BULLISH", "BEARISH", "NEUTRAL"].includes(parsed.bias)) {
    return { verdict: null, tokens: tokensUsed };
  }

  const confidenceRaw = coerceNumber(parsed.confidence) ?? 0.5;
  return {
    verdict: {
      bias: parsed.bias as ManagerVerdict["bias"],
      confidence: Math.min(1, Math.max(0, confidenceRaw)),
      conditions: Array.isArray(parsed.conditions) ? parsed.conditions.map(String).slice(0, 5) : [],
      rationale: String(parsed.rationale ?? "").slice(0, 700),
    },
    tokens: tokensUsed,
  };
}

// ── Etapa 4: Trade Planner (tier deep, JSON) + lecciones ────
async function stagePlanner(
  symbol: string,
  timeframe: string,
  reports: Record<string, string>,
  verdict: ManagerVerdict | null,
  tokensSoFar: number
): Promise<{ plan: TradePlan | null; tokens: number; lessonsBlock: string }> {
  const lessonsBlock = buildLessonsContextBlock(symbol);

  const { content, tokensUsed } = await callLLMByTier({
    tier: "deep",
    system: `Eres el Trade Planner de un escritorio SMC institucional para ${symbol} (timeframe base ${timeframe}).
Convientes el veredicto del Research Manager en un plan concreto Y RESPETANDO LOS FILTROS.
Reglas duras del SOP que NO puedes violar aunque el veredicto sea alcista/bajista:
- Sin ChoCh/BOS confirmado en M1/M5 con RVOL ≥ 1.5x → action = WAIT.
- Si hay divergencia DXY, exige doble confirmación y action = WAIT si no está presente.
- riskPct máximo 1.0; si las noticias están en precaución, riskPct = 0.25.
- Si no hay plan claro: action = REVIEW. Nunca fuerces una entrada.
- stopLossPips: US30≈15, NAS100≈20, XAUUSD≈30, GBPJPY≈20, BTCUSD≈500 (ajusta si la estructura lo justifica).
Responde EXCLUSIVAMENTE con JSON válido:
{"action":"EXECUTE|WAIT|REVIEW","direction":"BUY|SELL","stopLossPips":numero_positivo,"riskPct":numero,"setup":"fvg|order_block|breaker|choch|otro","reasoning":"2-3 frases ancladas a los reportes"}`,
    user: `VEREDICTO DEL RESEARCH MANAGER:\n${verdict ? JSON.stringify(verdict) : "(no disponible — trata como incertidumbre alta)"}\n\nREPORTES:\n${Object.entries(reports).map(([k, v]) => `### ${k.toUpperCase()}\n${v}`).join("\n\n")}\n\n${lessonsBlock}`,
    jsonMode: true,
    maxTokens: 900,
    temperature: 0.3,
  });

  const parsed = extractJson<Partial<TradePlan>>(content);
  if (!parsed || !parsed.action || !["EXECUTE", "WAIT", "REVIEW"].includes(parsed.action)) {
    // Regla de oro: una decisión ilegible NUNCA se degrada a algo operable.
    return { plan: null, tokens: tokensUsed, lessonsBlock };
  }

  const slp = coerceNumber(parsed.stopLossPips);
  const risk = coerceNumber(parsed.riskPct);

  return {
    plan: {
      action: parsed.action as TradePlan["action"],
      direction: parsed.direction === "SELL" ? "SELL" : parsed.direction === "BUY" ? "BUY" : undefined,
      stopLossPips: slp !== null && slp > 0 ? slp : undefined,
      riskPct: risk !== null ? Math.min(1.0, Math.max(0.1, risk)) : undefined,
      setup: parsed.setup ? String(parsed.setup).slice(0, 40) : undefined,
      reasoning: String(parsed.reasoning ?? "").slice(0, 700),
    },
    tokens: tokensUsed,
    lessonsBlock,
  };
}

// ── Etapa 5: trío de riesgo (tier quick, en paralelo) ───────
async function stageRiskTrio(
  symbol: string,
  plan: TradePlan | null,
  verdict: ManagerVerdict | null,
  gates: Gate[],
  tokensSoFar: number
): Promise<{ opinions: RiskOpinion[]; vetoes: number; tokens: number }> {
  const personas = [
    { key: "agresivo", desc: "Analista de riesgo AGRESIVO: defiende tomar la operación si la asimetría es buena. Veta solo si el plan es objetivamente negligente." },
    { key: "conservador", desc: "Analista de riesgo CONSERVADOR: protege el capital ante todo. Veta si hay cualquier gate amarillo, datos faltantes o el setup no está confirmado al 100%." },
    { key: "neutral", desc: "Analista de riesgo NEUTRAL: balancea. Veta solo si la evidencia ponderada favorece quedarse fuera." },
  ];

  const context = `PLAN DEL TRADER:\n${plan ? JSON.stringify(plan) : "(plan ilegible — considera veto)"}\n\nVEREDICTO MANAGER:\n${verdict ? JSON.stringify(verdict) : "(no disponible)"}\n\nFILTROS:\n${gates.map((g) => `[${g.status}] ${g.name}: ${g.detail}`).join("\n")}`;

  const results = await Promise.all(
    personas.map((p) =>
      callLLMByTier({
        tier: "quick",
        system: `${p.desc}\nResponde EXCLUSIVAMENTE con JSON válido: {"verdict":"OK|VETO","concern":"1-2 frases con tu principal preocupación o respaldo"}`,
        user: context,
        jsonMode: true,
        maxTokens: 400,
        temperature: 0.35,
      }).then(({ content, tokensUsed }) => {
        const parsed = extractJson<Partial<RiskOpinion>>(content);
        return {
          opinion: {
            // Fail-closed: JSON ilegible del analista de riesgo = VETO
            // (un gate de riesgo jamás aprueba por defecto)
            verdict: parsed?.verdict === "OK" ? "OK" : "VETO",
            concern: String(parsed?.concern ?? "(opinión ilegible — veto preventivo)").slice(0, 300),
          } as RiskOpinion,
          tokens: tokensUsed,
        };
      }).catch((err) => {
        captureAutoError("risk_trio", err as Error, { persona: p.key });
        return { opinion: { verdict: "VETO", concern: "(opinión no disponible por error — veto preventivo)" } as RiskOpinion, tokens: 0 };
      })
    )
  );

  const opinions = results.map((r) => r.opinion);
  const vetoes = opinions.filter((o) => o.verdict === "VETO").length;
  return { opinions, vetoes, tokens: results.reduce((a, r) => a + r.tokens, 0) };
}

// ── Render final ────────────────────────────────────────────
function renderVerdict(opts: {
  symbol: string;
  timeframe: string;
  finalAction: FinalAction;
  gates: Gate[];
  verdict: ManagerVerdict | null;
  plan: TradePlan | null;
  opinions: RiskOpinion[];
  abortReason?: string;
  latencyMs: number;
  tokens: number;
}): string {
  const { symbol, timeframe, finalAction, gates, verdict, plan, opinions } = opts;
  const icon =
    finalAction === "EXECUTE" ? "🚀" : finalAction === "ABORTED" ? "🛑" : finalAction === "REVIEW" ? "🔍" : "⏳";

  const gatesStr = gates
    .map((g) => {
      const e = g.status === "GREEN" ? "🟢" : g.status === "YELLOW" ? "🟡" : g.status === "RED" ? "🔴" : "⚪";
      return `${e} **${g.name}**: ${g.detail}`;
    })
    .join("\n");

  const riskStr = opinions.length
    ? opinions.map((o, i) => `${o.verdict === "VETO" ? "🚫" : "👍"} **${["Agresivo", "Conservador", "Neutral"][i]}**: ${o.concern}`).join("\n")
    : "—";

  const planStr =
    plan && plan.action === "EXECUTE"
      ? `| Campo | Valor |\n|---|---|\n| Dirección | **${plan.direction}** |\n| SL | ${plan.stopLossPips} pips |\n| Riesgo | ${plan.riskPct}% |\n| Setup | ${plan.setup ?? "—"} |`
      : "No se generó plan operable.";

  return [
    `## ${icon} Protocolo Institucional SMC — ${symbol} (${timeframe})`,
    "",
    `**DECISIÓN FINAL: ${finalAction}**${opts.abortReason ? ` — ${opts.abortReason}` : ""}`,
    "",
    "### 🛡️ Filtros",
    gatesStr,
    "",
    "### 🧭 Síntesis del Research Manager",
    verdict
      ? `Sesgo **${verdict.bias}** · confianza **${(verdict.confidence * 100).toFixed(0)}%**\n${verdict.rationale}${verdict.conditions.length ? `\nCondiciones: ${verdict.conditions.join(" · ")}` : ""}`
      : "Veredicto ilegible → decisión protegida (REVIEW).",
    "",
    "### ⚖️ Debate y riesgo",
    riskStr,
    "",
    "### 🎯 Plan",
    planStr,
    plan?.reasoning ? `\n${plan.reasoning}` : "",
    "",
    `_${opts.latencyMs > 0 ? `⏱️ ${(opts.latencyMs / 1000).toFixed(1)}s · ` : ""}🎫 ${opts.tokens} tokens · decisión #auditada en decision_log_`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ── Orquestador principal ───────────────────────────────────
export async function runDecisionPipeline(opts: PipelineOptions): Promise<PipelineResult> {
  const symbol = opts.symbol.toUpperCase().trim();
  const timeframe = opts.timeframe ?? "M5";
  const t0 = Date.now();
  let tokens = 0;

  try {
    // ── Etapa 0: higiene de pendientes + riesgo de cuenta (sin tokens) ──
    // La limpieza corre en paralelo con los filtros; su fallo jamás
    // interrumpe el pipeline (solo deja el log honesto).
    const [{ gates, reports }, accountGate] = await Promise.all([
      stageAnalysts(symbol, timeframe, opts.onProgress),
      stageAccountRisk(),
    ]);
    gates.push(accountGate);
    void cleanupStalePendingOrders(opts.onProgress);
    const redGate = gates.find((g) => g.status === "RED");

    if (redGate) {
      // ABORT antes de gastar un solo token en debate
      const decisionId = saveDecision({
        userId: opts.userId,
        symbol,
        timeframe,
        finalAction: "ABORTED",
        gatesJson: JSON.stringify(gates),
        reasoning: `Abortado por gate rojo: ${redGate.name} — ${redGate.detail}`,
      });
      const md = renderVerdict({
        symbol, timeframe, finalAction: "ABORTED", gates, verdict: null, plan: null,
        opinions: [], abortReason: redGate.detail, latencyMs: Date.now() - t0, tokens: 0,
      });
      return { symbol, timeframe, finalAction: "ABORTED", decisionId, markdown: md };
    }

    // ── Etapa 2: debate ──
    const debate = await stageDebate(symbol, reports, opts.onProgress);
    tokens += debate.tokens;

    // ── Etapa 3: manager ──
    opts.onProgress?.(`🧭 Fase 3/6 · Research Manager sintetizando…`);
    const mgr = await stageManager(symbol, reports, debate, tokens);
    tokens += mgr.tokens;
    const verdict = mgr.verdict;

    // ── Etapa 4: planner + lecciones ──
    opts.onProgress?.(`📐 Fase 4/6 · Construyendo plan de trade (con lecciones aprendidas)…`);
    const planner = await stagePlanner(symbol, timeframe, reports, verdict, tokens);
    tokens += planner.tokens;
    let plan = planner.plan;

    // ── Etapa 5: trío de riesgo ──
    const needRisk = plan?.action === "EXECUTE";
    let opinions: RiskOpinion[] = [];
    let vetoes = 0;
    if (needRisk) {
      opts.onProgress?.(`🛡️ Fase 5/6 · Comité de riesgo (agresivo/conservador/neutral)…`);
      const risk = await stageRiskTrio(symbol, plan, verdict, gates, tokens);
      opinions = risk.opinions;
      vetoes = risk.vetoes;
      tokens += risk.tokens;
    }

    // ── Gate final EN CÓDIGO ──
    let finalAction: FinalAction;
    let abortReason: string | undefined;

    if (!plan) {
      finalAction = "REVIEW";
      abortReason = "Plan ilegible del planner → decisión protegida";
    } else if (plan.action === "REVIEW") {
      finalAction = "REVIEW";
      abortReason = plan.reasoning;
    } else if (plan.action === "WAIT") {
      finalAction = "WAIT";
      abortReason = plan.reasoning;
    } else if (vetoes >= 2) {
      finalAction = "WAIT";
      abortReason = `Veto del comité de riesgo (${vetoes}/2 necesarios)`;
      plan = { ...plan, action: "WAIT" };
    } else {
      // Fail-closed (SOP v3.2): UNKNOWN en filtros críticos JAMÁS permite EXECUTE.
      // Un dato faltante no es verde: es un hueco de información que bloquea.
      const CRITICAL_GATES = ["market_hours", "news", "rvol", "price_feed", "account_risk"];
      const criticalUnknown = gates.some(
        (g) => g.status === "UNKNOWN" && CRITICAL_GATES.includes(g.name)
      );
      const hasYellow = gates.some((g) => g.status === "YELLOW");
      const weakConfidence = !verdict || verdict.confidence < 0.65 || verdict.bias === "NEUTRAL";

      if (criticalUnknown) {
        finalAction = "WAIT";
        abortReason = `Filtros críticos sin datos (${gates.filter((g) => g.status === "UNKNOWN" && CRITICAL_GATES.includes(g.name)).map((g) => g.name).join(", ")}) → EXECUTE bloqueado (fail-closed)`;
        plan = { ...plan, action: "WAIT" };
      } else if (hasYellow && weakConfidence) {
        finalAction = "WAIT";
        abortReason = "Filtros en precaución + confianza insuficiente del manager";
        plan = { ...plan, action: "WAIT" };
      } else if (hasYellow) {
        // Yellow + confianza sólida → EXECUTE con riesgo reducido
        finalAction = "EXECUTE";
        plan = { ...plan, riskPct: Math.min(plan.riskPct ?? 0.5, 0.25) };
      } else {
        finalAction = "EXECUTE";
      }
    }

    // Ajuste de riesgo por gate amarillo de noticias (doble seguridad en código)
    const newsYellow = gates.some((g) => g.name === "news" && g.status === "YELLOW");
    if (finalAction === "EXECUTE" && newsYellow && plan) {
      plan = { ...plan, riskPct: 0.25 };
    }

    const latencyMs = Date.now() - t0;
    const decisionId = saveDecision({
      userId: opts.userId,
      symbol,
      timeframe,
      finalAction,
      direction: plan?.direction,
      stopLossPips: plan?.stopLossPips ?? null,
      riskPct: plan?.riskPct ?? null,
      confidence: verdict?.confidence ?? null,
      gatesJson: JSON.stringify(gates),
      reportsJson: JSON.stringify(reports).slice(0, 8_000),
      debateJson: JSON.stringify({ bull: debate.bull, bear: debate.bear, risk: opinions }).slice(0, 8_000),
      reasoning: abortReason ?? plan?.reasoning ?? undefined,
      tokensUsed: tokens,
      latencyMs,
    });

    // ── Flip de bias: pendientes del agente en dirección opuesta al bias
    // decidido quedan anuladas (su EXECUTE original ya fue invalidado por
    // la regla de decisión-más-reciente del hard-gate one-shot).
    if (plan?.direction && (finalAction === "EXECUTE" || finalAction === "WAIT")) {
      const opp = await cancelOppositePendings(symbol, plan.direction);
      if (opp.length) opts.onProgress?.(`🧹 ${opp.length} pendiente(s) opuesta(s) al bias ${plan.direction} cancelada(s)`);
    }

    const md = renderVerdict({
      symbol, timeframe, finalAction, gates, verdict, plan, opinions,
      abortReason, latencyMs, tokens,
    });

    return { symbol, timeframe, finalAction, decisionId, markdown: md };
  } catch (err) {
    captureAutoError("decision_pipeline", err as Error, { symbol, timeframe });
    const latencyMs = Date.now() - t0;
    const decisionId = saveDecision({
      userId: opts.userId,
      symbol,
      timeframe,
      finalAction: "REVIEW",
      reasoning: `Fallo del pipeline: ${(err as Error).message}`,
      latencyMs,
    });
    return {
      symbol,
      timeframe,
      finalAction: "REVIEW",
      decisionId,
      markdown: `## 🔍 Protocolo interrumpido — ${symbol}\n\nEl pipeline falló y la decisión queda protegida como **REVIEW** (nunca operable por defecto).\n\n\`\`\`\n${(err as Error).message}\n\`\`\`\n_Revisa \`reflectOnTrade\` o los errores capturados para más detalle._`,
    };
  }
}
