// ============================================================
// src/data/candle_provider.ts
// SE-DATA (se-data-2): proveedor multi-TF alineado para el STRATEGY ENGINE
// (docs/STRATEGY_ENGINE_V1.md §2 contrato de datos).
//
// Reglas que este módulo materializa:
//  - §0.2  No-repaint: la vela en curso se EXCLUYE SIEMPRE (solo velas
//          cerradas), siguiendo la higiene de src/smc/live.ts:405-427.
//  - §0.3  Fail-closed: si falta cualquier TF solicitado (error de bridge,
//          velas insuficientes o hueco), getAligned devuelve null con motivo
//          en events — nunca datos incompletos.
//  - B17.1 Datos alineados por timestamp; hueco > 1 barra sin vela ⇒
//          fail-closed del ciclo (sin rellenar huecos silenciosamente).
//  - Higiene de frescura (live.ts:439-448): vela más reciente con antigüedad
//          > staleMultiplier×TF ⇒ marca stale (no bloquea; el engine decide).
//
// Diseño:
//  - El bridge client va INYECTADO por constructor (tipado estructural:
//    `new MT5CandleProvider(MT5Bridge)` — MT5Bridge de src/config/mt5bridge.ts
//    satisface BridgeCandleClient). CERO imports: sin red ni I/O en import
//    time; todo perezoso.
//  - Caché LRU en memoria por (symbol, tf, count) con TTL corto (default 5s)
//    para no martillar el bridge en cada ciclo. La caché guarda la serie ya
//    DEDUPLICADA, ORDENADA y de solo CERRADAS-al-momento-del-fetch: nunca
//    puede servir una vela parcial disfrazada de cerrada. Con `fresh: true`
//    se fuerza re-fetch (el scheduler del cierre de vela debe usarlo).
//  - Alineación: los TFs comparten el reloj; se alinea al ÚLTIMO CIERRE COMÚN
//    (mínimo del último cierre de cada TF) y se trunca la cola que cierra
//    después (skew de feed entre TFs ⇒ quedan solo velas válidas en común).
// ============================================================

// ── Tipos públicos ─────────────────────────────────────────

/** Temporalidades del motor (§2.1). El bridge soporta más; el engine usa estas 4. */
export type TF = "M1" | "M5" | "M15" | "H1";

/** Vela canónica del engine (contrato local de SE-DATA; conciliable con
 *  src/strategy/ por tipado estructural). `time` = epoch ms UTC de APERTURA. */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number; // tickVolume del bridge (estándar MT5 para RVOL)
}

export const TF_MINUTES: Record<TF, number> = { M1: 1, M5: 5, M15: 15, H1: 60 };

/** Vela cruda tal como la devuelve el bridge (bridge.py /candles →
 *  MT5Candle en mt5bridge.ts: `time` ISO string; se tolera epoch numérico
 *  para mocks y futuras versiones del bridge). */
export interface BridgeCandle {
  time: string | number;
  open: number;
  high: number;
  low: number;
  close: number;
  tickVolume?: number;
}

/** Puerto mínimo del cliente de velas — inyección de dependencias.
 *  MT5Bridge (src/config/mt5bridge.ts) satisface este interface tal cual. */
export interface BridgeCandleClient {
  getCandles(
    symbol: string,
    timeframe: string,
    count: number
  ): Promise<BridgeCandle[]>;
}

/** Resultado de getAligned: velas CERRADAS de cada TF alineadas al último
 *  cierre común. TFs no solicitados ⇒ array vacío. */
export interface MultiTF {
  h1: Candle[];
  m15: Candle[];
  m5: Candle[];
  m1: Candle[];
  /** Epoch ms del último cierre común a TODOS los TFs solicitados. */
  alignedAt: number;
  /** Huecos detectados (informativo; con failOnGaps=true un MultiTF no-nulo
   *  nunca lleva huecos — se devolvería null). */
  gaps: string[];
  /** Marca de frescura (live.ts:439-448): true si algún TF solicitado tiene
   *  su última vela cerrada con antigüedad > staleMultiplier×TF. */
  stale: boolean;
  staleReasons: string[];
}

