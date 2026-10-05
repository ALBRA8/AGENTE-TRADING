# Agente de IA para Trading Institucional (SMC)

Agente de Inteligencia Artificial para análisis y operativa de trading institucional basado en **Smart Money Concepts (SMC)**, con integración a **MetaTrader 5 (MT5)** y bot interactivo en **Telegram**.

Impulsado por modelos LLM de alto rendimiento (Kimi K2.5 / DeepSeek vía NVIDIA NIM), búsqueda web en tiempo real con **Tavily**, y puente Python para ejecución directa en MetaTrader 5.

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
  - **MetaTrader 5**: Conexión nativa mediante puente Python (`bridge.py`) con API REST local.
  - **Telegram Bot**: Control, alertas, gráficos y confirmaciones de órdenes en tiempo real.
  - **Noticias & Macroeconomía**: Consultas en tiempo real vía Tavily API para evitar operar en noticias de alto impacto.
  - **Memoria & Estado**: Persistencia local con SQLite.

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

---

## ⚠️ Descargo de Responsabilidad (Disclaimer)

Este software es para fines educativos y experimentales. El trading en mercados financieros conlleva un alto nivel de riesgo. Opera siempre primero en cuentas de demostración.
