// ============================================================
// src/bot/telegram.ts
// Telegram bot de Agente Conversacional usando grammy – Long Polling
// ============================================================

import { Bot, Context, InputFile } from "grammy";
import path from "path";
import fs from "fs";
import { runAgentLoop } from "../agent/loop.js";
import { upsertUser } from "../database/sqlite.js";
import { MODEL_TIERS } from "../config/nvidia.js";
import dotenv from "dotenv";

dotenv.config({ override: true }); // override: el .env del proyecto gana sobre variables del sistema

// ── Modo operativo (compliance Task 8-b) ──────────────────
// DEMO por defecto; LIVE solo con opt-in explícito LIVE_TRADING=true.
const TRADING_MODE =
  (process.env.LIVE_TRADING ?? "").trim().toLowerCase() === "true" ? "LIVE" : "DEMO";
const MODE_BADGE = TRADING_MODE === "LIVE" ? "🔴 [LIVE]" : "🟢 [DEMO]";

/**
 * Línea corta de riesgo que acompaña a toda notificación de orden ejecutada
 * (compliance: disclaimer tras ejecución, auditoría 6-c).
 */
const TRADE_RISK_LINE =
  "\n\n⚠️ _Operaste en los mercados con riesgo de pérdida total de tu capital. Verifica la orden en tu MT5 y gestiona tu tamaño._";

/** Detecta la respuesta del tool de ejecución dentro del texto del agente. */
const TRADE_EXECUTED_RE = /Orden .*Ejecutada en MT5|Ticket MT5/i;

function withRiskDisclaimer(text: string): string {
  return TRADE_EXECUTED_RE.test(text) ? `${text}${TRADE_RISK_LINE}` : text;
}

// ── Env validation ─────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN || BOT_TOKEN.includes("AAAAAAAA")) {
  throw new Error(
    "[Telegram] TELEGRAM_BOT_TOKEN is missing or still a placeholder."
  );
}