/** Resultado de getCandlesOnClose: solo velas cerradas de UN TF (no-repaint
 *  §0.2), con la marca de frescura visible para el scheduler del engine. */
export interface ClosedCandleSeries {
  candles: Candle[]; // ascendentes, deduplicadas, vela en curso excluida
  stale: boolean;
  staleReason: string | null;
}

/** Eventos de diagnóstico (fail-closed siempre emite motivo). */
export type ProviderEvent =
  | { kind: "bridge_error"; symbol: string; tf: TF | null; reason: string }
  | { kind: "insufficient_candles"; symbol: string; tf: TF; have: number; need: number }
  | { kind: "gap_detected"; symbol: string; tf: TF; gaps: string[] }
  | { kind: "stale"; symbol: string; tf: TF; ageMin: number };

export interface CandleProviderOptions {
  /** TTL de la caché LRU en ms (default 5000 = evita martillar el bridge,
   *  cuyo timeout ya es de 5s en mt5bridge.ts). */
  cacheTtlMs?: number;
  /** Antigüedad máxima de la última vela cerrada, en múltiplos del TF
   *  (default 3, exactamente live.ts:443 `ageMin > tfMinutes * 3`). */
  staleMultiplier?: number;
  /** Reloj inyectable (epoch ms) para tests deterministas. */
  now?: () => number;
  /** Sumidero de eventos (motivos de fail-closed / stale). Nunca rompe al
   *  provider: un throw del sink se traga. */
  onEvent?: (ev: ProviderEvent) => void;
  /** Máximo de entradas de la caché LRU (default 32). */
  maxCacheEntries?: number;
  /** Velas extra pedidas sobre minCount para absorber la vela en curso,
   *  duplicados y el truncado por alineación (default 8). */
  fetchMargin?: number;
  /** B17.1: hueco en cualquier TF solicitado ⇒ getAligned = null (default
   *  true, fail-closed). false ⇒ devuelve el MultiTF con gaps registrado
   *  (solo para diagnóstico/backfill; el engine V1 debe dejarlo en true). */
  failOnGaps?: boolean;
}

export interface GetOpts {
  /** true ⇒ ignora la caché de lectura y re-fetch (escríbela igualmente).
   *  El scheduler que reacciona al CIERRE de vela debe usar fresh:true para
   *  no leer una serie a la que le falta la vela que acaba de cerrar (lag ≤ TTL). */
  fresh?: boolean;
}

/** Contrato que consume el Strategy Engine (SE-CORE). */
export interface CandleProvider {
  /** Velas multi-TF alineadas al último cierre común. Null = fail-closed
   *  (motivo en events y en lastRejectReason). */
  getAligned(
    symbol: string,
    tfs: TF[],
    minCount: number,
    opts?: GetOpts
  ): Promise<MultiTF | null>;
  /** Resuelve el "cierre de vela" de un TF: solo velas CERRADAS (la vela en
   *  curso se excluye siempre — no-repaint §0.2). */
  getCandlesOnClose(
    symbol: string,
    tf: TF,
    minCount: number,
    opts?: GetOpts
  ): Promise<ClosedCandleSeries | null>;
  /** Vaciado de caché (todo, o solo el símbolo dado). */
  invalidateCache(symbol?: string): void;
  /** Último motivo de rechazo (null si la última llamada fue exitosa). */
  readonly lastRejectReason: string | null;
}

// ── Implementación ─────────────────────────────────────────

type SeriesResult = { ok: true; series: Candle[] } | { ok: false; reason: string };
interface CacheEntry {
  at: number;
  series: Candle[]; // cerradas-al-fetch, dedup, ascendentes
}

