import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { runAgentLoop } from "./agent/loop.js";
import db, { getRecentMessages } from "./database/sqlite.js";
import { getAgentStatusAsync } from "./agent/observability.js";
import { evaluateBrain, getBrainTrend } from "./agent/brain_eval.js";
import { runSettlement, startAgentMaintenance } from "./agent/settlement.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function startDashboard(port: number = 3000) {
  const app = express();
  
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  // SEGURIDAD (auditoría 6-b): auth por bearer token opcional.
  // Exporta DASHBOARD_TOKEN en .env para exigirlo en cada llamada.
  const dashboardToken = process.env.DASHBOARD_TOKEN;
  if (dashboardToken) {
    app.use("/api", (req, res, next) => {
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

  // API: Get Trade Performance (for future features / dashboard stats)
  app.get("/api/performance", (req, res) => {
    try {
      const history = db.prepare("SELECT * FROM trade_performance ORDER BY timestamp DESC LIMIT 20").all();
      res.json(history);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // ── API: Observabilidad del agente (Fase 5) ──
  app.get("/api/agent/status", async (_req, res) => {
    try {
      res.json(await getAgentStatusAsync());
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // ── API: Evaluación del cerebro (Fase 4) ──
  // GET solo LEE; el snapshot de tendencia se genera solo con ?snapshot=1
  // (un cliente ruidoso no debe envenenar la tendencia, auditoría 6-b)
  app.get("/api/agent/brain", (req, res) => {
    try {
      const report = evaluateBrain();
      if (req.query.snapshot === "1") {
        db.prepare(`INSERT INTO brain_evaluations (score, report_json) VALUES (?, ?)`)
          .run(report.score, JSON.stringify(report));
      }
      res.json({ ...report, trend: getBrainTrend(10).reverse() });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
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
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // ── API: forzar settlement manual ──
  app.post("/api/agent/settle", async (_req, res) => {
    try {
      res.json(await runSettlement(25));
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // API: Get Chat History
  app.get("/api/chat/history", (req, res) => {
    try {
      // Using a predefined web session ID
      const messages = getRecentMessages("web_session", 50);
      res.json(messages.reverse()); // Chronological order
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // API: Send Message to Agent
  app.post("/api/chat/message", async (req, res) => {
    const { message } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: "Message is required" });
    }

    try {
      // We will use Server-Sent Events (SSE) to stream the reasoning and response if needed,
      // but for simplicity and robustness, we can stream JSON chunks or just return the final response 
      // if streaming is too complex for this basic chat. Let's return the full response and reasoning.
      
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
      console.error("[Web API] Error in chat:", error);
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // SEGURIDAD: bind a localhost por defecto. El dashboard manipula la cuenta
  // (chat → tools); expónlo en LAN/0.0.0.0 SOLO con DASHBOARD_TOKEN configurado.
  const host = process.env.HOST ?? "127.0.0.1";
  app.listen(port, host, () => {
    console.log(`[Dashboard] 🌐 Web Interface running at http://${host}:${port}${host === "127.0.0.1" ? " (solo local — exporta HOST para exponer en red)" : " ⚠️ expuesto"}`);
  });
}
