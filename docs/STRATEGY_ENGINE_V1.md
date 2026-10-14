# TRADING STRATEGY ENGINE V1.0 — Especificación Única

| Campo | Valor |
|---|---|
| Estado | PROPUESTA — pendiente de validación del propietario antes de implementar |
| Versión | 1.0 (cualquier cambio de regla = bump de versión) |
| Fecha | 2026-10-15 |
| Fuente A | 15 videos del propietario (estructura, liquidez, 3 Pilares, Zonas de Interés ×2, OpenTrade ×3) |
| Fuente B | `instrucciones.txt` (decodificación técnica del mismo sistema) |
| Fuente C | `docs/INTEGRATION_MAP_STRATEGY_ENGINE.md` (realidad verificada del código) |
| Fuente D | `docs/PROMPT06.md` (marco de capas A–J, se mantiene como marco de trabajo) |

**Regla de precedencia**: esta especificación prevalece sobre cualquier descripción previa (incluido el Pine v2, que prueba otra lógica). Si un bloque de esta spec contradice `instrucciones.txt`, manda esta spec y se documenta la desviación en §20.

---

## 0. Principios no negociables

1. **Determinismo total**: el mismo histórico de velas produce exactamente las mismas señales. Cero discreción, cero temperatura, cero interpretación.
2. **No-repaint**: toda regla se evalúa **al cierre de vela** de su temporalidad. Ninguna señal usa la vela en curso ni datos futuros.
3. **Fail-closed**: si falta cualquier insumo (velas de un TF, nivel de sesión, calendario económico), el motor NO genera señal; nunca opera con información incompleta.
4. **El LLM nunca decide**: el LLM (NVIDIA NIM) recibe señales ya fabricadas por el motor y solo las narra/explica/audita (capa de comunicación). No puede crear, modificar ni vetar setups por criterio propio.
5. **Riesgo existente intacto**: la señal del motor entra por la misma cadena que hoy — `risk_controls` (1% diario, 2 posiciones, 2 pérdidas consecutivas) → `policy` → hard-gate → `execution_guard`. El motor no bypassa nada.
6. **Un solo motor para vivo y backtest**: el núcleo del motor consume arrays de velas y produce eventos; el vivo lo alimenta el bridge y el backtest el cargador histórico. Misma lógica, distinta fuente de datos.

---

## 1. Definiciones mecánicas (sin ambigüedad)

Cada definición es una regla computable. Los índices se refieren a velas cerradas del TF indicado.

**D-1. Swing point** — Vela i es *swing high* si su high es el máximo de la ventana `[i-L, i+L]` (L = `swingLookback`, default 2). Ídem swing low con el mínimo. Se confirma solo cuando han cerrado L velas posteriores.

**D-2. BOS (continuación)** — En tendencia alcista: vela que **cierra con cuerpo** por encima del último swing high confirmado. En bajista: cierre con cuerpo por debajo del último swing low. La mecha sola NO rompe (regla de `instrucciones.txt`: ruptura con cuerpo de vela).

**D-3. BOS VÁLIDO (generador de POI)** — Un BOS que cumple AMBAS condiciones:
- (a) el tramo de impulso que lo causa partió de una vela contraria previa (no es un desplazamiento vertical sin retroceso), y
- (b) entre el último extremo estructural y la ruptura hubo **toma de liquidez interna** (D-4) dentro de las últimas `liquidityWindow` velas (default 20).

**D-4. Toma de liquidez interna** — una vela cuyo high/high supera el swing high interno anterior (o low < swing low interno anterior) **sin cierre** más allá del extremo estructural mayor. Liquidez barrida = combustible del movimiento.

**D-5. CHOCH (reversión)** — En tendencia alcista: cierre con cuerpo por debajo del último swing low válido que originó el último swing high. Ídem inverso. Un CHOCH es **confiable** si ocurre tras neutralizar liquidez (D-4 o sweep externo D-6) — regla del video: "un ChoCh válido suele ocurrir después de neutralizar liquidez".

