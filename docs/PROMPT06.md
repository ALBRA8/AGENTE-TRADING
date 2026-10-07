# PROMPT 06 — Implementación de referencia (estado tras Task 10-d)

Este documento resume **dónde vive cada sección del PROMPT 06 en el código** y qué
se ADAPTÓ (arquitectura existente, Task 1–8) versus qué es NUEVO (Task 9/10).
Es un mapa de auditoría: cada sección apunta a archivos concretos y al trabajo
que la verificó (suites `tests/*`).

---

## §1 — Capas y archivos

El agente queda organizado en capas independientes donde la inferior NO puede ser
saltada por la superior:

| Capa | Archivos | Origen |
|---|---|---|
| Datos vivos | `src/config/mt5bridge.ts` (cliente HTTP con timeout), `bridge.py` (token obligatorio en `/order` y `/cancel`) | Adaptado (Task 8-a) |
| Verdad / gates | `src/agent/tools/check_*`, `analyze_market.ts`, `src/smc/live.ts`, `src/agent/risk_controls.ts` | Adaptado + endurecido (Task 8/10-a) |
| Cerebro | `src/agent/pipeline.ts` (multi-rol, JSON o REVIEW), `src/config/nvidia.ts` (+ provider mock §16) | Adaptado + Task 10 |
| Gobernanza | `src/agent/policy.ts`, `src/agent/execution_guard.ts` | NUEVO (Task 10) |
| Ejecución | `src/agent/tools/execute_trade_mt5.ts` (hard-gate one-shot + sizing) | Adaptado (Task 8-a) |
| Memoria / skills | `src/database/sqlite.ts`, `src/agent/self_improve.ts`, `consolidation.ts`, `src/skills/registry.ts` | Adaptado + NUEVO (Task 10-c) |
| Interfaces | `server.ts` (policy API), `src/bot/telegram.ts` (gobernanza), `public_adaptada/` (badge, kill switch, Doctor, Skills) | Adaptado + Task 10-d |
| Tests | `tests/smoke_phases.ts`, `truth_data.test.ts`, `risk_smc.test.ts`, `backtest_validity.test.ts`, `memory_skills.test.ts`, `e2e_pipeline.ts` | NUEVO |

## §2 — Auditorías 9-a…9-i (hallazgos principales)

- **9-a**: Tavily sin timeout y duplicados de noticias → AbortController 8s + dedup por URL.
- **9-b**: gates fail-open (news/dxy/rvol/price_feed caían a GREEN ante tool crash) → UNKNOWN fail-closed; RVOL fabricaba 1.00x → UNKNOWN honesto.
- **9-c**: killzones solo en el prompt → en código por símbolo; símbolo sin política → UNKNOWN; XAU restringido a Londres+NY.
- **9-d**: settlement honesto (PnL real del bridge, `outcome_source`, sin inventar cierres).
- **9-e**: `PIPELINE_GATE=off` (bypass) eliminado; hoy el escape es un aviso de que fue solicitado e ignorado (§23).
- **9-f**: `policy_events` append-only como columna vertebral de gobernanza.
- **9-g**: backtester NO VÁLIDO/NO REPRODUCIBLE (entrada en hindsight, P&L fabricado, sin seed/hash) → veredicto INVALID (ver §7).
- **9-h**: snapshot del brain escribía sin token → fail-closed; DASHBOARD_TOKEN obligatorio para mutar.
- **9-i**: el LLM podía auto-validarse/auto-promover lecciones → gate de promoción humano (Task 10-c).

## §5 — Execution Guard independiente

`src/agent/execution_guard.ts` → `assertOrderAllowed(order, ctx, tick)` con 9 checks
fail-closed, invocado **desde dentro de `MT5Bridge.placeOrder`** (el único punto por el
que pasa cualquier orden real): kill switch, autorización LIVE, whitelist
`ALLOWED_SYMBOLS`, volumen (≤ `MAX_LOT`), lados SL/TP, tick fresco (`MAX_TICK_AGE_S`),
spread (`MAX_SPREAD_PCT`), sanidad de entrada, `getAccountRisk` re-evaluado **en el
envío** y dedup one-shot. Rechazo → excepción `code: "GUARD_REJECTED"` y la orden
nunca sale del proceso.

