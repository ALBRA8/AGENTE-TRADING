// ============================================================
// src/agent/tools/get_current_time.ts
// Example tool: returns the current date/time
// ============================================================

import type { Tool } from "../types.js";

export const getCurrentTime: Tool = {
  // ── OpenAI function definition ──────────────────────────
  definition: {
    type: "function",
    function: {
      name: "get_current_time",
      description:
        "Returns the current date and time in ISO 8601 format. " +
        "Use this when the user asks what time or date it is.",
      parameters: {
        type: "object",
        properties: {
          timezone: {
            type: "string",
            description:
              "Optional IANA timezone identifier (e.g. 'America/Bogota'). " +
              "Defaults to the server's local timezone.",
          },
        },
        required: [],
      },
    },
  },

  // ── Handler ─────────────────────────────────────────────
  async execute(args: Record<string, unknown>): Promise<string> {
    const tz =
      typeof args.timezone === "string" ? args.timezone : undefined;

    try {
      const now = new Date();
      const formatted = now.toLocaleString("es-CO", {
        timeZone: tz ?? "America/Bogota",
        dateStyle: "full",
        timeStyle: "long",
      });
      return `La fecha y hora actual es: **${formatted}**`;
    } catch {
      // Fallback if timezone is invalid
      return `La fecha y hora actual (UTC) es: **${new Date().toISOString()}**`;
    }
  },
};
