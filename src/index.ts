// ============================================================
// src/index.ts
// Agente Conversacional – Entry point
// ============================================================

import "dotenv/config";
import { bot } from "./bot/telegram.js";
import { startDashboard } from "./server.js";

const AGENT_NAME = process.env.AGENT_NAME ?? "Agente Conversacional";

async function main() {
  console.log(`
╔═══════════════════════════════════════╗
║   ${AGENT_NAME.padEnd(27)} ║
║   Kimi K2.5 · NVIDIA NIM · grammy     ║
╚═══════════════════════════════════════╝
`);

  console.log("[Boot] 🗄️  Database initialized (SQLite WAL mode)");
  
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
