import type { Tool } from "../types.js";
import { reflectOnExperience, triageUnresolvedErrors } from "../self_improve.js";

interface ReflectArgs {
  symbol?: string;
  setup?: string;
  outcomePnl?: number;
  errorMade?: string;
  userNote?: string;
}

export const reflectOnTrade: Tool = {
  definition: {
    type: "function",
    function: {
      name: "reflectOnTrade",
      description:
        "REGISTRA UNA LECCIÓN para el auto-mejoramiento del agente. Úsala SIEMPRE que: el usuario reporte el resultado de un trade (ganancia/pérdida), el usuario corrija un error del agente, se descubra un fallo operativo, o haya un aprendizaje del mercado. El sistema destila la experiencia en una lección reutilizable que se inyectará en decisiones futuras.",
      parameters: {
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description: "Activo relacionado (ej. US30). Opcional pero recomendado."
          },
          setup: {
            type: "string",
            description: "Setup SMC involucrado (ej. ChoCh M1, FVG H1, Order Block M15)."
          },
          outcomePnl: {
            type: "number",
            description: "Resultado en USD (negativo si fue pérdida)."
          },
          errorMade: {
            type: "string",
            description: "Error concreto cometido (por el agente o el trader)."
          },
          userNote: {
            type: "string",
            description: "Notas libres del usuario sobre qué pasó."
          }
        }
      }
    }
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const { symbol, setup, outcomePnl, errorMade, userNote } = args as unknown as ReflectArgs;

    const hasContent = symbol || setup || outcomePnl !== undefined || errorMade || userNote;
    if (!hasContent) {
      return "Necesito al menos un dato: activo, setup, resultado (PnL), error cometido o notas de lo que pasó.";
    }

    const result = await reflectOnExperience({
      symbol,
      setup,
      outcomePnl: outcomePnl ?? null,
      errorMade,
      userNote,
      source: "user",
      // ── Task 10-c (MemoryDV §9): evidencia honesta de origen ──
      // El PnL lo reporta el USUARIO (no lo observó el sistema):
      // truth_level='REPORTED' ≠ 'OBSERVED' (que reserva settlement para
      // PnL cerrado con decision_id). Sin PnL → inferencia semántica.
      evidence: {
        origin: "user_report",
        symbol: symbol ?? null,
        setup: setup ?? null,
        pnl: outcomePnl ?? null,
      },
      truthLevel: outcomePnl !== undefined ? "REPORTED" : "INFERRED",
      memoryType: outcomePnl !== undefined ? "EPISODIC" : "SEMANTIC",
    });

    // Aprovecha para triage de errores automáticos recurrentes
    const triaged = await triageUnresolvedErrors().catch(() => 0);

    if (!result.saved) {
      return "No pude destilar una lección de esa experiencia (falta contexto o la reflexión falló). Dame más detalles: ¿qué activo, qué setup y qué resultado?";
    }

    return [
      `### 🧠 ${result.deduped ? "Lección reforzada" : "Lección nueva"} guardada (#${result.lessonId})`,
      "",
      `> ${result.lessonText}`,
      "",
      result.deduped
        ? "Este patrón ya estaba registrado: se aumentó su contador de ocurrencias (más importancia futura)."
        : "Se inyectará automáticamente en los próximos análisis del protocolo institucional.",
      triaged > 0 ? `\n🔧 Triage adicional: ${triaged} error(es) operativo(s) recurrente(s) convertido(s) en lección.` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
};