## §6 — Verdad / truth levels

- Precio/estructura: solo `MT5Bridge` (candle/tick freshness en `smc/live.ts`, `check_rvol.ts`); feed rancio → `DATOS STALE` → gate UNKNOWN.
- Analistas: los números vienen de código determinista, no del LLM.
- Memoria (`truth_level`): `OBSERVED` (settlement con PnL cerrado) > `REPORTED` (usuario) > `INFERRED` (detector/LLM). Toda lección lleva `evidence_json` citable (Task 10-c).
- Provider contract (§16): `LLM_PROVIDER=mock` devuelve fixtures deterministas SOLO para E2E/tests; fail-safe: con `LIVE_TRADING=true` el mock lanza error (`src/config/nvidia.ts`).

## §7 — Backtest: veredictos

Auditoría 9-g: el motor de simulación es **INVALID / NOT REPRODUCIBLE** hasta tener
manifest completo (`backtest_runs`: `data_hash`, `params_json`, `code_version`,
`seed`) y las 8 correcciones de validez documentadas en el worklog 9-g. Los modos
`report` (journal real) son los únicos alimentando decisiones; `simulation/stress/
wfa/portfolio/regime` quedan etiquetados NO-OPERATIVOS. Suite: `tests/backtest_validity.test.ts`.

## §8 — Sizing

`execute_trade_mt5.ts`: valor-pip exacto desde `symbol_info` (`trade_tick_value /
trade_tick_size`), fallback honesto a tabla `PIP_VALUE_USD` (+ env overrides), lote
round-down a `volume_step`, caps `volume_min/volume_max/MAX_LOT`, riesgo forzado al
`risk_pct` de la decisión (el LLM no puede inflarlo). Sin riesgo numérico en la
decisión → RECHAZO (§8 fail-closed). Suite: `tests/risk_smc.test.ts`.

## §9 — Kill switch + Policy

`src/agent/policy.ts`: `getPolicy()` (modos PAPER/SIMULATION/BACKTEST/RECOMMENDATION/
MANUAL_APPROVAL/LIVE), kill switch GLOBAL (activo → ninguna orden desde NINGUNA
interfaz), setters auditados (`setPolicyMode/setAutonomyLevel/setAutonomyCeiling/
setKillSwitch`) que escriben en `policy_events` (append-only: quién/cuándo/por qué).
Interfaces de gobernanza: Telegram `/kill /modo /nivel /techo /policy`, dashboard
`POST /api/policy` (exige `DASHBOARD_TOKEN`, fail-closed si falta) y botón 🛑 Kill en la UI.

## §10 — Paper por defecto

Sin `LIVE_TRADING=true` **nada** toca el broker: `execute_trade_mt5` calcula y
registra la orden con `status="demo"` en `trade_orders`; `ordersReceived` del broker
queda vacío (verificado en E2E). El doble factor LIVE se prueba en el escenario 7 del E2E.

## §11 — Doble factor

LIVE exige **policy mode=LIVE + techo ≥ L4 + nivel efectivo ≥ L4 + env
`LIVE_TRADING=true` + decisión `approval_status='approved'`**. Nunca se infiere de
API keys, MT5 o del bridge. El arranque del servidor aborta si LIVE sin
`DASHBOARD_TOKEN` (§11 en `server.ts`).

## §12 — Approval contract

`decision_log.approval_status` (`auto|pending|approved|rejected`) + `consumed_at`
(one-shot). `approveDecision(id, actor)` solo acepta EXECUTE pendiente no consumida;
exposto en dashboard (`action:"approve"`) y Telegram `/aprobar <id>`.

## §13 — Verificación de ejecución

Tras `POST /order`, `placeOrder` compara retcode (10008/10009), precio y volumen
request-vs-actual → `verification: "verified" | "divergence"`, persistido en
`trade_orders.verification_status`. `BRIDGE_TIMEOUT` → estado UNKNOWN, decisión
queda consumida (sin reintentos que dupliquen).

