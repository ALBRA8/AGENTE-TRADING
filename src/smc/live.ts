// ============================================================
// src/smc/live.ts
// Analizador SMC EN VIVO: cablea el detector REAL del backtest
// (src/backtest/smc_detector.ts) a las velas del bridge MT5.
//
// Cierra el punto C2 de la auditoría (Task 6-a): hasta hoy el
// análisis en vivo era fabricado (macroTrend/BOS/ChoCh hardcodeados
// en analyze_market.ts). Aquí NO se inventa nada: cada número del
// resultado sale de las velas reales del bridge o de las velas
// inyectadas (para tests). Si el bridge no responde o las velas no
// alcanzan → available:false con razón honesta (fail-closed).
// ============================================================

import { MT5Bridge, type MT5Candle } from "../config/mt5bridge.js";
import {
  processCandles,
  detectSwingPoints,
  detectStructureShifts,
  detectFVGs,
  isValidSetup,
} from "../backtest/smc_detector.js";
import type { ProcessedCandle, FVG, SwingPoint, SMCSetup } from "../backtest/types.js";

// ── Tipos públicos ──────────────────────────────────────────

export type LiveTrend = "ALCISTA" | "BAJISTA" | "RANGO" | "UNKNOWN";

/** POI (Point of Interest): zona operable real derivada de las velas. */
export interface LivePOI {
  kind: "ORDER_BLOCK" | "FVG";
  direction: "BULLISH" | "BEARISH";
  top: number;
  bottom: number;
  candleIndex: number;
  time: Date;
  mitigated: boolean;
  /** Origen auditable: qué estructura generó la zona */
  origin: string;
}

export interface LiveStructureShift {
  type: "BOS" | "ChoCh";
  direction: "BULLISH" | "BEARISH";
  price: number;
  time: Date;
  candleIndex: number;
  confidence: number;
  rvol: number;
}

export interface LiveAnalysis {
  available: boolean;
  unavailableReason?: string;
  symbol: string;
  timeframe: string;
  trend: LiveTrend;
  lastPrice: number;
  candleCount: number;
  asOf: string;
  swings: SwingPoint[];
  structureShifts: LiveStructureShift[];
  fvgs: FVG[];
  pois: LivePOI[];
  setupValid: boolean;
  confidence: number;
  /** §6 verdad de datos (Task 10-a): feed rancio = (now − asOf) > 3×TF */
  dataStale: boolean;
  staleReason?: string;
  /** true si la última vela de la serie YA CERRÓ (la vela en curso se excluye) */
  lastCandleClosed: boolean;
  /** Taxonomía de verdad §6: qué es observado directo y qué es inferencia */
  truthLevels: {
    candles: "OBSERVED";
    structure: "OBSERVED";
    trend: "INFERRED";
    setup: "INFERRED";
  };
  reportText: string;
}

// ── Configuración ───────────────────────────────────────────

/** Timeframes aceptados por el bridge (ver TIMEFRAME_MAP en bridge.py) */
const SUPPORTED_TIMEFRAMES = new Set(["M1", "M5", "M15", "H1"]);
const CANDLES_TO_FETCH = 200;
/** Minutos por timeframe — base de frescura (3×TF) y vela-en-curso */
const TF_MINUTES: Record<string, number> = { M1: 1, M5: 5, M15: 15, H1: 60 };

/**
 * Niveles de verdad §6 del análisis en vivo (Task 10-a): las velas y la
 * estructura detectada sobre ellas son OBSERVED (medidas del feed/detector);
 * la tendencia y la validez del setup son INFERRED (derivadas de lo anterior).
 * Constante, no parametrizable: la fuente NO se decide en runtime.
 */
const LIVE_TRUTH_LEVELS: LiveAnalysis["truthLevels"] = {
  candles: "OBSERVED",
  structure: "OBSERVED",
  trend: "INFERRED",
  setup: "INFERRED",
};
/**
 * Mínimo de velas para analizar: el detector usa lookback 5 a cada lado
 * para swings y necesita ≥4 swings para estructuras; con menos de 60 velas
 * el resultado sería ruido, no análisis.
 */
