// ============================================================
// src/lib/harness/types.ts
// ARNÉS — Skill Registry (migración PROYECTO → ARNÉS, Fase 4)
//
// Las skills del arnés son plugins EJECUTABLES con operaciones
// tipadas. NOTA de convivencia: src/skills/registry.ts (PROMPT 06)
// es el CONTRATO DECLARATIVO de las 17 skills del SOP — aquí no se
// duplica: el plugin `sop-skills` lo expone a través de esta interfaz.
// ============================================================

import type { BridgeRegistry } from "../bridges/types.js";
import type { KnowledgeRegistry } from "./knowledge-registry.js";
import type { AgentAdapter } from "../adapters/types.js";

export type SkillCategory =
  | "validation"
  | "generation"
  | "analysis"
  | "assembly"
  | "review"
  | "orchestration"
  | "domain-specific";

export interface SkillParamDef {
  type: "string" | "number" | "boolean" | "object" | "array";
  required: boolean;
  description?: string;
}

export interface SkillOperation {
  id: string;
  name: string;
  description: string;
  params?: Record<string, SkillParamDef>;
}

export interface SkillContext {
  bridges: BridgeRegistry;
  knowledge: KnowledgeRegistry;
  agent: AgentAdapter;
  params: Record<string, unknown>;
}

export interface SkillResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface ISkillPlugin {
  readonly id: string;
  readonly name: string;
  readonly category: SkillCategory;
  readonly operations: SkillOperation[];
  execute(operation: string, context: SkillContext): Promise<SkillResult>;
}

export class SkillRegistry {
  private skills = new Map<string, ISkillPlugin>();

  register(skill: ISkillPlugin): void {
    this.skills.set(skill.id, skill);
  }

  get(id: string): ISkillPlugin | undefined {
    return this.skills.get(id);
  }

  list(): Array<{ id: string; name: string; category: SkillCategory; operations: string[] }> {
    return Array.from(this.skills.values()).map((s) => ({
      id: s.id,
      name: s.name,
      category: s.category,
      operations: s.operations.map((o) => o.id),
    }));
  }

  findByCategory(category: SkillCategory): ISkillPlugin[] {
    return Array.from(this.skills.values()).filter((s) => s.category === category);
  }

  async execute(skillId: string, operation: string, context: SkillContext): Promise<SkillResult> {
    const skill = this.skills.get(skillId);
    if (!skill) return { success: false, error: `Skill not found: ${skillId}` };
    if (!skill.operations.some((o) => o.id === operation)) {
      return { success: false, error: `Operation ${operation} not found in skill ${skillId}` };
    }
    try {
      return await skill.execute(operation, context);
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  }
}
