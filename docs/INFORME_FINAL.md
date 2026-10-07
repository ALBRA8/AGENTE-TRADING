# INFORME FINAL — PROMPT 06: FINALIZACIÓN AGENTE-TRADING

> Fecha: 2026-10-05 · Método: 9 auditores paralelos (Tasks 9-a..9-i) → 4 tracks de
> implementación (10-a..10-d) → integración + E2E + clean-room (10-e).
> Detalle de auditorías: `worklog.md` Tasks 9-a..9-i · Mapa de implementación: `docs/PROMPT06.md`.

## A. ESTADO

```text
READY WITH LIMITATIONS
```
Operativo y seguro **en PAPER/DEMO** (default). Limitaciones documentadas en E/I.
LIVE EXECUTION permanece DESHABILITADO por diseño (ver I).

## B. CAPACIDADES EXISTENTES (ya implementadas antes de este prompt)

- Pipeline de decisión 6 etapas con gates deterministas fail-closed (`pipeline.ts`)
- Hard-gate one-shot decisión→orden con binding de dirección/SL/riesgo (`execute_trade_mt5.ts`)
- SMC real en vivo: detector del backtest cableado a velas MT5 (`smc/live.ts`)
- Kill-switches de cuenta, sizing exacto por `symbol_info`, expiración de pendientes (`risk_controls.ts`, Task 8)
- Settlement con reflexión post-trade, Brain Score, Track Record (`settlement.ts`, `brain_eval.ts`, `trackrecord.ts`)
- Modo DEMO por defecto, server endurecido, licencia offline, compliance kit (Task 8)

## C. CAMBIOS REALIZADOS (este prompt — integración sobre rebuild, §27)

| Capa | Cambio | Archivos |
|---|---|---|
| §6/§19 Policy Engine | NUEVO: modos PAPER…LIVE, niveles L0-L5 con techo, kill switch global, `policy_events` append-only, aprobación humana | `src/agent/policy.ts`, `sqlite.ts` |
| §5 Execution Guard | NUEVO e independiente: 9 checks fail-closed DENTRO de `placeOrder` (kill switch, LIVE doble-factor, whitelist, volumen, SL/TP, tick fresco, spread, riesgo en el envío, dedup) | `src/agent/execution_guard.ts`, `mt5bridge.ts` |
| §13 Verificación | request-vs-actual (retcode 10008/10009, precio, volumen) → `verification_status` en `trade_orders`; timeout = orden `unknown` SIN release (anti-duplicado) | `mt5bridge.ts`, `execute_trade_mt5.ts` |
| §11/§23 Sin bypass | `PIPELINE_GATE=off` eliminado (solo aviso); boot aborta si LIVE sin `DASHBOARD_TOKEN`; bridge.py exige `BRIDGE_TOKEN` (anti drive-by) | `execute_trade_mt5.ts`, `server.ts`, `bridge.py` |
| §6 Verdad | RVOL sin fabricar 1.00x; gates news/dxy/price fail-closed; `dataStale` + vela-en-curso excluida; `truthLevels` (OBSERVED/INFERRED); killzones XAUUSD; símbolo sin política → UNKNOWN | `check_rvol/market_hours/news/live/analyze_market` |
| §23 Anti-injection | Noticias envueltas en `<<<UNTRUSTED>>>` (dato, nunca instrucción), timeout, dedup, timestamps | `check_news.ts` |
| §7 Backtest válido | ChoCh real (fix comparadores invertidos), FVG no nace mitigado, entrada en vela de confirmación (anti look-ahead), P&L real = lotes×Δ×pipValue, fricción, manifest {data_hash, params, seed, code_version} → todo output sin manifest = ⚠️ INVALID | `smc_detector/simulator/engine/run_backtest_pro` |
| §3/§4/§9 MemoryDV | Campos MemoryDV en `agent_lessons`; consolidación con validación estadística (Wilson LB); promoción SOLO con gate auditado; LLM ya no puede promover lecciones | `consolidation.ts`, `self_improve.ts`, `settlement.ts`, `search_lessons.ts` |
| §5 Skills | 17 SkillContracts declarativos (15 ACTIVE, 2 PENDING honestas) sobre funciones existentes, cero duplicación | `src/skills/registry.ts` |
| §20 Doctor | 9 secciones (SYSTEM…TESTING) con verdicts OK/WARN/FAIL + auto-repair solo determinista | `src/agent/doctor.ts`, tool `runDoctor` |
| §12/§19 Interfaces | API `/api/policy` (GET/POST con token obligatorio), Telegram `/kill /modo /nivel /techo /aprobar /policy`, UI badge `modo·L{eff}/L{techo}·🛑` + vistas Doctor/Skills | `server.ts`, `telegram.ts`, `public_adaptada` |
| §25 E2E | Happy path paper + 10 rechazos → NO TRADE (38 asserts) con mock bridge HTTP + provider LLM mock | `tests/e2e_pipeline.ts`, `nvidia.ts` |
| Infra | better-sqlite3 v11→v13 (elimina SIGABRT nativo de Node 24), `.env.example` completo, CI gate ≤29 | `package.json` |

