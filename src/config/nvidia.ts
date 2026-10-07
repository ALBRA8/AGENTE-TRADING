// ============================================================
// src/config/nvidia.ts
// Configuración del cliente NVIDIA NIM para Agente de Trading (Kimi K2.5)
// ============================================================

import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config({ override: true }); // override: la key del .env siempre gana sobre variables del sistema

// ── Constants ─────────────────────────────────────────────
export const NVIDIA_CONFIG = {
  baseURL: "https://integrate.api.nvidia.com/v1",
  // ── Modelo activo ─────────────────────────────────────────
  model: "nvidia/nemotron-3-super-120b-a12b",
  embeddingModel: "nvidia/nv-embedqa-e5-v5",
  contextWindow: 128_000,
  maxTokens: 8_192,
  temperature: 0.6,
  topP: 0.7,

  // Retry policy – exponential back-off
  retry: {
    maxAttempts: 3,
    initialDelayMs: 1_000,
    backoffFactor: 2,
  },
} as const;

// ── Tiers de modelo (patrón TradingAgents) ──────────────────────
// quick → analistas, debaters, reflexión (barato y rápido)
// deep  → research manager, trade planner, gate final (razonamiento profundo)
// Se pueden sobreescribir por .env sin tocar código.
export const MODEL_TIERS = {
  quick: process.env.QUICK_MODEL ?? "meta/llama-3.3-70b-instruct",
  deep: process.env.DEEP_MODEL ?? "nvidia/nemotron-3-super-120b-a12b",
} as const;

export type ModelTier = keyof typeof MODEL_TIERS;

// ── PROVIDER MOCK (PROMPT 06 §16 — provider contract) ─────────────
// LLM_PROVIDER=mock activa un proveedor DETERMINISTA sin red: no llama a
// NVIDIA, devuelve fixtures según marcadores del prompt (§25 E2E).
//
// ⚠️  SOLO SIRVE PARA E2E/TESTS. JAMÁS usarlo en producción: sus respuestas
//     son afirmaciones fabricadas (bias/plan/veredicto fijos), no análisis.
// FAIL-SAFE (§16): si LIVE_TRADING=true el mock se RECHAZA (error) — el
// trading real exige el provider real; nunca inferir autoridad del mock.
export function isMockProvider(): boolean {
  return (process.env.LLM_PROVIDER ?? "").trim().toLowerCase() === "mock";
}

const MOCK_TOKENS = 42; // número pequeño fijo: el mock no consume tokens reales

function mockCompletion(opts: {
  tier: ModelTier;
  system: string;
  user: string;
}): { content: string; tokensUsed: number } {
  const system = opts.system ?? "";
  const user = opts.user ?? "";

  // Debate: posturas por marcador en el USER prompt (texto plano corto)
  if (user.includes("POSTURA: TORO")) {
    return {
      content:
        "TORO: La estructura es alcista según el reporte SMC (BOS confirmado y retroceso a POI con volumen institucional). " +
        "El horario está en killzone y el RVOL respalda el impulso. El riesgo admite mi tesis: si pierde el POI, el plan queda invalidado.",
      tokensUsed: MOCK_TOKENS,
    };
  }
  if (user.includes("POSTURA: OSO")) {
    return {
      content:
        "OSO: El alegado BOS puede ser un barrido de liquidez; el retroceso aún no muestra reacción confirmada. " +
        "Sin confirmación de ChoCh en M1/M5 el movimiento es frágil, y la correlación DXY no está verificada. Admito que la estructura mayor es alcista.",
      tokensUsed: MOCK_TOKENS,
    };
  }

  // JSON por marcador en el SYSTEM prompt. ORDEN IMPORTANTE: el system del
  // planner cita "veredicto del Research Manager" → Trade Planner se evalúa
  // ANTES que Research Manager para no cruzar los fixtures.
  if (system.includes("Trade Planner")) {
    return {
      content: JSON.stringify({
        action: "EXECUTE",
        direction: "BUY",
        stopLossPips: 15,
        riskPct: 0.5,
        setup: "choch",
        reasoning: "Plan del mock",
      }),
      tokensUsed: MOCK_TOKENS,
    };
  }
  if (system.includes("Research Manager")) {
    return {
      content: JSON.stringify({
        bias: "BULLISH",
        confidence: 0.8,
        conditions: ["ChoCh M5 confirmado"],
        rationale: "Estructura real detectada",
      }),
      tokensUsed: MOCK_TOKENS,
    };
  }
  if (system.includes("riesgo") || system.includes("Analista de riesgo")) {
    return {
      content: JSON.stringify({ verdict: "OK", concern: "mock sin objeciones" }),
      tokensUsed: MOCK_TOKENS,
    };
  }

  // Fallback: JSON válido (fail-closed río abajo: los parseadores deciden)
  return {
    content: JSON.stringify({ verdict: "OK", concern: "mock" }),
    tokensUsed: MOCK_TOKENS,
  };
}

