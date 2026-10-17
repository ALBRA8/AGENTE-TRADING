// TRADING STRATEGY ENGINE V1.0 — tipos (spec §2.2, docs/STRATEGY_ENGINE_V1.md)
export interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }
export type TF = 'H1' | 'M15' | 'M5' | 'M1';
export type Bias = 'bull' | 'bear' | 'range';
export type SState =
  | 'S0_SCAN' | 'S1_H1_OK' | 'S2_SWEEP_OK' | 'S3_POI_WAIT' | 'S4_IN_POI'
  | 'S5_CONFIRMED' | 'S6_TRIGGER_WAIT' | 'S7_ORDER_LIVE' | 'S8_MANAGED' | 'S9_CLOSED';

export interface SessionLevels {
  londonHigh: number | null; londonLow: number | null;
  asiaHigh: number | null; asiaLow: number | null;
  pdh: number | null; pdl: number | null;
}

export interface POI {
  kind: 'ORDER_BLOCK' | 'FVG' | 'BREAKER';
  top: number; bottom: number;
  originBarTime: number;          // D-8 vela caja
  m15BosTime: number;             // BOS válido que la generó
  liquidityTakenBeforeBos: boolean; // D-3b
}

export interface TriggerInfo {
  m1ChochTime: number;
  block: { top: number; bottom: number; kind: 'ORDER_BLOCK' | 'FVG' };
  retestLimitPrice: number;       // R10.1
}

export interface SLInfo { price: number; structuralRef: 'choch_extreme' | 'poi_edge' | 'be'; pips: number }
export interface TPInfo { price: number; liquidityRef: string; rr: number }

export interface OpenTradeContext {   // B11
  pillars: { h1: string; m15: string; m1: string };
  liquiditySweep: string;
  confirmation: string;
  tfsUsed: TF[];
  degraded: boolean;
}

export interface StrategySignal {
  id: string;
  symbol: string;
  direction: 'long' | 'short';
  state: SState;
  h1: { bias: Bias; lastBosTime: number | null };
  liquidity: {
    londonHigh: number | null; londonLow: number | null;
    swept: 'london_high' | 'london_low' | 'internal' | null; sweptAt: number | null;
  };
  poi: POI | null;
  confirmation: { m5ChochTime: number; brokenLevel: number } | null;
  trigger: TriggerInfo | null;
  entry: { type: 'LIMIT'; price: number; expiresAt: number } | null;
  sl: SLInfo | null;
  tp: TPInfo | null;
  risk: { riskPct: number };
  session: 'NY_KILLZONE' | 'LDN_KILLZONE';
  openTradeContext: OpenTradeContext;
  degraded: boolean;
  pipSize: number;
}

export interface StrategyConfig {
  symbol: string;
  pipSize: number;            // US30 = 1.0
  swingLookback: number;      // D-1 (2)
  liquidityWindow: number;    // D-3b (20)
  sweepMaxCandles: number;    // D-7 (3)
  poiMaxAgeBarsM15: number;   // B6/R15.4 (16 M15 = 4h)
  m5ConfirmMaxBars: number;   // R8.2 (12 M5 = 1h)
  m1TriggerMaxBars: number;   // R9.3 (15 M1)
  retestMaxBars: number;      // R10.3 (12 M1)
  retestFibPercent: number;   // R10.1 (0.5)
  maxSlPips: number;          // R12.3 (15 US30)
  slBufferTicks: number;      // R12.1 (2)
  minRR: number;              // R13.2 (2.0)
  breakevenMode: 'structural' | 'fixed_1r' | 'off';  // B14
  newsBlackoutBeforeMin: number; // B16.4 (15)
  newsBlackoutAfterMin: number;  // B16.4 (30)
  riskPct: number;            // 0.5 (instrucciones.txt §3)
}

// Máquina de estados §3
export interface Sequence {
  dir: 'long' | 'short';
  stage: SState;
  bias: Bias;
  lastBosTime: number | null;
  stageSince: number;         // time M1 de entrada al stage
  swept: 'london_high' | 'london_low' | 'internal' | null;
  sweptAt: number | null;
  poi: POI | null;
  extremeInPOI: number | null;  // R12.1 extremo del fallo estructural
  confirm: { m5ChochTime: number; brokenLevel: number } | null;
  trigger: TriggerInfo | null;
  order: { type: 'LIMIT'; price: number; expiresAt: number } | null;
  sl: SLInfo | null;
  tp: TPInfo | null;
  filledAt: number | null;
  beApplied: boolean;
  degraded: boolean;
}

export type EngineEventType =
  | 'GATE_BLOCK' | 'SWEEP' | 'POI_CREATED' | 'POI_ENTERED' | 'M5_CONFIRMED'
  | 'M1_TRIGGER' | 'ORDER_READY' | 'FILLED' | 'BE_SET' | 'TP_HIT' | 'SL_HIT'
  | 'EXPIRED' | 'INVALIDATED' | 'REJECTED_RR' | 'REJECTED_SL';

export interface EngineEvent { type: EngineEventType; time: number; detail: string }

export interface EngineInput {
  now: number;                 // cierre de vela M1 actual
  candlesH1: Candle[];
  candlesM15: Candle[];
  candlesM5: Candle[];
  candlesM1: Candle[];
  sessionLevels: SessionLevels;
  inKillzone: boolean;         // NY 08:00-12:00 ET (o Londres si activo)
  newsBlackout: boolean;       // B16.4
  riskBlocked: string | null;  // kill-switches existentes (B16.5)
  h1ExtremeHigh?: number | null;  // extremo estructural H1 para TP (B13.1)
  h1ExtremeLow?: number | null;
}

export interface EngineState { symbol: string; seq: Sequence | null; events: EngineEvent[]; lastSignal: StrategySignal | null }

export interface EngineOutput { state: EngineState; signal: StrategySignal | null; closed: StrategySignal | null }
