import type { Tool } from "../types.js";
import db from "../../database/sqlite.js";

interface RunBacktestArgs {
  period?: "week" | "month" | "all";
}

export const runBacktest: Tool = {
  definition: {
    type: "function",
    function: {
      name: "runBacktest",
      description: "Analiza los trades históricos en la base de datos y genera un Reporte de Ajuste con sugerencias para mejorar el Stop Loss, horarios de operación y setup de mayor éxito.",
      parameters: {
        type: "object",
        properties: {
          period: {
            type: "string",
            enum: ["week", "month", "all"],
            description: "Período de análisis: 'week' (última semana), 'month' (último mes), 'all' (todos). Default: week."
          }
        },
        required: []
      }
    }
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const { period = "week" } = args as unknown as RunBacktestArgs;

    let dateFilter = "";
    if (period === "week") {
      dateFilter = `AND timestamp >= datetime('now', '-7 days')`;
    } else if (period === "month") {
      dateFilter = `AND timestamp >= datetime('now', '-30 days')`;
    }

    const trades = db.prepare(
      `SELECT * FROM trade_performance WHERE result_pl IS NOT NULL ${dateFilter} ORDER BY timestamp ASC`
    ).all() as Array<{
      id: number;
      timestamp: string;
      asset: string;
      setup_detected: string;
      result_pl: number;
      error_made: string;
      dxy_correlation: string;
    }>;

    if (trades.length === 0) {
      return `📊 **Reporte de Backtesting (${period})**\n\nNo hay trades registrados con resultado P/L para el período seleccionado. Necesitas usar 'logTradePerformance' con el campo 'resultPl' al cerrar cada operación.`;
    }

    // ── Estadísticas Generales ───────────────────────────────────
    const total = trades.length;
    const winners = trades.filter(t => t.result_pl > 0);
    const losers = trades.filter(t => t.result_pl <= 0);
    const winRate = (winners.length / total * 100).toFixed(1);
    const avgWin = winners.length > 0 ? (winners.reduce((a, t) => a + t.result_pl, 0) / winners.length).toFixed(2) : "0";
    const avgLoss = losers.length > 0 ? Math.abs(losers.reduce((a, t) => a + t.result_pl, 0) / losers.length).toFixed(2) : "0";
    const totalPL = trades.reduce((a, t) => a + t.result_pl, 0).toFixed(2);
    const expectancy = ((parseFloat(winRate) / 100 * parseFloat(avgWin)) - ((1 - parseFloat(winRate) / 100) * parseFloat(avgLoss))).toFixed(2);

    // ── Análisis por Activo ─────────────────────────────────────
    const byAsset: Record<string, { wins: number; total: number; pl: number }> = {};
    for (const t of trades) {
      const asset = t.asset || "UNKNOWN";
      if (!byAsset[asset]) byAsset[asset] = { wins: 0, total: 0, pl: 0 };
      byAsset[asset].total++;
      byAsset[asset].pl += t.result_pl;
      if (t.result_pl > 0) byAsset[asset].wins++;
    }

    const assetSummary = Object.entries(byAsset)
      .map(([a, s]) => `  - **${a}:** WR ${(s.wins / s.total * 100).toFixed(0)}% | P/L Total: $${s.pl.toFixed(2)}`)
      .join("\n");

    // ── Análisis de Errores Frecuentes ──────────────────────────
    const errors = trades.filter(t => t.error_made && t.error_made !== "N/A").map(t => t.error_made);
    const errorCount: Record<string, number> = {};
    for (const e of errors) {
      errorCount[e] = (errorCount[e] || 0) + 1;
    }
    const topErrors = Object.entries(errorCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([e, c]) => `  - (${c}x) "${e}"`)
      .join("\n");

    // ── Sugerencias de Ajuste (Inteligencia) ────────────────────
    const suggestions: string[] = [];

    if (parseFloat(winRate) < 50) {
      suggestions.push("🔴 **Win Rate inferior al 50%**: Revisar criterios de entrada. El bot puede estar operando fuera de Killzones o sin ChoCh confirmado.");
    }

    if (parseFloat(avgLoss) > parseFloat(avgWin) * 1.5) {
      suggestions.push("🔴 **Pérdidas promedio superan ganancias x1.5**: Ajustar Take Profit a mínimo 1:2 RR o reducir el Stop Loss dinámico.");
    }

    const btcTrades = byAsset["BTCUSD"] || byAsset["BITCOIN"];
    if (btcTrades && btcTrades.wins / btcTrades.total < 0.5) {
      suggestions.push("⚠️ **BTCUSD con bajo rendimiento**: Activar filtro H1 FVG obligatorio y operar solo en sesiones Londres/NY.");
    }

    const gbpTrades = byAsset["GBPJPY"];
    if (gbpTrades && gbpTrades.wins / gbpTrades.total < 0.5) {
      suggestions.push("⚠️ **GBPJPY con bajo rendimiento**: Restringir operaciones exclusivamente a sesión de Londres (3-8 AM EST).");
    }

    if (suggestions.length === 0) {
      suggestions.push("✅ El sistema está operando dentro de parámetros saludables. Mantener SOP actual.");
    }

    const periodLabel = period === "week" ? "Última Semana" : period === "month" ? "Último Mes" : "Histórico Completo";

    return `
# 📊 Reporte de Backtesting Dinámico — ${periodLabel}

## Estadísticas Generales
| Métrica | Valor |
|---|---|
| **Total Trades** | ${total} |
| **Win Rate** | ${winRate}% |
| **Ganancia Promedio** | $${avgWin} |
| **Pérdida Promedio** | $${avgLoss} |
| **P/L Total** | $${totalPL} |
| **Expectancy por Trade** | $${expectancy} |

## Rendimiento por Activo
${assetSummary}

## Errores Más Frecuentes
${topErrors || "  - Ningún error registrado en este período."}

## 🧠 Sugerencias de Auto-Optimización
${suggestions.map(s => `- ${s}`).join("\n")}
    `.trim();
  }
};