**D-6. Liquidez externa** — Niveles objetivos del precio: PDH/PDL (previous day high/low), High/Low de la sesión de Londres (D-7), High/Low de la sesión de Asia, y extremos estructurales mayores (último swing H1/M15 relevante). Regla de oro del sistema: *si el precio no rompe un máximo, irá a buscar un mínimo* (y viceversa).

**D-7. Sweep (neutralización)** — El precio **barre** un nivel de liquidez L si: `high > L` (o `low < L`) con mecha y **cierra de vuelta** al lado de origen del nivel dentro de `sweepMaxCandles` velas (default 3). Si cierra y permanece más allá durante `sweepMaxCandles`, no es sweep: es ruptura (BOS externo).

**D-8. POI ("Caja")** — Rectángulo definido por la **última vela contraria completa antes del desplazamiento que causó un BOS válido** (D-3): `top = high` de esa vela, `bottom = low` de esa vela. Alternativa válida cuando el desplazamiento deja FVG: la POI puede ser el FVG del desplazamiento (elección: la caja del OB primario; FVG como fallback si el OB no existe). Tipos: `ORDER_BLOCK`, `FVG`, `BREAKER`.

**D-9. Cambio de polaridad (Breaker)** — Una zona de oferta cuya ruptura fue BOS válido se convierte en zona de demanda para el retroceso (y viceversa). Toda POI usada por el motor hereda la dirección del BOS que la generó: la POI de un long es el origen alcista; la de un short, el origen bajista.

**D-10. Mitigación** — Una POI queda **mitigada** (deja de ser operable si aún no se ejecutó; una vez ejecutado el trade, es contexto) cuando una vela **cierra** dentro de sus límites sin que se haya disparado la secuencia de confirmación, o cuando el precio cierra más allá de su extremo remoto (invalidación, ver B15).

**D-11. Retest** — Tras el CHOCH de trigger, el precio regresa a la zona del bloque (OB/FVG de M1) que causó ese CHOCH: para long, `low <= top_del_bloque`; para short, `high >= bottom_del_bloque`.

**D-12. Killzones canónicas** — Las ventanas de `evaluateMarketHours` (DST-safe, `America/New_York`): **Londres 03:00–12:00 ET**, **NY 08:00–17:00 ET**, killzone de ejecución **NY 08:00–12:00 ET**, Asia 19:00–04:00 ET. Esta spec adopta esas ventanas como únicas definiciones de sesión (elimina la divergencia del detector de backtest con EST fijo).

---

## 2. Contrato de datos

### 2.1 Entradas obligatorias (por símbolo, en cada ciclo de evaluación)

| Insumo | TF | Mínimo de velas | Uso |
|---|---|---|---|
| `candlesH1` | H1 | 100 | Pilar 1: sesgo macro (B1) |
| `candlesM15` | M15 | 200 | Pilar 2: estructura + POI (B2, B6) |
| `candlesM5` | M5 | 200 | Pilar 3a: confirmación (B8) |
| `candlesM1` | M1 | 200 | Pilar 3b: trigger + retest (B9, B10) |
| `sessionLevels` | — | — | High/Low Londres y Asia, PDH/PDL (B4) |
| `marketHours` | — | — | Killzones DST-safe (D-12) |
| `newsBlackout` | — | — | Ventana de alto impacto (B16) |

⚠️ Realidad del código (Fuente C): hoy solo existe fetch single-TF vía bridge Windows sin caché. El orquestador multi-TF alineado por timestamp es **prerrequisito** (ver §19, riesgo 1).

### 2.2 Salida: `StrategySignal`

