import type { Tool } from "../types.js";

const TAVILY_API_KEY = process.env.TAVILY_API_KEY ?? "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";
const TAVILY_URL    = "https://api.tavily.com/search";

interface CheckNewsArgs {
  asset?: string;
}

interface TavilyResult {
  title:   string;
  url:     string;
  content: string;
  score:   number;
}

interface TavilyResponse {
  results: TavilyResult[];
  answer?: string;
}

async function tavilySearch(query: string): Promise<TavilyResponse> {
  const res = await fetch(TAVILY_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key:      TAVILY_API_KEY,
      query:        query,
      search_depth: "advanced",
      max_results:  5,
      include_answer: true,
    }),
  });
  if (!res.ok) throw new Error(`Tavily error ${res.status}: ${await res.text()}`);
  return res.json() as Promise<TavilyResponse>;
}

/** Detecta keywords de riesgo en los titulares y devuelve nivel */
function detectRiskLevel(texts: string[]): { level: "HIGH" | "MEDIUM" | "LOW"; keywords: string[] } {
  const HIGH_RISK = [
    "NFP", "non-farm payroll", "CPI", "inflation", "FOMC", "fed rate",
    "interest rate decision", "GDP", "recession", "crash", "bank failure",
    "emergency", "war", "sanction", "NFP", "nóminas", "decisión de tasas",
    "halving", "SEC", "ban crypto", "ETF approval",
  ];
  const MEDIUM_RISK = [
    "jobless claims", "PMI", "retail sales", "housing", "earnings",
    "balance of trade", "debt ceiling", "bitcoin volatility",
  ];

  const found_high:   string[] = [];
  const found_medium: string[] = [];
  const allText = texts.join(" ").toLowerCase();

  for (const kw of HIGH_RISK)   if (allText.includes(kw.toLowerCase())) found_high.push(kw);
  for (const kw of MEDIUM_RISK) if (allText.includes(kw.toLowerCase())) found_medium.push(kw);

  if (found_high.length   > 0) return { level: "HIGH",   keywords: found_high };
  if (found_medium.length > 0) return { level: "MEDIUM", keywords: found_medium };
  return { level: "LOW", keywords: [] };
}

export const checkNews: Tool = {
  definition: {
    type: "function",
    function: {
      name: "checkNews",
      description: "Busca noticias macroeconómicas REALES con Tavily. Analiza el sentimiento y riesgo fundamental antes de operar. Detecta eventos de alto impacto (NFP, CPI, FOMC, decisiones de tasas, etc.).",
      parameters: {
        type: "object",
        properties: {
          asset: {
            type: "string",
            description: "Activo para el cual se consulta el contexto macro (ej. US30, BTCUSD, GBPJPY)."
          }
        }
      }
    }
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const { asset = "US30" } = args as unknown as CheckNewsArgs;
    const now = new Date();

    // Queries específicas por activo
    const queries: Record<string, string[]> = {
      US30:   ["US30 Dow Jones market news today", "FOMC Fed interest rate economic events today"],
      NAS100: ["Nasdaq 100 tech stocks news today", "Fed economic events inflation today"],
      XAUUSD: ["gold XAU price news today", "US Dollar inflation geopolitical risk today"],
      BTCUSD: ["Bitcoin BTC price news today", "crypto regulation SEC news today"],
      BITCOIN:["Bitcoin BTC price news today", "crypto regulation news today"],
      GBPJPY: ["GBP JPY forex news today", "Bank of England Bank of Japan interest rate news"],
    };
    const defaultQueries = [
      `${asset} market news today`,
      "global economic events high impact news today",
    ];
    const activeQueries = queries[asset.toUpperCase()] ?? defaultQueries;

    try {
      // Buscar en paralelo para mayor velocidad
      const [res1, res2] = await Promise.all([
        tavilySearch(activeQueries[0]),
        tavilySearch(activeQueries[1]),
      ]);

      const allResults = [...(res1.results ?? []), ...(res2.results ?? [])];
      const allTexts   = allResults.map(r => `${r.title} ${r.content}`);
      const risk       = detectRiskLevel(allTexts);

      // Top 4 noticias más relevantes (por score)
      const top = allResults
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, 4);

      const newsList = top.map((r, i) =>
        `${i + 1}. **${r.title}**\n   → ${r.content.slice(0, 180).trim()}...\n   🔗 ${r.url}`
      ).join("\n\n");

      const aiSummary = res1.answer ?? res2.answer ?? "Sin resumen disponible.";

      // Determinar estado operativo
      let riskStatus: string;
      let instruction: string;

      if (risk.level === "HIGH") {
        riskStatus  = "🔴 BLOQUEADO — Evento de Alto Impacto detectado";
        instruction = `STOP. NO ejecutar órdenes. Palabras clave detectadas: ${risk.keywords.join(", ")}. Esperar el resultado del evento y mínimo 15 minutos de consolidación posterior.`;
      } else if (risk.level === "MEDIUM") {
        riskStatus  = "🟡 PRECAUCIÓN — Riesgo Moderado";
        instruction = `Reducir tamaño de posición al 0.25%. Exigir doble confirmación de ChoCh. Keywords: ${risk.keywords.join(", ")}.`;
      } else {
        riskStatus  = "🟢 OPERABLE — Sin eventos de alto impacto detectados";
        instruction = "Proceder con análisis técnico SMC según el SOP v2. Mantener gestión de riesgo estándar (0.5%).";
      }

      return `
# 📰 Inteligencia de Noticias — Tavily Real-Time
**Activo:** ${asset} | **Hora Colombia:** ${now.toLocaleString("es-CO", { timeZone: "America/Bogota" })}

## Estado Operativo
**${riskStatus}**

## Resumen IA (Tavily)
${aiSummary}

## Top Noticias
${newsList}

## Instrucción para el Agente
${instruction}
      `.trim();

    } catch (err) {
      return `⚠️ Error al consultar Tavily: ${(err as Error).message}\nVerifica tu clave de API en TAVILY_API_KEY.`;
    }
  }
};


