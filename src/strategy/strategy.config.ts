// Defaults V1 — tabla §2.3 de docs/STRATEGY_ENGINE_V1.md
import type { StrategyConfig } from './types.js';

export const DEFAULT_STRATEGY_CONFIG: StrategyConfig = {
  symbol: 'US30',
  pipSize: 1.0,               // US30: 1 pip = 1 punto (instrucciones.txt §3)
  swingLookback: 2,           // D-1
  liquidityWindow: 20,        // D-3b
  sweepMaxCandles: 3,         // D-7
  poiMaxAgeBarsM15: 16,       // R15.4: 16 velas M15 = 4h
  m5ConfirmMaxBars: 12,       // R8.2: 12 M5 = 1h
  m1TriggerMaxBars: 15,       // R9.3
  retestMaxBars: 12,          // R10.3
  retestFibPercent: 0.5,      // R10.1
  maxSlPips: 15,              // R12.3 US30
  slBufferTicks: 2,           // R12.1
  minRR: 2.0,                 // R13.2
  breakevenMode: 'structural',// B14 (R14.1)
  newsBlackoutBeforeMin: 15,  // B16.4
  newsBlackoutAfterMin: 30,
  riskPct: 0.5,               // instrucciones.txt §3
};
