# MAPA DE INTEGRACIÓN — STRATEGY ENGINE DETERMINISTA (SMC 3 Pilares)

Task: mapa-2 · Agente: EXPLORER-ARCHITECT (solo lectura) · Fecha: auditoría sobre el árbol actual de AGENTE-TRADING.
Fuente de verdad de la estrategia: `instrucciones.txt` (P1=H1 dirección, P2=M15 estructura+POI, P3=M5/M1 confirmación+ejecución; killzones; liquidez interna/externa; SL estructural; TP=liquidez externa).

---

## Resumen ejecutivo

1. El repo ya tiene un detector SMC REAL y probado (`src/backtest/smc_detector.ts`) cableado a velas de MT5 en vivo vía `src/smc/live.ts`, pero trabaja **una sola TF por llamada**, sin alineación H1→M15→M5→M1 y sin liquidez de sesiones.
2. La cadena objetivo (H1 contexto → High/Low de Londres → sweep NY → POI M15 válida → retorno → CHOCH M1 → retest → entrada) exige 5 piezas nuevas: sesión-liquidez, validador de POI con polaridad/toma-previa, confirmación M5, trigger M1+retest y el orquestador. Los primitivos (swings, BOS/ChoCh, FVG, OB, tendencia, RVOL, killzones DST-safe) ya existen y son reutilizables.
3. El pipeline de decisión (`src/agent/pipeline.ts`) decide HOY con el LLM (debate→manager→planner, `setup: "fvg|order_block|breaker|choch|otro"` en pipeline.ts:381). Hay DOS puntos de inserción limpios para un `StrategySignal` determinista: engine-como-fuente (sintetiza el `TradePlan` y salta el LLM decisor) y engine-como-filtro (veta/corrige el plan del LLM tras `stagePlanner`).
4. El comité de riesgo (`risk_controls.ts`), el policy gate, el hard-gate one-shot y el execution guard operan sobre la decisión/orden, no sobre su origen: **un setup del engine los atraviesa sin cambios**.
5. El registro OpenTrade actual (`decision_log` + `trade_orders`) no captura POI, sesión, tipo de liquidez barrida, trigger ni retest; hace falta una columna JSON de contexto de estrategia (migración ad-hoc ya es el patrón del repo, sqlite.ts:197-247).
6. El backtest actual prueba un flip de bandas ATR (Pine v2: `trend_dir` por `ta.atr`, zarus30_v2_strategy.pine:117-149) o el detector single-TF con entrada al close; para backtestear LA estrategia hacen falta: cargador multi-TF alineado, modelado de LIMIT en retest y datos M1 históricos. `simulateTrades` es reutilizable adaptando el fill; métricas/MonteCarlo/WFA son reutilizables tal cual.
7. Riesgo #1 de integración: las velas solo existen en vivo vía bridge Windows (`copy_rates_from_pos`, ventana móvil, sin caché ni histórico persistido); sin M1 histórico garantizado no hay backtest fiel del trigger ni del retest.

---

## 1. src/smc/live.ts — exports, tipos y qué falta

`src/smc/` contiene UN único módulo: `live.ts`.

**Exports exactos:**
- `type LiveTrend = "ALCISTA" | "BAJISTA" | "RANGO" | "UNKNOWN"` (live.ts:26).
- `interface LivePOI` (live.ts:29-39): `kind: "ORDER_BLOCK" | "FVG"`, `direction`, `top`, `bottom`, `candleIndex`, `time`, `mitigated`, `origin: string` (origen auditable).
- `interface LiveStructureShift` (live.ts:41-49): `type: "BOS" | "ChoCh"`, direction, price, time, candleIndex, confidence, rvol.
- `interface LiveAnalysis` (live.ts:51-79): available/unavailableReason, symbol, timeframe, trend, lastPrice, candleCount, asOf, swings, structureShifts, fvgs, pois, setupValid, confidence, dataStale/staleReason, lastCandleClosed, truthLevels (OBSERVED/INFERRED), reportText.
- `async function analyzeLiveStructure(symbol, timeframe, candles?, opts? { now })` (live.ts:350-555): única API pública.

