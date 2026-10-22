# MIGRACIÓN PROYECTO → ARNÉS — Fase 0: Análisis (read-only)

Proyecto objetivo: **AGENTE-TRADING** (`/home/z/my-project/AGENTE-TRADING`, rama `feature/harness`).
Fecha: 2026-10-22 · Agente inyectado: **AGENTE-GENERAL (embebido, `GeneralAdapter`)**.

---

## 1. STACK IDENTIFICADO

| Detector | Resultado |
|---|---|
| `package.json` | SÍ → Node.js 22+, **ESM** (`"type":"module"`), TypeScript 5.6 strict |
| `requirements.txt` / `pyproject.toml` | NO (Python ad-hoc: `bridge.py` Flask 37KB + `__pycache__`) |
| `src/lib/` | NO (convención propia: `src/<dominio>/`) — se crea `src/lib/` solo para el arnés |
| `src/app/api/` | NO (Express 5 en `src/server.ts`, puerto 4000 — adaptar Fase 9 a Express) |
| Clasificación | **HÍBRIDO TS/Python**: bot TS + bridge Flask↔MT5 (puerto 5001) |

Dependencias clave: `express@5`, `better-sqlite3@13`, `grammy` (Telegram), `openai@4` (SDK → endpoint NVIDIA NIM OpenAI-compatible), `node-fetch`, `vectra` (memoria vectorial), `dotenv`, `cors`.
Build: `tsc` (rootDir `src` → `dist`), dev `tsx watch`. Tests: `tsx tests/*.ts` (13 suites, sin framework).

## 2. ARCHIVOS DEL AGENTE ENCARNADO (lógica embebida)

| Módulo | Rol | Llamadas externas |
|---|---|---|
| `src/config/nvidia.ts` | Cliente LLM NIM (Kimi/nemotron + tiers quick/deep) + embeddings + mock provider (§16) + retry | SDK `openai` → `integrate.api.nvidia.com/v1` (ÚNICO punto SDK del repo) |
| `src/config/mt5bridge.ts` (513 l.) | Cliente HTTP MT5: `MT5Bridge{health,getAccount,getPrice,getCandles,placeOrder,…}` + token `X-AGT-Token` + EXECUTION GUARD | Flask `http://localhost:5001` |
| `src/bot/telegram.ts` | Bot grammY (long polling), whitelist `ALLOWED_IDS` | Telegram API |
| `src/agent/` (13 módulos) | loop, pipeline (759 l.), policy, risk_controls, execution_guard, settlement, doctor, brain_eval, trackrecord, self_improve, consolidation, observability, position_manager, registry + `tools/` | consumen `callLLMByTier` (nunca SDK directo) |
| `src/agent/tools/search_market_memory.ts` | memoria vectorial | `getEmbeddings` + vectra |

Consumidores del LLM (`callLLMByTier`): `agent/loop.ts`, `agent/pipeline.ts`, `agent/self_improve.ts`, `agent/tools/log_trade_performance.ts`, `agent/tools/search_market_memory.ts`, `agent/settlement.ts`, `bot/telegram.ts`. **Ninguno instancia el SDK fuera de `config/nvidia.ts`** (ya cumple el principio "no SDK fuera de bridges").

## 3. CONOCIMIENTO DEL DOMINIO (candidatos KnowledgeRegistry)

| Fuente | Contenido | Clase LIPO |
|---|---|---|
| `src/strategy/engine.ts` (230 l.) | Máquina de estados **S0–S9** función pura sin I/O | L |
| `docs/STRATEGY_ENGINE_V1.md` | Catálogo completo **B1–B18** (bloques operativos) + reglas R + umbrales | L |
| `src/config/asset_risk_table.ts` | SL por activo (US30 80/NAS 20/oro 12/GBPJPY 20/BTC 500) + aliases broker | L |
| `CONTEXTO DEL AGENTE TRADING/` (8 .md) | Arquitectura, decisiones, reglas de continuidad | L (referenciado, no duplicado) |
| `src/skills/registry.ts` (544 l.) | **17 skills SOP ya contratadas** (declarativas, con métricas honestas) | I → envolver en `ISkillPlugin` |
| Prompts embebidos | En `agent/pipeline.ts` (analistas/debate/planner/gate) | L (quedan en su módulo; el arnés los referencia) |

## 4. CLASIFICACIÓN LIPO

| Módulo | Clase | Acción |
|---|---|---|
| `config/asset_risk_table.ts` | **L** | KEEP + registrar como módulo de conocimiento (`asset-risk-table`) |
| `strategy/engine.ts` + spec B1-B18 | **L** | KEEP + catálogo S0-S9/B1-B18 como conocimiento (`smc-engine-phases`, `smc-blockers`) |
| `skills/registry.ts` (contratos SOP) | **I** | REFACTOR aditivo: plugin `sop-skills` expone los 17 contratos vía SkillRegistry (sin duplicar: `reference` intacto) |
| `config/nvidia.ts` | **I** | REFACTOR aditivo: `NimBridge` lo envuelve (chat/embeddings); **call sites existentes NO se reescriben** (bot en producción) |
| `config/mt5bridge.ts` | **I** | REFACTOR aditivo: `Mt5Bridge` (harness) envuelve `MT5Bridge` existente (15 endpoints Flask) |
| `bot/telegram.ts` | **I** | REFACTOR aditivo: `TelegramBridge` para notify saliente |
| `config/nvidia.ts` (mock §16) | **P?** | NO PODAR: es fail-safe documentado de E2E — código vivo, no muerto |
| Duplicados/stubs | **P** | Sin objetivos confirmados en este análisis (no se borra nada sin `rg` de imports) |
| Todo lo nuevo | **O** | ORGANIZE: `src/lib/{harness,adapters,bridges}/`, `src/bootstrap.ts`, `src/lib/__tests__/` |

