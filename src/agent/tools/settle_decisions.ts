import type { Tool } from "../types.js";
import { runSettlement, maintenanceState } from "../settlement.js";

export const settleDecisions: Tool = {
  definition: {
    type: "function",
    function: {
      name: "settleDecisions",
      description:
        "Cierra (settlement) las decisiones EXECUTE cuyo horizonte venció: busca la orden vinculada, registra el PnL disponible y genera lecciones automáticas. Úsala cuando el usuario pregunte por resultados de trades anteriores o pida 'cerrar el ciclo' de decisiones. También corre automáticamente en background.",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Máximo de decisiones a procesar en esta pasada (default 10)."
          }
        }
      }
    }
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const limit = Math.min(50, Math.max(1, Number(args.limit) || 10));
    const summary = await runSettlement(limit);

    if (summary.settled + summary.estimated + summary.expired === 0) {
      return [
        "### ✅ Settlement al día",
        "",
        "No hay decisiones EXECUTE vencidas pendientes de cierre.",
        maintenanceState.lastSettlementAt
          ? `_Última pasada automática: ${maintenanceState.lastSettlementAt}_`
          : "",
      ]
        .filter(Boolean)
        .join("\n");
    }

    return [
      "### 🧾 Settlement completado",
      "",
      `| Resultado | Cantidad |`,
      `|---|---|`,
      `| Cerrados con PnL real | ${summary.settled} |`,
      `| Estimados (posición viva, flotante) | ${summary.estimated} |`,
      `| Expirados sin datos | ${summary.expired} |`,
      "",
      ...(summary.details.length ? ["**Detalle:**", ...summary.details.map((d) => `- ${d}`)] : []),
      "",
      "_Las decisiones cerradas con PnL generaron lecciones automáticas para el pipeline._",
    ].join("\n");
  }
};
