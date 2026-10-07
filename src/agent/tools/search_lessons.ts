import type { Tool } from "../types.js";
import { searchLessons } from "../../database/sqlite.js";

interface SearchLessonsArgs {
  keyword?: string;
  symbol?: string;
}

/**
 * Task 10-c (gate §3/§4 del auditor 9-i): este tool era el choke point de la
 * VIOLACIÓN de promoción — el LLM podía auto-validar (validateId) y
 * auto-promover (promoteId) una lección en una misma sesión, convirtiendo UN
 * trade en regla permanente del system prompt. Ambas acciones fueron
 * RETIRADAS del alcance del LLM:
 *   - Validación: solo código determinista (consolidateMemory, con stats
 *     Wilson sobre decision_log settled).
 *   - Promoción: solo promoteLessonGated (consolidation.ts) con evidencia +
 *     evento auditado en policy_events. Sin tool que la exponga.
 * El tool queda SOLO DE BÚSQUEDA/LECTURA.
 */
export const searchLessonsTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "searchLessons",
      description:
        "Consulta las LECCIONES aprendidas por el agente (memoria de errores y aciertos). SOLO LECTURA: busca por palabra clave o activo. NO permite promover ni cambiar el estado de validación: la validación es estadística (consolidación determinista) y la promoción está gated con aprobación humana y auditoría.",
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
          }
        }
      }
    }
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const { keyword, symbol } = args as unknown as SearchLessonsArgs;

    // Búsqueda (solo lectura)
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
      "_⭐ = promovida (siempre en el system prompt) · La validación/promoción NO está disponible para el modelo: es un gate determinista con auditoría (§3/§4)._",
    ].join("\n");
  }
};