**Decisión de seguridad (justificación):** el bot corre en el PC del usuario y se auto-actualiza; Fase 8 será **aditiva y envolvente, NO invasiva**: ningún import del bot se reescribe, ninguna función existente cambia de firma. El checklist "no hay llamadas directas a SDK fuera de bridges" YA se cumple por diseño previo (SDK solo en `config/nvidia.ts`, que es el motor del NimBridge). Los consumidores nuevos (dashboard, AGENTE-GENERAL, futuros swaps de cajero) pasan por el arnés; los consumers actuales migrarán en un pase posterior con backtest.

## 5. MAPA DE DEPENDENCIAS Y ACOPLAMIENTO OCULTO

- **Entrada**: `src/index.ts` → bot Telegram + `startDashboard(4000)` + `startAgentMaintenance()`.
- **Acoplamiento por env (25 vars)**: `NVIDIA_API_KEY` (¡`config/nvidia.ts` **LANZA en import si falta** → los bridges del arnés DEBEN usar `import()` dinámico), `TELEGRAM_BOT_TOKEN` (Bot constructor también puede lanzar → igual), `MT5_BRIDGE_URL`, `BRIDGE_TOKEN`, `DASHBOARD_TOKEN`, `ALLOWED_IDS`, `DB_PATH`, `POLICY_MODE`, `LIVE_TRADING`, `ALLOWED_SYMBOLS`, `LLM_PROVIDER`, `QUICK_MODEL`/`DEEP_MODEL`, `LICENSE_SECRET`, `MAX_RISK_PCT`, `MAX_LOT`, `TP_LADDER`, `PIPELINE_GATE`…
- **Puertos**: 4000 dashboard · 5001 Flask↔MT5. **BD**: `./data/agente.db` (SQLite WAL, singleton en `database/sqlite.ts` — importación con efecto secundario: crea/abre BD).
- **Orden de inicialización**: `sqlite.ts` y `nvidia.ts` tienen efectos al importar → el bootstrap del arnés usará lazy singleton (`runtime.ts`) y `import()` dinámico para NUNCA romper el arranque existente.
- **Qué se rompe si muevo X**: nada — no se mueve ningún fichero existente (solo se añade `src/lib/`).

## 6. DISEÑO DE BRIDGES (STACK REAL, decisión del propietario)

| Prioridad | Bridge | Type | Motor |
|---|---|---|---|
| 1 | `NimBridge` | `nim` | `callLLMByTier`/`getEmbeddings` (NIM vía OpenAI-compatible) — ops: chat, generate, analyze, embeddings |
| 2 | `ZaiSdkBridge` | `zai-sdk` | plantilla (no instalado en este repo → `isAvailable()=false`, fallback honesto) |
| 3 | `Mt5Bridge` | `mt5` | `MT5Bridge` existente (account/price/candles/positions/order/history…) |
| 4 | `TelegramBridge` | `telegram` | grammy `bot.api.sendMessage` a `ALLOWED_IDS` |
| 5 | `PythonBridge` | `python` | plantilla subprocess (`scripts/<op>.py`) para futuro |

Orden de fallback configurable; NIM primero por decisión "stack real". El FAIL-SAFE §16 (mock prohibido con LIVE_TRADING=true) se conserva dentro del NimBridge al reutilizar `callLLMByTier`.

## 7. FASE 9 ADAPTADA (no hay Next.js)

`/api/harness` sobre **Express 5** en `src/server.ts`:
- `GET /api/harness` → list bridges/skills/knowledge + health (lectura pública, como el resto de GET).
- `POST /api/harness` → operaciones (`agent-execute`, `execute-skill`, `knowledge-health`, …) con el patrón fail-closed de `/api/policy` POST: exigen `DASHBOARD_TOKEN` explícito aunque el middleware global no esté activo.

## 8. PLAN DE FASES 1-10 (registrado antes de ejecutar)

1-7: crear `src/lib/` + interfaces + registries + bridges reales + `GeneralAdapter` + `src/bootstrap.ts` con `initHarness()` lazy. 8: LIPO aditivo (§4). 9: rutas Express (§7). 10: `tsc --noEmit` + suite nueva `src/lib/__tests__/harness.test.ts` (estilo repo: asserts + tsx, sin framework) + `npm test` existente intacto + checklist. Despliegue: SOLO rama `feature/harness` (push de la rama; **main no se toca** → el PC del propietario no la descarga con el doble clic hasta merge explícito).
