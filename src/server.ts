import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { runAgentLoop } from "./agent/loop.js";
import db, { getRecentMessages } from "./database/sqlite.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function startDashboard(port: number = 3000) {
  const app = express();
  
  app.use(cors());
  app.use(express.json());
  
  // Serve static files from the 'public' directory
  app.use(express.static(path.join(__dirname, "../public")));

  // API: Get Trade Performance (for future features / dashboard stats)
  app.get("/api/performance", (req, res) => {
    try {
      const history = db.prepare("SELECT * FROM trade_performance ORDER BY timestamp DESC LIMIT 20").all();
      res.json(history);
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

  app.listen(port, "0.0.0.0", () => {
    console.log(`[Dashboard] 🌐 Web Interface running at http://localhost:${port}`);
  });
}
