import type { Tool } from "../types.js";
import { getAgentStatusAsync, renderStatusMarkdown } from "../observability.js";

export const agentStatusTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "agentStatus",
      description:
        "Foto completa del estado operativo del agente: decisiones de las últimas 24h/7d, settlement pendiente, PnL settled, lecciones del auto-mejoramiento, errores sin resolver, hard-gate y salud de dependencias (bridge MT5, API key). Úsala para '¿cómo estás?', checks de salud o diagnóstico rápido.",
      parameters: {
        type: "object",
        properties: {}
      }
    }
  },

  async execute(): Promise<string> {
    const status = await getAgentStatusAsync();
    return renderStatusMarkdown(status);
  }
};