export class MT5CandleProvider implements CandleProvider {
  private readonly client: BridgeCandleClient;
  private readonly ttlMs: number;
  private readonly staleMul: number;
  private readonly nowFn: () => number;
  private readonly onEvent: (ev: ProviderEvent) => void;
  private readonly maxEntries: number;
  private readonly margin: number;
  private readonly failOnGaps: boolean;
  /** LRU: clave `${symbol}|${tf}|${count}`. */
  private readonly cache = new Map<string, CacheEntry>();
  private _lastRejectReason: string | null = null;

  constructor(client: BridgeCandleClient, opts: CandleProviderOptions = {}) {
    this.client = client;
    this.ttlMs = opts.cacheTtlMs ?? 5000;
    this.staleMul = opts.staleMultiplier ?? 3;
    this.nowFn = opts.now ?? (() => Date.now());
    this.onEvent = opts.onEvent ?? (() => undefined);
    this.maxEntries = opts.maxCacheEntries ?? 32;
    this.margin = opts.fetchMargin ?? 8;
    this.failOnGaps = opts.failOnGaps ?? true;
  }

  get lastRejectReason(): string | null {
    return this._lastRejectReason;
  }

  // ── helpers ──

  private tfMs(tf: TF): number {
    return TF_MINUTES[tf] * 60_000;
  }

  private emit(ev: ProviderEvent): void {
    try {
      this.onEvent(ev);
    } catch {
      // El sumidero de eventos nunca puede romper el proveedor (fail-closed
      // debe ser observable, no contagioso).
    }
  }

  private reject(reason: string): null {
    this._lastRejectReason = reason;
    return null;
  }

