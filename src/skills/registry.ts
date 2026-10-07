// ============================================================
// src/skills/registry.ts
// SKILL CONTRACTS (PROMPT 06 §5 — Task 10-c, diseño del auditor 9-i)
//
// Las 17 skills del SOP mapeadas a funciones EXISTENTES del repo.
// CONTRATO DECLARATIVO: este archivo NO implementa lógica — cada
// `procedure.reference` apunta a la función/tool que YA ejecuta la skill
// (cero duplicación, §27). El registry es metadata + verificación; la
// ejecución sigue viviendo en su módulo original.
//
// Honestidad:
//   - status "PENDING" = la capacidad NO existe todavía en el código
//     (VALIDATE_RETEST y ANALYZE_LIQUIDITY: hallazgo del auditor 9-c/9-i).
//   - success_rate se calcula de fuentes reales (decision_log settled,
//     trade_orders verification) o es null con "sin datos" — nunca inventado.
//   - backtest: el motor actual es NOT REPRODUCIBLE (auditor 9-g), así que
//     RUN/ANALYZE_BACKTEST llevan la marca INVALID en pitfalls/verification.
// ============================================================

import db from "../database/sqlite.js";

// ── Tipos del contrato ──────────────────────────────────────

/** Métrica de éxito medible con fuente real. null = sin datos (honesto). */
export interface SkillMetric {
  rate: number;        // 0-1
  n: number;           // tamaño de muestra real
  source: string;      // de dónde salió la tasa (tabla/consulta)
  computed_at: string;
}

export interface SkillContract {
  identity: string;          // nombre canónico UPPER_SNAKE (único)
  purpose: string;           // qué logra (1-2 frases)
  trigger: string;           // cuándo/por quién se invoca
  prerequisites: string;     // qué debe ser cierto antes de ejecutarla
  procedure: {
    description: string;     // pasos en prosa
    reference: string;       // función existente que la ejecuta (archivo:línea o módulo)
  };
  tools_required: string[];  // tools del agent registry que usa
  expected_result: string;
  verification: string;      // check determinista que confirma el resultado
  pitfalls: string;          // fallos típicos / cómo no engañarse
  evidence: string;          // dónde queda registrada la evidencia
  version: string;
  confidence: number;        // 0-1, estimación honesta del implementador
  success_rate: SkillMetric | null;
  origin: string;            // de dónde surge la skill (spec/auditoría/task)
  last_validated: string | null; // fecha ISO (YYYY-MM-DD) de última validación formal
  regression_tests: string[];    // suites que la cubren
  status: "ACTIVE" | "PENDING";
}

// ── Métricas honestas desde fuentes reales ──────────────────

