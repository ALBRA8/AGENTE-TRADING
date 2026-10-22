// ============================================================
// src/lib/harness/sop-skills-plugin.ts
// ARNÉS — Plugin `sop-skills` (Fase 4/8, LIPO "I" aditivo)
//
// Expone las 17 skills del SOP (contrato declarativo de
// src/skills/registry.ts, PROMPT 06 §5) a través del SkillRegistry del
// arnés. CERO duplicación: los datos salen del registry existente con
// sus métricas honestas; este plugin solo los adapta a la interfaz
// ISkillPlugin. Import dinámico: skills/registry.ts abre la BD.
// ============================================================

import type { ISkillPlugin, SkillOperation, SkillContext, SkillResult } from "./types.js";

type SkillsModule = typeof import("../../skills/registry.js");

export class SopSkillsPlugin implements ISkillPlugin {
  readonly id = "sop-skills";
  readonly name = "Skills del SOP (17 contratos declarativos)";
  readonly category = "domain-specific" as const;
  private mod: SkillsModule | null = null;

  readonly operations: SkillOperation[] = [
    {
      id: "list",
      name: "Listar contratos",
      description: "Devuelve las 17 skills del SOP con identidad, propósito y estado (ACTIVE/PENDING).",
    },
    {
      id: "get",
      name: "Contrato completo",
      description: "Devuelve el contrato completo de una skill por identity.",
      params: { identity: { type: "string", required: true, description: "identity UPPER_SNAKE de la skill" } },
    },
    {
      id: "markdown",
      name: "Render markdown",
      description: "Render markdown del registry completo (igual que /api/skills).",
    },
  ];

  private async load(): Promise<SkillsModule> {
    if (!this.mod) this.mod = await import("../../skills/registry.js");
    return this.mod;
  }

  async execute(operation: string, context: SkillContext): Promise<SkillResult> {
    try {
      const skills = await this.load();
      const registry = skills.getSkillsRegistry();
      switch (operation) {
        case "list": {
          const status = String(context.params.status ?? "");
          const rows = registry
            .filter((s) => !status || s.status === status)
            .map((s) => ({
              identity: s.identity,
              purpose: s.purpose,
              status: s.status,
              confidence: s.confidence,
              success_rate: s.success_rate,
              version: s.version,
            }));
          return { success: true, data: { count: rows.length, skills: rows } };
        }
        case "get": {
          const identity = String(context.params.identity ?? "").toUpperCase();
          const contract = registry.find((s) => s.identity === identity);
          if (!contract) return { success: false, error: `Skill no encontrada: ${identity}` };
          return { success: true, data: contract };
        }
        case "markdown":
          return { success: true, data: { markdown: skills.renderSkillsMarkdown() } };
        default:
          return { success: false, error: `Operación no soportada: ${operation}` };
      }
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  }
}
