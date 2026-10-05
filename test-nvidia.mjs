// test-nvidia.mjs – Diagnóstico mejorado NVIDIA NIM
// Ejecutar: node test-nvidia.mjs
import OpenAI from "openai";
import { readFileSync, existsSync } from "fs";

// ── Leer .env manualmente ──────────────────────────────────
function loadEnv(path = ".env") {
  if (!existsSync(path)) return {};
  const result = {};
  for (const line of readFileSync(path, "utf-8").split(/\r?\n/)) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) result[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return result;
}

const env = loadEnv(".env");
// Prioridad: variable de entorno del sistema > .env
const apiKey = process.env.NVIDIA_API_KEY || env.NVIDIA_API_KEY;

if (!apiKey) {
  console.error("❌ No se encontró NVIDIA_API_KEY");
  process.exit(1);
}

// Mostramos solo el inicio y fin para verificar sin exponer la key completa
const keyPreview = `${apiKey.slice(0, 10)}...${apiKey.slice(-8)}`;
console.log(`🔑 Key usada:     ${keyPreview} (${apiKey.length} chars)`);
console.log(`🔑 Key en .env:   ${env.NVIDIA_API_KEY ? env.NVIDIA_API_KEY.slice(0, 10) + "..." + env.NVIDIA_API_KEY.slice(-8) : "NO ENCONTRADA"}`);
console.log(`🔑 Key en system: ${process.env.NVIDIA_API_KEY ? process.env.NVIDIA_API_KEY.slice(0, 10) + "..." + process.env.NVIDIA_API_KEY.slice(-8) : "NO ENCONTRADA"}`);
console.log();

// ── Config ────────────────────────────────────────────────
const BASE_URL = "https://integrate.api.nvidia.com/v1";
const MODELS = [
  "meta/llama-3.3-70b-instruct",
  "moonshotai/kimi-k2.5",
];

// ── Primero: test con fetch nativo para verificar sin SDK ─
async function rawFetchTest(model) {
  console.log(`\n🌐 RAW FETCH test → ${model}`);
  const body = JSON.stringify({
    model,
    messages: [{ role: "user", content: "di solo: OK" }],
    max_tokens: 16,
    temperature: 0,
  });

  const start = Date.now();
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "Accept": "application/json",
      },
      body,
    });

    const elapsed = Date.now() - start;
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = null; }

    if (res.ok) {
      const content = parsed?.choices?.[0]?.message?.content ?? "(vacío)";
      console.log(`   ✅ HTTP ${res.status} (${elapsed}ms) → "${content}"`);
    } else {
      console.error(`   ❌ HTTP ${res.status} (${elapsed}ms)`);
      console.error(`   Body: ${text.slice(0, 300)}`);
    }
    return res.ok;
  } catch (err) {
    const elapsed = Date.now() - start;
    console.error(`   ❌ Error de red (${elapsed}ms): ${err.message}`);
    return false;
  }
}

// ── Test con SDK OpenAI ───────────────────────────────────
async function sdkTest(model) {
  console.log(`\n🔧 SDK OpenAI test → ${model}`);
  const client = new OpenAI({ baseURL: BASE_URL, apiKey, timeout: 30_000, maxRetries: 0 });

  const start = Date.now();
  try {
    const res = await client.chat.completions.create({
      model,
      messages: [{ role: "user", content: "di solo: OK" }],
      max_tokens: 16,
      temperature: 0,
    });
    const elapsed = Date.now() - start;
    const content = res.choices?.[0]?.message?.content ?? "(vacío)";
    console.log(`   ✅ OK (${elapsed}ms) → "${content}"`);
    return true;
  } catch (err) {
    const elapsed = Date.now() - start;
    console.error(`   ❌ ${err.constructor?.name}: HTTP ${err.status ?? "?"} (${elapsed}ms)`);
    if (err.error) console.error(`   Detail: ${JSON.stringify(err.error)}`);
    return false;
  }
}

// ── Test tool calling con Kimi ────────────────────────────
async function toolCallTest(model) {
  console.log(`\n🛠️  Tool calling test → ${model}`);
  const client = new OpenAI({ baseURL: BASE_URL, apiKey, timeout: 30_000, maxRetries: 0 });

  try {
    const res = await client.chat.completions.create({
      model,
      messages: [{ role: "user", content: "¿Qué hora es?" }],
      tools: [{
        type: "function",
        function: {
          name: "get_current_time",
          description: "Retorna la hora actual",
          parameters: { type: "object", properties: {} },
        },
      }],
      tool_choice: "auto",
      max_tokens: 64,
    });

    const choice = res.choices?.[0];
    if (choice?.message?.tool_calls?.length) {
      const tc = choice.message.tool_calls[0];
      console.log(`   ✅ Llamó herramienta: ${tc.function.name} (finish: ${choice.finish_reason})`);
    } else {
      console.log(`   ⚠️  No usó herramienta (finish: ${choice?.finish_reason}) → "${choice?.message?.content}"`);
    }
  } catch (err) {
    console.error(`   ❌ ${err.constructor?.name}: ${err.message}`);
  }
}

// ── Ejecutar ──────────────────────────────────────────────
console.log("═".repeat(60));
console.log("🚀 DIAGNÓSTICO NVIDIA NIM – CRM ALBRA");
console.log(`📡 Base URL: ${BASE_URL}`);
console.log(`⏰ ${new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" })}`);
console.log("═".repeat(60));

for (const model of MODELS) {
  console.log(`\n${"▓".repeat(60)}`);
  console.log(`  MODELO: ${model}`);
  console.log(`${"▓".repeat(60)}`);

  const rawOk = await rawFetchTest(model);
  const sdkOk = await sdkTest(model);

  if (sdkOk) {
    await toolCallTest(model);
  }
}

console.log(`\n${"═".repeat(60)}`);
console.log("✅ DIAGNÓSTICO COMPLETADO");
console.log("═".repeat(60));
