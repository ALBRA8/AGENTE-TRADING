// ============================================================
// src/agent/registry.ts
// Central tool registry – add new tools here
// ============================================================

import type { Tool } from "./types.js";
import { getCurrentTime } from "./tools/get_current_time.js";
import { analyzeMarket } from "./tools/analyze_market.js";
import { checkNews } from "./tools/check_news.js";
import { logTradePerformance } from "./tools/log_trade_performance.js";
import { checkDXY } from "./tools/check_dxy.js";
import { checkMarketHours } from "./tools/check_market_hours.js";
import { searchMarketMemory } from "./tools/search_market_memory.js";
import { checkRVOL } from "./tools/check_rvol.js";
import { runBacktest } from "./tools/run_backtest.js";
import { runBacktestPro } from "./tools/run_backtest_pro.js";
import { executeTradeMT5 } from "./tools/execute_trade_mt5.js";
import { runDecisionPipelineTool } from "./tools/run_decision_pipeline.js";
import { reflectOnTrade } from "./tools/reflect_on_trade.js";
import { searchLessonsTool } from "./tools/search_lessons.js";
import { settleDecisions } from "./tools/settle_decisions.js";
import { evaluateBrainTool } from "./tools/evaluate_brain.js";
import { agentStatusTool } from "./tools/agent_status.js";
import { doctorStatusTool } from "./tools/doctor_status.js";
import { runStrategyEngineTool } from "./tools/run_strategy_engine.js";
import { captureAutoError } from "./self_improve.js";

// ── Register all available tools ───────────────────────────
const TOOL_REGISTRY: Tool[] = [
 getCurrentTime,
 analyzeMarket,
 checkNews,
 checkDXY,
 logTradePerformance,
 checkMarketHours,
 searchMarketMemory,
 checkRVOL,
 runBacktest,
 runBacktestPro,
 executeTradeMT5,
 runDecisionPipelineTool,
 reflectOnTrade,
 searchLessonsTool,
 settleDecisions,
 evaluateBrainTool,
 agentStatusTool,
 doctorStatusTool, // Task 10-c §20: doctor del agente (agrega checks existentes)
 runStrategyEngineTool, // STRATEGY ENGINE V1.0: tick determinista S0-S9 (spec §6)
 // agrega más herramientas aquí conforme crece el agente
];

export function getAllTools(): Tool[] {
  return TOOL_REGISTRY;
}

export async function executeToolByName(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  const tool = TOOL_REGISTRY.find(
    (t) => t.definition.function.name === name
  );

  if (!tool) {
    return `Herramienta desconocida: "${name}". Las herramientas disponibles son: ${TOOL_REGISTRY.map(
      (t) => t.definition.function.name
    ).join(", ")}.`;
  }

  try {
    return await tool.execute(args);
  } catch (err) {
    // Auto-mejoramiento: todo fallo de herramienta se captura para triage
    captureAutoError(name, err as Error, args);
    throw err;
  }
}
