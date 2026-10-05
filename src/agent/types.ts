// ============================================================
// src/agent/types.ts
// Shared type definitions for the agent layer
// ============================================================

import type { ChatCompletionTool } from "openai/resources/chat/completions.js";

export interface Tool {
  /** Function definition that will be sent to the LLM */
  definition: ChatCompletionTool;
  /** Handler that receives parsed args and returns a result string */
  execute(args: Record<string, unknown>): Promise<string>;
}

export interface AgentInput {
  userId: string;
  userMessage: string;
  /** Pre-transcribed text when input came from audio */
  transcription?: string;
  /** Callback for streaming tokens back to Telegram */
  onStream?: (chunk: string, isReasoning: boolean) => void;
}

export interface AgentOutput {
  response: string;
  reasoning?: string;
  /** How many tool iterations were used in this turn */
  iterations: number;
}