## §19 — Niveles de autonomía

L0 OBSERVE … L5 SELF-IMPROVE con **techo** duro (`min(nivel, techo)` = efectivo).
LIVE imposible sin subir el techo a ≥ L4 explícitamente (`setPolicyMode("LIVE")`
lanza error con techo L<4 — freno de dos llaves). Por defecto PAPER L2 techo L2.

## §20 — Doctor

`src/agent/doctor.ts`: `runDoctor()` agrega checks existentes en 9 secciones
(SYSTEM/MARKET_DATA/STRATEGY/RISK/EXECUTION/SECURITY/MEMORY/SKILLS/TESTING) con
veredicto OK/WARN/FAIL + score 0-100; `runDoctorRepairs()` solo operaciones
deterministas documentadas. Expuesto en `GET /api/agent/doctor`, tool `runDoctor`
y vista 🩺 Doctor de la UI.

## §21-22 — Observabilidad y auditoría

- `observability.ts` + `GET /api/agent/status` (decisiones 24h/7d, tokens, latencia, safety) + `GET /api/trackrecord`.
- `policy_events` (gobernanza), `backtest_runs` (reproducibilidad), `agent_errors`/`agent_lessons` (auto-mejora) — todo consultable y sin UPDATE de historia.

## §24-25 — Tests + E2E

| Suite | Cubre |
|---|---|
| `tests/smoke_phases.ts` | fases del agente, licencia, registry |
| `tests/truth_data.test.ts` | §6 datos honestos (rvol/stale/UNKNOWN) |
| `tests/risk_smc.test.ts` | §8 sizing, kill-switches de cuenta, SMC en vivo |
| `tests/backtest_validity.test.ts` | §7 veredictos de validez |
| `tests/memory_skills.test.ts` | MemoryDV, gate de promoción, skills, doctor (46 asserts) |
| `tests/e2e_pipeline.ts` | **§25 E2E completo**: mock bridge HTTP + `LLM_PROVIDER=mock` + Tavily interceptado + reloj congelado (martes 10:30 NY). Happy path (EXECUTE → orden `[DEMO]` en `trade_orders`, 0 órdenes al broker) + **10 rechazos**: risk exceeded (guard en el envío), stale data, missing SL, invalid size (below_min), daily loss (gate RED → ABORTED), kill switch (EXECUTE→WAIT + policy block), approval missing (LIVE sin humano), permission denied (techo), broker unavailable, duplicate order (one-shot). Siempre termina en NO TRADE con `ordersReceived` vacío. |

Ejecutar: `npm test` (todo) o `npm run test:e2e`. El E2E borra su DB temporal
(`data/e2e_test.db`) al terminar y no consume APIs externas ni tokens.

## §27 — No-sobre-arquitectura: ADAPTADO vs NUEVO

- **ADAPTADO** (sin reescribir): pipeline multi-rol, tools de análisis, sizing del
  tool de ejecución, settlement, track record, dashboard Express, bot grammy.
- **NUEVO**: `policy.ts`, `execution_guard.ts`, `doctor.ts`, `consolidation.ts`,
  `skills/registry.ts`, provider mock en `nvidia.ts`, tabla `policy_events`/
  `backtest_runs`, endpoints de policy/doctor/skills, comandos de gobernanza en
  Telegram, vistas Doctor/Skills + badge de gobernanza en la UI, y el E2E.
- Se conservaron los bugs conocidos de `src/backtest/` (29 errores tsc
  pre-existentes) como registro honesto del §7: arreglarlos sin el manifest de
  reproducibilidad sería maquillar INVALID.

## Pendientes humanos

1. **Rotar la key de Tavily** (filtrada en el historial del repo público; el código actual la lee solo de `.env`).
2. **Purgar el historial de git** (secretos antiguos) y rotar cualquier credencial afectada.
3. Reconstruir `src/backtest/` con manifest de reproducibilidad antes de usar cualquier métrica del motor de simulación (§7).
4. Configurar `DASHBOARD_TOKEN` en el servidor para habilitar los controles de gobernanza del dashboard (hoy fail-closed: 503).
