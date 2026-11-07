// quick-test.mjs – Prueba rápida Kimi K2.5 con key del .env
import OpenAI from "openai";
import { readFileSync } from "fs";

// Leer .env directamente (sin dotenv para evitar que el sistema lo sobreescriba)
const envLines = readFileSync(".env", "utf-8").split(/\r?\n/);
const env = Object.fromEntries(
  envLines.flatMap(l => {
    const m = l.match(/^([^#=]+)=(.*)$/);
    return m ? [[m[1].trim(), m[2].trim()]] : [];
  })
);

const apiKey = env.NVIDIA_API_KEY;
console.log(`🔑 Key del .env: ${apiKey.slice(0,10)}...${apiKey.slice(-8)} (${apiKey.length} chars)`);

const client = new OpenAI({
  baseURL: "https://integrate.api.nvidia.com/v1",
  apiKey,
  timeout: 90_000,
  maxRetries: 2,
});

console.log("🧪 Probando z-ai/glm-5.3-flash...");
try {
  const res = await client.chat.completions.create({
    model: env.NVIDIA_MODEL || "z-ai/glm-5.3-flash",
    messages: [{ role: "user", content: "Responde solo con: FUNCIONA" }],
    max_tokens: 16,
    temperature: 0,
  });
  console.log(`✅ GLM-5.3-flash responde: "${res.choices[0].message.content}"`);
  console.log(`   Finish reason: ${res.choices[0].finish_reason}`);
  console.log(`   Tokens: ${res.usage?.total_tokens}`);
} catch (err) {
  console.error(`❌ Error: HTTP ${err.status} – ${err.message}`);
  if (err.error) console.error("   Detail:", JSON.stringify(err.error));
}
