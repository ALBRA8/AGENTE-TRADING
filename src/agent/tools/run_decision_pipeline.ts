import type { Tool } from "../types.js";
import { runDecisionPipeline } from "../pipeline.js";

interface RunPipelineArgs {
  asset: string;
  timeframe?: "H1" | "M15" | "M5" | "M1";
}

export const runDecisionPipelineTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "runDecisionPipeline",
      description:
        "Ejecuta el PROTOCOLO INSTITUCIONAL COMPLETO multi-agente: filtros en paralelo (horario, noticias, DXY, RVOL, SMC) → debate Bull vs Bear → Research Manager → plan de trade con lecciones aprendidas → comité de riesgo → decisión final auditada. USAR ESTE TOOL antes de executeTradeMT5 para cualquier análisis operativo serio. Es la vía oficial para obtener una decisión EXECUTE válida.",
      parameters: {
        type: "object",
        properties: {
          asset: {
            type: "string",
            description: "Activo a analizar (US30, NAS100, XAUUSD, BTCUSD, GBPJPY)."
          },
          timeframe: {
            type: "string",
            enum: ["H1", "M15", "M5", "M1"],
            description: "Timeframe base del análisis. Default: M5."
          }
        },
        required: ["asset"]
      }
    }
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const { asset, timeframe } = args as unknown as RunPipelineArgs;
    if (!asset) return "❌ Falta el activo a analizar.";

    const result = await runDecisionPipeline({
      symbol: asset,
      timeframe: timeframe ?? "M5",
    });

    return [
      result.markdown,
      "",
      result.finalAction === "EXECUTE"
        ? `✅ Decisión EXECUTE válida (#${result.decisionId}). Ya puedes usar executeTradeMT5 con los parámetros del plan dentro de la ventana de validez.`
        : `ℹ️ Decisión ${result.finalAction} (#${result.decisionId}). No se autoriza ejecución por ahora.`,
    ].join("\n");
  }
};