**Constantes de configuración** (live.ts:84-110): `SUPPORTED_TIMEFRAMES = {M1,M5,M15,H1}` (:84), `CANDLES_TO_FETCH = 200` (:85), `TF_MINUTES` (:87), `MIN_CANDLES = 60` (:106), `OB_SCAN_BACK = 20` (:108), `SOP_RVOL_THRESHOLD = 1.5` (:110).

**Qué calcula:**
- Reutiliza el detector de backtest: `processCandles, detectSwingPoints, detectStructureShifts, detectFVGs, isValidSetup` (import en live.ts:15-21).
- Corrige la mitigación de FVGs (`recomputeFvgMitigation`, live.ts:123-140) y re-asocia FVGs a setups (`associateCorrectedFvgs`, :148-160).
- Order Blocks reales: última vela contraria al impulso, escaneando ≤20 velas atrás del shift; zona = cuerpo; mitigado si el precio volvió (live.ts:168-212). NOTA: usa wick para test de mitigación del OB (:184-193) — decisión a reverificar contra "mitigación por invasión total" del Pine.
- Tendencia derivada del patrón real de swings (higher-low+ruptura→ALCISTA, etc.), NO del rótulo del shift, porque el detector emite BOS+ChoCh emparejados (comentario live.ts:214-227; código :228-271).
- Higiene de datos: vela en curso EXCLUIDA (:417-427), staleness `(now − última cerrada) > 3×TF` → `dataStale` (:439-448), fail-closed total (bridge caído/velas insuficientes/throw del detector → `available:false`, :359-379, :550-554).
- Setup válido: `isValidSetup` con `requireFVG:true, requireKillzone:false, rvolThreshold:1.5` (:479-483) — la killzone la valida el gate del pipeline.

**Qué le falta para la estrategia objetivo:**
- Multi-TF: una llamada = una TF; no hay H1→M15→M5→M1.
- `LivePOI` no modela breaker/polaridad, ni "toma previa de liquidez antes del BOS" (requisito instrucciones.txt §1/§Reglas), ni High/Low de Londres como POI.
- No existe: detección de sweep de liquidez, retorno al POI, CHOCH M1 como trigger, retest del bloque del CHOCH, SL estructural (el del low/high que generó el ChoCh), TP=liquidez externa.
- `confidence` es una heurística de RVOL (rvol/2, ChoCh×0.8, live.ts:497-507), no un score de la estrategia.

## 2. Datos multi-TF: de dónde salen y qué falta

- **Fuente única en vivo: bridge.py (Flask, Windows, `http://localhost:5001`)**. `GET /candles/<symbol>/<timeframe>/<count>` (bridge.py:211-238) → `mt5.copy_rates_from_pos(resolved, tf, 0, count)` (:222). TFs soportados por el puente: `TIMEFRAME_MAP = {M1, M5, M15, H1, H4, D1}` (bridge.py:69-76). NO hay TradingView ni sqlite de velas ni ningún otro feed.
- **Cliente**: `MT5Bridge.getCandles(symbol, tf, count)` (mt5bridge.ts:198-203), con timeout `BRIDGE_TIMEOUT_MS=5000` (mt5bridge.ts:16-20).
- **Quién pide velas hoy y cuántas**:
  - `analyzeLiveStructure` → 200 velas de UN TF (live.ts:391).
  - `checkRVOL` → 25 velas del TF del pipeline (check_rvol.ts:115).
  - `run_backtest_pro` modo simulation → velas del bridge para el backtest (run_backtest_pro.ts:241-264; engine cap 5000 velas, engine.ts:195, 215).
