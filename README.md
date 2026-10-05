# Agente de IA para Trading Institucional (SMC)

Agente de Inteligencia Artificial para análisis y operativa de trading institucional basado en **Smart Money Concepts (SMC)**, con integración a **MetaTrader 5 (MT5)** vía **bridge local Python (`bridge.py`)** y bot interactivo en **Telegram**.

Impulsado por modelos LLM vía **NVIDIA NIM** con dos tiers (configurables por `.env`, estos son los defaults de `src/config/nvidia.ts`):

- **deep** (research manager, trade planner, gate final): `nvidia/nemotron-3-super-120b-a12b`
- **quick** (analistas, debate, riesgo, reflexión): `meta/llama-3.3-70b-instruct`

Búsqueda web en tiempo real con **Tavily** para el filtro de noticias. Sin dependencias de servicios de brokering externos: la ejecución va SIEMPRE por el bridge local de MetaTrader 5.

---

## 🏆 Track Record — la vitrina del producto

El diferencial: **el único bot que te demuestra por qué NO operó.** Cada decisión WAIT/REVIEW queda auditada con su motivo en `decision_log`, y el endpoint público `GET /api/trackrecord` resume el historial real:

- Win rate y expectancy sobre decisiones SETTLED (con PnL cerrado por el settlement).
- Mejor/peor símbolo por PnL acumulado y serie temporal acumulada.
- **Top 5 "Por qué NO operó"** (motivos reales de espera: killzones, RVOL, fail-closed…).
- Racha actual y Brain Score más reciente.

Es lectura pública (sin auth), con caché de 60s y **sin PII ni números de cuenta**. Es un historial descriptivo: **no promete rentabilidad futura**.

---

## 🚀 Características Principales

- **Estrategia Smart Money Concepts (SMC):**
  - Identificación de estructura Top-Down (H1, M15, M5, M1).
  - Puntos de Interés (POI), Breaker Blocks, Order Blocks e Imbalances (FVG).
  - Detección de Break of Structure (BOS) y Change of Character (ChoCh).
  - Enfoque en sesiones operativas y Killzones (Londres, Nueva York, Asia) especialmente para US30 y Forex.
- **Gestión de Riesgo Integrada:**
  - Control de riesgo por operación (0.5% - 1%).
  - Cálculo dinámico de lotaje y Stop Loss estructural.
- **Integraciones:**
  - **MetaTrader 5**: Conexión mediante **bridge local** (`bridge.py`, API REST en tu propio Windows) — no se usa ningún servicio cloud de brokering.
  - **Telegram Bot**: Control, alertas, gráficos y confirmaciones de órdenes en tiempo real.
  - **Noticias & Macroeconomía**: Consultas en tiempo real vía Tavily API para evitar operar en noticias de alto impacto.
  - **Memoria & Estado**: Persistencia local con SQLite.
- **Track Record auditable:** `GET /api/trackrecord` — win rate, expectancy, razones de espera y serie temporal desde `decision_log`.

---

## 📁 Estructura del Proyecto

```text
├── bridge.py               # Puente Python Flask para interactuar con MetaTrader 5 (MT5)
├── instalar_bridge.bat     # Script de instalación para dependencias del bridge de MT5
├── deploy_trading.ps1      # Script PowerShell para despliegue
├── src/                    # Código fuente en TypeScript (Agente, Telegram, Herramientas)
│   ├── index.ts            # Punto de entrada principal del agente
│   ├── bot/                # Configuración y comandos de Telegram
│   ├── tools/              # Herramientas del agente (MT5, Tavily, Análisis)
│   └── ...
├── docs/                   # Documentación adicional
├── public/                 # Recursos estáticos
├── instrucciones.txt       # Guía y desglose técnico de la metodología SMC
├── .env.example            # Plantilla de variables de entorno
└── package.json            # Configuración y dependencias Node.js
```

---

## 🛠️ Requisitos Previos

