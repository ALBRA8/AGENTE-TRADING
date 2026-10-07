import type { Tool } from "../types.js";
import { saveTradePerformance } from "../../database/sqlite.js";
import { getEmbeddings } from "../../config/nvidia.js";
import { LocalIndex } from "vectra";
import path from "path";
import fs from "fs";

const VECTOR_DB_PATH = path.resolve("./data/vector_memory");

interface LogTradeArgs {
  setupDetected: string;
  nemotronThought: string;
  resultPl?: number;
  errorMade?: string;
  asset?: string;
  dxyCorrelation?: string;
}

export const logTradePerformance: Tool = {
  definition: {
    type: "function",
    function: {
      name: "logTradePerformance",
      description: "Registra en la Base de Datos de Aprendizaje el rendimiento de una operación (Setup, Pensamientos, P/L, Errores). Úsalo para registrar operaciones ejecutadas o escenarios analizados a posteriori.",
      parameters: {
        type: "object",
        properties: {
          setupDetected: {
            type: "string",
            description: "Estructura y patrón técnico detectado (ej. BOS M15, ChoCh M1)."
          },
          nemotronThought: {
            type: "string",
            description: "Tu razonamiento interno fundamentado sobre la entrada macro y técnica."
          },
          resultPl: {
            type: "number",
            description: "Resultado de la operación en dinero o RR. Opcional si la operación no ha cerrado."
          },
          errorMade: {
            type: "string",
            description: "Lecciones aprendidas o desviaciones del SOP cometidas en esta operación. Opcional."
          },
          asset: {
            type: "string",
            description: "Activo operado (Ej. US30, NAS100, XAUUSD)."
          },
          dxyCorrelation: {
            type: "string",
            description: "Estado de la correlación con el DXY."
          }
        },
        required: ["setupDetected", "nemotronThought"]
      }
    }
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const { setupDetected, nemotronThought, resultPl, errorMade, asset = "US30", dxyCorrelation = "N/A" } = args as unknown as LogTradeArgs;
    
    // 1. Guardar en SQLite (Base de datos relacional/persistente)
    saveTradePerformance(setupDetected, nemotronThought, resultPl, errorMade, asset, dxyCorrelation);

    // 2. Guardar en Base de Datos Vectorial (Memoria a Largo Plazo)
    try {
      if (!fs.existsSync(VECTOR_DB_PATH)) {
        fs.mkdirSync(VECTOR_DB_PATH, { recursive: true });
      }

      const index = new LocalIndex(VECTOR_DB_PATH);
      if (!await index.isIndexCreated()) {
        await index.createIndex();
      }

      const textToEmbed = `Asset: ${asset} | Structure: ${setupDetected} | DXY: ${dxyCorrelation}`;
      const vector = await getEmbeddings(textToEmbed, "passage");

      await index.insertItem({
        vector: vector,
        metadata: {
          asset,
          setup_detected: setupDetected,
          dxy_correlation: dxyCorrelation,
          result_pl: resultPl || 0,
          error_made: errorMade || "N/A",
          timestamp: new Date().toISOString()
        }
      });
    } catch (vError) {
      console.error("[Vector DB] Error al guardar memoria:", vError);
      // Fallback silencioso para no interrumpir el flujo principal
    }
    
    return "✅ Registro de aprendizaje almacenado correctamente en SQLite y en la Memoria Vectorial.";
  }
};
