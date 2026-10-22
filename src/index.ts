// ============================================================
// src/index.ts
// Agente Conversacional – Entry point
// ============================================================

import "dotenv/config";
import { bot } from "./bot/telegram.js";
import { startDashboard } from "./server.js";
import { startAgentMaintenance } from "./agent/settlement.js";

const AGENT_NAME = process.env.AGENT_NAME ?? "Agente Conversacional";

async function main() {
  console.log(`
╔═══════════════════════════════════════╗
║   ${AGENT_NAME.padEnd(27)} ║
║   Kimi K2.5 · NVIDIA NIM · grammy     ║
╚═══════════════════════════════════════╝
`);

  console.log("[Boot] 🗄️  Database initialized (SQLite WAL mode)");

  // Mantenimiento continuo: settlement de decisiones + triage de errores
  startAgentMaintenance();

  // ── ARNÉS (migración PROYECTO → ARNÉS): montar el chaleco AGENTE-GENERAL ──
  // Best-effort: si algo falla, el bot arranca IGUAL que antes de la migración
  // (el arnés es aditivo y NUNCA bloquea el arranque — migration-analysis.md §4).
  try {
    const { ensureHarness } = await import("./lib/harness/runtime.js");
    const h = await ensureHarness();
    console.log(
      `[Boot] 🦺 Arnés montado: ${h.agent.name} v${h.agent.version} · bridges [${h.bridges.list().map((b) => b.type).join(", ")}] · conocimiento [${h.knowledge.list().map((k) => k.id).join(", ")}]`
    );
  } catch (err) {
    console.warn(`[Boot] ⚠️ Arnés no montado (no bloquea el arranque): ${(err as Error).message}`);
  }

  // Start Web Dashboard
  startDashboard(process.env.PORT ? parseInt(process.env.PORT) : 4000);
  
  console.log("[Boot] 🤖 Starting Telegram bot (Long Polling)…");

  // Start Long Polling – no webhook, no port config needed
  await bot.start({
    onStart(botInfo) {
      console.log(
        `[Boot] ✅ Bot started: @${botInfo.username} (ID: ${botInfo.id})`
      );
      console.log("[Boot] 🔑 Whitelist active – only allowed users can chat.");
      console.log(`[Boot] 🚀 ${AGENT_NAME} is live and listening!\n`);
    },
  });
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
