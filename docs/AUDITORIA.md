# AUDITORÍA EXTERNA — AGENTE-TRADING

> Fecha: 2026-10-05 · 3 auditores independientes (subagentes especializados)
> Método: solo lectura del código completo + worklog de desarrollo. Reportes
> crudos de cada auditor en `worklog.md` (Tasks 6-a, 6-b, 6-c).

## Veredictos

| Silla | Score | Resumen en una frase |
|---|---|---|
| 🎯 Estrategia y Riesgo (trading) | **30/100** | "Framework excelente con una estrategia de papel dentro: arquitectura institucional, pero el análisis SMC en vivo era fabricado y el lotaje podía volar la cuenta en GBPJPY." |
| 🔧 Arquitectura y Código | **38/100** | "La historia del producto es de las mejores vistas en un agente retail; lo que no vende es que la ejecución descansaba sobre un gate no one-shot, filtros con datos inventados y un endpoint web abierto." |
| 📦 Producto / GTM / Compliance | **58/100** | "Núcleo genuinamente diferenciado y demostrable, pero pre-comercial: sin licencia, pagos, onboarding ni track record. No es humo — todavía no está envuelto." |

**Consenso de los 3**: el activo vendible es la ARQUITECTURA DE DECISIÓN (pipeline
auditable + hard-gate en código + auto-mejora + Brain Score) — no existe en otro bot
retail. Pero había 6 problemas críticos convergentes que bloqueaban la venta.

## Problemas críticos detectados (consenso)

| # | Problema | Auditor | Estado |
|---|---|---|---|
| C1 | API key de Tavily **hardcodeada y pública en GitHub** (`check_news.ts:3`) | 1, 2, 3 | ✅ CORREGIDO en código (fallback eliminado, fail-fast honesto). ⚠️ **ACCIÓN HUMANA PENDIENTE: rotar la key en tavily.com y purgar del historial de git** |
| C2 | Análisis SMC en vivo hardcodeado (`analyze_market.ts`): BOS/ChoCh "detectados" sin mirar el mercado → el pipeline razona sobre estructura inventada | 1, 2 | ⚠️ PARCIAL: RVOL y DXY ya devuelven UNKNOWN honesto (sin números random ni divergencia inventada). Falta cablear `backtest/smc_detector.ts` a las velas del bridge para estructura real |
| C3 | Hard-gate NO one-shot: una decisión EXECUTE autorizaba N órdenes; SL y riesgo no vinculados al plan; dirección nula pasaba; decisión vieja no se invalidaba | 1, 2 | ✅ CORREGIDO: `claimDecision` atómico (one-shot), invalidación por decisión posterior, dirección obligatoria, SL acotado ±(0.5x–1.25x) del plan, riesgo heredado de la decisión (el LLM no puede inflarlo) |
| C4 | Matemática de lotaje destructiva: GBPJPY → 250 lotes (riesgo ~325% de la cuenta); XAUUSD ~10x de riesgo real | 1 | ✅ CORREGIDO: tabla honesta de valor-pip por símbolo (`PIP_VALUE_USD` + override por env `PIP_VALUE_OVERRIDES`), cap `MAX_LOT`, riesgo REAL mostrado en la respuesta, símbolo desconocido → RECHAZO (fail-closed). ⚠️ Pendiente de precisión total: exponer `symbol_info` del bridge (tick_value, contract_size) |
| C5 | Gates fail-open: UNKNOWN en news/RVOL/precio dejaba pasar EXECUTE; error del tool de horario → GREEN; sábados/domingos operables (dayOfWeek sin usar) | 1, 2 | ✅ CORREGIDO: UNKNOWN en filtros críticos (market_hours/news/rvol/price_feed) bloquea EXECUTE (fail-closed); fin de semana → RED en código; killzones por activo EN CÓDIGO (US30 8-12 NY, GBPJPY solo Londres); hora NY con timezone real (DST-safe); trío de riesgo fail-closed (JSON ilegible = VETO) |
| C6 | Servidor web sin auth en 0.0.0.0 → cualquiera podía operar la cuenta MT5 vía chat | 2, 3 | ✅ CORREGIDO: bind a `127.0.0.1` por defecto (env `HOST` para exponer), `DASHBOARD_TOKEN` opcional (bearer auth), body limit 1MB |

