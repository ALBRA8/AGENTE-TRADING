import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import path from "path";
import fs from "node:fs";
import { fileURLToPath } from "url";
import { runAgentLoop } from "./agent/loop.js";
import db, { getRecentMessages } from "./database/sqlite.js";
import { getAgentStatusAsync } from "./agent/observability.js";
import { evaluateBrain, getBrainTrend } from "./agent/brain_eval.js";
import { runSettlement, startAgentMaintenance } from "./agent/settlement.js";
import { getTrackRecord } from "./agent/trackrecord.js";
import { getLicenseGate, renderLicenseLogLine } from "./license.js";
import {
  getPolicySummary,
  setPolicyMode,
  setAutonomyLevel,
  setAutonomyCeiling,
  setKillSwitch,
  approveDecision,
  getPolicyEventsHistory,
  type PolicyMode,
} from "./agent/policy.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// PROMPT 06 §6/§19: el modo ya NO se infiere de LIVE_TRADING — lo emite el
// Policy Engine (policy_events > env, default PAPER). LIVE_TRADING es solo el
// segundo factor del modo LIVE.

// ── SEGURIDAD (auditoría 6-b + Task 8-b): rate limit por IP a mano ──
// Sin dependencias nuevas: Map en memoria con ventana fija de 60s.
const RATE_LIMIT_PER_MIN = Math.max(1, parseInt(process.env.RATE_LIMIT_PER_MIN ?? "60", 10) || 60);
const RATE_WINDOW_MS = 60_000;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function rateLimitApi(req: Request, res: Response, next: NextFunction): void {
  if (!req.path.startsWith("/api/")) return next();
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateBuckets.set(ip, bucket);
  }
  bucket.count++;
  if (bucket.count > RATE_LIMIT_PER_MIN) {
    const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    res.set("Retry-After", String(retryAfterSec));
    res.status(429).json({ error: "Demasiadas solicitudes. Espera antes de reintentar." });
    return;
  }
  next();
}

// Limpieza periódica del Map (evita fuga lenta por IPs únicas). No retiene el proceso.
function startRateLimitJanitor(): void {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [ip, bucket] of rateBuckets) {
      if (bucket.resetAt <= now) rateBuckets.delete(ip);
    }
  }, RATE_WINDOW_MS);
  timer.unref?.();
}

// Errores: log completo en consola, respuesta GENÉRICA al cliente
// (nunca filtrar stack traces ni mensajes internos, auditoría 6-b).
function fail(res: Response, context: string, error: unknown): void {
  console.error(`[Dashboard] ${context}:`, error);
  if (!res.headersSent) {
    res.status(500).json({ error: "Error interno del servidor." });
  }
}

