import type { Tool } from "../types.js";
import { searchLessons, promoteLesson, setLessonValidation } from "../../database/sqlite.js";

interface SearchLessonsArgs {
  keyword?: string;
  symbol?: string;
  promoteId?: number;
  validateId?: number;
  status?: "pending" | "verified" | "unresolved" | "contradicted";
}

export const searchLessonsTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "searchLessons",
      description:
        "Consulta las LECCIONES aprendidas por el agente (memoria de errores y aciertos). Permite buscar por palabra clave o activo, y también promover una lección a memoria permanente o cambiar su estado de validación.",
      parameters: {
        type: "object",
        properties: {
          keyword: {
            type: "string",
            description: "Palabra clave a buscar en las lecciones."
          },
          symbol: {
            type: "string",
            description: "Filtrar por activo (ej. US30)."
          },
          promoteId: {
            type: "number",
            description: "ID de lección a PROMOVER a memoria permanente (viajará siempre en el system prompt)."
          },
          validateId: {
            type: "number",
            description: "ID de lección cuyo estado de validación se quiere cambiar."
          },
          status: {
            type: "string",
            enum: ["pending", "verified", "unresolved", "contradicted"],
            description: "Nuevo estado de validación para validateId."
          }
        }
      }
    }
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const { keyword, symbol, promoteId, validateId, status } = args as unknown as SearchLessonsArgs;

    // Acciones de mantenimiento
    if (promoteId) {
      promoteLesson(promoteId, true);
      return `⭐ Lección #${promoteId} promovida a memoria permanente. Viajará en el system prompt de todas las sesiones.`;
    }
    if (validateId && status) {
      setLessonValidation(validateId, status);
      return `✅ Lección #${validateId} actualizada a estado "${status}".`;
    }

    // Búsqueda
    const lessons = searchLessons(keyword, symbol, 15);
    if (lessons.length === 0) {
      return "📭 No hay lecciones registradas" + (keyword || symbol ? " para ese criterio." : " todavía. Usa reflectOnTrade cuando ocurra un error o aprendizaje.");
    }

    const lines = lessons.map((l) => {
      const statusIcon =
        l.validation_status === "verified" ? "✅" :
        l.validation_status === "unresolved" ? "⚠️" :
        l.validation_status === "contradicted" ? "❌" : "📌";
      return [
        `**#${l.id}** ${statusIcon} \`${l.pattern_key}\`${l.promoted ? " ⭐" : ""} (visto ${l.times_seen}x · ${l.kind})`,
        `  ${l.lesson}`,
        l.scope ? `  _Ámbito: ${l.scope}_` : "",
      ].filter(Boolean).join("\n");
    });

    return [
      `### 🧠 Memoria de aprendizaje (${lessons.length} lección${lessons.length === 1 ? "" : "es"})`,
      "",
      ...lines,
      "",
      "_⭐ = promovida (siempre en el system prompt) · usa promoteId/validateId para mantenimiento._",
    ].join("\n");
  }
};