- **Config de TF**: el pipeline recibe `timeframe` opcional y default `M5` (pipeline.ts:521; run_decision_pipeline.ts:40); enum H1|M15|M5|M1 en tools (run_decision_pipeline.ts:25). **El pipeline analiza UN solo TF** (analyzeMarket con ese TF, pipeline.ts:220).
- **Caché/store de velas: NO EXISTE**. Cada llamada es HTTP fresco al bridge; sqlite solo guarda decisiones/órdenes/lecciones (sqlite.ts:74-153). No hay backfill, no hay alineación entre TFs, no hay histórico persistido.
- **Para H1+M15+M5+M1 sincronizados en vivo haría falta**: (a) un orquestador que pida los 4 TFs por ciclo y los alinee por timestamp (los `time` ISO del bridge vienen de MT5 y son comparables); (b) un scheduler de "cierre de vela" por TF (hoy NO existe ningún loop por vela: solo el settlement cada 60 min, settlement.ts:264-294); (c) una caché en memoria/disco con dedupe por `time` para no depender de 200 velas exactas; (d) decidir profundidad M1 (200 velas M1 ≈ 3,3 h — suficiente para trigger/retest del día, insuficiente si se quiere M1 de varias sesiones).
- **Detalle puente**: `normalize_symbol` resuelve variantes Vantage (bridge.py:81-108) — el engine debe usar siempre el `symbol` normalizado devuelto (`"symbol": resolved` en la respuesta :238).

## 3. Sesiones y killzones

- **Módulo**: `src/agent/tools/check_market_hours.ts`. Función pura `evaluateMarketHours(rawSymbol, now?)` (:48-162) + veredicto tipado `MarketHoursVerdict` (:15-31) con `isLondon/isNY/isAsian/isLondonSession/isNYKillzone/blocked/unknown`. El tool `checkMarketHours` solo formatea (:169-222).
- **DST-safe**: hora NY con `Intl.DateTimeFormat("America/New_York")` (:53-59) — sin offset fijo.
- **Sesiones en hora NY**: Londres 3-12, NY 8-17, Asia 19-4 (:64-66). Killzones: NY 8-12 (:69), Londres 3-12 (:70).
- **Políticas por activo** (:92-159): fin de semana → RED; US30/NAS100/SPX500 → killzone NY 8-12 obligatoria; GBPJPY/EURJPY → solo Londres; XAUUSD → Londres+NY; crypto 24/7; símbolo sin política → `unknown` (fail-closed).
- **High/Low de sesión: NO EXISTE**. Grep de `londonHigh|sessionHigh|london_high|sessionRange|asiaRange` sobre src/ → 0 resultados. El rango de Asia y el High/Low de Londres no se registran en ningún sitio.
- **Dónde añadirlo**: módulo nuevo `src/strategy/session-liquidity.ts` que, alimentado con velas M5/M1 del día, calcule Asia range (19:00-04:00 NY) y London High/Low (03:00-12:00 NY) usando los mismos límites de `evaluateMarketHours`, y detecte el sweep de NY (ruptura del High/Low de Londres durante la killzone 8-12). Duplicación a vigilar: `analyze_market.ts` replica el reloj NY y la killzone por su cuenta (getNYClock :30-41, isNYKillzone :73-75).
- **Divergencia DST en backtest**: `isNYKillzone` del detector usa EST=-5 FIJO (smc_detector.ts:355-360), distinto del live DST-safe. El engine debe usar una única fuente (la de `check_market_hours`).

## 4. Pipeline de decisión: nombres exactos y puntos de inserción

Archivo: `src/agent/pipeline.ts` (único; no hay research_manager.ts ni trade_planner.ts separados — son stages internos).

**Exports**: `GateStatus`, `FinalAction`, `Gate`, `PipelineResult` (:32-68), `runDecisionPipeline(opts)` (:519-709). **Privados (NO exportados)**: `ManagerVerdict` (:41-46), `TradePlan` (:48-55: action/direction/stopLossPips/riskPct/setup/reasoning), `RiskOpinion` (:57-60).