const MIN_CANDLES = 60;
/** Ventana máxima (velas) hacia atrás para buscar la vela origen del OB */
const OB_SCAN_BACK = 20;
/** RVOL mínimo del SOP para validar un BOS */
const SOP_RVOL_THRESHOLD = 1.5;

// ── Helpers internos ────────────────────────────────────────

/**
 * Re-evalúa la mitigación de los FVGs usando SOLO velas posteriores a la
 * formación. El detector del backtest arranca su bucle de mitigación en
 * `endIndex` (la propia vela de cierre del gap), lo que marca TODO FVG
 * como mitigado en el momento de nacer — en vivo eso vaciaría el listado
 * de POIs por completo. Aquí se corrige a la semántica SMC estándar
 * ("mitigado = el precio volvió a la zona DESPUÉS de formarse") sin tocar
 * src/backtest/** (fuera del alcance de esta tarea).
 */
function recomputeFvgMitigation(fvgs: FVG[], candles: ProcessedCandle[]): FVG[] {
  return fvgs.map((f) => {
    const corrected: FVG = { ...f, isMitigated: false, mitigationIndex: undefined };
    for (let i = f.endIndex + 1; i < candles.length; i++) {
      const c = candles[i];
      const touched =
        f.type === "BULLISH"
          ? c.low <= f.top && c.low >= f.bottom
          : c.high <= f.top && c.high >= f.bottom;
      if (touched) {
        corrected.isMitigated = true;
        corrected.mitigationIndex = i;
        break;
      }
    }
    return corrected;
  });
}

/**
 * Asocia a cada estructura (BOS/ChoCh) el FVG no mitigado más reciente del
 * mismo sentido dentro de las 10 velas previas — misma regla que
 * associateFVGsWithSetups del detector, pero con la mitigación corregida
 * (la original nunca asociaría: todos los FVGs nacen "mitigados" allí).
 */
function associateCorrectedFvgs(setups: SMCSetup[], fvgs: FVG[]): SMCSetup[] {
  return setups.map((setup) => {
    const relevant = fvgs.find(
      (fvg) =>
        !fvg.isMitigated &&
        fvg.endIndex < setup.index &&
        fvg.endIndex >= setup.index - 10 &&
        ((setup.direction === "BULLISH" && fvg.type === "BULLISH") ||
          (setup.direction === "BEARISH" && fvg.type === "BEARISH"))
    );
    return relevant ? { ...setup, fvg: relevant } : setup;
  });
}

/**
 * Order Blocks reales: última vela de color contrario al impulso rompedor,
 * escaneando hacia atrás desde la vela del shift (origen del movimiento).
 * Zona = cuerpo de la vela (open/close). Mitigado = una vela posterior
 * regresó a tocar la zona.
 */
function deriveOrderBlocks(
  shifts: SMCSetup[],
  candles: ProcessedCandle[]
): LivePOI[] {
  const blocks: LivePOI[] = [];
  const seen = new Set<number>();

  for (const s of shifts) {
    for (let i = s.index - 1; i >= Math.max(0, s.index - OB_SCAN_BACK); i--) {
      const c = candles[i];
      const isOpposite = s.direction === "BULLISH" ? !c.up : c.up;
      if (!isOpposite) continue;

      const top = Math.max(c.open, c.close);
      const bottom = Math.min(c.open, c.close);
      let mitigated = false;
      for (let j = s.index + 1; j < candles.length; j++) {
        const touched =
          s.direction === "BULLISH"
            ? candles[j].low <= top
            : candles[j].high >= bottom;
        if (touched) {
          mitigated = true;
          break;
        }
      }

      if (!seen.has(i)) {
        seen.add(i);
        blocks.push({
          kind: "ORDER_BLOCK",
          direction: s.direction === "BULLISH" ? "BULLISH" : "BEARISH",
          top,
          bottom,
          candleIndex: i,
          time: c.time,
          mitigated,
          origin: `Origen de ${s.type} ${s.direction} @ ${s.price}`,
        });
      }
      break; // una sola vela origen por shift
    }
  }
  return blocks;
}