  /** Normaliza una vela cruda; null si está corrupta (fuera, como live.ts:396-404). */
  private toCandle(raw: BridgeCandle): Candle | null {
    const time = typeof raw.time === "number" ? raw.time : Date.parse(raw.time);
    const open = Number(raw.open);
    const high = Number(raw.high);
    const low = Number(raw.low);
    const close = Number(raw.close);
    const volume = Number(raw.tickVolume ?? 0);
    if (
      !Number.isFinite(time) ||
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close) ||
      high < low ||
      high < open ||
      high < close ||
      low > open ||
      low > close
    ) {
      return null;
    }
    return { time, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 };
  }

  /** Serie de un TF: fetch (cacheado con TTL) + validación + dedupe por
   *  timestamp + orden ascendente + exclusión de la vela en curso AL MOMENTO
   *  DEL FETCH (no-repaint §0.2 — una vela capturada sin cerrar jamás entra
   *  en caché, así nunca se sirve un OHLC parcial como cerrado). */
  private async getSeries(
    symbol: string,
    tf: TF,
    count: number,
    fresh: boolean
  ): Promise<SeriesResult> {
    const key = `${symbol}|${tf}|${count}`;
    const nowMs = this.nowFn();
    if (!fresh) {
      const hit = this.cache.get(key);
      if (hit && nowMs - hit.at < this.ttlMs) {
        this.cache.delete(key); // refresca recencia (LRU)
        this.cache.set(key, hit);
        return { ok: true, series: hit.series };
      }
    }

    let raw: BridgeCandle[];
    try {
      raw = await this.client.getCandles(symbol, tf, count);
    } catch (err) {
      const reason = `bridge_error ${symbol} ${tf}: ${(err as Error).message}`;
      this.emit({ kind: "bridge_error", symbol, tf, reason: (err as Error).message });
      return { ok: false, reason };
    }
    if (!Array.isArray(raw)) {
      const reason = `bridge_error ${symbol} ${tf}: respuesta sin array de velas`;
      this.emit({ kind: "bridge_error", symbol, tf, reason });
      return { ok: false, reason };
    }

    // Dedupe por timestamp (última ocurrencia gana) + descarte de corruptas.
    const byTime = new Map<number, Candle>();
    for (const r of raw) {
      const c = this.toCandle(r);
      if (c) byTime.set(c.time, c);
    }

    // Exclusión de la vela en curso AL MOMENTO DEL FETCH: la vela que abre en
    // T cierra en T + TF (live.ts:405-427); si fetchNow < T + TF está viva y
    // su OHLC es un parcial ⇒ fuera (no-repaint §0.2).
    const series = [...byTime.values()]
      .filter((c) => c.time + this.tfMs(tf) <= nowMs)
      .sort((a, b) => a.time - b.time);

    this.cache.set(key, { at: nowMs, series });
    if (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return { ok: true, series };
  }

  /** Higiene de frescura exacta de live.ts:439-448 (age medida desde la
   *  APERTURA de la última cerrada, umbral staleMultiplier×TF). */
  private staleness(
    series: Candle[],
    tf: TF,
    nowMs: number
  ): { stale: boolean; reason: string | null; ageMin: number } {
    if (series.length === 0) {
      return { stale: true, reason: `${tf}: sin velas cerradas`, ageMin: -1 };
    }
    const lastOpen = series[series.length - 1].time;
    const ageMin = (nowMs - lastOpen) / 60_000;
    if (ageMin > TF_MINUTES[tf] * this.staleMul) {
      return {
        stale: true,
        reason: `${tf}: última vela de hace ${Math.round(ageMin)} min (TF ${tf}); mercado cerrado o feed muerto`,
        ageMin,
      };
    }
    return { stale: false, reason: null, ageMin };
  }

  /** B17.1: hueco > 1 barra del TF sin vela ⇒ registrado (la vela contigua
   *  diff == tfMs es normal; diff > tfMs significa ≥1 vela ausente). */
  private detectGaps(series: Candle[], tf: TF): string[] {
    const tfMs = this.tfMs(tf);
    const gaps: string[] = [];
    for (let i = 1; i < series.length; i++) {
      const diff = series[i].time - series[i - 1].time;
      if (diff > tfMs) {
        const missing = Math.round(diff / tfMs) - 1;
        gaps.push(
          `${tf}: hueco de ${missing} vela(s) entre ` +
            `${new Date(series[i - 1].time).toISOString()} y ${new Date(series[i].time).toISOString()}`
        );
      }
    }
    return gaps;
  }

  // ── API pública ──

  async getAligned(
    symbol: string,
    tfs: TF[],
    minCount: number,
    opts?: GetOpts
  ): Promise<MultiTF | null> {
    this._lastRejectReason = null;
    if (!symbol || tfs.length === 0) {
      return this.reject("getAligned: symbol vacío o lista de TFs vacía");
    }
    if (!Number.isInteger(minCount) || minCount <= 0) {
      return this.reject(`getAligned: minCount inválido (${minCount})`);
    }
    const wanted = [...new Set(tfs)]; // dedupe de TFs pedidos dos veces
    const nowMs = this.nowFn();
    const fresh = opts?.fresh === true;

    // 1. Fetch en PARALELO por TF (§2.1) — cada serie ya es cerrada+dedup+asc.
    const results = await Promise.all(
      wanted.map((tf) => this.getSeries(symbol, tf, minCount + this.margin, fresh))
    );
    const seriesByTf = new Map<TF, Candle[]>();
    for (let i = 0; i < wanted.length; i++) {
      const r: SeriesResult = results[i];
      if (!r.ok) return this.reject(r.reason); // bridge caído ⇒ fail-closed §0.3
      seriesByTf.set(wanted[i], r.series);
    }

    // 2. Alineación al ÚLTIMO CIERRE COMÚN (los TFs comparten el reloj).
    let alignedAt = Number.POSITIVE_INFINITY;
    for (const tf of wanted) {
      const s = seriesByTf.get(tf) ?? [];
      if (s.length === 0) {
        this.emit({ kind: "insufficient_candles", symbol, tf, have: 0, need: minCount });
        return this.reject(
          `velas insuficientes ${symbol} ${tf}: 0 cerradas < ${minCount} (§2.1/B17.1)`
        );
      }
      const lastClose = s[s.length - 1].time + this.tfMs(tf);
      if (lastClose < alignedAt) alignedAt = lastClose;
    }

    // 3. Truncado de la cola que cierra DESPUÉS del cierre común (skew de
    //    feed entre TFs) — al alignedAt todos los TFs tienen exactamente las
    //    velas aquí presentes como CERRADAS.
    const aligned = new Map<TF, Candle[]>();
    for (const tf of wanted) {
      const s = seriesByTf.get(tf) ?? [];
      aligned.set(tf, s.filter((c) => c.time + this.tfMs(tf) <= alignedAt));
    }

    // 4. Mínimo por TF sobre la serie ya alineada (§2.1/B17.1) — fail-closed.
    for (const tf of wanted) {
      const s = aligned.get(tf) ?? [];
      if (s.length < minCount) {
        this.emit({ kind: "insufficient_candles", symbol, tf, have: s.length, need: minCount });
        return this.reject(
          `velas insuficientes ${symbol} ${tf}: ${s.length} cerradas < ${minCount} (§2.1/B17.1)`
        );
      }
    }

    // 5. Staleness (marca, NO bloquea — live.ts:439-448; el engine decide).
    const staleReasons: string[] = [];
    for (const tf of wanted) {
      const st = this.staleness(aligned.get(tf) ?? [], tf, nowMs);
      if (st.stale) {
        staleReasons.push(st.reason ?? `${tf}: stale`);
        this.emit({ kind: "stale", symbol, tf, ageMin: st.ageMin });
      }
    }

    // 6. Gaps sobre la serie alineada — B17.1 fail-closed.
    const allGaps: string[] = [];
    for (const tf of wanted) {
      const gaps = this.detectGaps(aligned.get(tf) ?? [], tf);
      if (gaps.length > 0) {
        this.emit({ kind: "gap_detected", symbol, tf, gaps });
        allGaps.push(...gaps);
      }
    }
    if (allGaps.length > 0 && this.failOnGaps) {
      return this.reject(`gaps detectados (B17.1 fail-closed): ${allGaps.join("; ")}`);
    }

    return {
      h1: aligned.get("H1") ?? [],
      m15: aligned.get("M15") ?? [],
      m5: aligned.get("M5") ?? [],
      m1: aligned.get("M1") ?? [],
      alignedAt,
      gaps: allGaps,
      stale: staleReasons.length > 0,
      staleReasons,
    };
  }

  async getCandlesOnClose(
    symbol: string,
    tf: TF,
    minCount: number,
    opts?: GetOpts
  ): Promise<ClosedCandleSeries | null> {
    this._lastRejectReason = null;
    if (!symbol || !Number.isInteger(minCount) || minCount <= 0) {
      return this.reject(
        `getCandlesOnClose: argumentos inválidos (symbol='${symbol}', minCount=${minCount})`
      );
    }
    const nowMs = this.nowFn();
    const r = await this.getSeries(symbol, tf, minCount + this.margin, opts?.fresh === true);
    if (!r.ok) return this.reject(r.reason);
    if (r.series.length < minCount) {
      this.emit({ kind: "insufficient_candles", symbol, tf, have: r.series.length, need: minCount });
      return this.reject(
        `velas insuficientes ${symbol} ${tf}: ${r.series.length} cerradas < ${minCount} (§2.1/B17.1)`
      );
    }
    const st = this.staleness(r.series, tf, nowMs);
    if (st.stale) {
      this.emit({ kind: "stale", symbol, tf, ageMin: st.ageMin });
    }
    return { candles: r.series, stale: st.stale, staleReason: st.reason };
  }

  invalidateCache(symbol?: string): void {
    if (!symbol) {
      this.cache.clear();
      return;
    }
    const prefix = `${symbol}|`;
    for (const k of [...this.cache.keys()]) {
      if (k.startsWith(prefix)) this.cache.delete(k);
    }
  }
}
