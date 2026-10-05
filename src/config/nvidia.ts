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