/**
 * Tendencia derivada de la estructura detectada (nunca inventada).
 *
 * NOTA sobre el detector real (src/backtest/smc_detector.ts, no editable
 * en esta tarea): para una ventana de 4 swings L,H,L,H con higher-low y
 * ruptura al alza emite A LA VEZ "BOS BULLISH" y "ChoCh BEARISH" (las
 * condiciones de ambos bloques son idénticas en su código), y lo mismo
 * en el espejo bajista. Por eso la tendencia NO se toma del rótulo del
 * último shift (sería ambiguo/sistemáticamente invertido), sino del
 * patrón REAL de los swings de la ventana más reciente:
 *   higher low + ruptura de high → ALCISTA
 *   lower high + ruptura de low  → BAJISTA
 * Sin shifts: comparación de los últimos swing highs/lows.
 */
function deriveTrend(
  setups: SMCSetup[],
  swings: SwingPoint[]
): { trend: LiveTrend; basis: string } {
  const last = setups[setups.length - 1];
  if (last && last.swingPoints.length >= 4) {
    const s0 = last.swingPoints[last.swingPoints.length - 4];
    const s1 = last.swingPoints[last.swingPoints.length - 3];
    const s2 = last.swingPoints[last.swingPoints.length - 2];
    const s3 = last.swingPoints[last.swingPoints.length - 1];
    const higherLow = s2.price > s0.price;
    const higherHigh = s3.price > s1.price;
    const lowerHigh = s3.price < s1.price;
    const lowerLow = s2.price < s0.price;
    if (higherLow && higherHigh) {
      return {
        trend: "ALCISTA",
        basis: `Estructura real: higher low (${s2.price} > ${s0.price}) + ruptura de high (${s3.price} > ${s1.price})`,
      };
    }
    if (lowerHigh && lowerLow) {
      return {
        trend: "BAJISTA",
        basis: `Estructura real: lower high (${s3.price} < ${s1.price}) + ruptura de low (${s3.price} < ${s1.price})`,
      };
    }
    return { trend: "RANGO", basis: "Última ventana de estructura sin secuencia direccional clara" };
  }

  const highs = swings.filter((s) => s.type === "HIGH");
  const lows = swings.filter((s) => s.type === "LOW");
  const hh = highs.length >= 2 && highs[highs.length - 1].price > highs[highs.length - 2].price;
  const hl = lows.length >= 2 && lows[lows.length - 1].price > lows[lows.length - 2].price;
  const lh = highs.length >= 2 && highs[highs.length - 1].price < highs[highs.length - 2].price;
  const ll = lows.length >= 2 && lows[lows.length - 1].price < lows[lows.length - 2].price;
  if (highs.length >= 2 && lows.length >= 2) {
    if (hh && hl) return { trend: "ALCISTA", basis: "Swings: higher highs + higher lows (sin shift confirmado)" };
    if (lh && ll) return { trend: "BAJISTA", basis: "Swings: lower highs + lower lows (sin shift confirmado)" };
    return { trend: "RANGO", basis: "Swings sin secuencia direccional clara" };
  }
  if (highs.length >= 2 && lh) return { trend: "BAJISTA", basis: "Swings: lower highs (sin shifts ni lows suficientes)" };
  if (highs.length >= 2 && hh) return { trend: "ALCISTA", basis: "Swings: higher highs (sin shifts ni lows suficientes)" };
  return { trend: "UNKNOWN", basis: "Estructura insuficiente (sin shifts ni pares de swings)" };
}