```ts
interface StrategySignal {
  id: string;                    // AGT-SE1-<SYM>-<epoch>
  symbol: string;
  direction: 'long' | 'short';
  state: S0|S1|S2|S3|S4|S5|S6|S7|S8|S9;   // máquina de estados §3
  h1: { bias: 'bull'|'bear'|'range'; lastBosTime: number };
  liquidity: {
    londonHigh: number; londonLow: number;
    swept: 'london_high'|'london_low'|'internal'|null;
    sweptAt: number | null;
  };
  poi: {
    kind: 'ORDER_BLOCK'|'FVG'|'BREAKER';
    top: number; bottom: number;
    originBarTime: number;       // vela caja M15
    m15BosTime: number;          // BOS válido que la generó
    liquidityTakenBeforeBos: boolean;
  };
  confirmation: { m5ChochTime: number; brokenLevel: number } | null;
  trigger: {
    m1ChochTime: number;
    block: { top: number; bottom: number; kind: 'ORDER_BLOCK'|'FVG' };
    retestLimitPrice: number;    // B10
  } | null;
  entry:  { type: 'LIMIT'; price: number; expiresAt: number } | null;
  sl:     { price: number; structuralRef: 'choch_low'|'choch_high'|'poi_edge'; pips: number } | null;
  tp:     { price: number; liquidityRef: 'pdh'|'pdl'|'london_high'|'london_low'|'asia_high'|'asia_low'|'structural_extreme'; rr: number } | null;
  risk:   { riskPct: 0.5 };      // fijo por V1 (instrucciones.txt §3)
  session: 'NY_KILLZONE' | 'LDN_KILLZONE';
  openTradeContext: {          // B11 — registro OpenTrade completo
    pillars: { h1: string; m15: string; m1: string };
    liquiditySweep: string;    // descripción legible del sweep
    confirmation: string;      // descripción del CHOCH M5/M1
    tfsUsed: ('H1'|'M15'|'M5'|'M1')[];
  };
}
```

### 2.3 Parámetros consolidados (defaults V1, todos en un único `strategy.config.ts`)

| Parámetro | Default | Bloque |
|---|---|---|
| `swingLookback` | 2 | D-1 |
| `liquidityWindow` | 20 | D-3 |
| `sweepMaxCandles` | 3 | D-7 |
| `poiMaxAgeBars` (M15) | 16 (=4 h) | B6/B7 |
| `m5ConfirmMaxBars` | 12 (=1 h) | B8 |
| `m1TriggerMaxBars` | 15 | B9 |
| `retestMaxBars` (M1) | 12 | B10 |
| `retestFibPercent` | 50 % del bloque trigger | B10 |
| `maxSlPips` (US30) | 15 | B12 |
| `slBufferTicks` | 2 | B12 |
| `minRR` | 2.0 | B13 |
| `breakevenMode` | `structural` (B14) | B14 |
| `newsBlackoutMin` | 15 antes / 30 después | B16 |

---

## 3. Máquina de estados del motor

Evaluada en cada **cierre de vela M1** (el TF más fino); los niveles superiores se recalculan solo cuando cierra su propia vela.

```
S0 ESCANEando     : H1 sesgo definido? NO→permanece; SÍ→S1
S1 H1_OK          : ¿sweep de Londres (o liquidez interna) alineado? NO→S1; SÍ→S2
S2 SWEEP_OK       : ¿BOS válido M15 en dirección H1? NO→S2; SÍ→S3 (POI creada D-8)
S3 POI_WAIT       : ¿precio retorna a la caja? NO (expira poiMaxAgeBars)→S0; SÍ→S4
S4 IN_POI         : ¿CHOCH M5 a favor dentro de la caja? NO→S4; SÍ→S5
S5 CONFIRMED      : ¿CHOCH M1 + bloque trigger? NO→S5 (timeout m5ConfirmMaxBars→S0); SÍ→S6
S6 TRIGGER_WAIT   : ¿retest del bloque M1 en retestMaxBars? NO→S0 (setup anulado); SÍ→S7
S7 ORDER_LIVE     : orden LIMIT colocada → riesgo existente valida → S8 (llenada) | expira→S0
S8 MANAGED        : BE estructural / SL / TP → S9
S9 CLOSED         : registra OpenTrade + feed de métricas → S0
```