**Etapas reales**:
1. `stageAnalysts` (:212-286): 5 tools en paralelo — checkMarketHours/checkNews/checkDXY/checkRVOL/analyzeMarket (:215-221) — y gates por **string-matching del markdown** (p.ej. `hours.includes("🔴 RED — pipeline debe ABORTAR")` :228-241; price_feed :279-283).
2. `stageDebate` (:289-321): toro vs oso, tier quick.
3. `stageManager` (:324-358): JSON `{bias, confidence, conditions, rationale}`.
4. `stagePlanner` (:361-409): JSON `{action, direction, stopLossPips, riskPct, setup, reasoning}`; **el enum de setup vive en el PROMPT**: `"setup":"fvg|order_block|breaker|choch|otro"` (:381); `setup` se guarda como string libre truncado a 40 (:403).
5. `stageRiskTrio` (:412-457): 3 LLM quick, JSON ilegible = VETO (:440-444).
6. Gate final en código (:582-630): `CRITICAL_GATES = [market_hours, news, rvol, price_feed, account_risk]` (:602); UNKNOWN→WAIT; YELLOW+confianza<0.65/NEUTRAL→WAIT (:607-616); YELLOW→EXECUTE con riskPct 0.25 (:617-620).
7. Policy check (:632-654) → `saveDecision` (:657-674) → render.

**Dónde se decide el setup HOY**: en el planner LLM (:361-409). El LLM también elige dirección y SL (con guía de tabla en el prompt :379).

**Punto de inserción — OPCIÓN A "engine-como-fuente" (bypass del LLM decisor)**:
- Tras `stageAnalysts`/`stageAccountRisk` (pipeline.ts:529-534) insertar `const signal = await runStrategyEngine(symbol)`.
- Si `signal` existe: construir el `TradePlan` desde el signal (direction=signal.direction, stopLossPips=SL estructural del M1, riskPct=0.5, setup=`"strategy_engine:<poiKind>"`) y SALTAR debate/manager/planner (o correrlos en modo "explicador" para el markdown). El plan pasa por el MISMO gate final, policy y `saveDecision` (:582-674) — requisito duro: para ser ejecutable la decisión debe persistirse como `final_action='EXECUTE'` porque `executeTradeMT5` lee `getRecentExecuteDecision(symbol, 15min)` (execute_trade_mt5.ts:270).
- El LLM queda relegado a redactar la explicación del setup ya detectado (exactamente el mandato del proyecto).

**Punto de inserción — OPCIÓN B "engine-como-filtro"**:
- Mantener el pipeline LLM íntegro; después de `stagePlanner` (:566-568) y antes del trío de riesgo:
  - Si `plan.action === "EXECUTE"` y el engine NO tiene setup activo coherente → degradar a WAIT (razón auditable "sin StrategySignal determinista").
  - Si el engine SÍ tiene setup: sobrescribir `plan.stopLossPips` (estructural), `plan.setup` y opcionalmente `plan.direction` con los del signal.
- Alternativa complementaria: añadir un gate `strategy_engine` a `gates[]` e incluirlo en `CRITICAL_GATES` (:602) para que un engine sin señal bloquee EXECUTE por la vía estándar fail-closed.

**Nota de contrato**: `TradePlan`/`ManagerVerdict`/`RiskOpinion` no se exportan — si el engine va a fabricar el plan, conviene exportar el tipo (hallazgo ya registrado por el auditor 12-c).

## 5. Riesgo: kill-switches existentes y cómo pasa el engine

Archivo: `src/agent/risk_controls.ts` (+ policy + execution_guard).

- **Límites** (`getRiskLimits`, :80-87): `MAX_DAILY_LOSS_PCT=1`, `MAX_OPEN_POSITIONS=2`, `MAX_CONSECUTIVE_LOSSES=2`, `MAX_TOTAL_EXPOSURE_LOTS=3` (env-overridable leído en cada llamada).
- **Evaluación** (`getAccountRisk`, :109-252): proveedores inyectables (`RiskProviders` :24-31: account/positions/pnlToday/consecutiveLosses; defaults MT5Bridge+sqlite :91-98). Fail-closed: fuente caída = violación (:172-220). `evaluated=false` → UNKNOWN que bloquea igual (:169). PnL diario desde `outcome_pnl` settled del día UTC (sqlite.ts:867-880); racha por `outcome_pnl` descendente (:888-904).
- **Consumo**: `stageAccountRisk` (pipeline.ts:187-209) → gate `account_risk` (RED/UNKNOWN bloquea EXECUTE por :602-611).
- **Capas aguas abajo (independientes del origen de la señal)**:
  - Policy: `initialApprovalStatus`/`assertExecutionForDecision` (policy.ts:103, :133) — LIVE exige modo LIVE + nivel L4+ + `LIVE_TRADING=true` + decisión aprobada (policy.ts:155-165).
  - Hard-gate one-shot en `executeTradeMT5`: decisión vigente ≤15 min, dirección coincidente, SL acotado 0.5×–1.25× del plan, riskPct forzado de la decisión, claim atómico (execute_trade_mt5.ts:270-329).
  - EXECUTION GUARD dentro de `MT5Bridge.placeOrder` (mt5bridge.ts:217-254; `assertOrderAllowed` execution_guard.ts:61): tick vivo, spread, dedup, re-check de cuenta.
