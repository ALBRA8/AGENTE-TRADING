// STRATEGY ENGINE V1.0 — máquina de estados S0-S9 (spec §3) — función PURA, sin I/O
// Evaluada al cierre de vela M1 (no-repaint: solo velas cerradas llegan como input)
import type {
  EngineEvent, EngineInput, EngineOutput, EngineState, EngineEventType,
  Sequence, SessionLevels, StrategyConfig, StrategySignal, Candle,
} from './types.js';
import { computeH1Bias, detectBodyBreaks } from './h1-context.js';
import { computeInternalLiquidity, detectSweep, externalLevels } from './session-liquidity.js';
import { detectValidBOS, buildPOI, isPOIValid, hasReturnedToPOI, isInvalidatedBeyondPOI } from './poi-validator.js';
import { confirmM5 } from './m5-confirmation.js';
import { triggerM1, retestTouched } from './m1-trigger.js';
import { DEFAULT_STRATEGY_CONFIG } from './strategy.config.js';

const MIN = 60_000;

export function createEngineState(symbol: string): EngineState {
  return { symbol, seq: null, events: [], lastSignal: null };
}

function emit(st: EngineState, type: EngineEventType, time: number, detail: string): void {
  st.events.push({ type, time, detail });
}

function againstBreak(candles: Candle[], dir: 'long' | 'short', afterTime: number, L: number): boolean {
  // R15.2/R15.3: ruptura en contra (BOS/CHOCH contrario a la dirección del trade)
  const want = dir === 'long' ? 'bear' : 'bull';
  return detectBodyBreaks(candles, L).some(b => b.dir === want && b.time > afterTime);
}

function buildSignal(seq: Sequence, symbol: string, cfg: StrategyConfig, now: number): StrategySignal {
  return {
    id: `AGT-SE1-${symbol}-${seq.order ? seq.order.expiresAt : seq.stageSince}`,
    symbol,
    direction: seq.dir,
    state: seq.stage,
    h1: { bias: seq.bias, lastBosTime: seq.lastBosTime },
    liquidity: { londonHigh: null, londonLow: null, swept: seq.swept, sweptAt: seq.sweptAt },
    poi: seq.poi,
    confirmation: seq.confirm,
    trigger: seq.trigger,
    entry: seq.order,
    sl: seq.sl,
    tp: seq.tp,
    risk: { riskPct: cfg.riskPct },
    session: 'NY_KILLZONE',
    openTradeContext: {   // B11 — checklist OpenTrade de los videos
      pillars: {
        h1: `sesgo ${seq.bias} (BOS H1)`,
        m15: seq.poi ? `POI ${seq.poi.kind} [${seq.poi.bottom}-${seq.poi.top}] originada en BOS válido${seq.poi.liquidityTakenBeforeBos ? ' con liquidez previa' : ''}` : 'sin POI',
        m1: seq.trigger ? `CHOCH M1 ${seq.dir} + retest del ${seq.trigger.block.kind}` : (seq.confirm ? 'CHOCH M5 confirmado' : 'esperando confirmación'),
      },
      liquiditySweep: `${seq.swept === 'london_low' ? 'sweep del Low de Londres' : seq.swept === 'london_high' ? 'sweep del High de Londres' : 'sweep de liquidez interna'} @ ${seq.sweptAt ?? '-'}`,
      confirmation: seq.confirm ? `CHOCH M5 @ ${seq.confirm.m5ChochTime} rompió ${seq.confirm.brokenLevel}` : 'pendiente',
      tfsUsed: seq.degraded ? ['H1', 'M15', 'M5'] : ['H1', 'M15', 'M5', 'M1'],
      degraded: seq.degraded,
    },
    degraded: seq.degraded,
    pipSize: cfg.pipSize,
  };
}

function resetSeq(st: EngineState, seq: Sequence, reason: string, now: number, cfg: StrategyConfig): void {
  emit(st, 'INVALIDATED', now, `${seq.dir} ${seq.stage}: ${reason}`);
  st.seq = null;
}