Cualquier transición fallida o dato faltante ⇒ **reset a S0 con log del motivo** (fail-closed). El motor puede mantener **una sola secuencia activa por símbolo y dirección**.

---

## 4. Los 18 bloques de reglas

Formato: regla numerada → fuente → criterio computable.

### B1 — Contexto H1 (Pilar 1: dirección macro)
- **R1.1** El sesgo H1 es `bull` si el último BOS H1 fue alcista y el precio cotiza por encima del último swing low H1 válido; `bear` en espejo; `range` en cualquier otro caso. *(Fuente: instrucciones.txt §1.A, Pilar 1)*
- **R1.2** Solo se generan setups **a favor del sesgo H1**. `range` ⇒ no se opera (B16).
- **R1.3** El sesgo se recalcula **solo al cierre de vela H1**; durante la hora no cambia.

### B2 — Estructura M15 (Pilar 2)
- **R2.1** En M15 se detectan swings (D-1), BOS y CHOCH (D-2, D-5) al cierre de cada vela M15.
- **R2.2** El setup exige un **BOS válido M15 (D-3)** en la dirección del sesgo H1 como evento generador. Un CHOCH M15 que contradice H1 no genera setup (es invalidación, B15).

### B3 — Liquidez interna y externa
- **R3.1** Liquidez interna = swing highs/lows menores dentro del rango estructural vigente (D-4). *(instrucciones.txt §3)*
- **R3.2** Liquidez externa = PDH, PDL, High/Low Londres, High/Low Asia, extremo estructural H1 (D-6).
- **R3.3** El BOS generador debe ir precedido de toma de liquidez interna (D-3b). Sin retroceso previo ⇒ BOS inválido ⇒ no hay POI. *(video: "los movimientos verticales sin retrocesos no generan POIs fiables")*
- **R3.4** El TP del setup SIEMPRE apunta a liquidez externa (B13).

### B4 — High/Low de Londres
- **R4.1** Al cierre de la sesión de Londres (12:00 ET) — y provisionalmente durante NY hasta ese momento — el motor registra `londonHigh` / `londonLow` (máximo/mínimo de todas las velas de la ventana D-12 de Londres). *(video: "Londres genera el máximo o mínimo del día hasta ese momento; actúa como zona de liquidez")*
- **R4.2** Estos niveles son liquidez externa objetivo para sweeps (B5) y candidatos a TP (B13).
- **R4.3** Los niveles persisten durante toda la jornada NY del mismo día y se resetean al inicio de la sesión de Londres siguiente.

### B5 — Sweep de Nueva York
- **R5.1** La killzone de ejecución es **NY Open 08:00–12:00 ET**. Solo dentro de esta ventana se ejecutan setups. *(instrucciones.txt §2.B, §4)*
- **R5.2** Condición de entrada al flujo: NY debe **barrer** (D-7) el `londonHigh` (para shorts) o `londonLow` (para longs) **en contra del sesgo H1**, o barrer liquidez interna relevante alineada. *(video: "el objetivo de la apertura de NY es romper el High/Low de Londres"; instrucciones: neutralización de liquidez de sesiones)*
- **R5.3** Interpretación polaridad (regla del video 2): si NY rompe el High de Londres y el sesgo H1 es bear, esa zona rota se convierte en POI de oferta (resistencia→soporte roto) para buscar ventas en el retroceso. El BOS válido que sigue al sweep fija esa caja (D-8, D-9).
- **R5.4** Si no ocurre sweep en la ventana ⇒ no hay setup ese día en esa dirección (el motor puede armar la dirección opuesta solo si su propio flujo B1–B5 se cumple).