- **Cómo someter un setup del engine sin fricción**: el engine NO toca `risk_controls.ts`. El signal se convierte en decisión (`saveDecision`) y de ahí en orden; las 4 capas (account_risk gate, policy, hard-gate, guard) se aplican idénticas porque juzgan decisión/orden, no origen. Única decisión de diseño: si el engine-emite-EXECUTE directo, el `riskPct` del signal (0.5% del SOP, instrucciones.txt §3) viaja en `saveDecision({riskPct:0.5})` para que el binding del hard-gate lo fuerce igual.

## 6. Ejecución y OpenTrade: flujo actual y huecos de registro

**Flujo señal→orden→settlement** (todo verificado):
1. `executeTradeMT5` (tool, execute_trade_mt5.ts:202-571): hard-gate one-shot (:261-329) → health del bridge (:333) → account+tick+symbol_info (:340-352) → sizing `computePipValueUSD` (:109-121, symbol_info exacto o tabla `PIP_VALUE_USD` :57-67) y `computeLotFromRisk` round-down (:140-175) → orden LIMIT en retroceso del 50% del SL (:399-416: `entryPrice = ask − 0.5×SL×pipSize`), **TP fijo 1:3** (:409/:413) → comment auditable `AGT-<DIR>-<SYMBOL>-<decisión>` (:420) → expiración = 15 min (:437, `DECISION_VALIDITY_MINUTES` :51) → DEMO por defecto sin `LIVE_TRADING=true` (:443-481) → `placeOrder` con guard + verificación §13 (:488-491) → `saveOrder` (:522-538) con `strategy: "SMC-hardgate"`.
2. **trade_orders** (sqlite.ts:136-150): decision_id, symbol, direction, order_type, volume, entry_price, stop_loss, take_profit, ticket, risk_pct, status + migraciones risk_amount/strategy/expiration/verification_status/slippage (:228-247).
3. **Settlement** (settlement.ts:52-190, horizonte 24 h :34-37): busca orden por decision_id (:101); PnL por (a) log manual `trade_performance` casado por **símbolo+timestamp** sin ticket (:120-138 — riesgo de misatribución ya auditado), (b) flotante de posición viva (:141-155), (c) posición cerrada sin datos → expira tras 8 intentos (:157-171). `settleWithPnl` → `updateDecisionOutcome` + `reflectOnExperience` con evidencia OBSERVED (:212-243).

**Huecos para un registro OpenTrade completo** (POI, TFs, sesión, liquidez barrida, trigger, retest):
- `decision_log` tiene `entry_price` (sqlite.ts:82) pero el pipeline NUNCA lo rellena (saveDecision :657-674 no lo envía).
- No existen columnas para: POI (kind/top/bottom/origin/TF), sesiones (Londres/NY/Asia), tipo de liquidez (interna/externa/High-Low de Londres), trigger (CHOCH M1: precio/hora), precio de retest, nivel de SL estructural, nivel de TP=liquidez externa.
- Camino mínimo invasivo: una columna JSON `strategy_context` en `decision_log` y/o `trade_orders` vía el patrón de migración idempotente existente (pragma table_info + ALTER, sqlite.ts:197-247), escrita por el pipeline en modo engine-como-fuente (y en modo filtro, adjuntando el signal que aprobó/corrigió el plan).

## 7. Backtest: cómo enchufar el engine determinista

