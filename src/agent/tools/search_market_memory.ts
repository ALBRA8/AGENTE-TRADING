import type { Tool } from "../types.js";
import { getEmbeddings } from "../../config/nvidia.js";
import { LocalIndex } from "vectra";
import path from "path";
import fs from "fs";
import db from "../../database/sqlite.js";

const VECTOR_DB_PATH = path.resolve("./data/vector_memory");

/**
 * Interface para los argumentos de búsqueda en memoria
 */
interface SearchMarketMemoryArgs {
  h1Structure: string;
  dxyState: string;
  asset: string;
}

export const searchMarketMemory: Tool = {
  definition: {
    type: "function",
    function: {
      name: "searchMarketMemory",
      description: "Consulta la memoria a largo plazo para encontrar escenarios de mercado similares y su tasa de éxito.",
      parameters: {
        type: "object",
        properties: {
          h1Structure: {
            type: "string",
            description: "Descripción de la estructura H1 (ej. 'Tendencia alcista con BOS reciente')."
          },
          dxyState: {
            type: "string",
            description: "Estado del DXY (ej. 'Bajista, perdiendo soporte')."
          },
          asset: {
            type: "string",
            description: "Activo que se está analizando."
          }
        },
        required: ["h1Structure", "dxyState", "asset"]
      }
    }
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const { h1Structure, dxyState, asset } = args as unknown as SearchMarketMemoryArgs;
    
    if (!fs.existsSync(VECTOR_DB_PATH)) {
      fs.mkdirSync(VECTOR_DB_PATH, { recursive: true });
    }

    const index = new LocalIndex(VECTOR_DB_PATH);
    if (!await index.isIndexCreated()) {
      await index.createIndex();
    }

    // 1. Sincronización rápida (Opcional: En un sistema real esto se haría en background)
    // Buscamos trades recientes en SQLite que no estén en la memoria vectorial
    // Para simplificar esta demo, asumimos que se guardan al finalizar cada trade.

    // 2. Generar embedding de la búsqueda
    const queryText = `Asset: ${asset} | Structure: ${h1Structure} | DXY: ${dxyState}`;
    const queryVector = await getEmbeddings(queryText, "query");

    // 3. Buscar en el índice vectorial (query, topK, minScore)
    // @ts-ignore
    const results = await index.queryItems(queryVector, 5);

    if (results.length === 0) {
      return "No se encontraron escenarios similares en la memoria a largo plazo. Proceder con análisis estándar.";
    }

    // 4. Procesar resultados y calcular tasa de éxito
    let positiveResults = 0;
    let totalResults = results.length;
    let summaries = [];

    for (const result of results) {
      const metadata = result.item.metadata as any;
      if (metadata.result_pl > 0) positiveResults++;
      summaries.push(`- [Similitud ${(result.score * 100).toFixed(1)}%]: Setup ${metadata.asset} con resultado ${metadata.result_pl > 0 ? 'EXITOSO' : 'FALLIDO'}. Nota: ${metadata.error_made || 'Ninguna'}`);
    }

    const successRate = (positiveResults / totalResults) * 100;

    return `
### Análisis de Memoria Histórica
- **Escenarios similares detectados:** ${totalResults}
- **Tasa de Éxito Histórica:** ${successRate.toFixed(1)}%
- **Recomendación:** ${successRate > 60 ? 'ALTA PROBABILIDAD. El escenario ha funcionado bien anteriormente.' : 'PRECAUCIÓN. La tasa de éxito histórica para este escenario es baja o moderada.'}

**Detalle de coincidencias:**
${summaries.join('\n')}
    `.trim();
  }
};
