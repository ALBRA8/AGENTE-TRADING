// ============================================================
// src/backtest/report_generator.ts
// Generador de reportes HTML profesionales
// ============================================================

import { BacktestResult, Trade, EquityPoint, PerformanceMetrics } from "./types.js";
import path from "path";
import fs from "fs";

export interface ReportOptions {
  outputDir: string;
  includeTrades: boolean;
  includeMonteCarlo: boolean;
  theme?: "dark" | "light";
}

/** Genera un reporte HTML completo del backtest */
export function generateHTMLReport(
  result: BacktestResult,
  options: ReportOptions
): string {
  const fileName = `backtest_${result.config.asset}_${formatDate(result.timeExecuted)}.html`;
  const outputPath = path.join(options.outputDir, fileName);

  // Asegurar directorio
  if (!fs.existsSync(options.outputDir)) {
    fs.mkdirSync(options.outputDir, { recursive: true });
  }

  const html = generateHTMLContent(result, options);
  fs.writeFileSync(outputPath, html, "utf-8");

  return outputPath;
}

function generateHTMLContent(result: BacktestResult, options: ReportOptions): string {
  const { config, metrics, trades, monteCarlo } = result;

  const theme = options.theme === "light" ? getLightTheme() : getDarkTheme();

  let tradesHTML = "";
  if (options.includeTrades) {
    tradesHTML = generateTradesTable(trades);
  }

  let monteCarloHTML = "";
  if (options.includeMonteCarlo && monteCarlo) {
    monteCarloHTML = generateMonteCarloSection(monteCarlo);
  }

  const setupChart = generateSetupChart(metrics);
  const hourChart = generateHourChart(metrics);

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Backtest Report - ${config.asset}</title>
  <style>${theme.styles}</style>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
</head>
<body>
  <div class="container">
    <header>
      <h1>📊 Backtest Report</h1>
      <h2>${config.asset} | ${config.timeframe} | ${formatDateRange(result)}</h2>
      <p class="timestamp">Generado: ${result.timeExecuted.toLocaleString("es-ES")}</p>
    </header>

    <div class="metrics-grid">
      <div class="metric-card highlight">
        <h3>Retorno Total</h3>
        <div class="value" style="color: ${getColor(metrics.totalReturn)}">${metrics.totalReturn.toFixed(2)}%</div>
        <span class="label">$${metrics.totalProfit.toFixed(2)}</span>
      </div>

      <div class="metric-card">
        <h3>Win Rate</h3>
        <div class="value" style="color: ${getColor(metrics.winRate - 50)}">${metrics.winRate.toFixed(1)}%</div>
        <span class="label">${metrics.totalTrades} trades</span>
      </div>

      <div class="metric-card dim">
        <h3>Max Drawdown</h3>
        <div class="value" style="color: #ff4757">-${metrics.maxDrawdown.toFixed(2)}%</div>
        <span class="label">$${metrics.maxDrawdownAmount.toFixed(2)}</span>
      </div>

      <div class="metric-card">
        <h3>Profit Factor</h3>
        <div class="value" style="color: ${metrics.profitFactor > 1.5 ? "#2ed573" : "#ffa502"}">${metrics.profitFactor.toFixed(2)}</div>
        <span class="label">${getPFVerdict(metrics.profitFactor)}</span>
      </div>
    </div>

    <div class="metrics-grid">
      <div class="metric-card">
        <h3>Sharpe Ratio</h3>
        <div class="value">
          ${metrics.sharpeRatio.toFixed(2)}
          ${getSharpeIcon(metrics.sharpeRatio)}
        </div>
      </div>

      <div class="metric-card">
        <h3>Sortino Ratio</h3>
        <div class="value">
          ${metrics.sortinoRatio.toFixed(2)}
        </div>
        <span class="label">Calidad del retorno</span>
      </div>

      <div class="metric-card">
        <h3>Calmar Ratio</h3>
        <div class="value">
          ${metrics.calmarRatio.toFixed(2)}
        </div>
        <span class="label">Retorno/DD máx</span>
      </div>

      <div class="metric-card">
        <h3>SQN</h3>
        <div class="value">
          ${metrics.sqn.toFixed(2)}
          ${getSQNVerdict(metrics.sqn)}
        </div>
      </div>
    </div>

    <section class="equity-section">
      <h2>📈 Curva de Equity</h2>
      <div class="chart-container">
        <canvas id="equityChart"></canvas>
      </div>
    </section>

    <section class="setup-analysis">
      <div class="chart-grid">
        <div class="chart-card">
          <h3>Rendimiento por Setup</h3>
          <canvas id="setupChart"></canvas>
        </div>
        <div class="chart-card">
          <h3>Win Rate por Hora (EST)</h3>
          <canvas id="hourChart"></canvas>
        </div>
      </div>
    </section>

    <section class="metrics-detail">
      <h2>📋 Métricas Detalladas</h2>

      <div class="detail-grid">
        <div class="detail-card">
          <h4>Estadísticas de Trades</h4>
          <table>
            <tr><td>Total Trades</td><td class="value">${metrics.totalTrades}</td></tr>
            <tr><td>Ganadores</td><td class="value green">${(metrics.totalTrades * metrics.winRate / 100).toFixed(0)}</td></tr>
            <tr><td>Perdedores</td><td class="value red">${(metrics.totalTrades * metrics.lossRate / 100).toFixed(0)}</td></tr>
            <tr><td>Win/Loss Ratio</td><td class="value">${metrics.winLossRatio.toFixed(2)}</td></tr>
            <tr><td>Consec. Max Ganadas</td><td class="value green">${metrics.maxConsecutiveWins}</td></tr>
            <tr><td>Consec. Max Perdidas</td><td class="value red">${metrics.maxConsecutiveLosses}</td></tr>
          </table>
        </div>

        <div class="detail-card">
          <h4>Tamaño de Trades</h4>
          <table>
            <tr><td>Mayor Ganancia</td><td class="value green">$${metrics.largestWin.toFixed(2)}</td></tr>
            <tr><td>Mayor Pérdida</td><td class="value red">$${metrics.largestLoss.toFixed(2)}</td></tr>
            <tr><td>Prom. Ganancia</td><td class="value green">$${metrics.avgWin.toFixed(2)}</td></tr>
            <tr><td>Prom. Pérdida</td><td class="value red">$${metrics.avgLoss.toFixed(2)}</td></tr>
            <tr><td>Expectancy</td><td class="value">$${metrics.avgTrade.toFixed(2)}</td></tr>
            <tr><td>Expectancy (R)</td><td class="value">${metrics.expectancy.toFixed(2)}R</td></tr>
          </table>
        </div>

        <div class="detail-card">
          <h4>Duración</h4>
          <table>
            <tr><td>Duración Media</td><td class="value">${formatDuration(metrics.avgTradeDuration)}</td></tr>
            <tr><td>Dur. Ganadores</td><td class="value">${formatDuration(metrics.avgWinDuration)}</td></tr>
            <tr><td>Dur. Perdedores</td><td class="value">${formatDuration(metrics.avgLossDuration)}</td></tr>
            <tr><td>Recovery Factor</td><td class="value">${metrics.recoveryFactor.toFixed(2)}</td></tr>
            <tr><td>Tiempo Underwater</td><td class="value">${metrics.underwaterPercentage.toFixed(1)}%</td></tr>
          </table>
        </div>

        <div class="detail-card">
          <h4>Benchmarks</h4>
          <table>
            <tr><td>Buy & Hold</td><td class="value">${result.benchmarks.buyHold.toFixed(2)}%</td></tr>
            <tr><td>B&H Drawdown</td><td class="value red">${result.benchmarks.buyHoldDrawdown.toFixed(2)}%</td></tr>
            <tr><td>Alpha sobre B&H</td><td class="value ${result.metrics.totalReturn > result.benchmarks.buyHold ? 'green' : 'red'}">${(result.metrics.totalReturn - result.benchmarks.buyHold).toFixed(2)}%</td></tr>
            <tr><td>CAGR Anualizado</td><td class="value">${metrics.annualizedReturn.toFixed(2)}%</td></tr>
          </table>
        </div>
      </div>
    </section>

    ${monteCarloHTML}

    ${tradesHTML}

    <footer>
      <p>Reporte generado por Trading Agent Backtest Engine</p>
      <p>SMC Smart Money Concepts | Data-driven trading</p>
    </footer>
  </div>

  <script>
    // Equity Chart
    const equityCtx = document.getElementById('equityChart').getContext('2d');
    new Chart(equityCtx, {
      type: 'line',
      data: {
        labels: ${JSON.stringify(result.equityCurve.map(e => e.time.toLocaleDateString()).filter((v, i, a) => i % 10 === 0))},
        datasets: [{
          label: 'Equity',
          data: ${JSON.stringify(result.equityCurve.filter((e, i) => i % 10 === 0).map(e => e.equity.toFixed(2)))},
          borderColor: '#00f5ff',
          backgroundColor: 'rgba(0, 245, 255, 0.1)',
          fill: true,
          tension: 0.1
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: false } }
      }
    });

    // Setup Chart
    ${setupChart}

    // Hour Chart
    ${hourChart}
  </script>
</body>
</html>`;
}

function generateMonteCarloSection(monteCarlo: any): string {
  return `
  <section class="monte-carlo">
    <h2>🎲 Análisis Monte Carlo (${monteCarlo.iterations.toLocaleString()} simulaciones)</h2>

    <div class="mc-grid">
      <div class="mc-card">
        <h4>Distribución Final Equity</h4>
        <div class="mc-values">
          <div><span>Mediana:</span> <strong>$${monteCarlo.finalEquity.median.toFixed(0)}</strong></div>
          <div><span>Media:</span> $${monteCarlo.finalEquity.mean.toFixed(0)}</div>
          <div><span>Peor caso:</span> <span class="red">$${monteCarlo.finalEquity.worst.toFixed(0)}</span></div>
          <div><span>Mejor:</span> <span class="green">$${monteCarlo.finalEquity.best.toFixed(0)}</span></div>
          <div><span>P95:</span> <strong class="green">$${monteCarlo.finalEquity.percentiles['95'].toFixed(0)}</strong></div>
        </div>
      </div>

      <div class="mc-card">
        <h4>Riesgo de Ruina</h4>
        <div class="mc-values">
          <div><span>Risk of Ruin:</span> <strong class="${monteCarlo.riskOfRuin < 5 ? 'green' : monteCarlo.riskOfRuin < 15 ? 'yellow' : 'red'}">${monteCarlo.riskOfRuin.toFixed(1)}%</strong></div>
          <div><span>Prob. de Profit:</span> <strong class="green">${monteCarlo.probabilityOfProfit.toFixed(1)}%</strong></div>
          <div><span>DD Esperado:</span> ${monteCarlo.drawdown.mean.toFixed(1)}%</div>
          <div><span>Peor DD:</span> <span class="red">-${monteCarlo.drawdown.worst.toFixed(1)}%</span></div>
        </div>
      </div>
    </div>
  </section>`;
}

function generateTradesTable(trades: Trade[]): string {
  if (trades.length === 0) return "";

  const rows = trades.slice(0, 50).map((t) => `
    <tr class="${t.profit > 0 ? 'win' : 'loss'}">
      <td>${t.entry.time.toLocaleDateString()} ${t.entry.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
      <td><span class="badge ${t.direction.toLowerCase()}">${t.direction}</span></td>
      <td>${t.setupType}</td>
      <td>$${t.entryPrice.toFixed(2)}</td>
      <td>$${t.exit.price.toFixed(2)}</td>
      <td class="${t.profit > 0 ? 'green' : 'red'}">$${t.profit.toFixed(2)}</td>
      <td>${t.profitPips.toFixed(1)}</td>
      <td><span class="badge ${t.exit.reason.toLowerCase()}">${t.exit.reason}</span></td>
    </tr>
  `).join("");

  return `
  <section class="trades-section">
    <h2>💰 Trades (${Math.min(trades.length, 50)} mostrados)</h2>
    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Dir</th>
            <th>Setup</th>
            <th>Entry</th>
            <th>Exit</th>
            <th>P/L</th>
            <th>Pips</th>
            <th>Razón</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>`;
}

function generateSetupChart(metrics: PerformanceMetrics): string {
  const setups = Object.entries(metrics.metricsBySetup);
  if (setups.length === 0) return "";

  return `
    const setupCtx = document.getElementById('setupChart').getContext('2d');
    new Chart(setupCtx, {
      type: 'bar',
      data: {
        labels: ${JSON.stringify(setups.map(([k]) => k))},
        datasets: [{
          label: 'Win Rate %',
          data: ${JSON.stringify(setups.map(([_, v]) => v.winRate))},
          backgroundColor: ${JSON.stringify(setups.map(([_, v]) => v.winRate > 50 ? '#2ed573' : '#ff4757'))}
        }]
      },
      options: {
        responsive: true,
        scales: { y: { beginAtZero: true, max: 100 } }
      }
    });
  `;
}

function generateHourChart(metrics: PerformanceMetrics): string {
  const hours = Object.values(metrics.metricsByHour).sort((a, b) => a.hour - b.hour);
  if (hours.length === 0) return "";

  return `
    const hourCtx = document.getElementById('hourChart').getContext('2d');
    new Chart(hourCtx, {
      type: 'bar',
      data: {
        labels: ${JSON.stringify(hours.map(h => `${h.hour}:00`))},
        datasets: [
          {
            label: 'Win Rate %',
            data: ${JSON.stringify(hours.map(h => h.winRate))},
            backgroundColor: 'rgba(0, 245, 255, 0.7)'
          },
          {
            label: '# Trades',
            data: ${JSON.stringify(hours.map(h => h.count))},
            backgroundColor: 'rgba(255, 0, 160, 0.5)',
            yAxisID: 'y1'
          }
        ]
      },
      options: {
        responsive: true,
        scales: {
          y: { beginAtZero: true, max: 100, position: 'left' },
          y1: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false } }
        }
      }
    });
  `;
}

function getDarkTheme() {
  return {
    styles: `
      :root {
        --bg-primary: #0f172a;
        --bg-secondary: #1e293b;
        --text-primary: #e2e8f0;
        --text-secondary: #94a3b8;
        --accent-cyan: #00f5ff;
        --accent-magenta: #ff00a0;
        --accent-green: #2ed573;
        --accent-red: #ff4757;
        --border: #334155;
      }
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        background: var(--bg-primary);
        color: var(--text-primary);
        line-height: 1.6;
      }
      .container { max-width: 1400px; margin: 0 auto; padding: 1rem; }
      header { text-align: center; padding: 2rem 0; border-bottom: 1px solid var(--border); margin-bottom: 2rem; }
      h1 { font-size: 2rem; color: var(--accent-cyan); margin-bottom: 0.5rem; }
      h2 { font-size: 1.2rem; color: var(--text-secondary); font-weight: 400; }
      .timestamp { color: var(--text-secondary); margin-top: 0.5rem; }
      .metrics-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        gap: 1rem;
        margin-bottom: 1.5rem;
      }
      .metric-card {
        background: var(--bg-secondary);
        padding: 1.5rem;
        border-radius: 12px;
        border: 1px solid var(--border);
        text-align: center;
        transition: transform 0.2s;
      }
      .metric-card:hover { transform: translateY(-2px); border-color: var(--accent-cyan); }
      .metric-card.highlight { border-color: var(--accent-cyan); box-shadow: 0 0 20px rgba(0, 245, 255, 0.1); }
      .metric-card h3 { font-size: 0.8rem; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 0.5rem; }
      .metric-card .value { font-size: 1.8rem; font-weight: 700; }
      .metric-card .label { font-size: 0.8rem; color: var(--text-secondary); display: block; margin-top: 0.3rem; }
      .chart-container { background: var(--bg-secondary); padding: 1.5rem; border-radius: 12px; margin: 1.5rem 0; }
      .chart-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
      .chart-card { background: var(--bg-secondary); padding: 1.5rem; border-radius: 12px; }
      .chart-card h3 { margin-bottom: 1rem; color: var(--accent-cyan); }
      section { margin: 2rem 0; }
      section h2 { color: var(--accent-cyan); margin-bottom: 1.5rem; padding-bottom: 0.5rem; border-bottom: 1px solid var(--border); }
      .detail-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1.5rem; }
      .detail-card { background: var(--bg-secondary); padding: 1.5rem; border-radius: 12px; }
      .detail-card h4 { color: var(--accent-magenta); margin-bottom: 1rem; }
      table { width: 100%; border-collapse: collapse; }
      table tr { border-bottom: 1px solid var(--border); }
      table tr:last-child { border-bottom: none; }
      table td { padding: 0.75rem 0; }
      table td:first-child { color: var(--text-secondary); }
      table .value { font-weight: 600; text-align: right; }
      .green { color: var(--accent-green); }
      .red { color: var(--accent-red); }
      .yellow { color: #ffa502; }
      .badge { display: inline-block; padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.7rem; font-weight: 600; text-transform: uppercase; }
      .badge.long { background: rgba(46, 213, 115, 0.2); color: var(--accent-green); }
      .badge.short { background: rgba(255, 71, 87, 0.2); color: var(--accent-red); }
      .badge.tp_hit { background: rgba(46, 213, 115, 0.2); color: var(--accent-green); }
      .badge.sl_hit { background: rgba(255, 71, 87, 0.2); color: var(--accent-red); }
      .table-container { overflow-x: auto; }
      .trades-section table { font-size: 0.9rem; }
      .trades-section th { text-align: left; padding: 0.75rem; background: rgba(0, 245, 255, 0.1); color: var(--accent-cyan); }
      .trades-section td { padding: 0.75rem; }
      .trades-section tr.win { background: rgba(46, 213, 115, 0.05); }
      .trades-section tr.loss { background: rgba(255, 71, 87, 0.05); }
      .monte-carlo { background: var(--bg-secondary); padding: 1.5rem; border-radius: 12px; border-left: 4px solid var(--accent-magenta); }
      .mc-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 2rem; margin-top: 1rem; }
      .mc-card h4 { color: var(--accent-magenta); margin-bottom: 1rem; }
      .mc-values div { display: flex; justify-content: space-between; padding: 0.5rem 0; border-bottom: 1px solid var(--border); }
      .mc-values div:last-child { border-bottom: none; }
      .mc-values span { color: var(--text-secondary); }
      footer { text-align: center; padding: 2rem; color: var(--text-secondary); border-top: 1px solid var(--border); margin-top: 2rem; }
      @media (max-width: 768px) {
        .chart-grid { grid-template-columns: 1fr; }
        .mc-grid { grid-template-columns: 1fr; }
        .metrics-grid { grid-template-columns: repeat(2, 1fr); }
      }
    `,
  };
}

function getLightTheme() {
  return {
    styles: getDarkTheme().styles
      .replace("--bg-primary: #0f172a", "--bg-primary: #f8fafc")
      .replace("--bg-secondary: #1e293b", "--bg-secondary: #ffffff")
      .replace("--text-primary: #e2e8f0", "--text-primary: #1e293b")
      .replace("--text-secondary: #94a3b8", "--text-secondary: #64748b")
      .replace("--border: #334155", "--border: #e2e8f0"),
  };
}

function getColor(value: number): string {
  if (value > 5) return "#2ed573";
  if (value > 0) return "#ffa502";
  return "#ff4757";
}

function getSharpeIcon(sharpe: number): string {
  if (sharpe > 1.5) return "✅";
  if (sharpe > 1) return "⚡";
  if (sharpe > 0.5) return "⚠️";
  return "❌";
}

function getSQNVerdict(sqn: number): string {
  if (sqn > 2.5) return "🟢 Excelente";
  if (sqn > 1.6) return "🟡 Bueno";
  if (sqn > 0.9) return "🟠 Promedio";
  if (sqn > 0) return "🔴 Débil";
  return "🔴 Inaceptable";
}

function getPFVerdict(pf: number): string {
  if (pf > 2) return "Sobresaliente";
  if (pf > 1.5) return "Sostenible";
  if (pf > 1) return "Frágil";
  return "Insostenible";
}

function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = Math.floor(minutes % 60);
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function formatDate(date: Date): string {
  return date.toISOString().split("T")[0];
}

function formatDateRange(result: BacktestResult): string {
  const start = result.config.startDate.toLocaleDateString("es-ES");
  const end = result.config.endDate.toLocaleDateString("es-ES");
  return `${start} → ${end}`;
}
