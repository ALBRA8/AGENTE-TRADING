// ============================================================
// src/lib/harness/runtime.ts
// ARNÉS — Runtime singleton (Fase 7): acceso perezoso al arnés.
//
// ¿Por qué perezoso? config/nvidia.ts y bot/telegram.ts tienen efectos
// al importarse (lanzan sin API keys) y database/sqlite.ts abre la BD.
// El arnés NUNCA debe romper el arranque del bot: se monta on-demand
// y cualquier fallo se degrada (503) sin tumbar el proceso.
// ============================================================

import type { BootstrapResult } from "../../bootstrap.js";

let harness: BootstrapResult | null = null;
let mounting: Promise<BootstrapResult> | null = null;

export function getHarness(): BootstrapResult | null {
  return harness;
}

export function setHarness(h: BootstrapResult): void {
  harness = h;
}

/** Monta el arnés si aún no está (idempotente, concurrencia segura). */
export async function ensureHarness(): Promise<BootstrapResult> {
  if (harness) return harness;
  if (!mounting) {
    mounting = (async () => {
      const { bootstrapHarness } = await import("../../bootstrap.js");
      const h = await bootstrapHarness();
      harness = h;
      return h;
    })();
    mounting.catch(() => {
      mounting = null; // permitir reintento en la siguiente petición
    });
  }
  return mounting;
}
