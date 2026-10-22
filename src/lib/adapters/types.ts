// ============================================================
// src/lib/adapters/types.ts
// ARNÉS — Interfaz AgentAdapter (migración PROYECTO → ARNÉS, Fase 2)
//
// AGENTE-GENERAL ES LA CONSTANTE: implementa ESTA interfaz y se
// "coloca" como chaleco sobre el arnés del proyecto. No conoce el
// dominio: todo el conocimiento vive en el KnowledgeRegistry y toda
// la capacidad exterior en el BridgeRegistry.
// ============================================================

import type { BridgeRegistry } from "../bridges/types.js";
import type { SkillRegistry } from "../harness/types.js";
import type { KnowledgeRegistry } from "../harness/knowledge-registry.js";

export type StackType = "nextjs" | "node" | "python" | "hybrid";

export interface AgentCapability {
  operation: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface AdapterResult {
  success: boolean;
  data?: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface HealthStatus {
  healthy: boolean;
  latency?: number;
  details?: Record<string, unknown>;
}

/** Bridges que este proyecto reconoce (stack real de AGENTE-TRADING). */
export type BridgeType = "nim" | "zai-sdk" | "mt5" | "telegram" | "python" | "http";

export interface BridgeConfig {
  type: BridgeType;
  enabled: boolean;
  config?: Record<string, unknown>;
}

export interface ProjectConfig {
  projectName: string;
  stack: StackType;
  environment: "development" | "production";
  bridges: BridgeConfig[];
}

export interface HarnessContext {
  bridges: BridgeRegistry;
  skills: SkillRegistry;
  knowledge: KnowledgeRegistry;
  config: ProjectConfig;
}

export interface AgentAdapter {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly capabilities: AgentCapability[];
  initialize(context: HarnessContext): Promise<void>;
  execute(operation: string, params: Record<string, unknown>): Promise<AdapterResult>;
  canHandle(operation: string): boolean;
  healthCheck(): Promise<HealthStatus>;
  shutdown(): Promise<void>;
}
