// ============================================================
// src/lib/adapters/general-adapter.ts
// ARNÉS — AGENTE-GENERAL (el cajero intercambiable, Fase 6)
//
// Implementa AgentAdapter. NO sabe nada de trading: conversa a través
// de bridges, valida contra el KnowledgeRegistry y ejecuta skills del
// arnés. Si mañana se sustituye por otro cajero, este fichero es el
// ÚNICO que cambia — la caja registradora (bridges/skills/knowledge)
// se queda intacta.
// ============================================================

import type {
  AgentAdapter,
  AgentCapability,
  AdapterResult,
  HarnessContext,
  HealthStatus,
} from "./types.js";

export class GeneralAdapter implements AgentAdapter {
  readonly id = "agente-general";
  readonly name = "AGENTE-GENERAL";
  readonly version = "1.0.0";
  readonly capabilities: AgentCapability[];
  private context: HarnessContext | null = null;

  constructor() {
    this.capabilities = [
      { operation: "chat", description: "Conversación con IA (tier quick/deep del bridge de mayor prioridad)" },
      { operation: "generate", description: "Generación de contenido" },
      { operation: "analyze", description: "Análisis de datos/texto" },
      { operation: "validate", description: "Validación contra reglas del dominio (KnowledgeRegistry)" },
      { operation: "execute-skill", description: "Ejecutar skill del arnés (SkillRegistry)" },
      { operation: "query-knowledge", description: "Consultar conocimiento del dominio" },
    ];
  }

  async initialize(context: HarnessContext): Promise<void> {
    this.context = context;
    const bridgeList = context.bridges.list();
    console.log(
      `[GeneralAdapter] Chaleco montado sobre ${context.config.projectName}. ` +
        `Bridges: ${bridgeList.map((b) => b.type).join(", ")} · ` +
        `Skills: ${context.skills.list().length} · Conocimiento: ${context.knowledge.list().length} módulos`
    );
  }

  async execute(operation: string, params: Record<string, unknown>): Promise<AdapterResult> {
    if (!this.context) return { success: false, error: "Adapter not initialized" };
    const p = params ?? {};
    try {
      switch (operation) {
        case "chat":
        case "generate":
        case "analyze": {
          const result = await this.context.bridges.execute(operation, p);
          return {
            success: result.success,
            data: result.data,
            error: result.error,
            metadata: { source: result.source },
          };
        }
        case "validate": {
          const moduleId = String(p.knowledgeId ?? "");
          const knowledgeResult = this.context.knowledge.get(moduleId);
          if (!knowledgeResult) {
            return { success: false, error: `Knowledge module not found: ${moduleId}` };
          }
          const bridgeResult = await this.context.bridges.execute("chat", {
            tier: p.tier ?? "quick",
            system: `Usa estas reglas del dominio: ${JSON.stringify(knowledgeResult.getContent())}`,
            user: `Valida: ${JSON.stringify(p.data ?? p)}`,
            jsonMode: true,
          });
          return {
            success: bridgeResult.success,
            data: bridgeResult.data,
            error: bridgeResult.error,
            metadata: { source: bridgeResult.source, knowledgeId: moduleId },
          };
        }
        case "execute-skill": {
          const skillResult = await this.context.skills.execute(
            String(p.skillId ?? ""),
            String(p.operation ?? ""),
            {
              bridges: this.context.bridges,
              knowledge: this.context.knowledge,
              agent: this,
              params: (p.params as Record<string, unknown>) || {},
            }
          );
          return { success: skillResult.success, data: skillResult.data, error: skillResult.error };
        }
        case "query-knowledge": {
          const moduleId = String(p.moduleId ?? "");
          const module = this.context.knowledge.get(moduleId);
          if (!module) return { success: false, error: `Knowledge module not found: ${moduleId}` };
          return { success: true, data: module.getContent(), metadata: { version: module.version } };
        }
        default:
          return { success: false, error: `Unknown operation: ${operation}` };
      }
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  }

  canHandle(operation: string): boolean {
    return this.capabilities.some((c) => c.operation === operation);
  }

  async healthCheck(): Promise<HealthStatus> {
    if (!this.context) return { healthy: false, details: { error: "Not initialized" } };
    const bridgeHealth = await this.context.bridges.healthAll();
    const available = bridgeHealth.filter((b) => b.available).length;
    const knowledge = this.context.knowledge.healthCheck();
    return {
      healthy: available > 0 && knowledge.invalid.length === 0,
      details: {
        bridges: bridgeHealth.map((b) => ({ type: b.type, available })),
        bridgesAvailable: available,
        knowledge,
      },
    };
  }

  async shutdown(): Promise<void> {
    this.context = null;
    console.log("[GeneralAdapter] Cajero desconectado del arnés (la caja registradora se queda).");
  }
}