### B6 — Validación de POI
Una zona es POI operable solo si cumple **TODAS**:
- **R6.1** Es el origen (última vela contraria, D-8) de un BOS válido M15 (D-3). *(instrucciones.txt §1: "Un POI solo es válido si es el origen de un BOS")*
- **R6.2** Ese BOS fue precedido de toma de liquidez (interna D-4 o el sweep externo de B5). *(instrucciones.txt §1 "Requisito de Liquidez")*
- **R6.3** La dirección de la POI coincide con el sesgo H1 y con la dirección del sweep (polaridad correcta, D-9).
- **R6.4** La POI no está mitigada (D-10) ni expirada (`poiMaxAgeBars`).
- **R6.5** Si coexisten varias POI válidas, se toma la **más reciente** que cumpla; el resto se descarta (una secuencia activa por dirección).

### B7 — Retorno al POI
- **R7.1** Se espera que una vela M15 o M1 **entre** en la caja (`top > x > bottom`) tras el BOS. *(video 1: "no perseguir; esperar el retroceso a la zona de mitigación")*
- **R7.2** Prohibido perseguir: si el precio alcanza TP-level sin haber retocado la POI, el setup muere sin trade.
- **R7.3** Si el precio cierra más allá del extremo remoto de la caja antes de confirmar ⇒ invalidación (B15).

### B8 — Confirmación M5 (Pilar 3a: impulso)
- **R8.1** Con el precio dentro de la POI, se exige un **CHOCH M5 a favor del sesgo H1** (D-5) que rompa el micro-swing construido durante el retroceso hacia la caja. *(instrucciones.txt §1.A: M5 = reacción al POI; §4: ChoCh confirma el cambio de polaridad)*
- **R8.2** El CHOCH M5 debe ocurrir **dentro o sobre la caja** (precio aún dentro de `top..bottom` ± buffer de 1 tick) y dentro de `m5ConfirmMaxBars`.
- **R8.3** El fallo estructural previo (el precio intenta continuar en contra y **no rompe** el extremo absoluto de la caja/estructura) queda registrado como parte del contexto OpenTrade. *(instrucciones.txt §4: "Fallo Estructural")*

### B9 — CHOCH M1 (trigger, Pilar 3b: ejecución)
- **R9.1** Tras el CHOCH M5, se exige **CHOCH M1 a favor** que rompa el último micro-máximo/mínimo M1 que llevó el precio hacia la caja. *(instrucciones.txt §4: "rompe el último micro-máximo/mínimo que lo llevó hacia el POI")*
- **R9.2** El bloque trigger (OB/FVG M1 que causó ese CHOCH, D-8 aplicado a M1) se guarda como zona de retest.
- **R9.3** Timeout: si no hay CHOCH M1 en `m1TriggerMaxBars` desde la confirmación M5 ⇒ setup anulado (S0).
- **R9.4** Modo degradado (solo si M1 no está disponible): el CHOCH M5 hace de trigger y el bloque trigger es el OB/FVG M5 equivalente. Debe marcarse `degraded: true` en el contexto y está **prohibido en backtest comparativo** (no mezclar modos en métricas).

### B10 — Retest y entrada
- **R10.1** Orden **LIMIT** al precio de retest = `retestFibPercent` (50 %) del bloque trigger M1, en el lado proximal (para long: 50 % por debajo del top del bloque; para short: espejo). *(instrucciones.txt §4: "orden Limit en el retroceso (retest) hacia el bloque que generó el ChoCh")*
- **R10.2** Fill válido en backtest: el precio **toca** el nivel (M1 `low <= limit` para long). Touch = fill (conservador: sin exigir volumen).
- **R10.3** La orden expira si no se llena en `retestMaxBars` velas M1 ⇒ setup anulado, sin re-colocación.
- **R10.4** Prohibida entrada a mercado. Si el precio arranca sin retestear (B7.2 aplicado al trigger), no hay trade.