**APIs existentes**:
- `BacktestEngine.runBacktest(rawCandles, backtestConfig)` (engine.ts:206-370): Fase 1 `processCandles` → Fase 2 `detectFVGs`/`detectSwingPoints`/`detectStructureShifts`/`associateFVGsWithSetups` con filtro `confidence>0.5` (:269-280) → Fase 3 `simulateTrades` → Fase 4 `calculateMetrics` → Fase 5 MonteCarlo con PRNG sembrado `mulberry32` (:84-93) → manifest de reproducibilidad (`buildRunManifest` :120-153, `persistBacktestManifest` :160-184 → tabla `backtest_runs`; veredicto VALID/INVALID :49, :73-77).
- `simulateTrades(candles, setups, config, friction?)` (simulator.ts:146-459): entrada al close de la vela de confirmación `setup.index + SWING_LOOKBACK` (:172-179, `SWING_LOOKBACK=5` smc_detector.ts:20), SL fijo por activo (US30 15/NAS100 20/XAU 30/BTC 500/JPY 20, ChoCh×1.3, :107-143), TP=`tpRatio×SL` (:343-347), fricción spread/comisión/slippage (`DEFAULT_FRICTION` :76-80), ambigüedad intra-vela = SL primero (:226-249), gap-through honesto, MAE/MFE, timeExit 30 velas (:216-221).
- `WalkForwardAnalyzer.runWFA` (walk_forward.ts:65+) sobre `BacktestEngine` con grid `tpRatio/requireFVG/rvolThreshold/riskPerTrade`; sin solape train/test (:90-97).
- Tool expuesto: `runBacktestPro` con schema solo `report|simulation|stress` (run_backtest_pro.ts:60-62; el interface lista más modos :29 pero no están cableados). WFA real existe pero no está expuesto en ningún tool.

**Lo que prueba HOY el Pine v2 NO es esta estrategia**: `zarus30_v2_strategy.pine` dispara por flip de bandas ATR (`trend_dir` con `upper_band = high − 3×ATR` / `lower_band = low + 3×ATR`, líneas 117-149; `strategy.entry("L"...)` :190) con SL fijo por activo y TPs 1R/2R/3R — es el clon del script del usuario, no los 3 pilares SMC.

**Para backtestear LA ESTRATEGIA hacen falta**:
1. **Cargador multi-TF**: hoy solo hay ventana móvil del bridge por TF sin alineación; el engine determinista necesita H1+M15+M5+M1 del MISMO período (descarga propia o export de MT5; el bridge permite counts grandes pero sin garantía de profundidad M1).
2. **Simulador por eventos de vela con estado**: el motor de la estrategia es una máquina de estados (sesión→POI vigente→retorno→confirmación→trigger→retest→gestión). `simulateTrades` es un bucle single-series sobre setups precalculados; se reutiliza su gestión de P&L/fricción/MAE pero el bucle de entrada debe reescribirse para: LIMIT en el retest del bloque del CHOCH (fill solo si el precio vuelve al nivel), SL estructural (no pips fijos), TP = nivel de liquidez externa (no ratio fijo), BE@TP2 (equivalente a position_manager.ts), y eventos al CIERRE de vela M1/M5/M15/H1.
3. **Costes**: ya existen (spread/comisión/slippage DEFAULT_FRICTION, simulator.ts:76-80) — reutilizar.
4. **Killzone DST-safe en backtest**: reemplazar el EST=-5 fijo del detector (smc_detector.ts:355-360) por la lógica de `check_market_hours`.
5. **Salida compatible**: emitir `Trade[]` del mismo shape (types.ts:68-88) para reusar `calculateMetrics`, `monteCarloSimulation`, `calculateBuyHold`, reportes HTML y WFA sin cambios.

## 8. Propuesta de layout `src/strategy/` y tabla de reutilización

