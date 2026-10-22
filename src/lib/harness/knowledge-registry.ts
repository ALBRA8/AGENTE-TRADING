// ============================================================
// src/lib/harness/knowledge-registry.ts
// ARNÉS — Knowledge Registry (migración PROYECTO → ARNÉS, Fase 5)
//
// Aquí vive el CONOCIMIENTO DEL DOMINIO (la caja registradora).
// El cajero (AGENTE-GENERAL) no sabe nada de trading: consulta estos
// módulos. Decisión de LIPO (migration-analysis.md §4): los módulos
// REGISTRAN catálogos y delegan la ejecución en los módulos originales
// (cero duplicación, §27 del SOP).
// ============================================================

import { ASSET_SL_TABLE, getSlForSymbol } from "../../config/asset_risk_table.js";

export interface IKnowledgeModule {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly version: string;
  getContent(): Record<string, unknown>;
  validate(): boolean;
}

export class KnowledgeRegistry {
  private modules = new Map<string, IKnowledgeModule>();

  register(module: IKnowledgeModule): void {
    this.modules.set(module.id, module);
  }

  get(id: string): IKnowledgeModule | undefined {
    return this.modules.get(id);
  }

  list(): Array<{ id: string; name: string; category: string }> {
    return Array.from(this.modules.values()).map((m) => ({
      id: m.id,
      name: m.name,
      category: m.category,
    }));
  }

  getByCategory(category: string): IKnowledgeModule[] {
    return Array.from(this.modules.values()).filter((m) => m.category === category);
  }

  healthCheck(): { total: number; valid: number; invalid: string[] } {
    const invalid: string[] = [];
    let valid = 0;
    for (const m of this.modules.values()) {
      try {
        if (m.validate()) valid++;
        else invalid.push(m.id);
      } catch {
        invalid.push(m.id);
      }
    }
    return { total: this.modules.size, valid, invalid };
  }
}

// ─────────────────────────────────────────────────────────────
// MÓDULO 1: máquina de estados S0–S9 (Strategy Engine V1.0)
// Fuente: src/strategy/engine.ts (implementación viva) + docs/STRATEGY_ENGINE_V1.md §3
// ─────────────────────────────────────────────────────────────
const SMC_ENGINE_PHASES: IKnowledgeModule = {
  id: "smc-engine-phases",
  name: "Strategy Engine V1.0 — fases S0-S9",
  category: "business-flows",
  version: "1.0.0",
  getContent: () => ({
    source: "src/strategy/engine.ts + docs/STRATEGY_ENGINE_V1.md §3",
    invariant:
      "Función PURA sin I/O: el estado solo muta con vela confirmada (sin repintado).",
    phases: [
      { stage: "S0", name: "Gates + Sweep NY", blockers: ["B16", "B5"], detail: "Condiciones de no-trade en orden y sweep de la sesión; sin sweep no hay setup ese día en esa dirección." },
      { stage: "S1", name: "Armado de dirección", blockers: ["B1"], detail: "Sesgo macro H1 del Pilar 1 arma la dirección candidata." },
      { stage: "S2", name: "S2_SWEEP_OK — BOS M15", blockers: ["B2"], detail: "Esperar BOS válido M15 (Pilar 2: estructura)." },
      { stage: "S3", name: "S3_POI_WAIT — retorno al POI", blockers: ["B7"], detail: "El precio debe volver a la caja (POI validado, B6)." },
      { stage: "S4", name: "S4_IN_POI — confirmación M5", blockers: ["B8"], detail: "CHOCH M5 a favor dentro del POI (Pilar 3a)." },
      { stage: "S5", name: "S5_CONFIRMED — trigger M1", blockers: ["B9"], detail: "CHOCH M1 como trigger de ejecución (Pilar 3b)." },
      { stage: "S6", name: "S6_TRIGGER_WAIT — SL/TP estructurales", blockers: ["B12", "B13"], detail: "Fabricar SL/TP (liquidez externa) y decidir si el setup es aceptable." },
      { stage: "S7", name: "S7_ORDER_LIVE — retest y entrada", blockers: ["B10"], detail: "Orden pendiente en el retest del bloque trigger; prohibida entrada a mercado." },
      { stage: "S8", name: "S8_MANAGED — gestión", blockers: ["B14"], detail: "SL/TP conservador (R17.3) + break-even estructural (R14.1); TP Ladder 50/30/20." },
      { stage: "S9", name: "S9_CLOSED — cierre", blockers: ["B11"], detail: "SL_HIT / TP_HIT; registro completo de la operación (OpenTrade)." },
    ],
  }),
  validate: () => {
    const c = SMC_ENGINE_PHASES.getContent() as { phases: Array<{ stage: string }> };
    return Array.isArray(c.phases) && c.phases.length === 10;
  },
};

