// ============================================================
// src/lib/bridges/nim-bridge.ts
// ARNÉS — Bridge NVIDIA NIM (stack real, PRIORIDAD 1)
//
// Envuelve el cliente existente src/config/nvidia.ts (callLLMByTier /
// getEmbeddings) SIN duplicar nada. Import DINÁMICO obligatorio:
// config/nvidia.ts lanza en import si falta NVIDIA_API_KEY — el arnés
// nunca debe romper el arranque del bot por eso.
//
// FAIL-SAFE §16 conservado: LLM_PROVIDER=mock prohibido con
// LIVE_TRADING=true (la validación vive dentro de callLLMByTier).
// ============================================================

import type { IBridge, BridgeResult, BridgeHealth } from "./types.js";
import type { ModelTier } from "../../config/nvidia.js";

type NvidiaModule = typeof import("../../config/nvidia.js");

export class NimBridge implements IBridge {
  readonly type = "nim";
  readonly name = "NVIDIA NIM Bridge (quick/deep + embeddings)";
  private mod: NvidiaModule | null = null;

  async isAvailable(): Promise<boolean> {
    try {
      if (!this.mod) this.mod = await import("../../config/nvidia.js");
      return !!this.mod.nvidiaNIMClient;
    } catch {
      this.mod = null;
      return false;
    }
  }

  async execute(operation: string, params: Record<string, unknown>): Promise<BridgeResult> {
    try {
      if (!this.mod && !(await this.isAvailable())) {
        return {
          success: false,
          error: "NIM no disponible (NVIDIA_API_KEY ausente o placeholder)",
          source: this.type,
        };
      }
      const nvidia = this.mod!;
      switch (operation) {
        case "chat":
        case "generate":
        case "analyze": {
          const tier: ModelTier = params.tier === "deep" ? "deep" : "quick";
          const user =
            typeof params.user === "string"
              ? params.user
              : typeof params.prompt === "string"
                ? params.prompt
                : JSON.stringify(params.data ?? params ?? {});
          const r = await nvidia.callLLMByTier({
            tier,
            system: typeof params.system === "string" ? params.system : "",
            user,
            maxTokens: typeof params.maxTokens === "number" ? params.maxTokens : undefined,
            temperature: typeof params.temperature === "number" ? params.temperature : undefined,
            jsonMode: Boolean(params.jsonMode),
          });
          return {
            success: true,
            data: {
              content: r.content,
              tokensUsed: r.tokensUsed,
              model: nvidia.MODEL_TIERS[tier],
              tier,
            },
            source: this.type,
          };
        }
        case "embeddings": {
          const embedding = await nvidia.getEmbeddings(
            String(params.text ?? ""),
            params.inputType === "query" ? "query" : "passage"
          );
          return { success: true, data: { embedding }, source: this.type };
        }
        default:
          return { success: false, error: `Operación no soportada: ${operation}`, source: this.type };
      }
    } catch (e) {
      return { success: false, error: (e as Error).message, source: this.type };
    }
  }

  async healthCheck(): Promise<BridgeHealth> {
    const t0 = Date.now();
    const available = await this.isAvailable();
    return {
      available,
      latency: Date.now() - t0,
      details: {
        type: this.type,
        mock: available ? this.mod!.isMockProvider() : undefined,
        tiers: available ? this.mod!.MODEL_TIERS : undefined,
      },
    };
  }
}