function buildReport(
  a: Omit<LiveAnalysis, "reportText" | "available" | "unavailableReason">,
  trendBasis: string
): string {
  const lines: string[] = [];
  lines.push(`📊 **Estructura SMC EN VIVO — ${a.symbol} (${a.timeframe})**`);
  lines.push(`• Fuente: velas MT5 [OBSERVED] · tendencia [INFERRED — derivada de estructura]`);
  lines.push(`• Tendencia: **${a.trend}** — ${trendBasis}`);
  lines.push(`• Último precio: **${a.lastPrice}** · ${a.candleCount} velas CERRADAS hasta ${a.asOf}`);

  // Nota de vela en curso (Task 10-a): la exclusión evita BOS/FVG fantasma
  if (!a.lastCandleClosed) {
    lines.push(`• Nota: última vela EN CURSO EXCLUIDA del análisis (solo velas cerradas)`);
  }

  // Datos rancios (hallazgo 9-b P2): feed muerto/mercado cerrado → visible
  // y explícito. El texto exacto "DATOS STALE" lo reconoce el gate price_feed.
  if (a.dataStale) {
    lines.push(`⚠️ **DATOS STALE** — ${a.staleReason ?? "frescura no verificable"} (los gates tratarán esto como UNKNOWN)`);
  }

  const lastSwings = a.swings.slice(-6);
  lines.push(
    `• Swings (${a.swings.length}): ` +
      (lastSwings.length
        ? lastSwings.map((s) => `${s.type === "HIGH" ? "H" : "L"} ${s.price}`).join(" · ")
        : "ninguno detectado")
  );

  if (a.structureShifts.length) {
    lines.push(`• Estructura (BOS/ChoCh reales):`);
    for (const s of a.structureShifts.slice(-4)) {
      lines.push(
        `  - ${s.type} **${s.direction === "BULLISH" ? "ALCISTA" : "BAJISTA"}** @ ${s.price} · vela ${s.time.toISOString()} · conf ${(s.confidence * 100).toFixed(0)}% · rvol ${s.rvol.toFixed(2)}x`
      );
    }
  } else {
    lines.push(`• Estructura: sin BOS/ChoCh confirmados en la ventana analizada`);
  }

  if (a.fvgs.length) {
    lines.push(`• FVGs (${a.fvgs.length}):`);
    for (const f of a.fvgs.slice(-4)) {
      lines.push(
        `  - ${f.type} ${f.bottom}–${f.top} · ${f.isMitigated ? "MITIGADO" : "NO mitigado"} · velas ${f.startIndex}→${f.endIndex}`
      );
    }
  } else {
    lines.push(`• FVGs: ninguno detectado en la ventana`);
  }

  if (a.pois.length) {
    lines.push(`• POIs (zonas operables reales):`);
    for (const p of a.pois.slice(-5)) {
      lines.push(
        `  - ${p.kind} ${p.direction === "BULLISH" ? "demanda" : "oferta"} ${p.bottom}–${p.top} · ${p.mitigated ? "mitigado" : "vigente"} · vela ${p.time.toISOString()}`
      );
    }
  } else {
    lines.push(`• POIs: ninguna zona vigente`);
  }

  lines.push(
    `• Setup del detector: ${a.setupValid ? "🟢 VÁLIDO (BOS/ChoCh con FVG asociado y RVOL del SOP)" : "🟡 NO VÁLIDO ahora"} · confianza global ${(a.confidence * 100).toFixed(0)}%`
  );
  return lines.join("\n");
}

// ── API pública ─────────────────────────────────────────────

/**
 * Analiza la estructura SMC del símbolo con las velas REALES del bridge.
 * Si se inyectan `candles` (tests / reuso), se usan esas en lugar del bridge.
 * `opts.now` inyecta el reloj (tests): base de frescura y vela-en-curso.
 * Fail-closed: bridge caído, velas insuficientes o throw del detector →
 * available:false con razón honesta (§6: nunca analizar con datos a medias).
 */