### B11 — OpenTrade (registro completo de la operación)
Toda orden generada por el motor persiste su contexto completo (schema `openTradeContext` §2.2) — es la digitalización del checklist de los videos OpenTrade:
- **R11.1** Campos obligatorios: los 3 pilares (sesgo H1, BOS/POI M15, CHOCH M5/M1), qué liquidez fue barrida (London High/Low o interna) y cuándo, tipo de POI, nivel exacto de entrada/SL/TP con sus referencias estructurales, sesión y killzone, TFs usados, `degraded` flag.
- **R11.2** El registro se escribe en `decision_log.strategy_context` (JSON) siguiendo el patrón de migración existente en `sqlite.ts`, más `entry_price` (hoy nunca se rellena — deuda detectada en Fuente C).
- **R11.3** Al cierre (settlement), el registro queda unido al resultado (PnL, R múltiple) para alimentar B18 y la memoria del agente.

### B12 — Stop Loss estructural
- **R12.1** Long: SL = mínimo absoluto creado durante el fallo estructural (el low que generó el CHOCH trigger) − `slBufferTicks`. Short: espejo. *(instrucciones.txt §3: "SL nunca es aleatorio; estrictamente por encima/debajo del último mínimo/máximo que generó el ChoCh o por fuera de la Caja")*
- **R12.2** Alternativa válida: el extremo remoto de la POI (`poi_edge`) si este es más conservador — se elige el que dé el SL **más cercano** al precio y siga siendo estructural.
- **R12.3** Tope por activo: si el SL resultante supera `maxSlPips` (US30: 15) ⇒ setup rechazado (la precisión M1/M5 es requisito del sistema). *(instrucciones.txt §3)*
- **R12.4** Prohibido SL por % fijo del precio o por distancia arbitraria. La cadena multi-activo del Pine (5 activos) se reutiliza como tabla de conversión pip/tick.

### B13 — Take Profit (liquidez externa)
- **R13.1** TP = el nivel de **liquidez externa** (D-6) más cercano en dirección del trade, elegido en este orden: PDL/PDH → High/Low Londres → High/Low Asia → extremo estructural H1. *(instrucciones.txt §3: "TP1 es siempre el máximo o mínimo estructural anterior (liquidez externa)")*
- **R13.2** Filtro de aceptación: si `rr = |tp − entry| / |entry − sl| < minRR` (2.0) ⇒ setup rechazado **antes** de colocar orden.
- **R13.3** Se sustituye el TP fijo 1:3 del ejecutor actual (`execute_trade_mt5.ts:409`) por este TP estructural — cambio documentado para integración (Fuente C §6).

### B14 — Gestión de la posición
- **R14.1** Break-even estructural (default `breakevenMode: structural`): cuando M5 confirma un BOS a favor del trade (nuevo impulso confirmado), SL se mueve a entrada + costes (0 riesgo residual). *(instrucciones.txt §3: "una vez que el precio rompe un sub-nivel a favor, el riesgo debe ser mitigado")*
- **R14.2** No hay trailing por puntos. Única gestión: BE estructural (R14.1) y salida por SL/TP. El trailing por estructura M1/M5 queda como experimento V2 (no en V1).
- **R14.3** Cierre total en TP o SL. Sin cierres parciales en V1 (los TP1/TP2/TP3 del Pine quedan fuera de esta spec).

### B15 — Invalidaciones (el setup muere)
Anulación automática de la secuencia activa si:
- **R15.1** El precio **cierra** más allá del extremo remoto de la POI antes de confirmar (fallo de polaridad).
- **R15.2** Aparece un BOS M15 en contra del sesgo H1 mientras la secuencia está activa.
- **R15.3** Un CHOCH M5/M1 en contra durante S4/S5 antes del trigger.
- **R15.4** Expiran los timeouts (`poiMaxAgeBars`, `m5ConfirmMaxBars`, `m1TriggerMaxBars`, `retestMaxBars`).
- **R15.5** La POI queda mitigada por cierre sin haber disparado la secuencia (D-10).
- **R15.6** Entra ventana de noticias de alto impacto (B16) antes del fill.