```
src/strategy/
  types.ts               — StrategySignal, H1Context, SessionLevels, ValidPOI,
                           M5Confirmation, M1Trigger, StrategyEngineConfig, EngineState
  h1-context.ts          — Pilar 1: dirección macro H1 (ALCISTA/BAJISTA/RANGO)
  session-liquidity.ts   — Asia range + London High/Low + sweep de NY (liquidez interna/externa)
  poi-validator.ts       — Pilar 2: POI M15 válido (origen de BOS + toma previa de
                           liquidez + cambio de polaridad/breaker + no mitigado)
  m5-confirmation.ts     — Pilar 3a: reacción al llegar al POI (impulso a favor)
  m1-trigger.ts          — Pilar 3b: CHOCH M1 + retest del bloque generador + SL estructural
  engine.ts              — orquestador: onCandleClose(tf) → StrategySignal | null;
                           modo fuente (fabrica TradePlan) y modo filtro (gate)
```

| Bloque de la estrategia | Archivo/módulo propuesto | Reutiliza (sí/adapta/nuevo) | Dependencia crítica |
|---|---|---|---|
| Primitivos de velas (OHLC→Processed) | src/strategy/engine.ts | **SÍ** — `processCandles` (smc_detector.ts:23-54) | Ninguna |
| Swings por TF (H1/M15/M5/M1) | engine.ts + cada pilar | **SÍ** — `detectSwingPoints` (smc_detector.ts:130-175); ojo `SWING_LOOKBACK=5` ⇒ confirmación diferida por TF | Lag de confirmación en M1 (5 velas = 5 min) |
| BOS/ChoCh por TF | poi-validator, m5-confirmation, m1-trigger | **ADAPTA** — `detectStructureShifts` (smc_detector.ts:178-329); semántica ya corregida | El emparejamiento BOS/ChoCh por ventana obliga a filtrar por contexto, no por rótulo |
| Dirección H1 (P1) | h1-context.ts | **ADAPTA** — `deriveTrend` de live.ts:228-271 (patrón de swings, no rótulo) | 200 velas H1 ≈ 8 días: suficiente |
| FVG y mitigación correcta | poi-validator.ts | **SÍ** — `detectFVGs` + `recomputeFvgMitigation` (live.ts:123-140) | Duplicar la corrección, no usar `associateFVGsWithSetups` tal cual |
| POI M15 = origen de BOS | poi-validator.ts | **ADAPTA** — `deriveOrderBlocks` (live.ts:168-212) ya da "origen de shift" | Falta: toma previa de liquidez y polaridad/breaker → lógica NUEVA sobre el OB |
| Liquidez interna/externa + sweep | session-liquidity.ts | **NUEVO** | Ningún precedente en el repo; necesita M5/M1 del día |
| High/Low de Londres + killzones DST | session-liquidity.ts | **SÍ** — límites de sesión de `evaluateMarketHours` (check_market_hours.ts:48-162) | Definir "cierre" del High/Low (12:00 NY) y el sweep durante 8-12 |
| Retorno al POI + confirmación M5 | m5-confirmation.ts | **ADAPTA** — detector M5 + `computeRvol` (check_rvol.ts:33-70) | Umbral RVOL 1.5 ya estandarizado (SOP_RVOL_THRESHOLD live.ts:110) |
| CHOCH M1 trigger + retest | m1-trigger.ts | **ADAPTA** — detector M1; retest = NUEVO | Fill del retest requiere modelado LIMIT (no existe) |
| SL estructural / TP=liquidez externa | engine.ts (types) | **NUEVO** (cálculo); **SÍ** el sizing de la orden: `computePipValueUSD`/`computeLotFromRisk` (execute_trade_mt5.ts:109-175) | SL en pips = distancia estructural ×pipSize |
| Inserción en pipeline (fuente o filtro) | src/agent/pipeline.ts (punto :529-534 o :566-568) | **ADAPTA** — importar engine, fabricar/filtrar `TradePlan` | Exportar tipos privados si el engine fabrica el plan |
| Comité de riesgo / policy / hard-gate / guard | risk_controls.ts, policy.ts, execute_trade_mt5.ts, execution_guard.ts | **SÍ, sin cambios** | `saveDecision` con riskPct para el binding |
| Registro OpenTrade enriquecido | sqlite.ts (migración) | **ADAPTA** — añadir `strategy_context` JSON con patrón :197-247 | `entry_price` de decision_log hoy sin usar |
| Backtest de la estrategia | src/backtest (nuevo runner `runStrategyBacktest`) | **ADAPTA** — reutiliza `simulateTrades` para P&L/fricción; bucle de entrada NUEVO; métricas/MC/WFA **SÍ** tal cual | Datos multi-TF históricos alineados (bloqueante) |
| Reproducibilidad §7 | engine.ts (backtest) | **SÍ** — manifest/data_hash/seed ya operativo | Registrar el engine en `params_json` |