export async function analyzeLiveStructure(
  symbol: string,
  timeframe: string,
  candles?: MT5Candle[],
  opts?: { now?: Date }
): Promise<LiveAnalysis> {
  const sym = symbol.trim().toUpperCase();
  const tf = timeframe.trim().toUpperCase();

  const unavailable = (reason: string): LiveAnalysis => ({
    available: false,
    unavailableReason: reason,
    symbol: sym,
    timeframe: tf,
    trend: "UNKNOWN",
    lastPrice: NaN,
    candleCount: 0,
    asOf: "",
    swings: [],
    structureShifts: [],
    fvgs: [],
    pois: [],
    setupValid: false,
    confidence: 0,
    dataStale: false,
    staleReason: undefined,
    lastCandleClosed: false,
    truthLevels: LIVE_TRUTH_LEVELS,
    reportText: `❌ **Estructura SMC no disponible para ${sym} (${tf})**: ${reason}`,
  });

  if (!SUPPORTED_TIMEFRAMES.has(tf)) {
    return unavailable(`Timeframe no soportado: ${timeframe} (soportados: M1, M5, M15, H1)`);
  }

  // 1. Fuente de datos: velas inyectadas o bridge (fail-closed)
  let raw: MT5Candle[];
  if (candles && candles.length) {
    raw = candles;
  } else {
    try {
      raw = await MT5Bridge.getCandles(sym, tf, CANDLES_TO_FETCH);
    } catch (err) {
      return unavailable(`Bridge no disponible: ${(err as Error).message}`);
    }
  }

  // 2. Sanidad de velas: descartar filas corruptas antes de analizar
  const clean = (raw ?? []).filter(
    (c) =>
      c &&
      Number.isFinite(c.open) && Number.isFinite(c.high) &&
      Number.isFinite(c.low) && Number.isFinite(c.close) &&
      c.high >= c.low
  );
  // 2b. Frescura y vela en curso (Task 10-a, hallazgos 9-b P2):
  //  - La vela SIN CERRAR se EXCLUYE del análisis: un BOS/FVG sobre una vela
  //    que aún puede cambiar es estructura fantasma. Regla: la vela de
  //    apertura T cierra en T + TF; si now cae dentro de ese intervalo
  //    (y la vela ya abrió), está en curso.
  //  - STALE: si (now − última vela cerrada) > 3×TF el feed está muerto o el
  //    mercado cerrado → dataStale=true (el análisis sigue disponible pero
  //    marcado; el gate price_feed lo tratará como UNKNOWN).
  const tfMinutes = TF_MINUTES[tf] ?? 0;
  const nowMs = (opts?.now ?? new Date()).getTime();
  let series = clean;
  let lastCandleClosed = true;
  if (tfMinutes > 0 && series.length > 0) {
    const lastOpenMs = new Date(series[series.length - 1].time).getTime();
    const inProgress =
      Number.isFinite(lastOpenMs) &&
      nowMs >= lastOpenMs && // la vela ya abrió
      nowMs < lastOpenMs + tfMinutes * 60_000; // y aún no cierra
    if (inProgress) {
      series = series.slice(0, -1);
      lastCandleClosed = false;
    }
  }

  // El mínimo aplica a velas CERRADAS (lo que realmente se analiza)
  if (series.length < MIN_CANDLES) {
    return unavailable(
      `Velas insuficientes: ${series.length} cerradas (mínimo ${MIN_CANDLES})` +
        (!lastCandleClosed ? " tras excluir la vela en curso" : "")
    );
  }

  let dataStale = false;
  let staleReason: string | undefined;
  if (tfMinutes > 0) {
    const lastClosedMs = new Date(series[series.length - 1].time).getTime();
    if (Number.isFinite(lastClosedMs)) {
      const ageMin = (nowMs - lastClosedMs) / 60_000;
      if (ageMin > tfMinutes * 3) {
        dataStale = true;
        staleReason = `última vela de hace ${Math.round(ageMin)} min (TF ${tf}); mercado cerrado o feed muerto`;
      }
    }
  }

  // 3. Pipeline SMC con las funciones REALES del detector de backtest.
  //    Hallazgo 9-b P1: TODO el pipeline del detector va envuelto en
  //    try/catch — cualquier throw de un edge-case se convierte en
  //    unavailable honesto y JAMÁS en un GREEN que el pipeline interpretaría
  //    como "precio real disponible".
  try {
    const processed: ProcessedCandle[] = processCandles(
      series.map((c) => ({
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        tickVolume: c.tickVolume,
        realVolume: c.realVolume,
        spread: c.spread,
      }))
    );
    const volumes = processed.map((c) => c.tickVolume || 0);
    const swings: SwingPoint[] = detectSwingPoints(processed);
    const setups: SMCSetup[] = detectStructureShifts(processed, swings, volumes);
    const fvgs: FVG[] = recomputeFvgMitigation(detectFVGs(processed), processed);
    const associated = associateCorrectedFvgs(setups, fvgs);

    // 4. Setup válido según las reglas del detector (RVOL del SOP; killzone
    //    NO se exige aquí — la valida el gate de horario del pipeline).
    //    Se acepta el setup más reciente que cumpla: con el detector real,
    //    cada ventana emite BOS y ChoCh emparejados y solo uno de ellos
    //    lleva FVG asociado del mismo sentido.
    const setupConfig = { requireFVG: true, requireKillzone: false, rvolThreshold: SOP_RVOL_THRESHOLD };
    const validSetups = associated.filter((s) => isValidSetup(s, setupConfig, new Date()));
    const lastSetup = associated[associated.length - 1] ?? null;
    const lastValid = validSetups[validSetups.length - 1] ?? null;
    const setupValid = validSetups.length > 0;

    // 5. Tendencia y confianza derivadas de la estructura (no inventadas)
    const structureShifts: LiveStructureShift[] = setups.map((s) => ({
      type: s.type as "BOS" | "ChoCh",
      direction: s.direction,
      price: s.price,
      time: s.time,
      candleIndex: s.index,
      confidence: s.confidence,
      rvol: s.rvol,
    }));
    const { trend, basis } = deriveTrend(setups, swings);

    let confidence = 0;
    if (trend !== "UNKNOWN") {
      if (lastValid) {
        confidence = lastValid.confidence; // 0-1 (rvol/2; ChoCh ×0.8)
      } else if (lastSetup) {
        confidence = lastSetup.confidence * 0.5; // estructura sin confirmación de volumen/FVG
      } else {
        confidence = 0.2; // tendencia inferida solo de swings, sin shift
      }
    }
    confidence = Math.round(Math.min(1, Math.max(0, confidence)) * 100) / 100;

    // 6. POIs: order blocks derivados de los shifts + FVGs NO mitigados
    const orderBlocks = deriveOrderBlocks(setups, processed);
    const unmitigatedFvgs: LivePOI[] = fvgs
      .filter((f) => !f.isMitigated)
      .map((f) => ({
        kind: "FVG" as const,
        direction: f.type,
        top: f.top,
        bottom: f.bottom,
        candleIndex: f.endIndex,
        time: f.endTime,
        mitigated: false,
        origin: `FVG velas ${f.startIndex}→${f.endIndex}`,
      }));
    const pois = [...orderBlocks, ...unmitigatedFvgs];

    const last = processed[processed.length - 1];
    const analysis: Omit<LiveAnalysis, "reportText" | "available" | "unavailableReason"> = {
      symbol: sym,
      timeframe: tf,
      trend,
      lastPrice: last.close,
      candleCount: processed.length,
      asOf: last.time.toISOString(),
      swings,
      structureShifts,
      fvgs,
      pois,
      setupValid,
      confidence,
      dataStale,
      staleReason,
      lastCandleClosed,
      truthLevels: LIVE_TRUTH_LEVELS,
    };

    return {
      ...analysis,
      available: true,
      reportText: buildReport(analysis, basis),
    };
  } catch (err) {
    // §6: un bug del detector nunca debe degradarse a un análisis
    // aparentemente sano — unavailable con la causa real.
    return unavailable(`Error del detector SMC: ${(err as Error).message}`);
  }
}