### B16 — Condiciones de no-trade (gates previos, en orden)
- **R16.1** Fuera de killzone NY (08:00–12:00 ET) o Londres (si se habilita para el activo, según política por activo de `check_market_hours`).
- **R16.2** Sesgo H1 = `range`.
- **R16.3** Sin sweep en la jornada (B5 no ocurrió).
- **R16.4** Ventana de noticias alto impacto: `newsBlackoutMin` antes y después del evento (fuente `check_news`). *(video 3: "no operar en noticias; esperar nueva estructura")*
- **R16.5** Kill-switches del sistema ya existentes (no duplicados, se consultan): pérdida diaria ≥ 1 %, 2 pérdidas consecutivas, 2 posiciones abiertas, exposición máxima, fail-closed de riesgo.

### B17 — Reglas de backtest
- **R17.1** Datos M1 obligatorios para trigger/retest; H1/M15/M5 alineados por timestamp (sin rellenar huecos silenciosamente: gap ⇒ fail-closed del ciclo).
- **R17.2** Todas las reglas se evalúan al cierre de vela de su TF; fills de LIMIT por touch en M1 (R10.2).
- **R17.3** Ambigüedad intravela resuelta conservadoramente: si la misma vela M1 toca SL y TP, **cuenta SL**.
- **R17.4** Costes: spread + slippage + comisión por activo (mismos parámetros del simulador actual, Fuente C §7).
- **R17.5** Reproducibilidad: cada run registra manifest (símbolo, rango, hash de datos, versión de spec y config) reutilizando el estándar del `BacktestEngine` §7.
- **R17.6** Walk-forward obligatorio antes de declarar validez (`WalkForwardAnalyzer` existente). Prohibido optimizar sobre todo el histórico de una sola pieza.
- **R17.7** Mínimo de muestra: ≥ 100 trades por activo para que las métricas de B18 cuenten como válidas.

### B18 — Métricas de aceptación (PROPOSAL — umbral a confirmar con el propietario)
El sistema **no se declara rentable sin backtest** (regla establecida). Criterios propuestos para pasar de backtest → demo:
| Métrica | Umbral mínimo |
|---|---|
| Profit Factor (neto de costes) | ≥ 1.30 |
| Win Rate | ≥ 40 % con RR medio ≥ 2.0 |
| Max Drawdown | ≤ 10 % del capital |
| Muestra | ≥ 100 trades por activo |
| Walk-forward | PF out-of-sample ≥ 0.8 × PF in-sample |
| Monte Carlo (p95) | cuenta final positiva |
| Por sesión | NY debe ser rentable por sí sola (la estrategia vive en la killzone) |
| Por activo | empezar por US30 (activo del material); otros activos solo con sus propias métricas |
Criterios para demo→real: los de `policy` LIVE existentes (L4 + env + aprobación), sin cambios.

---

## 5. Lo que esta spec ELIMINA respecto al estado actual

| Elemento actual | Decisión V1 | Motivo |
|---|---|---|
| Flip de canal ATR del Pine v2 como "señal" | Descartado como señal; el Pine v2 queda como herramienta visual de zonas | No es la estrategia de los videos |
| Setup decidido por el LLM (`stagePlanner`, enum `fvg\|order_block\|breaker\|choch\|otro`) | El setup lo fabrica el motor; el planner del LLM se limita a narrar | Principio 4 |
| TP fijo 1:3 del ejecutor | TP = liquidez externa (B13) | Es la regla del sistema |
| LIMIT al 50 % de la distancia SL | LIMIT en retest del bloque trigger (B10) | Es la regla del sistema |
| EST fijo del detector de backtest | `evaluateMarketHours` DST-safe (D-12) | Una sola definición de sesión |
| Entrada al close de confirmación en el simulador | Fill por touch en retest (R10.2, R17.3) | Igualar backtest ↔ ejecución real |