function settledWinRate(): SkillMetric | null {
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n,
                COALESCE(SUM(CASE WHEN outcome_pnl > 0 THEN 1 ELSE 0 END), 0) AS wins
         FROM decision_log
         WHERE final_action = 'EXECUTE' AND outcome_settled = 1 AND outcome_pnl IS NOT NULL`
      )
      .get() as { n: number; wins: number };
    const n = Number(row.n) || 0;
    if (n === 0) return null;
    return {
      rate: Math.round((Number(row.wins) / n) * 10_000) / 10_000,
      n,
      source: "decision_log settled (outcome_pnl > 0 / n)",
      computed_at: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function executionVerificationRate(): SkillMetric | null {
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n,
                COALESCE(SUM(CASE WHEN verification_status = 'verified' THEN 1 ELSE 0 END), 0) AS ok
         FROM trade_orders WHERE verification_status IS NOT NULL`
      )
      .get() as { n: number; ok: number };
    const n = Number(row.n) || 0;
    if (n === 0) return null;
    return {
      rate: Math.round((Number(row.ok) / n) * 10_000) / 10_000,
      n,
      source: "trade_orders.verification_status = 'verified' / n (§13)",
      computed_at: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

const SIN_DATOS = "sin datos (no hay histórico settled/verificado suficiente)";

// ── Las 17 skills del spec ──────────────────────────────────

const TODAY = new Date().toISOString().slice(0, 10);

export const SKILLS: SkillContract[] = [
  {
    identity: "ANALYZE_MARKET",
    purpose: "Analiza la estructura SMC EN VIVO de un símbolo/timeframe a partir de velas reales del bridge.",
    trigger: "Inicio de todo análisis (chat o pipeline) para un símbolo.",
    prerequisites: "bridge.py corriendo; ≥60 velas limpias del timeframe (fail-closed si no).",
    procedure: {
      description: "Obtiene velas, procesa swings/shifts/FVGs/POIs, deriva tendencia y confianza del detector real.",
      reference: "analyzeLiveStructure — src/smc/live.ts:309 (reusa detectSwingPoints/detectStructureShifts de src/backtest/smc_detector.ts)",
    },
    tools_required: ["analyzeMarket", "MT5Bridge.getCandles"],
    expected_result: "LiveAnalysis {available, trend, swings, structureShifts, fvgs, pois, confidence, reportText}.",
    verification: "available===true y candleCount≥60; bridge caído → available:false con unavailableReason (nunca inventa).",
    pitfalls: "No confundir 'available:false' con tendencia RANGO: son cosas distintas; el reporte siempre dice la causa.",
    evidence: "reports_json del decision_log (etapa analistas) / respuesta del tool analyzeMarket.",
    version: "1.0.0",
    confidence: 0.85,
    success_rate: null,
    origin: "Spec SOP §análisis; implementado Task 7 (SMC live).",
    last_validated: TODAY,
    regression_tests: ["tests/risk_smc.test.ts (SMC en vivo con velas sintéticas)"],
    status: "ACTIVE",
  },
  {
    identity: "IDENTIFY_MARKET_STRUCTURE",
    purpose: "Identificar swings confirmados y tendencia derivada (ALCISTA/BAJISTA/RANGO) sin hindsight.",
    trigger: "Dentro de ANALYZE_MARKET, antes de buscar shifts/POIs.",
    prerequisites: "Serie de velas procesada (processCandles).",
    procedure: {
      description: "Swings con lookback 5 + tendencia derivada de la secuencia de swings y shifts.",
      reference: "detectSwingPoints (src/backtest/smc_detector.ts) + deriveTrend (src/smc/live.ts:201)",
    },
    tools_required: [],
    expected_result: "SwingPoint[] y LiveTrend con basis explicable.",
    verification: "deriveTrend devuelve tendencia UNKNOWN si no hay evidencia estructural (no fuerza clasificación).",
    pitfalls: "Swing confirmado con 5 velas futuras: en vivo la detección llega 5 velas tarde — es coste de confirmación, no señal anticipada.",
    evidence: "live.swings / live.trend en el análisis y reports_json.",
    version: "1.0.0",
    confidence: 0.8,
    success_rate: null,
    origin: "Spec SOP; Task 7.",
    last_validated: TODAY,
    regression_tests: ["tests/risk_smc.test.ts (swings detectados en serie sintética)"],
    status: "ACTIVE",
  },
  {
    identity: "DETECT_BOS",
    purpose: "Detectar rupturas de estructura (Break of Structure) con dirección y volumen.",
    trigger: "Dentro de ANALYZE_MARKET cuando el precio rompe un swing estructural.",
    prerequisites: "Swings identificados + tickVolume para RVOL del SOP.",
    procedure: {
      description: "Emite setups BOS con dirección, precio del nivel roto, RVOL y confianza.",
      reference: "detectStructureShifts — src/backtest/smc_detector.ts (consumido desde src/smc/live.ts:378)",
    },
    tools_required: [],
    expected_result: "SMCSetup[] type='BOS' con rvol y confidence.",
    verification: "Cada BOS exige ruptura efectiva de swing previo (comparación estricta de highs/lows).",
    pitfalls: "BOS y ChoCh se emparejan en la misma ventana: solo el que lleva FVG asociado del mismo sentido es válido para setup.",
    evidence: "live.structureShifts (candleIndex = vela de ruptura).",
    version: "1.0.0",
    confidence: 0.8,
    success_rate: null,
    origin: "Spec SOP; Task 7 (post-auditoría 9-g la validez del setup exige FVG del mismo sentido).",
    last_validated: TODAY,
    regression_tests: ["tests/risk_smc.test.ts (BOS detectados en serie)"],
    status: "ACTIVE",
  },
  {
    identity: "DETECT_CHOCH",
    purpose: "Detectar cambios de carácter (Change of Character) como cambio posible de tendencia.",
    trigger: "Dentro de ANALYZE_MARKET cuando se rompe la estructura opuesta a la tendencia vigente.",
    prerequisites: "Swings + serie procesada.",
    procedure: {
      description: "Emite setups ChoCh con dirección corregida (post-fix del choque BOS/ChoCh del detector).",
      reference: "detectStructureShifts — src/backtest/smc_detector.ts (corregido en Task 10-b; consumido desde src/smc/live.ts:378)",
    },
    tools_required: [],
    expected_result: "SMCSetup[] type='ChoCh' con dirección coherente con el lado roto.",
    verification: "Post-fix 10-b: la dirección del ChoCh ya no sale invertida y no duplica al BOS de la misma vela.",
    pitfalls: "Un ChoCh avisa cambio posible, no confirmado: el planner exige confirmación adicional (RVOL/FVG) antes de EXECUTE.",
    evidence: "live.structureShifts + gates_json del decision_log.",
    version: "1.1.0",
    confidence: 0.75,
    success_rate: null,
    origin: "Spec SOP; fix de dirección Task 10-b (auditor 9-g lo detectó invertido).",
    last_validated: TODAY,
    regression_tests: ["tests/risk_smc.test.ts"],
    status: "ACTIVE",
  },
  {
    identity: "IDENTIFY_POI",
    purpose: "Identificar zonas de interés (Order Blocks y FVGs no mitigados) para entrada.",
    trigger: "Tras detectar shifts, para localizar dónde entraría el precio.",
    prerequisites: "Shifts detectados; FVGs con mitigación recomputada.",
    procedure: {
      description: "Order Blocks derivados de los shifts + FVGs sin mitigar como POIs.",
      reference: "deriveOrderBlocks (src/smc/live.ts:141) + detectFVGs/recomputeFvgMitigation (src/backtest/smc_detector.ts, src/smc/live.ts:379)",
    },
    tools_required: [],
    expected_result: "LivePOI[] (order blocks y FVGs) con tipo, rango y estado.",
    verification: "Solo POIs con estructura completa se publican; FVGs mitigados se excluyen.",
    pitfalls: "El detector de backtest mitigaba FVGs al nacer (9-g): en vivo la mitigación se RECOMPUTA correcta (recomputeFvgMitigation) — no usar el campo del detector crudo.",
    evidence: "live.pois en el análisis.",
    version: "1.0.0",
    confidence: 0.75,
    success_rate: null,
    origin: "Spec SOP; Task 7.",
    last_validated: TODAY,
    regression_tests: ["tests/risk_smc.test.ts"],
    status: "ACTIVE",
  },
  {
    identity: "VALIDATE_RETEST",
    purpose: "Confirmar que el precio retestea el POI con reacción antes de entrar.",
    trigger: "Entre IDENTIFY_POI y la planificación de entrada.",
    prerequisites: "POI identificado + serie en vivo.",
    procedure: {
      description: "NO IMPLEMENTADO: no existe validación de retest en el código (hallazgo del auditor 9-c/9-i).",
      reference: "— pendiente de implementación (sin función que apuntar, por honestidad)",
    },
    tools_required: [],
    expected_result: "Confirmación de retest del POI (aún no disponible).",
    verification: "— sin check: la skill no existe; cualquier afirmación de retest hoy es del LLM, no del sistema.",
    pitfalls: "No dejar que el LLM 'suponga' retest: hasta que exista, el plan debe marcar la entrada como no confirmada.",
    evidence: "—",
    version: "0.0.0",
    confidence: 0,
    success_rate: null,
    origin: "Spec SOP; gap confirmado por auditor 9-c/9-i.",
    last_validated: null,
    regression_tests: [],
    status: "PENDING",
  },
  {
    identity: "ANALYZE_LIQUIDITY",
    purpose: "Analizar liquidez (equal highs/lows, barridos) antes de validar el setup.",
    trigger: "Dentro del análisis estructural avanzado.",
    prerequisites: "Serie de velas.",
    procedure: {
      description: "NO IMPLEMENTADO: no existe análisis de liquidez en el código.",
      reference: "— pendiente de implementación",
    },
    tools_required: [],
    expected_result: "Mapa de liquidez y sweeps (aún no disponible).",
    verification: "— sin check.",
    pitfalls: "El SOP lo asume: hoy el agente opera sin este filtro — reconocerlo en el riesgo de cada plan.",
    evidence: "—",
    version: "0.0.0",
    confidence: 0,
    success_rate: null,
    origin: "Spec SOP; gap confirmado por auditor 9-i.",
    last_validated: null,
    regression_tests: [],
    status: "PENDING",
  },
  {
    identity: "CALCULATE_POSITION_SIZE",
    purpose: "Calcular el lote exacto para un riesgo planificado con pip value real.",
    trigger: "Al convertir un plan EXECUTE en orden (executor).",
    prerequisites: "riskUsd del plan, SL en pips, pip value por symbol_info o tabla PIP_VALUE_USD.",
    procedure: {
      description: "Lote = riesgo/(SL×pipValue), round-down al volumeStep, caps MAX_LOT y volumeMin (below_min → rechazo).",
      reference: "computeLotFromRisk — src/agent/tools/execute_trade_mt5.ts:139 (computePipValueUSD :108)",
    },
    tools_required: ["executeTradeMT5 (usa computeLotFromRisk internamente)"],
    expected_result: "{lotSize, realRisk} con realRisk ≤ riesgo planificado, o rejected con causa.",
    verification: "tests/risk_smc.test.ts: lote round-down exacto y realRisk ≤ planificado (round-down garantiza).",
    pitfalls: "Símbolo sin pip value → null → RECHAZO fail-closed (nunca inventar lote).",
    evidence: "trade_orders.volume + risk_amount de la orden colocada.",
    version: "1.0.0",
    confidence: 0.9,
    success_rate: null,
    origin: "Task 8-a (sizing exacto con symbol_info).",
    last_validated: TODAY,
    regression_tests: ["tests/risk_smc.test.ts (sizing exacto)"],
    status: "ACTIVE",
  },
  {
    identity: "CALCULATE_RISK",
    purpose: "Evaluar kill-switches de cuenta (pérdida diaria, posiciones, exposición, racha) antes de operar.",
    trigger: "Gate account_risk del pipeline y re-chequeo pre-envío del guard.",
    prerequisites: "Cuenta MT5 legible (ancla); fuentes parciales caídas = fail-closed.",
    procedure: {
      description: "Snapshot de riesgo con límites por env y violaciones honestas.",
      reference: "getAccountRisk — src/agent/risk_controls.ts:109 (getRiskLimits :80)",
    },
    tools_required: [],
    expected_result: "AccountRiskSnapshot {ok, evaluated, violations[], details}.",
    verification: "evaluated=false o violaciones → EXECUTE bloqueado (fail-closed verificado en tests).",
    pitfalls: "ok=false NO distingue violación real de fuente caída: ambos bloquean; el detalle (violations vs errors) dice cuál.",
    evidence: "gates_json del decision_log (gate account_risk) + guardChecks de placeOrder.",
    version: "1.0.0",
    confidence: 0.9,
    success_rate: null,
    origin: "Task 8-a (kill-switches de cuenta).",
    last_validated: TODAY,
    regression_tests: ["tests/risk_smc.test.ts (kill-switches con providers inyectados)"],
    status: "ACTIVE",
  },
  {
    identity: "VALIDATE_TRADE",
    purpose: "Validar el plan contra los gates deterministas del SOP y la policy antes de ejecutar.",
    trigger: "Entre el planner y la decisión final del pipeline.",
    prerequisites: "Plan del planner + reports de analistas.",
    procedure: {
      description: "Gates de texto/estructura (🔴/🟡/🟢), account_risk y policy; assertExecutionForDecision decide si EXECUTE procede según modo/nivel/techo/kill/approval.",
      reference: "gates del pipeline — src/agent/pipeline.ts + assertExecutionForDecision — src/agent/policy.ts:133",
    },
    tools_required: ["runDecisionPipeline"],
    expected_result: "FinalAction EXECUTE/WAIT/REVIEW con gates_json y policy_result persistidos.",
    verification: "Todo downgrade/rechazo queda en decision_log (approval_status/policy_result) — nunca silencioso.",
    pitfalls: "PIPELINE_GATE=off es backdoor de debug (9-f): en LIVE debe estar ON; los gates solo pueden ENDURECER, nunca aflojar.",
    evidence: "decision_log.gates_json + policy_events.",
    version: "1.1.0",
    confidence: 0.85,
    success_rate: null, // se recalcula en getSkillsRegistry() con win rate settled
    origin: "Task 8 (pipeline institucional) + Task 10 policy engine.",
    last_validated: TODAY,
    regression_tests: ["tests/smoke_phases.ts"],
    status: "ACTIVE",
  },
  {
    identity: "RUN_BACKTEST",
    purpose: "Correr el motor de backtest sobre datos históricos para evaluar el SOP.",
    trigger: "Petición explícita del operador (tool).",
    prerequisites: "Datos del bridge; el motor actual NO es reproducible (9-g).",
    procedure: {
      description: "Ejecuta el modo simulation del motor con los parámetros dados.",
      reference: "tool runBacktest — src/agent/tools/run_backtest.ts (engine: src/backtest/engine.ts)",
    },
    tools_required: ["runBacktest"],
    expected_result: "Resumen del run — SIEMPRE marcado según reproducibilidad.",
    verification: "Sin manifest {data_hash, params, code_version, seed} el run es INVALID/NOT REPRODUCIBLE (tabla backtest_runs).",
    pitfalls: "El motor tiene look-ahead estructural y PnL fabricado (9-g): su salida NO alimenta decisiones ni promoción de lecciones.",
    evidence: "backtest_runs (manifest) — verdict por defecto INVALID_NOT_REPRODUCIBLE.",
    version: "0.9.0",
    confidence: 0.3,
    success_rate: null,
    origin: "Repo original; auditoría 9-g lo declara no reproducible.",
    last_validated: null,
    regression_tests: [],
    status: "ACTIVE", // el tool existe y corre (con marca INVALID) — lo no válido es el motor, no la existencia del tool
  },
  {
    identity: "ANALYZE_BACKTEST",
    purpose: "Interpretar los resultados de un backtest con veredicto de reproducibilidad.",
    trigger: "Tras RUN_BACKTEST.",
    prerequisites: "Run registrado con manifest en backtest_runs.",
    procedure: {
      description: "Lee el manifest persistido y el verdict; INVALID si falta manifest completo.",
      reference: "saveBacktestRunManifest — src/database/sqlite.ts (tabla backtest_runs; veredicto INVALID_NOT_REPRODUCIBLE por defecto)",
    },
    tools_required: ["runBacktest", "runBacktestPro"],
    expected_result: "Métricas SOLO si el run es VALID; si falta manifest → INVALID y se ignora.",
    verification: "SELECT verdict FROM backtest_runs WHERE run_id=? — INVALID → no usar para nada.",
    pitfalls: "Veredictos de 9-g: simulation/stress/wfa/portfolio/regime NO operativos hasta reconstruir el motor; usar solo el modo report (journal real de trade_performance).",
    evidence: "backtest_runs.metrics_json + verdict.",
    version: "0.9.0",
    confidence: 0.3,
    success_rate: null,
    origin: "Task 10 (manifest de reproducibilidad) + auditor 9-g.",
    last_validated: null,
    regression_tests: [],
    status: "ACTIVE",
  },
  {
    identity: "REVIEW_TRADE",
    purpose: "Destilar una lección reutilizable de un trade cerrado (settlement → reflexión).",
    trigger: "Automático al cerrar una decisión EXECUTE (settlement), o manual vía tool.",
    prerequisites: "PnL del trade (o nota del usuario).",
    procedure: {
      description: "Reflexión LLM tier-quick → lección con decay/scope/importance + MemoryDV (evidencia, truth_level, confidence).",
      reference: "reflectOnExperience — src/agent/self_improve.ts (desde settleWithPnl — src/agent/settlement.ts) / tool reflectOnTrade",
    },
    tools_required: ["reflectOnTrade", "settleDecisions"],
    expected_result: "Lección guardada con dedupe por pattern_key y evidencia citable (decision_id).",
    verification: "agent_lessons.evidence_json contiene decision_id y truth_level='OBSERVED' (settlement) / 'REPORTED' (usuario).",
    pitfalls: "Una lección de UN trade no entra al contexto (gate times_seen≥3) ni se promueve sin validación estadística.",
    evidence: "decision_log.outcome_* + agent_lessons.",
    version: "1.1.0",
    confidence: 0.8,
    success_rate: null,
    origin: "Patrón TradingAgents; MemoryDV Task 10-c.",
    last_validated: TODAY,
    regression_tests: ["tests/memory_skills.test.ts"],
    status: "ACTIVE",
  },
  {
    identity: "ANALYZE_TRADE_ERROR",
    purpose: "Capturar y clasificar errores operativos de tools para triage recurrente.",
    trigger: "Automático: todo fallo de tool pasa por captureAutoError.",
    prerequisites: "Error capturado desde executeToolByName.",
    procedure: {
      description: "Clasifica el error (pattern_key TOOL|tool|tipo) y lo acumula; triage ≥3 crea lección operativa OPS|.",
      reference: "captureAutoError + triageUnresolvedErrors — src/agent/self_improve.ts (invocado desde executeToolByName — src/agent/registry.ts)",
    },
    tools_required: [],
    expected_result: "agent_errors agrupado por pattern_key; recurrentes → agent_lessons PROCEDURAL.",
    verification: "agent_lessons.memory_type='PROCEDURAL' para lecciones OPS| (consolidación).",
    pitfalls: "El triage marca errores como resueltos al crear la lección: si el error vuelve, se re-acumula desde cero (por diseño).",
    evidence: "agent_errors + agent_lessons (kind=knowledge_gap).",
    version: "1.0.0",
    confidence: 0.85,
    success_rate: null,
    origin: "self-improving-agent; auditado 9-i (ciclo §4 70% cubierto).",
    last_validated: TODAY,
    regression_tests: ["tests/memory_skills.test.ts"],
    status: "ACTIVE",
  },
  {
    identity: "PREPARE_TRADE_PLAN",
    purpose: "Convertir el veredicto del Research Manager en un plan concreto (entry/SL/riskPct) respetando el SOP.",
    trigger: "Etapa 4 del pipeline, tras el debate y los gates de texto.",
    prerequisites: "Reports de analistas + veredicto del manager + lecciones elegibles (gate ≥3).",
    procedure: {
      description: "Planner LLM tier-deep con reglas duras del SOP inyectadas y lecciones de contexto.",
      reference: "stagePlanner — src/agent/pipeline.ts:359 (inyecta buildLessonsContextBlock — src/agent/self_improve.ts)",
    },
    tools_required: ["runDecisionPipeline"],
    expected_result: "TradePlan JSON válido o action=WAIT (nunca plan sin filtros del SOP).",
    verification: "El plan pasa por VALIDATE_TRADE antes de volverse decisión; gates_json registra el veredicto.",
    pitfalls: "El planner no puede violar las reglas duras (ChoCh/BOS+RVOL, DXY, riskPct máx) — el system prompt lo clava y los gates re-chequean.",
    evidence: "decision_log (stop_loss_pips, risk_pct, reasoning) + reports_json.",
    version: "1.0.0",
    confidence: 0.8,
    success_rate: null, // recalculada (win rate settled) en getSkillsRegistry()
    origin: "Task 8 (pipeline 4 etapas).",
    last_validated: TODAY,
    regression_tests: ["tests/smoke_phases.ts"],
    status: "ACTIVE",
  },
  {
    identity: "EXECUTE_APPROVED_TRADE",
    purpose: "Convertir una decisión EXECUTE aprobada en orden MT5 real con riesgo heredado y un solo disparo.",
    trigger: "Tras decisión EXECUTE vigente (≤15 min, no consumida) y policy que lo permita.",
    prerequisites: "Hard-gate: decisión reciente, claim one-shot, riesgo heredado de la decisión (no del LLM), policy+guard ok.",
    procedure: {
      description: "Hard-gate → clamps de riesgo → MT5Bridge.placeOrder con execution guard independiente y verificación §13.",
      reference: "executeTradeMT5 — src/agent/tools/execute_trade_mt5.ts:201 (guard: src/agent/execution_guard.ts; policy: src/agent/policy.ts)",
    },
    tools_required: ["executeTradeMT5"],
    expected_result: "trade_orders con ticket y verification_status 'verified'|'divergence'; sin ticket → releaseDecision.",
    verification: "Sin decisión válida no hay orden; PIPELINE_GATE=off solo tolerado fuera de LIVE; toda orden queda vinculada a decision_id.",
    pitfalls: "Es el punto de NO retorno de dinero real: la doble llave (policy + guard) es fail-closed; jamás relajar para 'probar'.",
    evidence: "trade_orders (risk_amount, strategy, expiration, verification_status) + policy_events.",
    version: "1.1.0",
    confidence: 0.85,
    success_rate: null, // recalculada (win rate settled) en getSkillsRegistry()
    origin: "Repo original + Task 8-a (clamps) + Task 10 (policy/guard).",
    last_validated: TODAY,
    regression_tests: ["tests/risk_smc.test.ts", "tests/smoke_phases.ts"],
    status: "ACTIVE",
  },
  {
    identity: "VERIFY_EXECUTION",
    purpose: "Verificar que el broker ejecutó lo pedido (§13) y cerrar el ciclo con settlement del resultado.",
    trigger: "Inmediatamente tras placeOrder, y periódicamente vía settlement (horizonte 24h).",
    prerequisites: "Respuesta del broker con retcode/price/volume.",
    procedure: {
      description: "Verificación request-vs-actual (retcode 10008/10009, tolerancia de precio y volumen) + cascada PnL→lección.",
      reference: "MT5Bridge.placeOrder verification — src/config/mt5bridge.ts:217-253 + runSettlement — src/agent/settlement.ts:51",
    },
    tools_required: ["settleDecisions"],
    expected_result: "verification_status 'verified'|'divergence' en trade_orders; outcome_pnl/outcome_source en decision_log; lección MemoryDV.",
    verification: "divergencia logueada y persistida; settlement solo cierra con evidencia (performance_log/bridge) o expira con causa.",
    pitfalls: "HTTP 200 NO significa ejecutado: sin verificación explícita una divergencia pasaría inadvertida; settlement sin PnL reportable expira honesto.",
    evidence: "trade_orders.verification_status/slippage + decision_log.outcome_* + agent_lessons.evidence_json.",
    version: "1.1.0",
    confidence: 0.85,
    success_rate: null, // recalculada (verification rate §13) en getSkillsRegistry()
    origin: "Task 9-a/10-b (verify §13) + Fase 2 (settlement).",
    last_validated: TODAY,
    regression_tests: ["tests/risk_smc.test.ts", "tests/smoke_phases.ts"],
    status: "ACTIVE",
  },
];

// ── API pública ─────────────────────────────────────────────

/**
 * Devuelve el registry con success_rate RECALCULADA de fuentes reales:
 *  - VALIDATE_TRADE / PREPARE_TRADE_PLAN / EXECUTE_APPROVED_TRADE:
 *      win rate de decisiones EXECUTE settled (decision_log).
 *  - VERIFY_EXECUTION: tasa de verificación §13 (trade_orders).
 *  - Resto: null con "sin datos" (jamás inventado).
 */
export function getSkillsRegistry(): SkillContract[] {
  const settled = settledWinRate();
  const verification = executionVerificationRate();
  return SKILLS.map((s) => {
    if (s.identity === "VALIDATE_TRADE" || s.identity === "PREPARE_TRADE_PLAN" || s.identity === "EXECUTE_APPROVED_TRADE") {
      return { ...s, success_rate: settled };
    }
    if (s.identity === "VERIFY_EXECUTION") {
      return { ...s, success_rate: verification };
    }
    return { ...s };
  });
}

/** Nota honesta para render cuando no hay métrica. */
function metricText(m: SkillMetric | null): string {
  return m ? `${Math.round(m.rate * 100)}% (n=${m.n})` : "sin datos";
}

/**
 * Tabla Markdown para Telegram/dashboard: skill, status, versión,
 * confidence y last_validated (contrato §5 en formato legible).
 */
export function renderSkillsMarkdown(): string {
  const skills = getSkillsRegistry();
  const active = skills.filter((s) => s.status === "ACTIVE").length;
  const pending = skills.filter((s) => s.status === "PENDING");

  const rows = skills.map(
    (s) =>
      `| \`${s.identity}\` | ${s.status === "ACTIVE" ? "✅ ACTIVE" : "🚧 PENDING"} | ${s.version} | ${s.confidence.toFixed(2)} | ${s.last_validated ?? "sin validar"} | ${metricText(s.success_rate)} |`
  );

  return [
    "### 🧭 Skills del agente (contrato §5)",
    "",
    `${active}/${skills.length} ACTIVE · ${pending.length} PENDING (honestas: no implementadas todavía)`,
    "",
    "| Skill | Status | Versión | Confianza | Última validación | Success rate |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
    pending.length
      ? `🚧 Pendientes: ${pending.map((p) => `\`${p.identity}\``).join(", ")} — se declaran PENDING en vez de fingirse activas.`
      : "",
    "_Cada skill apunta a la función existente que la ejecuta (cero lógica duplicada). success_rate calculada de decision_log settled / trade_orders §13 cuando hay muestra; \"sin datos\" si no._",
  ]
    .filter((l) => l.length > 0)
    .join("\n");
}