---

## Riesgos de integración (ordenados por gravedad)

1. **Datos M1/M5 históricos inexistentes como dataset** (GRAVE): las velas solo llegan en vivo por el bridge Windows con `copy_rates_from_pos` (ventana móvil, bridge.py:222), sin caché ni persistencia; el backtest actual usa esa misma ventana (máx 5000 velas, engine.ts:195). Sin una descarga/export propia alineada multi-TF NO se puede backtestear el trigger M1 ni el retest, y el live queda ciego si el bridge cae (fail-closed ya existente). Además `BRIDGE_TOKEN` del bridge no tiene soporte cliente (mt5bridge.ts:131-164 no envía X-AGT-Token) — bloqueante para ejecución real previa al engine (hallazgo H1 del PROMPT 06).
2. **No existe scheduler por cierre de vela** (GRAVE): la única recurrencia del sistema es el settlement (60 min, settlement.ts:264-294). El engine necesita un reloj por TF (M1 cada minuto) y 4 fetches por ciclo; con `BRIDGE_TIMEOUT_MS=5000` por llamada (mt5bridge.ts:17-20) y gates por string-matching, la latencia de un ciclo completo puede comerse la ventana del trigger M1. Requiere un runner propio fuera del pipeline LLM cuando actúe como fuente.
3. **Contrato de simulación incompatible con la ejecución real de la estrategia** (ALTO): `simulateTrades` entra al close de la vela de confirmación con SL en pips fijos y TP 1:N (simulator.ts:172-179, :333-347), mientras la estrategia exige LIMIT en retest, SL estructural y TP=liquidez externa; modelar el fill del retest y la ambigüedad intra-vela M1 sin look-ahead es la pieza más delicada del backtest. Riesgos menores asociados: killzone EST=-5 fija del detector (smc_detector.ts:355-360) vs DST-safe del live; settlement sin ticket (misatribución de PnL que alimenta kill-switch y lecciones, settlement.ts:120-138); lógica de killzone duplicada en 3 sitios (check_market_hours.ts, analyze_market.ts:73-75, smc_detector.ts:355-360); SL contradictorios entre tablas (US30 15 en execute_trade_mt5.ts:79 vs 80 en Pine v2 vs bandas 0.5-1.25× del hard-gate).

## Anexo: mapa instrucciones.txt → módulos

| Regla del SOP (instrucciones.txt) | Módulo propuesto | Estado en el repo |
|---|---|---|
| §1 POI = origen de BOS válido con toma previa de liquidez (líneas 4-9, 78-83) | poi-validator.ts | Parcial: `deriveOrderBlocks` da el origen; falta toma-previa y polaridad |
| §2.A Pilares H1/M15/M5/M1 (líneas 10-16, 61-65) | h1-context + engine multi-TF | Ausente: pipeline single-TF (pipeline.ts:220) |
| §2.B Londres High/Low + neutralización NY (líneas 17-21, 41-44) | session-liquidity.ts | Ausente (0 matches en grep) |
| §3 Riesgo 0.5%/1% diario/2 pérdidas (líneas 22-28) | risk_controls.ts + signal.riskPct | Existente y probado (risk_controls.ts:80-87) |
| §4 Trigger: fallo estructural + ChoCh M5/M1 + retest + SL bajo el nuevo extremo (líneas 29-35) | m1-trigger.ts + engine | ChoCh existe (smc_detector.ts:254-325); retest y SL estructural nuevos |
| §Síntesis: TP = liquidez del extremo opuesto (líneas 50-59) | engine.ts (TP=liquidez externa) | Nuevo; el live usa TP 1:3 fijo (execute_trade_mt5.ts:409) |