---

## 6. Trazabilidad: bloques → módulos (Fuente C)

| Bloque | Módulo propuesto (`src/strategy/`) | Reutiliza | Estado |
|---|---|---|---|
| B1 | `h1-context.ts` | `detectSwingPoints`, `detectStructureShifts`, `deriveTrend` (live.ts) | adaptar |
| B3, B4, B5 | `session-liquidity.ts` | `evaluateMarketHours` (check_market_hours) — **High/Low de sesión: NUEVO** | nuevo |
| B2, B6, B7 | `poi-validator.ts` | `deriveOrderBlocks` (adaptar a validación D-3/D-9), `recomputeFvgMitigation` | adaptar |
| B8 | `m5-confirmation.ts` | `detectStructureShifts` + CHOCH M5 | adaptar |
| B9, B10 | `m1-trigger.ts` | `detectStructureShifts`, `detectFVGs` (M1) | adaptar |
| — | `engine.ts` | máquina de estados §3, orquestación multi-TF, `computeRvol` | nuevo |
| B11 | `engine.ts` + `sqlite.ts` (strategy_context) | patrón de migración existente | adaptar |
| B12, B13 | `types.ts` + executor (cambios en `execute_trade_mt5.ts`) | `computePipValueUSD`, `computeLotFromRisk`, cadena SL multi-activo del Pine | adaptar |
| B14 | `position_manager.ts` (BE estructural) | position_manager | adaptar |
| B16 | `engine.ts` (gates) | `check_news`, kill-switches de `risk_controls` sin cambios | reutilizar |
| B17, B18 | `backtest/strategy_runner.ts` | `calculateMetrics`, `monteCarloSimulation`, `WalkForwardAnalyzer`, fricción de `simulator.ts` | reutilizar + runner nuevo |

Puntos de inserción en el pipeline (dos modos, decisión en Fase de diseño):
- **Modo FUENTE** (recomendado): el engine fabrica el `TradePlan` determinista tras `pipeline.ts:529-534` y salta debate/manager/planner; persiste `EXECUTE` para atravesar el hard-gate.
- **Modo FILTRO**: el LLM propone como hoy y el engine veta/corrige tras `pipeline.ts:566-568` (gate `strategy_engine` añadido a `CRITICAL_GATES`).

---

## 7. Decisiones abiertas para el propietario (antes de implementar)

1. **Modo de inserción**: FUENTE (motor manda, LLM narra) vs FILTRO (motor veta al LLM). Recomendación: FUENTE.
2. **`breakevenMode`**: `structural` (recomendado, fiel al material) vs `1:1 fijo` vs `off`.
3. **`minRR`**: 2.0 propuesto — confirmar o ajustar.
4. **Modo degradado sin M1** (R9.4): ¿permitido en vivo con flag, o M1 es innegociable?
5. **Londres como segunda killzone**: el material es NY-centric para US30; ¿se habilita Londres para XAU/GBPJPY desde V1 o queda V2?
6. **Umbrales de B18**: confirmar los valores mínimos de aceptación.
7. **Prerrequisito de datos**: ¿se autoriza construir el descargador/store de velas multi-TF (M1 incluido) necesario para backtest, hoy inexistente (riesgo 1 de Fuente C)?

## 8. Checklist de validación (gate hacia implementación)

- [ ] Propietario valida los 18 bloques contra su operativa (especialmente B5.3, B10.1, B12.2, B13.1).
- [ ] Decisiones abiertas §7 resueltas.
- [ ] CI verde en GitHub (commits locales `ecbda69`, `1dfc06d` pendientes de push).
- [ ] Datos multi-TF disponibles (histórico M1 para backtest + feed vivo).
- [ ] `npm test` verde con el nuevo módulo `src/strategy/` en modo SHADOW (registra señales, no ejecuta) durante N días de mercado.