1. **Node.js** (versión 18 o superior).
2. **Python** (versión 3.9 o superior en Windows, necesario para MetaTrader5).
3. **MetaTrader 5** instalado y con cuenta conectada (Demo o Real).
4. Cuentas y API keys de:
   - [NVIDIA NIM](https://build.nvidia.com)
   - [Tavily](https://tavily.com)
   - [Telegram BotFather](https://t.me/botfather)

---

## ⚙️ Instalación y Configuración

### 1. Clonar el Repositorio
```bash
git clone https://github.com/ALBRA8/AGENTE-TRADING.git
cd AGENTE-TRADING
```

### 2. Configurar Variables de Entorno
Copia la plantilla `.env.example` a `.env` y añade tus credenciales:
```bash
cp .env.example .env
```

Edita `.env` con tus claves:
- `NVIDIA_API_KEY`: Tu API key de NVIDIA NIM.
- `TAVILY_API_KEY`: Tu API key de Tavily.
- `TELEGRAM_BOT_TOKEN`: Token obtenido de BotFather.
- `ALLOWED_IDS`: Tu ID de Telegram (para autorizar el acceso).

### 3. Instalar Dependencias de Node.js
```bash
npm install
```

### 4. Instalar y Levantar el Bridge de MT5
En Windows, ejecuta:
```cmd
instalar_bridge.bat
```
O inicia manualmente el servidor Flask del bridge:
```bash
python bridge.py
```

### 5. Iniciar el Agente
Modo desarrollo:
```bash
npm run dev
```

Modo producción:
```bash
npm run build
npm start
```

### 6. Tests y CI
```bash
npm test        # smoke suite (plomería DB, hard-gate, track record, licencia)
npm run typecheck
```
El CI (`.github/workflows/ci.yml`) ejecuta `npm ci`, `npm test` y un typecheck con baseline de 76 errores pre-existentes en `src/backtest/**`.

---

## 🟢 Modo DEMO vs 🔴 Modo LIVE

| | DEMO (default) | LIVE |
|---|---|---|
| Órdenes reales en MT5 | ❌ nunca | ✅ según decide el agente |
| Cómo se activa | por defecto | `LIVE_TRADING=true` en `.env` |
| Badge en UI / Telegram | 🟢 [DEMO] | 🔴 [LIVE] |

- **DEMO es el modo por defecto**: el agente analiza y deja traza de sus decisiones, pero no coloca órdenes.
- **LIVE requiere opt-in explícito**: exporta `LIVE_TRADING=true` consciente de que las órdenes se ejecutarán en TU cuenta real de MT5. Bajo tu única responsabilidad.
- El modo se muestra en el badge del dashboard (`/api/agent/status` → `mode`) y en el `/start` de Telegram.

---

## 🔐 Licencia offline (HMAC)

El servidor valida una licencia firmada localmente (sin servidor de licencias):

```bash
# Generar (con LICENSE_SECRET exportado)
node --import tsx src/license.ts generate cliente@email.com 365

# Validar
node --import tsx src/license.ts validate <key>
```

Variables en `.env`:
- `LICENSE_SECRET`: secreto HMAC para firmar/validar.
- `LICENSE_KEY`: la licencia de esta instalación.
- `LICENSE_REQUIRED`: `false` (default) → si falta/inválida solo avisa en el log; `true` → el server responde 503 en `/api/*` (salvo `/api/trackrecord` y `/api/health`) mientras no haya licencia válida.

---

## ⚠️ Descargo de Responsabilidad (Disclaimer)

**AGENTE-TRADING es una herramienta educativa y de análisis. NO es asesoría financiera.**

El trading de instrumentos apalancados conlleva un nivel de riesgo muy alto y **puedes perder la totalidad de tu capital**. Los resultados pasados (incluido el Track Record) no garantizan resultados futuros. Los análisis generados por modelos de lenguaje pueden ser incorrectos; toda orden y gestión de riesgo son responsabilidad exclusiva del usuario, que debe cumplir la normativa de su jurisdicción. Opera siempre primero en cuentas de demostración.

El disclaimer completo, los Términos de Servicio (draft), la política de datos y el checklist de lanzamiento están en **`docs/COMPLIANCE.md`**. El texto legal de licencia está en el archivo **`LICENSE`** (software propietario, all rights reserved, uso personal mientras no se distribuya).