// ─────────────────────────────────────────────────────────────
// MÓDULO 2: catálogo de bloqueos operativos B1–B18
// Fuente: docs/STRATEGY_ENGINE_V1.md (§ bloques) + CONTEXTO DEL AGENTE TRADING/
// ─────────────────────────────────────────────────────────────
const SMC_BLOCKERS: IKnowledgeModule = {
  id: "smc-blockers",
  name: "Bloques operativos B1-B18",
  category: "validation-rules",
  version: "1.0.0",
  getContent: () => ({
    source: "docs/STRATEGY_ENGINE_V1.md (validar B5.3/B10.1/B12.2/B13.1 con el propietario)",
    blockers: [
      { id: "B1", name: "Contexto H1", detail: "Pilar 1: dirección macro del día." },
      { id: "B2", name: "Estructura M15", detail: "Pilar 2: BOS válido y caja (POI)." },
      { id: "B3", name: "Liquidez interna y externa", detail: "Mapa de liquidez previa al sweep." },
      { id: "B4", name: "High/Low de Londres", detail: "Niveles de sesión: objetivos de sweep (B5) y TP (B13)." },
      { id: "B5", name: "Sweep de Nueva York", detail: "Sin sweep en la ventana ⇒ no hay setup ese día en esa dirección." },
      { id: "B6", name: "Validación de POI", detail: "El BOS debe ir precedido de toma de liquidez (requisito D-3/D-9)." },
      { id: "B7", name: "Retorno al POI", detail: "El precio debe reingresar a la caja antes de confirmar." },
      { id: "B8", name: "Confirmación M5", detail: "Pilar 3a: CHOCH M5 a favor dentro del POI." },
      { id: "B9", name: "CHOCH M1 (trigger)", detail: "Pilar 3b: trigger de ejecución." },
      { id: "B10", name: "Retest y entrada", detail: "Orden pendiente en retest; entrada a mercado PROHIBIDA." },
      { id: "B11", name: "OpenTrade", detail: "Registro completo de la operación abierta." },
      { id: "B12", name: "Stop Loss estructural", detail: "SL derivado de estructura, nunca inventado." },
      { id: "B13", name: "Take Profit (liquidez externa)", detail: "TP en liquidez externa (High/Low de sesión, PDH/PDL)." },
      { id: "B14", name: "Gestión de la posición", detail: "SL/TP conservador + BE estructural + TP Ladder." },
      { id: "B15", name: "Invalidaciones", detail: "Condiciones que matan el setup activo." },
      { id: "B16", name: "Condiciones de no-trade", detail: "Gates previos EN ORDEN (spread, sesión, noticias, tick)." },
      { id: "B17", name: "Reglas de backtest", detail: "Reproducibilidad y fricciones obligatorias (comisión+slippage)." },
      { id: "B18", name: "Métricas de aceptación", detail: "PROPOSAL: umbral PF/DD a confirmar con el propietario." },
    ],
  }),
  validate: () => {
    const c = SMC_BLOCKERS.getContent() as { blockers: Array<{ id: string }> };
    return c.blockers.length === 18 && c.blockers[0].id === "B1" && c.blockers[17].id === "B18";
  },
};

// ─────────────────────────────────────────────────────────────
// MÓDULO 3: tabla única de SL por activo (manual operativo, Task 11-a)
// Delegación real: getSlForSymbol() es LA implementación (cero duplicación).
// ─────────────────────────────────────────────────────────────
const ASSET_RISK_TABLE: IKnowledgeModule = {
  id: "asset-risk-table",
  name: "Tabla única de SL por activo",
  category: "pricing-rules",
  version: "1.0.0",
  getContent: () => ({
    source: "src/config/asset_risk_table.ts (fuente única, Task 11-a)",
    resolver: "getSlForSymbol(symbol) — matching por subcadena, fail-closed (null si desconocido)",
    table: ASSET_SL_TABLE,
    policy:
      "US30 80 puntos · NAS100 20 pips · XAUUSD 12 puntos · GBPJPY 20 pips (pip=0.01) · BTCUSD 500 USD",
  }),
  validate: () => {
    const assets = Object.values(ASSET_SL_TABLE);
    if (assets.length !== 5) return false;
    if (!assets.every((a) => a.sl > 0 && Array.isArray(a.aliases) && a.aliases.length > 0)) return false;
    // El resolver delegado debe comportarse según el manual (smoke del conocimiento)
    return (
      getSlForSymbol("US30Cash") === 80 &&
      getSlForSymbol("XAUUSD.a") === 12 &&
      getSlForSymbol("SIMBOLO_DESCONOCIDO") === null
    );
  },
};

/**
 * REGISTRAR CONOCIMIENTO DEL PROYECTO AQUÍ.
 * Categorías usadas: business-flows (flujos del motor), validation-rules
 * (bloques operativos), pricing-rules (riesgo por activo).
 * Futuros módulos: manual operativo, killzones, segmentos de usuario…
 */
export function registerBuiltinKnowledge(registry: KnowledgeRegistry): void {
  registry.register(SMC_ENGINE_PHASES);
  registry.register(SMC_BLOCKERS);
  registry.register(ASSET_RISK_TABLE);
}