const ALLOWED_IDS = (process.env.ALLOWED_IDS ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

if (ALLOWED_IDS.length === 0) {
  console.warn(
    "[Telegram] ⚠️  ALLOWED_IDS is empty – no user will be able to interact with the bot!"
  );
}

// ── Bot instance ───────────────────────────────────────────
export const bot = new Bot(BOT_TOKEN);

// ── Security middleware: whitelist ─────────────────────────
bot.use(async (ctx: Context, next) => {
  const userId = ctx.from?.id?.toString();

  if (!userId || !ALLOWED_IDS.includes(userId)) {
    console.warn(
      `[Security] Blocked unauthorized user: ${userId ?? "unknown"}`
    );
    await ctx.reply(
      "🚫 No estás autorizado para usar este agente. Contacta al administrador."
    );
    return; // Stop the middleware chain
  }

  // Update user record in DB
  const from = ctx.from!;
  upsertUser(
    userId,
    from.username,
    from.first_name,
    from.last_name
  );

  await next();
});

// ── /start command ─────────────────────────────────────────
bot.command("start", async (ctx) => {
  await ctx.reply(
    `${MODE_BADGE} 👋 *Hola, soy tu Agente de Trading SMC.*\n\n` +
      `Escritorio de análisis institucional Smart Money Concepts con pipeline auditado, ` +
      `impulsado por NVIDIA NIM (deep: \`${MODEL_TIERS.deep}\` · quick: \`${MODEL_TIERS.quick}\`).\n\n` +
      `⚠️ *Disclaimer obligatorio:*\n` +
      `• Soy una *herramienta educativa y de análisis*. *No* doy asesoría financiera ni recomendaciones de inversión.\n` +
      `• Operar mercados apalancados conlleva un *riesgo elevado*: puedes perder *la totalidad de tu capital*.\n` +
      `• Por defecto opero en *DEMO* (sin órdenes reales). Pasar a LIVE con \`LIVE_TRADING=true\` es bajo tu única responsabilidad.\n\n` +
      `Puedes escribirme cualquier cosa o enviarme una nota de voz. ¡Estoy listo!`,
    { parse_mode: "Markdown" }
  );
});

// ── /clear command – wipe conversation history ─────────────
bot.command("clear", async (ctx) => {
  const userId = ctx.from!.id.toString();
  const db = (await import("../database/sqlite.js")).default;
  db.prepare("DELETE FROM conversations WHERE user_id = ?").run(userId);
  await ctx.reply("🗑️ Historial borrado. Empezamos de cero.");
});

// ── /memory command – show memory fragments ────────────────
bot.command("memory", async (ctx) => {
  const userId = ctx.from!.id.toString();
  const { getMemoryFragments } = await import("../database/sqlite.js");
  const frags = getMemoryFragments(userId);

  if (frags.length === 0) {
    await ctx.reply("🧠 No tengo recuerdos sobre ti todavía.");
    return;
  }

  const lines = frags.map((f) => `• *${f.key}*: ${f.value}`).join("\n");
  await ctx.reply(`🧠 *Mis recuerdos sobre ti:*\n\n${lines}`, {
    parse_mode: "Markdown",
  });
});

// ── Gobernanza (PROMPT 06 §9/§12/§19) ──────────────────────
// Comandos de policy reservados al operador humano (la whitelist de
// ALLOWED_IDS ya filtra quién llega aquí). Todo cambio queda auditado en
// policy_events con actor "telegram:<id>" y la razón del mensaje. La policy
// manda sobre TODAS las interfaces: un kill switch activo corta también
// las órdenes nacidas en este chat.
import {
  setKillSwitch,
  setPolicyMode,
  setAutonomyLevel,
  setAutonomyCeiling,
  approveDecision,
  getPolicySummary,
  getPolicyEventsHistory,
  type PolicyMode,
} from "../agent/policy.js";

const GOV_DISCLAIMER =
  "\n\n⚠️ _Herramienta educativa y de análisis, no asesoría financiera. La gobernanza de ejecución queda registrada en policy_events._";

// /kill on|off <razón> — kill switch GLOBAL (§9): ninguna orden desde
// ninguna interfaz mientras esté activo, ni siquiera LIVE aprobado.
bot.command("kill", async (ctx) => {
  const userId = ctx.from!.id.toString();
  const match = (ctx.match ?? "").trim();
  const [actionRaw, ...reasonParts] = match.split(/\s+/);
  const action = (actionRaw ?? "").toLowerCase();
  const reason = reasonParts.join(" ").trim() || "kill switch vía Telegram";

  if (action !== "on" && action !== "off") {
    await ctx.reply("Uso: `/kill on|off <razón>` — ej. `/kill on revisión del riesgo`", { parse_mode: "Markdown" });
    return;
  }

  const policy = setKillSwitch(`telegram:${userId}`, action === "on", reason);
  await ctx.reply(
    `🛑 *Kill switch ${action === "on" ? "ACTIVADO" : "DESACTIVADO"}*\n` +
      `Modo: \`${policy.mode}\` · Nivel efectivo: L${policy.effectiveLevel} (techo L${policy.autonomyCeiling})\n` +
      `Razón registrada: _${reason}_${GOV_DISCLAIMER}`,
    { parse_mode: "Markdown" }
  );
});

// /modo PAPER|LIVE <razón> — cambio de modo con freno de dos llaves (§19):
// LIVE exige techo ≥ L4; el error de techo se traduce a un mensaje claro.
bot.command("modo", async (ctx) => {
  const userId = ctx.from!.id.toString();
  const match = (ctx.match ?? "").trim();
  const [modeRaw, ...reasonParts] = match.split(/\s+/);
  const mode = (modeRaw ?? "").toUpperCase() as PolicyMode;
  const reason = reasonParts.join(" ").trim() || "cambio de modo vía Telegram";

  const VALID: PolicyMode[] = ["PAPER", "SIMULATION", "BACKTEST", "RECOMMENDATION", "MANUAL_APPROVAL", "LIVE"];
  if (!VALID.includes(mode)) {
    await ctx.reply(`Uso: \`/modo PAPER|SIMULATION|MANUAL_APPROVAL|LIVE <razón>\`\nModos válidos: ${VALID.join(" · ")}`, { parse_mode: "Markdown" });
    return;
  }

  try {
    const policy = setPolicyMode(`telegram:${userId}`, mode, reason);
    await ctx.reply(
      `🏛️ *Modo de policy: \`${policy.mode}\`*\n` +
        `Nivel efectivo: L${policy.effectiveLevel} · techo L${policy.autonomyCeiling} · kill switch ${policy.killSwitch ? "🛑 ACTIVO" : "inactivo"}\n` +
        (mode === "LIVE"
          ? "🔴 *LIVE requiere ADEMÁS*: `LIVE_TRADING=true` y aprobar cada decisión EXECUTE (doble factor §11/§12).\n"
          : "") +
        `Razón registrada: _${reason}_${GOV_DISCLAIMER}`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    await ctx.reply(
      `🚫 *No se pudo cambiar el modo:*\n${(err as Error).message}\n\n_El techo de autonomía es el freno de dos llaves: primero \`/techo 4\`, consciente y auditado._`,
      { parse_mode: "Markdown" }
    );
  }
});

// /nivel 0-5 [razón] — nivel de autonomía solicitado (efectivo = min(nivel, techo))
bot.command("nivel", async (ctx) => {
  const userId = ctx.from!.id.toString();
  const match = (ctx.match ?? "").trim();
  const [lvlRaw, ...reasonParts] = match.split(/\s+/);
  const level = parseInt(lvlRaw ?? "", 10);
  const reason = reasonParts.join(" ").trim() || "ajuste de nivel vía Telegram";

  if (!Number.isFinite(level) || level < 0 || level > 5) {
    await ctx.reply("Uso: `/nivel 0-5 <razón>` — L0 observar … L5 auto-mejora.", { parse_mode: "Markdown" });
    return;
  }

  try {
    const policy = setAutonomyLevel(`telegram:${userId}`, level, reason);
    await ctx.reply(
      `🎚️ *Nivel de autonomía: L${policy.autonomyLevel}*\n` +
        `Efectivo: L${policy.effectiveLevel} (techo L${policy.autonomyCeiling}) · modo \`${policy.mode}\`\n` +
        `Razón registrada: _${reason}_${GOV_DISCLAIMER}`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    await ctx.reply(`🚫 *No se pudo fijar el nivel:* ${(err as Error).message}`, { parse_mode: "Markdown" });
  }
});

// /techo 0-5 [razón] — techo duro de autonomía (LIVE exige techo ≥ L4)
bot.command("techo", async (ctx) => {
  const userId = ctx.from!.id.toString();
  const match = (ctx.match ?? "").trim();
  const [ceilRaw, ...reasonParts] = match.split(/\s+/);
  const ceiling = parseInt(ceilRaw ?? "", 10);
  const reason = reasonParts.join(" ").trim() || "ajuste de techo vía Telegram";

  if (!Number.isFinite(ceiling) || ceiling < 0 || ceiling > 5) {
    await ctx.reply("Uso: `/techo 0-5 <razón>` — el techo limita el nivel efectivo (min).", { parse_mode: "Markdown" });
    return;
  }

  try {
    const policy = setAutonomyCeiling(`telegram:${userId}`, ceiling, reason);
    await ctx.reply(
      `🧱 *Techo de autonomía: L${policy.autonomyCeiling}*\n` +
        `Efectivo: L${policy.effectiveLevel} · modo \`${policy.mode}\` · kill switch ${policy.killSwitch ? "🛑 ACTIVO" : "inactivo"}\n` +
        (ceiling >= 4 ? "⚠️ Con techo ≥ L4 es POSIBLE pasar a LIVE con `/modo LIVE` (auditoría reforzada §19).\n" : "") +
        `Razón registrada: _${reason}_${GOV_DISCLAIMER}`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    await ctx.reply(`🚫 *No se pudo fijar el techo:* ${(err as Error).message}`, { parse_mode: "Markdown" });
  }
});

// /aprobar <decisionId> — aprobación HUMANA de una decisión EXECUTE (§12)
bot.command("aprobar", async (ctx) => {
  const userId = ctx.from!.id.toString();
  const id = parseInt((ctx.match ?? "").trim(), 10);
  if (!Number.isFinite(id)) {
    await ctx.reply("Uso: `/aprobar <decisionId>` — aprueba una decisión EXECUTE pendiente (§12).", { parse_mode: "Markdown" });
    return;
  }
  const ok = approveDecision(id, `telegram:${userId}`);
  await ctx.reply(
    ok
      ? `✅ *Decisión #${id} APROBADA* por humano.\nLa próxima orden que la consuma podrá ejecutarse según el modo vigente.${GOV_DISCLAIMER}`
      : `🚫 *No se pudo aprobar la decisión #${id}:* debe ser EXECUTE, estar pendiente y no consumida (fail-closed §12).${GOV_DISCLAIMER}`,
    { parse_mode: "Markdown" }
  );
});

// /policy — resumen de gobernanza vigente + últimos 5 eventos (§21 auditoría)
bot.command("policy", async (ctx) => {
  const p = getPolicySummary();
  const events = getPolicyEventsHistory(5)
    .map(
      (e) =>
        `• \`${e.event}\` ${e.old_value ?? "—"} → *${e.new_value}* · ${e.actor}${e.reason ? ` · _${e.reason}_` : ""}`
    )
    .join("\n");
  await ctx.reply(
    `🏛️ *Estado de gobernanza*\n` +
      `• Modo: \`${p.mode}\`\n` +
      `• Nivel efectivo: L${p.effectiveLevel} (nivel L${p.autonomyLevel} · techo L${p.autonomyCeiling})\n` +
      `• Kill switch: ${p.killSwitch ? `🛑 *ACTIVO*${p.killReason ? ` — ${p.killReason}` : ""}` : "inactivo"}\n` +
      `• LIVE_TRADING env: \`${p.liveTradingEnv ? "true" : "false"}\`\n\n` +
      `📜 *Últimos eventos*${events ? `\n${events}` : ": (sin eventos)"}${GOV_DISCLAIMER}`,
    { parse_mode: "Markdown" }
  );
});

// ── Text message handler ───────────────────────────────────
bot.on("message:text", async (ctx) => {
  const userId = ctx.from!.id.toString();
  const text = ctx.message.text;

  // Show typing indicator
  await ctx.replyWithChatAction("typing");

  try {
    const result = await runAgentLoop({
      userId,
      userMessage: text,
    });

    // Compliance: si la respuesta notifica una orden ejecutada, añade la línea de riesgo.
    await ctx.reply(withRiskDisclaimer(result.response), { parse_mode: "Markdown" });
    console.log(
      `[Bot] ✉️  User ${userId} → ${result.iterations} iterations → replied`
    );
  } catch (err) {
    console.error("[Bot] Agent error:", err);
    await ctx.reply(
      "⚠️ Tuve un problema procesando tu mensaje. Por favor intenta de nuevo."
    );
  }
});

// ── Voice message handler (middleware placeholder) ─────────
bot.on("message:voice", async (ctx) => {
  const userId = ctx.from!.id.toString();

  await ctx.replyWithChatAction("typing");

  try {
    // ─────────────────────────────────────────────────────────
    // PLACEHOLDER: Download voice → transcribe → agent loop
    // Replace the stub below with a real Whisper/OpenAI call.
    // ─────────────────────────────────────────────────────────
    const voice = ctx.message.voice;
    const fileId = voice.file_id;
    const file = await ctx.api.getFile(fileId);
    const filePath = file.file_path;

    if (!filePath) {
      await ctx.reply("❌ No pude obtener el archivo de audio.");
      return;
    }

    // Download the OGG file
    const audioUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
    const tmpDir = "./data/tmp";
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    const localPath = path.join(tmpDir, `${userId}_${Date.now()}.ogg`);
    const fetchModule = await import("node-fetch");
    const fetchFn = fetchModule.default;
    const audioRes = await fetchFn(audioUrl);
    const buffer = Buffer.from(await audioRes.arrayBuffer());
    fs.writeFileSync(localPath, buffer);

    // TODO: Call Whisper API here and get transcription text
    // const transcription = await transcribeAudio(localPath);
    const transcription = "[Transcripción de audio no implementada aún]";

    // Pass transcription into the agent loop
    const result = await runAgentLoop({
      userId,
      userMessage: transcription,
      transcription,
    });

    // Clean up temp file
    fs.unlinkSync(localPath);

    // Compliance: misma línea de riesgo que en texto (respuesta puede notificar una orden).
    await ctx.reply(withRiskDisclaimer(`🎤 *Transcripción:* ${transcription}\n\n${result.response}`), {
      parse_mode: "Markdown",
    });
  } catch (err) {
    console.error("[Bot] Voice handler error:", err);
    await ctx.reply("⚠️ Error procesando la nota de voz.");
  }
});

// ── Graceful error handler ─────────────────────────────────
bot.catch((err) => {
  const ctx = err.ctx;
  console.error(`[Bot] Error for update ${ctx.update.update_id}:`, err.error);
});
