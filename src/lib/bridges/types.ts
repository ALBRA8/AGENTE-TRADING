// ============================================================
// src/lib/bridges/types.ts
// ARNÉS — Bridge Registry (migración PROYECTO → ARNÉS, Fase 3)
//
// Un "bridge" es el enchufe universal entre el arnés y el mundo
// exterior (LLM, MT5, Telegram, Python). El cajero (AGENTE-GENERAL)
// nunca habla con el exterior directamente: siempre a través de un
// bridge registrado aquí. Si el cajero se va, los bridges se quedan.
// ============================================================

export interface BridgeResult {
  success: boolean;
  data?: unknown;
  error?: string;
  /** Qué bridge produjo el resultado ('none' si ninguno pudo) */
  source: string;
}

export interface BridgeHealth {
  available: boolean;
  latency?: number;
  details?: Record<string, unknown>;
}

export interface IBridge {
  readonly type: string;
  readonly name: string;
  /** Chequeo barato y SIN efectos: ¿puede este bridge operar ahora? */
  isAvailable(): Promise<boolean>;
  execute(operation: string, params: Record<string, unknown>): Promise<BridgeResult>;
  healthCheck(): Promise<BridgeHealth>;
}

/**
 * Registry con orden de prioridad: los bridges "priority" se intentan
 * primero; el resto en orden de registro. Si un bridge falla o no está
 * disponible, el siguiente toma el relevo (fallback honesto, sin excepciones).
 */
export class BridgeRegistry {
  private bridges = new Map<string, IBridge>();
  private priority: string[] = [];

  register(bridge: IBridge, isPriority = false): void {
    this.bridges.set(bridge.type, bridge);
    if (isPriority) {
      this.priority = [bridge.type, ...this.priority.filter((t) => t !== bridge.type)];
    }
  }

  get(type: string): IBridge | undefined {
    return this.bridges.get(type);
  }

  /** Intenta en orden de prioridad hasta que uno responda con éxito. */
  async execute(operation: string, params: Record<string, unknown>): Promise<BridgeResult> {
    const order = [
      ...this.priority,
      ...Array.from(this.bridges.keys()).filter((k) => !this.priority.includes(k)),
    ];
    for (const type of order) {
      const bridge = this.bridges.get(type);
      if (!bridge) continue;
      let available = false;
      try {
        available = await bridge.isAvailable();
      } catch {
        available = false;
      }
      if (!available) continue;
      try {
        const result = await bridge.execute(operation, params);
        if (result.success) return result;
      } catch {
        continue;
      }
    }
    return { success: false, error: "No bridge available", source: "none" };
  }

  list(): Array<{ type: string; name: string }> {
    return Array.from(this.bridges.entries()).map(([type, b]) => ({ type, name: b.name }));
  }

  /** Salud de TODOS los bridges (para /api/harness y doctor). */
  async healthAll(): Promise<Array<{ type: string; name: string } & BridgeHealth>> {
    const out: Array<{ type: string; name: string } & BridgeHealth> = [];
    for (const [type, b] of this.bridges.entries()) {
      try {
        out.push({ type, name: b.name, ...(await b.healthCheck()) });
      } catch (e) {
        out.push({ type, name: b.name, available: false, details: { error: (e as Error).message } });
      }
    }
    return out;
  }
}
