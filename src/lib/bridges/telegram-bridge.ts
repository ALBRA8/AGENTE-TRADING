// ============================================================
// src/lib/bridges/telegram-bridge.ts
// ARNÉS — Bridge Telegram (stack real): notificaciones salientes vía
// el bot grammY existente (src/bot/telegram.ts). Solo NOTIFY: el bot
// sigue siendo el dueño del long polling y de la whitelist.
// Import dinámico: grammy lanza si falta TELEGRAM_BOT_TOKEN.
// ============================================================

import type { IBridge, BridgeResult, BridgeHealth } from "./types.js";

type TelegramModule = typeof import("../../bot/telegram.js");

export class TelegramBridge implements IBridge {
  readonly type = "telegram";
  readonly name = "Telegram Bridge (notify ALLOWED_IDS)";
  private mod: TelegramModule | null = null;

  async isAvailable(): Promise<boolean> {
    try {
      if (!this.mod) this.mod = await import("../../bot/telegram.js");
      return !!this.mod.bot?.api;
    } catch {
      this.mod = null;
      return false;
    }
  }

  /** Primer ID de la whitelist (fallback si el llamador no pasa chatId). */
  private defaultChatId(): string | null {
    const ids = String(process.env.ALLOWED_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return ids[0] ?? null;
  }

  async execute(operation: string, params: Record<string, unknown>): Promise<BridgeResult> {
    try {
      if (!this.mod && !(await this.isAvailable())) {
        return { success: false, error: "Telegram no disponible (token/whitelist)", source: this.type };
      }
      switch (operation) {
        case "notify": {
          const chatId = String(params.chatId ?? "") || this.defaultChatId();
          if (!chatId) {
            return { success: false, error: "Sin chatId y ALLOWED_IDS vacío (fail-closed)", source: this.type };
          }
          const text = String(params.text ?? params.message ?? "").slice(0, 4000);
          if (!text) return { success: false, error: "Texto vacío", source: this.type };
          await this.mod!.bot.api.sendMessage(chatId, text);
          return { success: true, data: { sent: true, chatId }, source: this.type };
        }
        default:
          return { success: false, error: `Operación no soportada: ${operation}`, source: this.type };
      }
    } catch (e) {
      return { success: false, error: (e as Error).message, source: this.type };
    }
  }

  async healthCheck(): Promise<BridgeHealth> {
    const available = await this.isAvailable();
    return {
      available,
      details: { type: this.type, whitelist: Boolean(process.env.ALLOWED_IDS) },
    };
  }
}
