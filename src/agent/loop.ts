// ============================================================
// src/agent/loop.ts
// Agent Loop – Razonamiento, Herramientas y Respuesta (Agente Conversacional)
// ============================================================

import type {
  ChatCompletionMessageParam,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions.js";

import { nvidiaNIMClient, NVIDIA_CONFIG, withRetry } from "../config/nvidia.js";
import {
  saveMessage,
  getRecentMessages,
  getMemoryFragments,
} from "../database/sqlite.js";
import { buildPromotedLessonsBlock, triageUnresolvedErrors } from "./self_improve.js";
import { getAllTools, executeToolByName } from "./registry.js";
import type { AgentInput, AgentOutput, Tool } from "./types.js";

function buildSystemPrompt(userId: string): string {
  const memories = getMemoryFragments(userId);
  const memoryBlock =
    memories.length > 0
      ? memories.map((m) => `• [${m.key}]: ${m.value}`).join("\n")
      : "No hay recuerdos previos registrados.";

  // PROMOCIÓN (auto-mejora): lecciones verificadas viajan siempre en el prompt
  const promotedBlock = buildPromotedLessonsBlock();

  return `Eres un Analista Senior de Trading Institucional y experto en Smart Money Concepts (SMC).
Tu cerebro es el modelo Nemotron-3-Super operando a través de NVIDIA NIM. Especialidad: US30, BTCUSD y GBPJPY.

## Perfil y Protocolo Operativo (SOP v3.1 – Pipeline Institucional)
**PARA CUALQUIER ANÁLISIS OPERATIVO SERIO usa el pipeline completo:**
1. 'runDecisionPipeline' → protocolo institucional multi-agente (filtros paralelos + debate bull/bear + manager + plan + comité de riesgo + decisión auditada)
1.5 'runTimeMachine' → con el plan del pipeline (entry/SL/TP), reproduce el trade 10,000 veces + replay histórico real. Veredicto: 🟢 odds a favor, 🟡 moneda al aire (reduce a 0.25% o exige confluencia extra), 🔴 en contra (no ejecutar). Es insumo para el comité, NO decide solo.
2. Si y SOLO SI la decisión es EXECUTE → 'executeTradeMT5' con los parámetros del plan (el hard-gate bloqueará cualquier intento sin decisión vigente y la orden queda vinculada a la decisión para su settlement)
3. 'reflectOnTrade' → cuando el usuario reporte resultados, errores o correcciones (auto-mejora)
4. 'settleDecisions' → para cerrar decisiones EXECUTE vencidas y convertirlas en lecciones (también corre solo, cada hora)
5. 'evaluateBrain' → cuando el usuario pida evaluación de calidad del agente (score 0-100 con tendencia)
6. 'agentStatus' → para checks de salud rápidos (decisiones, settlement, dependencias)
7. Los tools sueltos (checkNews, analyzeMarket, checkDXY…) úsalos solo para consultas informativas rápidas, NO como sustituto del pipeline.
8. SIEMPRE que el usuario pregunte por balance, saldo, equidad, cuenta o capital, ejecuta obligatoriamente la herramienta 'getAccountInfo' para leer los datos reales de MetaTrader 5.

## Reglas por Activo
- **GBPJPY:** Solo operar en sesión de Londres (3-12 AM EST). Sin overlap = sin trade.
- **BTCUSD:** Opera 24/7. FVG en H1 es REQUISITO INDISPENSABLE antes de buscar confirmación en M1. Fuera de Londres/NY, exigir doble confirmación.
- **US30:** Killzone NY (8-12 AM EST). RVOL mínimo 1.5x para validar BOS.

## Estructura y FVG
- BOS/ChoCh con ruptura de cuerpo. RVOL ≥ 1.5x confirma fuerza institucional.
- FVG no mitigado es obligatorio para POI válido.
- Breaker Blocks como segunda línea de defensa.

## Gestión de Riesgo
- Riesgo por operación: 0.5%. SL dinámico por activo.
- RR mínimo: 1:2 (preferir 1:3).
- Si 'searchMarketMemory' detecta tasa de éxito < 50% en el escenario, reducir tamaño de posición a 0.25%.

## Backtesting
- Cada fin de semana o cuando el usuario lo solicite, ejecutar 'runBacktest' para generar el Reporte de Ajuste.

## Recuerdos del usuario
${memoryBlock}

${promotedBlock}

## Estilo de Respuesta (OBLIGATORIO)
Simplifica los reportes al máximo. No redactes párrafos largos. Usa:
- Solo bullets y emojis de semáforo (🔴🟡🟢).
- Si un filtro bloquea el trade, explica el bloqueo en una sola línea y termina ahí.
- Estructura fija:
  * 💹 **Activo**: [Nombre]
  * 🛡️ **Filtros**: [Estado detallado con emojis]
  * 💰 **Precio**: [Bid/Ask o N/A]
  * 🎯 **Decisión**: [Ejecutar / Esperar / Cancelar]

## Reglas Generales
- La fecha y hora actual en Colombia es: ${new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" })}.
- Responde siempre de forma ultra-directa, ejecutiva y profesional. Menos charla, más ejecución.
`;
}

// ── History reconstruction ─────────────────────────────────
function buildHistory(userId: string): ChatCompletionMessageParam[] {
  const rows = getRecentMessages(userId, 20); // 20 rows → ~10 turns
  rows.reverse(); // oldest first

  const messages: ChatCompletionMessageParam[] = [];

  for (const row of rows) {
    if (row.role === "user" && row.content) {
      messages.push({ role: "user", content: row.content });
    } else if (row.role === "assistant" && row.content) {
      messages.push({ role: "assistant", content: row.content });
    }
    // Las filas 'tool' intermedias de turnos anteriores se omiten:
    // OpenAI/NIM exige emparejamiento estricto assistant.tool_calls -> tool.
    // La respuesta final del asistente ya contiene la información consolidada.
  }

  return messages;
}

// ── Main Agent Loop ────────────────────────────────────────
let triageRunCount = 0;

export async function runAgentLoop(input: AgentInput): Promise<AgentOutput> {
  const { userId, userMessage, onStream } = input;
  const maxIterations = Number(process.env.MAX_TOOL_ITERATIONS ?? 10);

  // TRIAGE (auto-mejora): cada 5 turnos revisa errores recurrentes
  // y los convierte en lecciones. Fire-and-forget, nunca bloquea.
  if (++triageRunCount % 5 === 0) {
    void triageUnresolvedErrors().catch(() => {});
  }

  // 1. Persist user turn
  saveMessage(userId, "user", userMessage);

  // 2. Build message array
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt(userId) },
    ...buildHistory(userId),
  ];

  const tools = getAllTools();
  let iterations = 0;
  let finalReasoningGlobal = "";

  // ── Escudo anti-cuelgue (fix "Failed to fetch" en /api/chat/message) ──
  // Si el modelo activo NO soporta tool-calling, NIM contesta 4xx hablando
  // de tools/functions: se reintenta UNA sola vez sin tools (texto plano).
  let toolsDisabled = false;

  // 3. Agent Loop
  for (let i = 0; i < maxIterations; i++) {
    iterations++;

    // ── Watchdog de inactividad (timeout defensivo, 15s por defecto) ──
    // Cubre conexión + espera del primer chunk + silencios ENTRE chunks.
    // Sin esto, un stream que abre y se calla deja el endpoint colgado.
    const idleMs = NVIDIA_CONFIG.streamIdleTimeoutMs;
    const controller = new AbortController();
    let idleTimer: NodeJS.Timeout | null = null;
    let timedOut = false;
    const armWatchdog = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        try { controller.abort(); } catch { /* noop */ }
      }, idleMs);
    };

    let finalContent = "";
    let finalReasoning = "";
    let toolCalls: any[] = [];
    let finishReason: string | null = null;

    try {
      armWatchdog();
      const stream = await withRetry(
        () =>
          (nvidiaNIMClient.chat.completions.create as any)(
            {
              model: NVIDIA_CONFIG.model,
              messages,
              ...(toolsDisabled
                ? {}
                : { tools: tools.map((t: Tool) => t.definition), tool_choice: "auto" }),
              max_tokens: NVIDIA_CONFIG.maxTokens,
              temperature: NVIDIA_CONFIG.temperature,
              top_p: NVIDIA_CONFIG.topP,
              stream: true,
              ...(NVIDIA_CONFIG.model.includes("nemotron")
                ? {
                    extra_body: {
                      chat_template_kwargs: { enable_thinking: true },
                      reasoning_budget: 16384,
                    },
                  }
                : {}),
            },
            // ⚠️ El signal va en OPTIONS (2º argumento), NO en el body. El SDK
            // openai v4 ignora un signal viajando dentro del body: el abort del
            // watchdog nunca llegaría a la capa HTTP y el corte real tardaría
            // requestTimeoutMs×reintentos en vez de streamIdleTimeoutMs.
            { signal: controller.signal }
          ),
        `iteration ${i + 1}`
      );

      for await (const chunk of (stream as any)) {
        armWatchdog(); // cada chunk re-arma el vigilante: solo la inactividad corta
        if (!chunk.choices || !chunk.choices[0]) continue;

        const delta = chunk.choices[0].delta as any;
        if (!delta) continue;

        if (chunk.choices[0].finish_reason) {
          finishReason = chunk.choices[0].finish_reason;
        }

        const rContent = delta.reasoning_content || "";
        const content = delta.content || "";

        if (rContent) {
          finalReasoning += rContent;
          if (onStream) onStream(rContent, true);
        }
        if (content) {
          finalContent += content;
          if (onStream) onStream(content, false);
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (!toolCalls[tc.index]) {
              toolCalls[tc.index] = {
                id: tc.id || "",
                type: "function",
                function: { name: tc.function?.name || "", arguments: "" },
              };
            }
            if (tc.id && !toolCalls[tc.index].id) {
              toolCalls[tc.index].id = tc.id;
            }
            if (tc.function?.name && !toolCalls[tc.index].function.name) {
              toolCalls[tc.index].function.name = tc.function.name;
            }
            if (tc.function?.arguments) {
              toolCalls[tc.index].function.arguments += tc.function.arguments;
            }
          }
        }
      }
    } catch (err) {
      // 1) Timeout defensivo: si hubo contenido parcial se entrega; si no,
      //    error CLARO para que el endpoint responda amigable.
      if (timedOut) {
        if (finalContent.trim()) {
          const partial = finalContent.trim();
          saveMessage(userId, "assistant", partial);
          return { response: partial, reasoning: finalReasoningGlobal, iterations };
        }
        throw new Error(
          `LLM_STREAM_TIMEOUT: ${NVIDIA_CONFIG.model} no envió datos en ` +
            `${Math.round(idleMs / 1000)}s (timeout defensivo anti-cuelgue)`
        );
      }
      // 2) Modelo sin soporte de tools → reintenta UNA vez sin tools.
      const msg = (err as Error).message || "";
      if (!toolsDisabled && /\b(400|404|422)\b/.test(msg) && /tool|function/i.test(msg)) {
        toolsDisabled = true;
        console.warn(
          `[AgentLoop] ⚠️ El modelo ${NVIDIA_CONFIG.model} no soporta tools: ` +
            `reintentando sin tools. (${msg.slice(0, 140)})`
        );
        i--; // repite esta misma iteración sin tools (el i++ del for re-alinea)
        continue;
      }
      throw err;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
    }

    // Post-stream check: openai-node v4 puede manifestar el abort como un FIN
    // LIMPIO del iterador (sin excepción), así que el flag timedOut manda
    // también fuera del catch. Sin esto, un stream colgado devolvería
    // "(sin respuesta)" en vez del error claro de timeout.
    if (timedOut) {
      if (finalContent.trim()) {
        const partial = finalContent.trim();
        saveMessage(userId, "assistant", partial);
        return { response: partial, reasoning: finalReasoningGlobal, iterations };
      }
      throw new Error(
        `LLM_STREAM_TIMEOUT: ${NVIDIA_CONFIG.model} no envió datos en ` +
          `${Math.round(idleMs / 1000)}s (timeout defensivo anti-cuelgue)`
      );
    }

    // Clean up empty indexes from array and normalize empty arguments to valid JSON object
    toolCalls = toolCalls.filter(Boolean);
    for (const tc of toolCalls) {
      if (tc?.function && (!tc.function.arguments || !tc.function.arguments.trim())) {
        tc.function.arguments = "{}";
      }
    }
    finalReasoningGlobal += finalReasoning;

    const assistantMessage: any = {
      role: "assistant",
      content: finalContent || null,
    };
    if (toolCalls.length > 0) {
      assistantMessage.tool_calls = toolCalls;
    }

    // Append assistant message to context
    messages.push(assistantMessage as ChatCompletionMessageParam);

    // 4a. If finish_reason is 'stop' → we have a final answer
    if (finishReason === "stop" || !toolCalls.length) {
      const finalText = finalContent || "(sin respuesta)";
      saveMessage(userId, "assistant", finalText);
      return { response: finalText, reasoning: finalReasoningGlobal, iterations };
    }

    // 4b. Tool calls → execute and feed results back
    for (const toolCall of toolCalls) {
      const fnName = toolCall.function.name;
      let args: Record<string, unknown> = {};

      try {
        args = JSON.parse(toolCall.function.arguments || "{}");
      } catch {
        args = {};
      }

      console.log(`[AgentLoop] 🔧 Tool call: ${fnName}`, args);

      let toolResult: string;
      try {
        toolResult = await executeToolByName(fnName, args);
      } catch (err) {
        toolResult = `Error ejecutando herramienta "${fnName}": ${(err as Error).message}`;
      }

      console.log(`[AgentLoop] ✅ Tool result: ${toolResult.slice(0, 120)}…`);

      // Persist tool interaction
      saveMessage(userId, "tool", toolResult, fnName, toolCall.id);

      // Feed result back into context
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: toolResult,
      });
    }
  }

  // Safety exit – max iterations reached
  const fallback = "He alcanzado el límite de razonamiento. Por favor, reformula tu pregunta.";
  saveMessage(userId, "assistant", fallback);
  return { response: fallback, reasoning: finalReasoningGlobal, iterations };
}
