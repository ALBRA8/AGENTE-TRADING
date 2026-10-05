import type { Tool } from "../types.js";
import { evaluateAndSnapshotBrain, getBrainTrend } from "../brain_eval.js";

export const evaluateBrainTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "evaluateBrain",
      description:
        "Evalúa la calidad del cerebro del agente con un score compuesto 0-100 (disciplina, calibración confianza/resultado, seguimiento de órdenes, aprendizaje y operativa). Úsala cuando el usuario pida '¿cómo está el agente?', 'evalúate', reportes de calidad o antes de decidir escalar riesgo.",
      parameters: {
        type: "object",
        properties: {
          withTrend: {
            type: "boolean",
            description: "Si es true, añade la tendencia de los últimos snapshots del score (default true)."
          }
        }
      }
    }
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const withTrend = args.withTrend !== false;
    const { markdown, report } = evaluateAndSnapshotBrain();

    const trendBlock = withTrend
      ? (() => {
          const trend = getBrainTrend(10).reverse();
          if (trend.length < 2) return "";
          const spark = trend.map((t) => `${t.score.toFixed(0)}`).join(" → ");
          const delta = trend[trend.length - 1].score - trend[0].score;
          return `\n### 📈 Tendencia del score\n${spark}\n_Delta: ${delta >= 0 ? "+" : ""}${delta.toFixed(1)} puntos_`;
        })()
      : "";

    const nextSteps = [
      "",
      "### Siguientes pasos sugeridos",
      report.components.followThrough.score < 8
        ? "- 📌 Seguimiento bajo: revisa decisiones EXECUTE que nunca llegaron a orden (settleDecisions para ver el detalle)."
        : "",
      report.components.calibration.score < 15 && report.stats.settled >= 5
        ? "- 🎯 Calibración débil: la confianza no está prediciendo resultados; considera subir el umbral de confianza para EXECUTE (0.65 → 0.75)."
        : "",
      report.components.operational.score < 7
        ? "- ⚙️ Errores recurrentes sin resolver: revisa los patrones capturados por el auto-mejoramiento."
        : "",
    ]
      .filter(Boolean)
      .join("\n");

    return markdown + trendBlock + nextSteps;
  }
};