export function startDashboard(port: number = 3000) {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: "1mb" }));
  app.use(rateLimitApi);
  startRateLimitJanitor();

  // ── Licencia offline (Task 8-b) ──
  // LICENSE_REQUIRED=true + licencia inválida → 503 en /api/*, salvo la
  // vitrina pública (/api/trackrecord) y el healthcheck (/api/health).
  // Con el default (LICENSE_REQUIRED=false) NUNCA se bloquea al dueño.
  const license = getLicenseGate();
  if (license.blocking) {
    app.use("/api", (req, res, next) => {
      const p = req.path.replace(/\/+$/, "");
      if (p === "/trackrecord" || p === "/health") return next();
      return res.status(503).json({
        error: "Servicio no disponible: licencia inválida o ausente (LICENSE_REQUIRED=true).",
      });
    });
  }

  // ── SEGURIDAD (auditoría 6-b): auth por bearer token opcional ──
  // Exporta DASHBOARD_TOKEN en .env para exigirlo en TODOS los POST /api/*
  // (incluido /api/chat/message y /api/agent/*). Los GET de lectura quedan
  // abiertos: el Track Record es la vitrina pública del producto.
  const dashboardToken = process.env.DASHBOARD_TOKEN;
  if (dashboardToken) {
    app.use("/api", (req, res, next) => {
      if (req.method !== "POST") return next();
      const auth = req.headers.authorization ?? "";
      if (auth !== `Bearer ${dashboardToken}`) {
        return res.status(401).json({ error: "No autorizado" });
      }
      next();
    });
  }

  // Serve static files from the 'public' directory
  app.use(express.static(path.join(__dirname, "../public")));

  // Mantenimiento en background: settlement + triage de errores (Fase 2/5)
  startAgentMaintenance();

  // ── API: healthcheck mínimo (sin auth, sin datos) ──
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, mode: getPolicySummary().mode, ts: new Date().toISOString() });
  });

  // ── API: Track Record — la vitrina pública (Task 8-b) ──
  // Cache en memoria de 60s; lectura sin auth por diseño de producto.
  const TRACKRECORD_CACHE_MS = 60_000;
  let trackRecordCache: { at: number; data: ReturnType<typeof getTrackRecord> } | null = null;
  app.get("/api/trackrecord", (_req, res) => {
    try {
      const now = Date.now();
      if (!trackRecordCache || now - trackRecordCache.at > TRACKRECORD_CACHE_MS) {
        trackRecordCache = { at: now, data: getTrackRecord() };
      }
      res.json(trackRecordCache.data);
    } catch (error) {
      fail(res, "trackrecord", error);
    }
  });

  // ── API: Pine TradingView (Task 11-c) — código listo para copiar/pegar ──
  // Whitelist estricta: solo los dos .pine de tradingview/. Lectura pública
  // (no expone nada sensible; mismos criterios que /api/trackrecord).
  const PINE_FILES: Record<string, string> = {
    indicador: "zarus30_v2.pine",
    estrategia: "zarus30_v2_strategy.pine",
  };
  app.get("/api/pine/:name", (req, res) => {
    try {
      const file = PINE_FILES[String(req.params.name ?? "").toLowerCase()];
      if (!file) {
        return res.status(404).json({ error: "Archivo Pine no encontrado. Usa 'indicador' o 'estrategia'." });
      }
      const code = fs.readFileSync(path.join(__dirname, "../tradingview", file), "utf8");
      res.json({ filename: file, code });
    } catch (error) {
      fail(res, "pine", error);
    }
  });

  // API: Get Trade Performance (for future features / dashboard stats)
  app.get("/api/performance", (_req, res) => {
    try {
      const history = db.prepare("SELECT * FROM trade_performance ORDER BY timestamp DESC LIMIT 20").all();
      res.json(history);
    } catch (error) {
      fail(res, "performance", error);
    }
  });

  // ── PROMPT 06 §6/§19: POLICY API ──
  // GET: estado vigente (público: modo/nivel/kill son datos de operación, sin secretos).
  app.get("/api/policy", (_req, res) => {
    try {
      res.json({ ...getPolicySummary(), history: getPolicyEventsHistory(20) });
    } catch (error) {
      fail(res, "policy GET", error);
    }
  });

  // POST: cambios de gobernanza — SIEMPRE exigen token (si no hay
  // DASHBOARD_TOKEN configurado, el control de policy está CERRADO: fail-closed).
  app.post("/api/policy", (req, res) => {
    try {
      const token = process.env.DASHBOARD_TOKEN;
      if (!token) {
        return res.status(503).json({ error: "Control de policy deshabilitado: exporta DASHBOARD_TOKEN para operar la gobernanza (fail-closed)." });
      }
      const auth = req.headers.authorization ?? "";
      if (auth !== `Bearer ${token}`) {
        return res.status(401).json({ error: "No autorizado" });
      }
      const { action, value, reason, decisionId } = req.body ?? {};
      const actor = `dashboard:${req.ip ?? "?"}`;
      const razon = String(reason ?? "(sin razón)").slice(0, 300);
      switch (String(action ?? "")) {
        case "set_mode":
          return res.json({ policy: setPolicyMode(actor, String(value).toUpperCase() as PolicyMode, razon) });
        case "set_level":
          return res.json({ policy: setAutonomyLevel(actor, parseInt(String(value), 10), razon) });
        case "set_ceiling":
          return res.json({ policy: setAutonomyCeiling(actor, parseInt(String(value), 10), razon) });
        case "kill_switch":
          return res.json({ policy: setKillSwitch(actor, String(value).toLowerCase() === "on", razon) });
        case "approve": {
          const id = parseInt(String(decisionId), 10);
          if (!Number.isFinite(id)) return res.status(400).json({ error: "decisionId requerido" });
          const ok = approveDecision(id, actor);
          return res.json({ approved: ok, policy: getPolicySummary() });
        }
        default:
          return res.status(400).json({ error: "action inválida: set_mode | set_level | set_ceiling | kill_switch | approve" });
      }
    } catch (error) {
      fail(res, "policy POST", error);
    }
  });

  // ── API: Observabilidad del agente (Fase 5) ──
  app.get("/api/agent/status", async (_req, res) => {
    try {
      const status = await getAgentStatusAsync();
      // Campo `mode` para el badge [DEMO]/[LIVE] de la UI (sin auth: GET).
      const pol = getPolicySummary();
      res.json({ ...status, mode: pol.mode, autonomyLevel: pol.effectiveLevel, autonomyCeiling: pol.autonomyCeiling, killSwitch: pol.killSwitch });
    } catch (error) {
      fail(res, "agent/status", error);
    }
  });

  // ── API: Evaluación del cerebro (Fase 4) ──
  // GET solo LEE; el snapshot de tendencia se genera solo con ?snapshot=1
  // (un cliente ruidoso no debe envenenar la tendencia, auditoría 6-b).
  // PROMPT 06 §23: snapshot=1 ESCRIBE → exige token; sin token configurado,
  // el snapshot queda DENEGADO (fail-closed, auditoría 9-h).
  app.get("/api/agent/brain", (req, res) => {
    try {
      const report = evaluateBrain();
      if (req.query.snapshot === "1") {
        const token = process.env.DASHBOARD_TOKEN;
        const auth = req.headers.authorization ?? "";
        if (!token || auth !== `Bearer ${token}`) {
          return res.status(403).json({ error: "snapshot=1 requiere DASHBOARD_TOKEN (escritura protegida)" });
        }
        db.prepare(`INSERT INTO brain_evaluations (score, report_json) VALUES (?, ?)`)
          .run(report.score, JSON.stringify(report));
      }
      res.json({ ...report, trend: getBrainTrend(10).reverse() });
    } catch (error) {
      fail(res, "agent/brain", error);
    }
  });

  // ── API: últimas decisiones auditadas ──
  app.get("/api/agent/decisions", (req, res) => {
    try {
      const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "20")) || 20));
      const rows = db
        .prepare(
          `SELECT id, created_at, symbol, timeframe, final_action, direction,
                  confidence, risk_pct, reasoning, tokens_used, latency_ms,
                  outcome_pnl, outcome_settled, outcome_source
           FROM decision_log ORDER BY id DESC LIMIT ?`
        )
        .all(limit);
      res.json(rows);
    } catch (error) {
      fail(res, "agent/decisions", error);
    }
  });

  // ── API: forzar settlement manual ──
  app.post("/api/agent/settle", async (_req, res) => {
    try {
      res.json(await runSettlement(25));
    } catch (error) {
      fail(res, "agent/settle", error);
    }
  });

  // API: Get Chat History
  app.get("/api/chat/history", (_req, res) => {
    try {
      // Using a predefined web session ID
      const messages = getRecentMessages("web_session", 50);
      res.json(messages.reverse()); // Chronological order
    } catch (error) {
      fail(res, "chat/history", error);
    }
  });

  // API: Send Message to Agent
  app.post("/api/chat/message", async (req, res) => {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Message is required" });
    }

    try {
      const response = await runAgentLoop({
        userId: "web_session",
        userMessage: message,
        onStream: (chunk, isReasoning) => {
          // Future: could hook up WebSockets for live streaming
        }
      });

      res.json({
        response: response.response,
        reasoning: response.reasoning || null
      });

    } catch (error) {
      // Log completo en servidor; al cliente solo un mensaje genérico.
      fail(res, "chat/message", error);
    }
  });

  // ── PROMPT 06 §20: DOCTOR — diagnóstico de las 9 secciones ──
  app.get("/api/agent/doctor", async (_req, res) => {
    try {
      const { runDoctor, renderDoctorMarkdown } = await import("./agent/doctor.js");
      const report = await runDoctor();
      res.json({ ...report, markdown: renderDoctorMarkdown(report) });
    } catch (error) {
      fail(res, "agent/doctor", error);
    }
  });

  // ── PROMPT 06 §5: SKILLS — contrato declarativo de capacidades ──
  app.get("/api/skills", async (_req, res) => {
    try {
      const { getSkillsRegistry, renderSkillsMarkdown } = await import("./skills/registry.js");
      res.json({ skills: getSkillsRegistry(), markdown: renderSkillsMarkdown() });
    } catch (error) {
      fail(res, "skills", error);
    }
  });

  // ── Arranque ──
  // SEGURIDAD: bind a localhost por defecto. El dashboard manipula la cuenta
  // (chat → tools); expónlo en LAN/0.0.0.0 SOLO con DASHBOARD_TOKEN configurado.
  // PROMPT 06 §11: LIVE sin DASHBOARD_TOKEN ABORTA EL ARRANQUE (nunca inferir
  // autorización: sin segundo factor no hay LIVE, ni del dashboard ni del bot).
  const host = process.env.HOST ?? "127.0.0.1";
  const bootPolicy = getPolicySummary();
  const bootToken = process.env.DASHBOARD_TOKEN;
  if ((bootPolicy.mode === "LIVE" || bootPolicy.liveTradingEnv) && !bootToken) {
    throw new Error(
      "ARRANQUE ABORTADO: modo LIVE (o LIVE_TRADING=true) sin DASHBOARD_TOKEN. Sin segundo factor de autenticación no hay trading real (PROMPT 06 §11). Configura DASHBOARD_TOKEN o vuelve a PAPER."
    );
  }
  app.listen(port, host, () => {
    console.log(`[Dashboard] 🌐 Web Interface running at http://${host}:${port}${host === "127.0.0.1" ? " (solo local — exporta HOST para exponer en red)" : " ⚠️ expuesto"}`);
    console.log(`[Dashboard] Modo: ${bootPolicy.mode} · autonomía L${bootPolicy.effectiveLevel} (techo L${bootPolicy.autonomyCeiling}) · kill switch ${bootPolicy.killSwitch ? "🛑 ACTIVO" : "inactivo"}${bootPolicy.mode === "LIVE" ? " — 🔴 LIVE con doble factor" : " — sin ejecución real de órdenes"}`);
    console.log(renderLicenseLogLine(license.state));
    console.log(`[Dashboard] Rate limit: ${RATE_LIMIT_PER_MIN} req/min por IP sobre /api/* (env RATE_LIMIT_PER_MIN)`);
  });
}
