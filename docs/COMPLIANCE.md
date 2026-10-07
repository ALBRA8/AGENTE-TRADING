# COMPLIANCE KIT — AGENTE-TRADING

> Última actualización: Task 8-b (productización). Este documento es el kit
> mínimo de cumplimiento para poder mostrar/vender el producto. Tono HONESTO:
> nunca prometemos rentabilidad ni resultados pasados futuros.

---

## 1. Disclaimer completo (Español)

**SOFTWARE EDUCATIVO Y DE ANÁLISIS — NO ES ASESORÍA FINANCIERA**

AGENTE-TRADING es una herramienta **educativa y de análisis técnico**
(Smart Money Concepts) que asiste al usuario en su propio proceso de
decisión de trading. **No es** una empresa de inversión, un gestor
autorizado, un asesor financiero regulado ni una señal de pago con
promesas de rentabilidad.

- **Riesgo de pérdida total**: operar instrumentos apalancados (índices,
  forex, materias primas, cripto) conlleva un riesgo elevado. Puedes
  perder **la totalidad de tu capital** e incluso más en condiciones
  extremas de mercado.
- **Resultados pasados ≠ futuros**: el Track Record (win rate,
  expectancy, PnL) es un **historial descriptivo** de decisiones ya
  cerradas. **Ninguna métrica de este producto implica ni promete
  rentabilidad futura.**
- **El agente puede equivocarse**: los modelos de lenguaje (LLM) pueden
  producir análisis incorrectos o incompletos. Toda decisión final y su
  riesgo son **responsabilidad exclusiva del usuario**.
- **Modo DEMO por defecto**: el sistema arranca sin ejecución de órdenes
  reales. La operativa real (LIVE, `LIVE_TRADING=true`) requiere un
  opt-in explícito del usuario y se realiza contra SU cuenta de MT5.
- **Jurisdicción**: el usuario es responsable de cumplir la normativa de
  su propia jurisdicción (impuestos, restricciones de instrumentos,
  requisitos locales de inversión).

Este disclaimer se muestra en tres capas (regla del kit):
1. **UI web** — footer fijo permanente.
2. **Telegram** — mensaje `/start` + línea de riesgo tras cada orden.
3. **README/LICENSE** — texto legal del repositorio.

---

## 2. Términos de Servicio (TOS draft)

**2.1 Servicio.** AGENTE-TRADING se entrega como software local (desktop,
Windows + MT5 + bridge Python). El titular del repo lo proporciona "tal
cual", sujeto a la LICENSE del repositorio.

**2.2 Sin garantía de resultados.** No se garantiza ningún resultado de
trading, disponibilidad del modelo LLM, del bridge, del broker ni de
servicios de terceros. No hay promesa de rentabilidad de ningún tipo.

**2.3 No asesoría.** Nada en el producto constituye asesoramiento de
inversión, legal, fiscal o contable. Las salidas del agente son
**análisis automatizados de carácter educativo**.

**2.4 Responsabilidad del usuario.** El usuario es el único responsable
de: las órdenes que confirme o ejecute, el tamaño de posición, la
configuración de sus claves API, el cumplimiento normativo en su
jurisdicción y la supervisión de su cuenta de MT5.

**2.5 Jurisdicción del usuario.** El contrato entre el operador del
software y su cliente se rige por la legislación de la jurisdicción del
usuario final, sin perjuicio de los derechos morales irrenunciables del
autor. Las disputas se intentarán resolver de buena forma y por vía
amistosa antes de cualquier acción legal.

**2.6 Terminación.** El incumplimiento de la LICENSE o de estos TOS
termina de inmediato el derecho de uso. El operador del software puede
también suspender el soporte ante uso abusivo, reventa no autorizada o
manipulación destinada a eludir la licencia.

**2.7 Limitación de responsabilidad.** EN LA MÁXIMA MEDIDA PERMITIDA POR
LA LEY, EL AUTOR NO SERÁ RESPONSABLE POR DAÑOS DIRECTOS, INDIRECTOS,
INCIDENTALES, ESPECIALES O CONSECUENTES, PÉRDIDA DE BENEFICIOS, DE DATOS
O DE CAPITAL DERIVADOS DEL USO O IMPOSIBILIDAD DE USO DEL SOFTWARE,
AUNQUE SE HAYA ADVERTIDO DE LA POSIBILIDAD.

**2.8 Datos y privacidad.** Ver sección 3. El software no incluye
telemetría externa.

---

## 3. Política de datos (básica)

**Qué guarda el producto (todo LOCAL, en SQLite `data/*.db`):**

| Tabla | Contenido |
|---|---|
| `conversations` | historial de chat (usuario ↔ agente) |
| `decision_log` | decisiones del pipeline: símbolo, acción, gates, razonamiento, resultado (PnL) |
| `trade_orders` | órdenes vinculadas a decisiones (símbolo, lote, SL/TP, ticket) |
| `trade_performance` | resultados reportados de trades |
| `agent_lessons` / `agent_errors` | lecciones aprendidas y errores clasificados (auto-mejora) |
| `brain_evaluations` | snapshots del Brain Score |
| `users` | id de Telegram, username y nombre para la whitelist |

**Qué NO se hace:**
- ❌ Sin telemetría externa: nada sale del equipo hacia servidores del
  autor (no analytics, no crash reporting remoto).
- ❌ Sin PII en la vitrina: el endpoint público `/api/trackrecord` no
  expone `user_id`, emails ni números de cuenta.
- ⚠️ Las claves API (NVIDIA NIM, Tavily, Telegram) viajan a SUS
  proveedores cuando el agente los consulta, bajo sus políticas.

**Cómo borrar TODO:** cerrar el agente y eliminar `data/*.db` (p. ej.
`data/opengravity.db`). No hay copias en ningún otro sitio. También puede
borrarse solo el historial de chat con el comando `/clear` de Telegram.

---

## 4. Checklist de lanzamiento (pre-venta)

- [ ] **HUMANO — URGENTE**: rotar la API key de Tavily filtrada en el
      historial de git y purgar el historial (`git filter-repo`) antes de
      cualquier distribución (auditorías 6-b/6-c).
- [ ] Push del código real a un repositorio privado (el producto solo
      existe en este disco).
- [ ] Definir y sustituir el **PLACEHOLDER de licencia comercial** en el
      archivo `LICENSE` (modelo one-time vs suscripción; NO anunciar
      precios hasta entonces).
- [ ] Publicar los TOS finales (sección 2) y este disclaimer en el canal
      de venta elegido.
- [ ] Onboarding: wizard/instalador que valide las 4 claves + bridge MT5
      y genere la licencia offline (HMAC, `src/license.ts`).
- [ ] Verificar que el primer arranque muestra el disclaimer triple
      (UI footer + Telegram `/start` + README) antes de permitir LIVE.
- [ ] Simular un comprador nuevo de cero: sin `.env`, con licencia
      correcta, y con licencia expirada (`LICENSE_REQUIRED=true` → 503).
- [ ] Revisar que `public/` y `public_adaptada/` no contienen datos
      reales de ningún usuario.