## Otros hallazgos relevantes (corregidos en esta pasada)

- **Settlement concurrente podía duplicar lecciones** → lock compartido (`maintenanceState.running`) + índice único parcial en `pattern_key` + upsert `ON CONFLICT` con fallback.
- **GET /api/agent/brain escribía snapshot** (un cliente ruidoso envenenaba la tendencia) → snapshot solo con `?snapshot=1`.
- **Órdenes LIMIT GTC eternas** vs decisiones de 15 min (auditor 1, C5): ⚠️ PENDIENTE — implementar expiración `ORDER_TIME_SPECIFIED` + cancelación de pendientes en cada pipeline run.
- **Kill-switches del SOP sin implementar** (límite de pérdida diaria 1%, máx 2 pérdidas consecutivas, máx posiciones): ⚠️ PENDIENTE — leer de MT5 positions, no del LLM.
- **Comité de riesgo y planner consumían datos falsos**: resuelto a la raíz con C2/C5 (honestidad de datos).

## Scores de venta por silla (post-fixes estimados)

| Silla | Antes | Tras fixes de hoy* | Con roadmap completo |
|---|---|---|---|
| Estrategia | 30 | ~45 | 75+ (SMC real + 3-6 meses de track record) |
| Ingeniería | 38 | ~55 | 80+ (tests, CI, Docker, multi-usuario) |
| Producto | 58 | ~62 | 85+ (licencia, instalador, compliance kit) |

*Estimación tras corregir C1-C6; los scores oficiales son los pre-fix (los auditores no re-evaluaron).

## Roadmap hacia "vendible" (consenso de los 3 auditores)

### Bloque 1 — Semana 1-2 (bloqueante para cobrar)
1. ⚠️ **HUMANO**: rotar la Tavily key YA + purgarla del historial de git (`git filter-repo`) + push del código actual (el producto solo existe en este disco)
2. Cablear `smc_detector.ts` a velas del bridge → estructura SMC real en el pipeline (elimina C2 de raíz)
3. Expiración de órdenes pendientes + cancelación en flips de dirección
4. Kill-switches de cuenta (pérdida diaria máx, posiciones abiertas, exposición total)

### Bloque 2 — Semana 3-6 (MVP vendible)
5. Kit compliance: disclaimer triple (UI/onboarding/EXECUTE), TOS sin garantía de resultados, modo demo por defecto con opt-in `LIVE_TRADING=true`
6. Instalador Windows con wizard (valida 4 keys + bridge) + license key offline (HMAC)
7. Landing + pricing (ej. $299 one-time o $49/mes) + corrección de branding ("MetaApi"→bridge MT5 local, modelo real)
8. `symbol_info` del bridge para sizing exacto multi-broker

### Bloque 3 — Mes 2-3 (prueba y escalado)
9. Track record público de 90 días en demo (auto-generado desde `decision_log`/`brain_evaluations` — la máquina ya existe)
10. CI con `npm test` (smoke suite incluida) + Docker + gestión de procesos
11. Multi-usuario real (userId en decisiones, gate por cuenta)
12. Vía de escalado elegida: white-label a prop firms (el audit log + hard-gate es exactamente lo que auditan)

## Nota final de los auditores

Los tres coinciden: **el diferencial es el "únicobot que te puede demostrar por qué NO operó"** — cada WAIT/REVIEW está auditado con su motivo, y el Brain Score mide si el cerebro mejora. Ese es el pitch. Lo que NO se puede hacer es cobrar antes de los Bloques 1-2: el primer comprador que opere GBPJPY real (antes del fix) lo descubría en la primera orden.
