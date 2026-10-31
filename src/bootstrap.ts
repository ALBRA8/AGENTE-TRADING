// ============================================================
// src/bootstrap.ts
// ARNÉS — Bootstrap (migración PROYECTO → ARNÉS, Fase 7)
//
// Monta el arnés completo: registries + bridges del stack real +
// AGENTE-GENERAL (chaleco). IDEMPOTENTE: puede llamarse varias veces.
// NO lanza excepciones hacia el arranque del bot: si algo falla, el
// arnés queda sin montar y el bot sigue funcionando igual que antes
// de la migración (decisión de seguridad, migration-analysis.md §4).
// ============================================================

import { BridgeRegistry } from "./lib/bridges/types.js";
import { NimBridge } from "./lib/bridges/nim-bridge.js";
import { ZaiSdkBridge } from "./lib/bridges/zai-sdk-bridge.js";
import { Mt5Bridge } from "./lib/bridges/mt5-bridge.js";
import { TelegramBridge } from "./lib/bridges/telegram-bridge.js";
import { PythonBridge } from "./lib/bridges/python-bridge.js";
import { SkillRegistry } from "./lib/harness/types.js";
import { SopSkillsPlugin } from "./lib/harness/sop-skills-plugin.js";
import { KnowledgeRegistry, registerBuiltinKnowledge } from "./lib/harness/knowledge-registry.js";
import { GeneralAdapter } from "./lib/adapters/general-adapter.js";
import type { AgentAdapter, ProjectConfig } from "./lib/adapters/types.js";

export interface BootstrapResult {
  agent: AgentAdapter;
  bridges: BridgeRegistry;
  skills: SkillRegistry;
  knowledge: KnowledgeRegistry;
  config: ProjectConfig;
}

/** Config por defecto: STACK REAL de AGENTE-TRADING (decisión del propietario). */
export const DEFAULT_HARNESS_CONFIG: ProjectConfig = {
  projectName: "AGENTE-TRADING",
  stack: "hybrid",
  environment: process.env.NODE_ENV === "production" ? "production" : "development",
  bridges: [
    { type: "nim", enabled: true }, // LLM real (integrate.api.nvidia.com)
    { type: "zai-sdk", enabled: true }, // fallback (no instalado → isAvailable false)
    { type: "mt5", enabled: true }, // Flask local :29413
    { type: "telegram", enabled: true }, // notify saliente
    { type: "python", enabled: false }, // utilidades futuras (off por defecto)
  ],
};

export async function bootstrapHarness(config: ProjectConfig = DEFAULT_HARNESS_CONFIG): Promise<BootstrapResult> {
  console.log(`[Bootstrap] Inicializando arnés para: ${config.projectName} (stack ${config.stack})`);

  const bridges = new BridgeRegistry();
  const skills = new SkillRegistry();
  const knowledge = new KnowledgeRegistry();

  // ── Bridges (orden = fallback; NIM es prioridad 1 por decisión "stack real")
  for (const bc of config.bridges) {
    if (!bc.enabled) continue;
    switch (bc.type) {
      case "nim":
        bridges.register(new NimBridge(), true);
        break;
      case "zai-sdk":
        bridges.register(new ZaiSdkBridge());
        break;
      case "mt5":
        bridges.register(new Mt5Bridge());
        break;
      case "telegram":
        bridges.register(new TelegramBridge());
        break;
      case "python":
        bridges.register(
          new PythonBridge(
            `${config.projectName}-python`,
            (bc.config?.pythonPath as string) || "python3",
            (bc.config?.scriptDir as string) || "./scripts"
          )
        );
        break;
      default:
        console.warn(`[Bootstrap] Bridge desconocido ignorado: ${bc.type}`);
    }
  }

  // ── Conocimiento del dominio (caja registradora)
  registerBuiltinKnowledge(knowledge);

  // ── Skills (contratos SOP existentes expuestos como plugins)
  skills.register(new SopSkillsPlugin());

  // ── El chaleco: AGENTE-GENERAL
  const agent = new GeneralAdapter();
  await agent.initialize({ bridges, skills, knowledge, config });

  console.log(
    `[Bootstrap] ✅ Arnés listo. Agente: ${agent.name} | Bridges: ${bridges.list().length} | ` +
      `Skills: ${skills.list().length} | Knowledge: ${knowledge.list().length}`
  );
  return { agent, bridges, skills, knowledge, config };
}