## D. RIESGOS ENCONTRADOS (resumen — detalle en Tasks 9-a..9-i)

1. **ChoCh invertido** en el detector (señales contrarias al SOP alimentaban el debate)
2. **RVOL fabricado** (1.00x sin volumen) y gates news/dxy/price **fail-open** ante crash del tool
3. **Guard no independiente** + `PIPELINE_GATE=off` = puerta trasera + sin kill switch global
4. **Sin verificación post-orden** (retcode ignorado; timeout liberaba la decisión → orden duplicada)
5. **bridge.py sin auth** (drive-by de órdenes reales desde el navegador)
6. **Sin aprobación humana** para LIVE (EXECUTE se auto-autorizaba)
7. **Backtest inválido**: look-ahead estructural, P&L fabricado, crash en pérdidas, 0 reproducibilidad
8. **Self-improvement sin gate**: 1 trade → lección → system prompt (violación §3/§4)
9. **Prompt injection** sin mitigación (noticias crudas al contexto)
10. **Tavily key PÚBLICA en GitHub** (commit 93f1709 — confirmado HTTP 200)

## E. RIESGOS PENDIENTES

1. ⚠️ **ACCIÓN HUMANA BLOQUEANTE**: rotar la Tavily key en tavily.com + purgar historial git (`git filter-repo`) + force-push. El código ya no la contiene, pero la historia sí.
2. 29 errores tsc legacy en `src/backtest/` (stress_test/regime/portfolio) — módulos **etiquetados INVALID / no operativos**; no afectan al core (compila limpio) pero degradan el build parcial.
3. Skills VALIDATE_RETEST y ANALYZE_LIQUIDITY **PENDING** (no existen aún; el plan de trade no ancla SL/TP a POI/liquidez — marcado honesto en el registry).
4. Vectra (memoria vectorial) sigue con escritura manual; sin backfill semántico automático.
5. Un solo usuario/cuenta; sin MCP ni Agent-to-Agent (N/A hoy — cuando existan, deben montarse como tools dentro de la cadena gates+policy+guard).

## F. TESTS (resultados exactos)

```text
tests/smoke_phases.ts        51 asserts ✅  exit 0
tests/risk_smc.test.ts       33 asserts ✅  exit 0
tests/truth_data.test.ts     59 asserts ✅  exit 0
tests/backtest_validity.ts   38 asserts ✅  exit 0
tests/memory_skills.test.ts  46 asserts ✅  exit 0
tests/e2e_pipeline.ts        38 asserts ✅  exit 0
─────────────────────────────────────────────
TOTAL: 265 asserts · 0 fallos · 6 suites · exit 0
tsc --noEmit: 29 errores (todos legacy src/backtest/, gate CI ≤29)
```

## G. E2E (§25 — resultados exactos)

- **Happy path**: MARKET DATA (mock bridge HTTP) → ANALYSIS (mock LLM) → SMC real → EXECUTE (gates GREEN, policy ALLOWED·L2·PAPER) → PAPER EXECUTION → `[DEMO]`, `trade_orders.status="demo"`, **0 órdenes al broker**, decision_log con policy_result y approval "auto" → VERIFY/AUDIT ✓
- **10 escenarios de rechazo → NO TRADE (0 órdenes al broker)**:
  1 risk exceeded (guard: pérdida diaria) · 2 stale data (price_feed UNKNOWN) · 3 missing SL · 4 invalid size (below_min) · 5 daily loss exceeded (ABORTED pre-tokens) · 6 kill switch active (policy block) · 7 approval missing (LIVE sin aprobación) · 8 permission denied (techo L2 rechaza LIVE) · 9 broker unavailable · 10 duplicate order (one-shot)

## H. CLEAN-ROOM (§26 — resultado exacto)

```text
Clon fresco (solo commits) → sin node_modules/DBs/.env → npm install (322 paquetes, from scratch)
→ imports core + migraciones + policy default PAPER/L2 ✓ → build (52 js, core LIMPIO; parcial por legacy backtest — LIMITACIÓN)
→ typecheck 29 (≤29) ✓ → 6 suites: 265 asserts exit 0 ✓ → E2E 38 asserts ✓ → Doctor score 93/100 en fresh env ✓
CLEAN-ROOM RESULT: PASS=15 FAIL=0 → 🟢 CLEAN-ROOM = PASS
Script reproducible: /home/z/my-project/scripts/cleanroom_agt.sh
```

