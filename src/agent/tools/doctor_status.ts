import type { Tool } from "../types.js";
import { runDoctor, runDoctorRepairs, renderDoctorMarkdown } from "../doctor.js";

interface DoctorToolArgs {
  repair?: boolean;
}

/**
 * Task 10-c §20: el LLM (y el dashboard vía API) pueden EjECUTAR el doctor
 * y ver el estado de salud completo. El auto-repair NO es invocable por el
 * LLM por defecto: solo con {"repair": true} explícito, y AUN ASÍ se limita
 * a las 3 operaciones deterministas documentadas en doctor.ts — jamás toca
 * estrategia, gates, policy ni lecciones promovidas.
 */
export const doctorStatusTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "runDoctor",
      description:
        "Ejecuta el DOCTOR del agente (§20): 9 secciones (SYSTEM, MARKET_DATA, STRATEGY, RISK, EXECUTION, SECURITY, MEMORY, SKILLS, TESTING) con veredictos OK/WARN/FAIL y score 0-100. Úsalo cuando el usuario pregunte por la salud del sistema, antes/después de sesiones de trading, o para diagnosticar fallos.",
      parameters: {
        type: "object",
        properties: {
          repair: {
            type: "boolean",
            description:
              "Opcional (default false). Ejecuta ANTES el auto-repair determinista: PRAGMA optimize, purga de agent_errors resueltos >30 días, backfill memory_type. Nunca toca estrategia.",
          },
        },
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const { repair } = args as unknown as DoctorToolArgs;

    let repairs: string[] | null = null;
    if (repair === true) {
      try {
        repairs = runDoctorRepairs();
      } catch (err) {
        repairs = [`auto-repair falló: ${(err as Error).message}`];
      }
    }

    const report = await runDoctor();
    const body = renderDoctorMarkdown(report);
    if (!repairs) return body;

    return [body, "", "**Auto-repair ejecutado:**", ...repairs.map((r) => `- ${r}`)].join("\n");
  }
};