export function evaluate(prev: EngineState, input: EngineInput, cfg: StrategyConfig = DEFAULT_STRATEGY_CONFIG): EngineOutput {
  const st: EngineState = { ...prev, events: [], lastSignal: prev.lastSignal };
  const now = input.now;
  let closed: StrategySignal | null = null;
  const h1 = computeH1Bias(input.candlesH1, cfg);

  // ================== secuencia activa ==================
  if (st.seq) {
    const seq = st.seq;
    // gates permanentes pre-fill (R15.6, R16.1)
    if (seq.stage !== 'S8_MANAGED' && seq.stage !== 'S9_CLOSED') {
      if (input.newsBlackout) { resetSeq(st, seq, 'blackout de noticias (R15.6)', now, cfg); return { state: st, signal: null, closed }; }
      if (!input.inKillzone) { resetSeq(st, seq, 'killzone terminada (R16.1)', now, cfg); return { state: st, signal: null, closed }; }
    }
    switch (seq.stage) {
      case 'S2_SWEEP_OK': {   // esperar BOS válido M15 (B2/R2.2)
        const bos = detectValidBOS(input.candlesM15, cfg, seq.bias);
        if (bos && bos.time > seq.stageSince) {
          if (!bos.liquidityTaken) { resetSeq(st, seq, 'BOS sin toma de liquidez previa (D-3b/R3.3)', now, cfg); break; }
          const poi = buildPOI(input.candlesM15, bos);
          if (!poi || !isPOIValid(poi, input.candlesM15, now, cfg)) { resetSeq(st, seq, 'POI inválida/expirada (R6.4)', now, cfg); break; }
          seq.poi = poi; seq.stage = 'S3_POI_WAIT'; seq.stageSince = now;
          emit(st, 'POI_CREATED', now, `${poi.kind} [${poi.bottom}-${poi.top}]`);
        }
        break;
      }
      case 'S3_POI_WAIT': {   // B7: retorno a la caja
        if (seq.poi && isInvalidatedBeyondPOI(input.candlesM15, seq.poi, seq.dir, seq.stageSince)) { resetSeq(st, seq, 'cierre más allá de la POI (R15.1)', now, cfg); break; }
        if (againstBreak(input.candlesM15, seq.dir, seq.stageSince, cfg.swingLookback)) { resetSeq(st, seq, 'BOS/CHOCH M15 en contra (R15.2)', now, cfg); break; }
        if (seq.poi && now - seq.poi.originBarTime > cfg.poiMaxAgeBarsM15 * 15 * MIN) { resetSeq(st, seq, 'POI expirada (R15.4)', now, cfg); break; }
        const ret = seq.poi ? hasReturnedToPOI(input.candlesM1.concat(input.candlesM5, input.candlesM15), seq.poi, seq.stageSince) : null;
        if (ret) {
          seq.stage = 'S4_IN_POI'; seq.stageSince = now;
          seq.extremeInPOI = seq.dir === 'long' ? ret.low : ret.high; // R8.3 empieza a trackearse
          emit(st, 'POI_ENTERED', now, `retorno a la caja @ ${ret.time}`);
        }
        break;
      }
      case 'S4_IN_POI': {   // B8: CHOCH M5 a favor
        if (seq.poi && isInvalidatedBeyondPOI(input.candlesM1, seq.poi, seq.dir, seq.stageSince)) { resetSeq(st, seq, 'cierre más allá de la POI (R15.1)', now, cfg); break; }
        if (againstBreak(input.candlesM5, seq.dir, seq.stageSince, cfg.swingLookback)) { resetSeq(st, seq, 'CHOCH M5 en contra (R15.3)', now, cfg); break; }
        // extremo del fallo estructural (R12.1): mínimo/máximo absoluto dentro de la caja
        for (const c of input.candlesM1) {
          if (c.time <= seq.stageSince) continue;
          if (seq.dir === 'long') seq.extremeInPOI = seq.extremeInPOI === null ? c.low : Math.min(seq.extremeInPOI, c.low);
          else seq.extremeInPOI = seq.extremeInPOI === null ? c.high : Math.max(seq.extremeInPOI, c.high);
        }
        const m5From = input.candlesM5.findIndex(c => c.time > seq.stageSince);
        const conf = seq.poi ? confirmM5(input.candlesM5, seq.dir, seq.poi, seq.stageSince, cfg, Math.max(0, m5From)) : null;
        if (conf) { seq.confirm = conf; seq.stage = 'S5_CONFIRMED'; seq.stageSince = now; emit(st, 'M5_CONFIRMED', now, `CHOCH M5 rompió ${conf.brokenLevel}`); break; }
        if (now - seq.stageSince > cfg.m5ConfirmMaxBars * 5 * MIN) { resetSeq(st, seq, 'timeout confirmación M5 (R8.2/R15.4)', now, cfg); }
        break;
      }
      case 'S5_CONFIRMED': {   // B9: CHOCH M1 (trigger)
        if (againstBreak(input.candlesM1, seq.dir, seq.stageSince, cfg.swingLookback)) { resetSeq(st, seq, 'CHOCH M1 en contra (R15.3)', now, cfg); break; }
        const tr = triggerM1(input.candlesM1, seq.dir, seq.confirm!.m5ChochTime, cfg);
        if (tr) {
          seq.trigger = tr; seq.stage = 'S6_TRIGGER_WAIT'; seq.stageSince = now;
          emit(st, 'M1_TRIGGER', now, `CHOCH M1 rompió bloque ${tr.block.kind} [${tr.block.bottom}-${tr.block.top}]`);
          break;
        }
        if (now - seq.confirm!.m5ChochTime > cfg.m1TriggerMaxBars * MIN) { resetSeq(st, seq, 'timeout trigger M1 (R9.3)', now, cfg); }
        break;
      }
      case 'S6_TRIGGER_WAIT': {   // B12/B13: fabricar SL/TP y decidir si el setup es aceptable
        const entry = seq.trigger!.retestLimitPrice;
        const pip = cfg.pipSize;
        const ext = seq.extremeInPOI ?? (seq.dir === 'long' ? seq.poi!.bottom : seq.poi!.top);
        const slA = seq.dir === 'long' ? ext - cfg.slBufferTicks * pip : ext + cfg.slBufferTicks * pip;         // R12.1 choch_extreme
        const slB = seq.dir === 'long' ? seq.poi!.bottom - cfg.slBufferTicks * pip : seq.poi!.top + cfg.slBufferTicks * pip; // R12.2 poi_edge
        let slPrice = Math.max(slA, slB);   // el más cercano al precio (más conservador en riesgo)
        if (seq.dir === 'long' && slPrice >= entry) slPrice = Math.min(slA, slB);
        if (seq.dir === 'short' && slPrice <= entry) slPrice = Math.max(slA, slB);
        const slPips = Math.abs(entry - slPrice) / pip;
        if (slPips > cfg.maxSlPips) { emit(st, 'REJECTED_SL', now, `SL ${slPips.toFixed(1)} > ${cfg.maxSlPips} pips (R12.3)`); resetSeq(st, seq, 'SL excede tope por activo (R12.3)', now, cfg); break; }
        const cands = externalLevels(input.sessionLevels, input.h1ExtremeHigh ?? null, input.h1ExtremeLow ?? null)
          .filter(l => seq.dir === 'long' ? l.price > entry : l.price < entry)
          .sort((a, b) => seq.dir === 'long' ? a.price - b.price : b.price - a.price);   // R13.1: el más cercano en dirección
        if (cands.length === 0) { resetSeq(st, seq, 'sin liquidez externa para TP (R13.1)', now, cfg); break; }
        const tp = cands[0];
        const rr = Math.abs(tp.price - entry) / Math.abs(entry - slPrice);
        if (rr < cfg.minRR) { emit(st, 'REJECTED_RR', now, `RR ${rr.toFixed(2)} < ${cfg.minRR} (R13.2)`); resetSeq(st, seq, 'RR insuficiente (R13.2)', now, cfg); break; }
        seq.sl = { price: slPrice, structuralRef: slPrice === slA ? 'choch_extreme' : 'poi_edge', pips: slPips };
        seq.tp = { price: tp.price, liquidityRef: tp.ref, rr };
        seq.order = { type: 'LIMIT', price: entry, expiresAt: now + cfg.retestMaxBars * MIN };
        seq.stage = 'S7_ORDER_LIVE'; seq.stageSince = now;
        st.lastSignal = buildSignal(seq, st.symbol, cfg, now);
        emit(st, 'ORDER_READY', now, `LIMIT ${entry} SL ${slPrice} TP ${tp.price} RR ${rr.toFixed(2)}`);
        break;
      }
      case 'S7_ORDER_LIVE': {   // B10: retest del bloque trigger
        if (now > seq.order!.expiresAt) { resetSeq(st, seq, 'orden expiró sin retest (R10.3)', now, cfg); break; }
        if (seq.poi && isInvalidatedBeyondPOI(input.candlesM1, seq.poi, seq.dir, seq.stageSince)) { resetSeq(st, seq, 'invalidada antes del fill (R15.1)', now, cfg); break; }
        const touch = retestTouched(input.candlesM1, seq.order!.price, seq.dir, seq.stageSince);
        if (touch) {
          seq.filledAt = touch.time; seq.stage = 'S8_MANAGED'; seq.stageSince = touch.time;
          emit(st, 'FILLED', touch.time, `fill LIMIT ${seq.order!.price}`);
          st.lastSignal = buildSignal(seq, st.symbol, cfg, touch.time);
        }
        break;
      }
      case 'S8_MANAGED': {   // B14: gestión — SL/TP conservador (R17.3) + BE estructural (R14.1)
        const last = input.candlesM1[input.candlesM1.length - 1];
        if (last && last.time > seq.stageSince) {
          const hitSL = seq.dir === 'long' ? last.low <= seq.sl!.price : last.high >= seq.sl!.price;
          const hitTP = seq.dir === 'long' ? last.high >= seq.tp!.price : last.low <= seq.tp!.price;
          if (hitSL) {   // R17.3: ambigüedad ⇒ SL primero
            emit(st, 'SL_HIT', last.time, `SL ${seq.sl!.price}`); seq.stage = 'S9_CLOSED';
            closed = buildSignal(seq, st.symbol, cfg, last.time); st.lastSignal = closed;
            st.seq = null; break;
          }
          if (hitTP) {
            emit(st, 'TP_HIT', last.time, `TP ${seq.tp!.price} (${seq.tp!.liquidityRef})`); seq.stage = 'S9_CLOSED';
            closed = buildSignal(seq, st.symbol, cfg, last.time); st.lastSignal = closed;
            st.seq = null; break;
          }
        }
        if (!seq.beApplied && cfg.breakevenMode === 'structural') {
          const want = seq.dir === 'long' ? 'bull' : 'bear';
          const m5Breaks = detectBodyBreaks(input.candlesM5, cfg.swingLookback);
          if (m5Breaks.some(b => b.dir === want && b.time > seq.filledAt!)) {   // R14.1: BOS M5 a favor ⇒ BE
            seq.sl = { price: seq.order!.price, structuralRef: 'be', pips: 0 };
            seq.beApplied = true; emit(st, 'BE_SET', now, `BE estructural @ ${seq.order!.price}`);
            st.lastSignal = buildSignal(seq, st.symbol, cfg, now);
          }
        }
        break;
      }
      default: break;
    }
    return { state: st, signal: st.lastSignal !== prev.lastSignal ? st.lastSignal : null, closed };
  }

  // ================== S0: gates B16 + sweep (B5) ==================
  if (!input.inKillzone) { emit(st, 'GATE_BLOCK', now, 'fuera de killzone (R16.1)'); return { state: st, signal: null, closed }; }
  if (input.newsBlackout) { emit(st, 'GATE_BLOCK', now, 'noticias alto impacto (R16.4)'); return { state: st, signal: null, closed }; }
  if (input.riskBlocked) { emit(st, 'GATE_BLOCK', now, `kill-switch: ${input.riskBlocked} (R16.5)`); return { state: st, signal: null, closed }; }
  if (h1.bias === 'range') { emit(st, 'GATE_BLOCK', now, 'sesgo H1 range (R16.2)'); return { state: st, signal: null, closed }; }

  const dir: 'long' | 'short' = h1.bias === 'bull' ? 'long' : 'short';
  const il = computeInternalLiquidity(input.candlesM15, cfg);       // R3.1
  // R5.2: orden de prioridad del sweep: Londres → Asia → interna
  let swept: Sequence['swept'] = null; let sweptAt: number | null = null;
  const trySweep = (level: number | null, kind: 'high' | 'low', label: Sequence['swept']): boolean => {
    if (level === null) return false;
    const r = detectSweep(input.candlesM5, level, kind, cfg);       // D-7 aplicado en M5 (TF de ejecución)
    if (r.swept) { swept = label; sweptAt = r.at; return true; }
    return false;
  };
  const ok = dir === 'long'
    ? trySweep(input.sessionLevels.londonLow, 'low', 'london_low') || trySweep(input.sessionLevels.asiaLow, 'low', 'internal') || il.lows.some(l => trySweep(l, 'low', 'internal'))
    : trySweep(input.sessionLevels.londonHigh, 'high', 'london_high') || trySweep(input.sessionLevels.asiaHigh, 'high', 'internal') || il.highs.some(l => trySweep(l, 'high', 'internal'));
  if (!ok) { emit(st, 'GATE_BLOCK', now, 'sin sweep de liquidez (R16.3)'); return { state: st, signal: null, closed }; }

  const seq: Sequence = {
    dir, stage: 'S2_SWEEP_OK', bias: h1.bias, lastBosTime: h1.lastBosTime,
    stageSince: now, swept, sweptAt,
    poi: null, extremeInPOI: null, confirm: null, trigger: null,
    order: null, sl: null, tp: null, filledAt: null, beApplied: false, degraded: false,
  };
  st.seq = seq;
  emit(st, 'SWEEP', now, `${swept} barrido @ ${sweptAt} → esperando BOS válido M15`);
  return { state: st, signal: null, closed };
}