/**
 * Llamada de chat no-streaming por tier, con retry incluido.
 * Devuelve el texto final y el uso de tokens reportado por la API.
 * LLM_PROVIDER=mock → fixtures deterministas sin red (§16/§25).
 */
export async function callLLMByTier(opts: {
  tier: ModelTier;
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
}): Promise<{ content: string; tokensUsed: number }> {
  // ── Provider mock (§16): fixture determinista, sin NVIDIA ──
  if (isMockProvider()) {
    // Fail-safe: trading real nunca sobre un proveedor de fixtures.
    if ((process.env.LIVE_TRADING ?? "").trim().toLowerCase() === "true") {
      throw new Error(
        "[NVIDIA] LLM_PROVIDER=mock está PROHIBIDO con LIVE_TRADING=true " +
          "(§16 fail-safe): el trading real exige el proveedor real. " +
          "Desactiva LIVE_TRADING o cambia LLM_PROVIDER."
      );
    }
    return mockCompletion(opts);
  }

  const model = MODEL_TIERS[opts.tier];
  const resp: any = await withRetry(
    () =>
      (nvidiaNIMClient.chat.completions.create as any)({
        model,
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.user },
        ],
        max_tokens: opts.maxTokens ?? 1_500,
        temperature: opts.temperature ?? 0.4,
        top_p: NVIDIA_CONFIG.topP,
        stream: false,
        ...(opts.jsonMode ? { response_format: { type: "json_object" } } : {}),
      }),
    `callLLMByTier(${opts.tier})`
  );

  const choice = resp?.choices?.[0];
  const raw: any = choice?.message ?? {};
  // Algunos modelos NIM separan el razonamiento del contenido final
  const content: string =
    (typeof raw.content === "string" && raw.content.trim()) ||
    (typeof raw.reasoning_content === "string" ? raw.reasoning_content : "") ||
    "";
  const tokensUsed: number = resp?.usage?.total_tokens ?? 0;
  return { content, tokensUsed };
}

// ── Validate required env vars ─────────────────────────────
const apiKey = process.env.NVIDIA_API_KEY;
if (!apiKey || apiKey.startsWith("nvapi-xxx")) {
  throw new Error(
    "[NVIDIA] NVIDIA_API_KEY está ausente o aún es el placeholder. " +
      "Please fill in your key in the .env file."
  );
}

// ── Singleton client ───────────────────────────────────────
// The openai SDK is used because NVIDIA NIM exposes an OpenAI-compatible API.
export const nvidiaNIMClient = new OpenAI({
  baseURL: NVIDIA_CONFIG.baseURL,
  apiKey,
  defaultHeaders: {
    // Ensures NVIDIA gateway accepts the request without blocking
    "User-Agent": "TradingAgent/1.0 (Node.js; NVIDIA-NIM-Compatible)",
    Accept: "application/json",
  },
  timeout: 90_000,   // 90 s – NIM can be slow on first call
  maxRetries: 0,     // We handle retries ourselves (exponential back-off)
});

// ── Exponential retry wrapper ──────────────────────────────
export async function withRetry<T>(
  fn: () => Promise<T>,
  label = "API call"
): Promise<T> {
  const { maxAttempts, initialDelayMs, backoffFactor } = NVIDIA_CONFIG.retry;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const isRetryable =
        err instanceof Error &&
        (err.message.includes("timeout") ||
          err.message.includes("ECONNRESET") ||
          err.message.includes("502") ||
          err.message.includes("503") ||
          err.message.includes("529"));

      if (!isRetryable || attempt === maxAttempts) break;

      const delayMs = initialDelayMs * Math.pow(backoffFactor, attempt - 1);
      console.warn(
        `[NVIDIA] ${label} attempt ${attempt}/${maxAttempts} failed. ` +
          `Retrying in ${delayMs}ms… (${(err as Error).message})`
      );
      await sleep(delayMs);
    }
  }

  throw lastError;
}

/**
 * Obtiene los embeddings de un texto usando NVIDIA NIM
 */
export async function getEmbeddings(text: string, type: "query" | "passage" = "passage"): Promise<number[]> {
  const model = `${NVIDIA_CONFIG.embeddingModel}`;
  
  return await withRetry(async () => {
    const response = await nvidiaNIMClient.embeddings.create({
      model: model,
      input: [text],
      // @ts-ignore: input_type is specific to NVIDIA NIM
      input_type: type, 
      encoding_format: "float",
    });
    
    return response.data[0].embedding;
  }, "Embeddings call");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