## I. LIVE TRADING

```text
DISABLED (por diseño; default PAPER)
```
Para habilitarlo se exigen TODAS estas barreras (en orden, cada una fail-closed):
`POLICY_MODE=LIVE` (auditado) + techo autonomía ≥ L4 (2ª llave) + nivel efectivo ≥ L4 +
`LIVE_TRADING=true` (2º factor, nunca inferido) + `DASHBOARD_TOKEN` (boot aborta sin él) +
aprobación humana por decisión (`/aprobar` o POST /api/policy approve) + kill switch off +
9 checks del Execution Guard en el punto de envío (incl. riesgo de cuenta re-evaluado) +
verificación request-vs-actual post-fill. **Con la Tavily key sin rotar y sin track record,
recomendamos NO habilitarlo** (ver A/E).

## J. MEMORYDV — estado real

- **EPISODIC**: `decision_log`/`trade_orders`/`trade_performance` + evidence_json por lección (decision_id, pnl, source)
- **SEMANTIC/PROCEDURAL**: `agent_lessons` extendido con memory_type/domain/confidence/truth_level/evidence_json/last_verified/utility/agent_id
- **Consolidación**: `consolidateMemory()` en el bucle de mantenimiento — patrón ≥5 ocurrencias → validación estadística (Wilson LB 95% sobre decision_log settled, n≥10) → `verified`; promoción SOLO vía `promoteLessonGated` (auditada en policy_events; el LLM NO tiene camino de promoción); auto-promoción OFF (doble llave: env + wilson≥0.6 + n≥30)
- Pendiente: backfill vectorial (vectra) y FACTUAL automático desde fuentes externas

## K. SKILLS — estado real

17/17 contratos definidos (`src/skills/registry.ts`, visible en `/api/skills`): 15 ACTIVE
mapeados a funciones existentes con regression_tests referenciados; 2 PENDING honestas
(VALIDATE_RETEST, ANALYZE_LIQUIDITY — no existe la detección en código; auditoría 9-c).
TOOL/SKILL/MEMORY/KNOWLEDGE/FEEDBACK/LEARNING/SELF-IMPROVEMENT quedan diferenciados en el contrato.

## L. DOCTOR — estado real

`runDoctor()` con 9 secciones (SYSTEM/MARKET DATA/STRATEGY/RISK/EXECUTION/SECURITY/MEMORY/SKILLS/TESTING),
verdicts OK/WARN/FAIL, score 0-100 (93/100 en clean-room), auto-repair SOLO determinista
(PRAGMA optimize, purga de errores resueltos >30d, backfill memory_type) y NUNCA sobre estrategia.
Expuesto en tool `runDoctor` y endpoint `/api/agent/doctor`.

## M. SELF-IMPROVEMENT — estado real

Ciclo controlado: EXECUTION → RESULT (settlement con PnL observado) → CAUSE ANALYSIS (reflexión
con evidencia y truth_level) → MEMORYDV → VALIDATION (Wilson + n mínimo) → CANDIDATE →
promoción GATEADA (auditada, jamás por el LLM) → regression tests existentes → contexto.
`LLM → modifica estrategia → live trading` es IMPOSIBLE: no hay tool de promoción y el
backtest sin manifest completo está etiquetado INVALID (no alimenta lecciones).

## N. RECOMENDACIONES (solo las necesarias)

1. **HOY**: rotar Tavily key + `git filter-repo` + force-push + pushear los commits locales
2. 90 días de track record en PAPER alimentado por settlement/Brain Score (`/api/trackrecord` ya lo sirve)
3. Implementar VALIDATE_RETEST y ANALYZE_LIQUIDITY (anclar SL/TP a POI/liquidez — auditor 9-c)
4. Arreglar stress_test/regime/portfolio (29 errores) si se quiere WFA/stress real; hasta entonces quedan INVALID
5. Backfill vectorial de memoria semántica (vectra) cuando haya ≥100 trades

---

**Principio final verificado**: el LLM propone; los datos verifican (truth levels, fail-closed);
la estrategia interpreta (detector real); el Risk Engine calcula (determinista, re-chequeado en el envío);
la Policy decide (modos/techo/kill switch); el Approval autoriza (humano, auditado); el Guard protege
(9 checks en el punto de envío); el broker ejecuta; el sistema verifica (request-vs-actual);
MemoryDV aprende (con validación estadística); el Doctor audita; y todo queda registrado
(policy_events, decision_log, trade_orders, agent_lessons, backtest_runs).
