// ============================================================
// src/lib/bridges/python-bridge.ts
// ARNÉS — Bridge Python (plantilla de la migración, fallback):
// ejecuta scripts/<operation>.py pasando JSON por argv y esperando
// JSON por stdout. En AGENTE-TRADING el Python real (bridge.py) es un
// SERVIDOR Flask y ya está cubierto por Mt5Bridge; este bridge queda
// para utilidades futuras (análisis offline, scraping, etc.).
// ============================================================

import { exec } from "child_process";
import { promisify } from "util";
import type { IBridge, BridgeResult, BridgeHealth } from "./types.js";

const execAsync = promisify(exec);

export class PythonBridge implements IBridge {
  readonly type = "python";
  readonly name: string;
  private pythonPath: string;
  private scriptDir: string;

  constructor(name = "Python Bridge", pythonPath = "python3", scriptDir = "./scripts") {
    this.name = name;
    this.pythonPath = pythonPath;
    this.scriptDir = scriptDir;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await execAsync(`${this.pythonPath} --version`, { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  async execute(operation: string, params: Record<string, unknown>): Promise<BridgeResult> {
    try {
      const scriptPath = `${this.scriptDir}/${operation}.py`;
      const args = JSON.stringify(params);
      const { stdout } = await execAsync(
        `${this.pythonPath} "${scriptPath}" '${args.replace(/'/g, "'\\''")}'`,
        { timeout: 30_000, maxBuffer: 1024 * 1024 }
      );
      const data = JSON.parse(stdout);
      return { success: true, data, source: this.type };
    } catch (e) {
      return { success: false, error: (e as Error).message, source: this.type };
    }
  }

  async healthCheck(): Promise<BridgeHealth> {
    const available = await this.isAvailable();
    return { available, details: { type: this.type, python: this.pythonPath, dir: this.scriptDir } };
  }
}
