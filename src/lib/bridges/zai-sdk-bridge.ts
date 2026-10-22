// ============================================================
// src/lib/bridges/zai-sdk-bridge.ts
// ARNÉS — Bridge ZAI SDK (plantilla de la migración, fallback)
//
// En AGENTE-TRADING el paquete z-ai-web-dev-sdk NO está instalado:
// isAvailable() devolverá false honestamente y el relevo lo toma el
// siguiente bridge. Si algún día se instala, el arnés lo usa sin
// cambios. Import con especificador VARIABLE para que TypeScript no
// exija el paquete en tiempo de compilación.
// ============================================================

import type { IBridge, BridgeResult, BridgeHealth } from "./types.js";

export class ZaiSdkBridge implements IBridge {
  readonly type = "zai-sdk";
  readonly name = "ZAI SDK Bridge";
  private sdk: any = null;

  async isAvailable(): Promise<boolean> {
    try {
      if (this.sdk) return true;
      const spec = "z-ai-web-dev-sdk"; // variable: evita resolución estática
      const mod: any = await import(/* @vite-ignore */ spec);
      this.sdk = mod?.default?.create ? await mod.default.create() : mod?.create ? await mod.create() : mod;
      return !!this.sdk;
    } catch {
      this.sdk = null;
      return false;
    }
  }

  async execute(operation: string, params: Record<string, unknown>): Promise<BridgeResult> {
    try {
      if (!this.sdk && !(await this.isAvailable())) {
        return { success: false, error: "ZAI SDK no disponible", source: this.type };
      }
      switch (operation) {
        case "chat":
        case "generate":
        case "analyze": {
          const result = await this.sdk.chat?.completions?.create?.({
            messages: [
              { role: "system", content: String(params.system ?? "") },
              { role: "user", content: String(params.user ?? params.prompt ?? "") },
            ],
          });
          const content = result?.choices?.[0]?.message?.content ?? result;
          return { success: true, data: { content }, source: this.type };
        }
        default:
          return { success: false, error: `Operación no soportada: ${operation}`, source: this.type };
      }
    } catch (e) {
      return { success: false, error: (e as Error).message, source: this.type };
    }
  }

  async healthCheck(): Promise<BridgeHealth> {
    const available = await this.isAvailable();
    return { available, details: { type: this.type } };
  }
}
