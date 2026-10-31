@echo off
setlocal EnableExtensions EnableDelayedExpansion
title AGT - Instalador de despliegue rapido
cd /d "%~dp0"

rem ================================================================
rem  INSTALAR-AGENTE.bat - ASISTENTE DE PRIMERA VEZ
rem  Lo abre INICIAR-AGENTE.vbs solo si falta .env o node_modules.
rem  Tambien puedes lanzarlo a mano cuando quieras.
rem
rem  Hace, en orden:
rem    1) Comprueba Node.js y Python
rem    2) Crea tu .env preguntandote las claves (solo si no existe)
rem    3) npm install (dependencias del agente)
rem    4) npm run build (si falla, arranca igual con tsx)
rem    5) Instala las dependencias Python del bridge (MetaTrader5, flask)
rem    6) Arranca todo con 1-INICIAR-AGENTE.bat
rem ================================================================

echo ============================================================
echo     AGENTE TRADING - INSTALADOR DE DESPLIEGUE RAPIDO
echo ============================================================
echo.

if not exist logs mkdir logs

rem ---- 1) Node.js -------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js no esta instalado.
  echo         Instala la version LTS desde https://nodejs.org
  echo         y vuelve a hacer doble clic en INICIAR-AGENTE.vbs
  echo [%date% %time%] FALLO: node no encontrado >> logs\instalador.log
  start "" https://nodejs.org
  pause
  exit /b 1
)
for /f "delims=" %%V in ('node --version') do echo [OK]   Node.js %%V encontrado.

rem ---- 2) Python (solo aviso: sin el no hay bridge MT5) ------------
set PYOK=0
set PY_CMD=python
where python >nul 2>&1
if not errorlevel 1 set PYOK=1
if "%PYOK%"=="0" (
  where py >nul 2>&1
  if not errorlevel 1 (
    set PYOK=1
    set PY_CMD=py
  )
)
if "%PYOK%"=="1" (
  echo [OK]   Python encontrado ^(el bridge MT5 podra arrancar^).
) else (
  echo [AVISO] Python no encontrado. Instalalo 64 bits desde
  echo         https://www.python.org/downloads/ marcando
  echo         "Add python.exe to PATH", y despues doble clic en
  echo         instalar_bridge.bat. El bot arranca igual, pero sin
  echo         datos de MT5.
  echo [%date% %time%] AVISO: python no encontrado >> logs\instalador.log
)

rem ---- 3) Fichero .env (pregunta las claves SOLO la primera vez) ---
if exist ".env" (
  echo [OK]   .env ya existe: lo respeto, no toco nada.
  goto deps
)

echo.
echo   Voy a crear tu fichero .env. Ten a mano:
echo     - NVIDIA API key    : https://build.nvidia.com
echo     - Token del bot     : @BotFather en Telegram
echo     - Tu ID de Telegram : para la whitelist
echo   Si te falta alguna, pulsa ENTER y la rellenas luego en .env
echo.
set "NVIDIA_IN="
set "TELEGRAM_IN="
set "ALLOWED_IN="
set /p NVIDIA_IN=  NVIDIA_API_KEY:
set /p TELEGRAM_IN=  TELEGRAM_BOT_TOKEN:
set /p ALLOWED_IN=  ALLOWED_IDS:

echo [....] Creando .env...
>  ".env" echo # .env creado por INSTALAR-AGENTE.bat el %date% %time%
>> ".env" echo NVIDIA_API_KEY=!NVIDIA_IN!
>> ".env" echo TAVILY_API_KEY=
>> ".env" echo TELEGRAM_BOT_TOKEN=!TELEGRAM_IN!
>> ".env" echo.
>> ".env" echo # Bridge MT5 local - puerto 29413 (no tradicional a proposito)
>> ".env" echo MT5_BRIDGE_URL=http://localhost:29413
>> ".env" echo BRIDGE_TOKEN=
>> ".env" echo ALLOWED_IDS=!ALLOWED_IN!
>> ".env" echo DB_PATH=./data/agente.db
>> ".env" echo.
>> ".env" echo # Gobernanza: siempre arranca en PAPER
>> ".env" echo POLICY_MODE=PAPER
>> ".env" echo AUTONOMY_LEVEL=2
>> ".env" echo AUTONOMY_CEILING=2
>> ".env" echo KILL_SWITCH=off
>> ".env" echo LIVE_TRADING=false
>> ".env" echo.
>> ".env" echo ALLOWED_SYMBOLS=US30,NAS100,XAUUSD,BTCUSD,GBPJPY
>> ".env" echo MAX_SPREAD_PCT=0.0005
>> ".env" echo MAX_TICK_AGE_S=120
>> ".env" echo.
>> ".env" echo # Dashboard en http://127.0.0.1:6879
>> ".env" echo DASHBOARD_TOKEN=
>> ".env" echo HOST=127.0.0.1
>> ".env" echo RATE_LIMIT_PER_MIN=60
>> ".env" echo.
>> ".env" echo AUTO_PROMOTE_LESSONS=false
>> ".env" echo AGENT_NAME=Agente de Trading
>> ".env" echo MAX_TOOL_ITERATIONS=10
>> ".env" echo LOG_LEVEL=info

if "!NVIDIA_IN!"=="" if "!TELEGRAM_IN!"=="" (
  echo [AVISO] Dejaste todas las claves vacias: el agente arrancara
  echo         pero sin LLM ni Telegram. Rellena .env con el Bloc
  echo         de notas cuando las tengas.
) else (
  echo [OK]   .env creado. Puedes editarlo cuando quieras con el Bloc de notas.
)

rem ---- 4) Dependencias npm -----------------------------------------
:deps
if exist "node_modules" (
  echo [OK]   Dependencias npm ya instaladas.
) else (
  echo [....] npm install - puede tardar varios minutos, no cierres...
  echo [%date% %time%] INFO: npm install empezando >> logs\instalador.log
  call npm install --no-audit --no-fund >> logs\instalador.log 2>&1
  if errorlevel 1 (
    echo [ERROR] npm install fallo. Mira logs\instalador.log y reintenta.
    pause
    exit /b 1
  )
  echo [OK]   Dependencias npm instaladas.
)

rem ---- 5) Build (opcional: si falla, arranca con tsx igual) --------
echo [....] Compilando el proyecto ^(npm run build^)...
call npm run build >> logs\instalador.log 2>&1
if errorlevel 1 (
  echo [AVISO] El build fallo - el agente arrancara en modo directo
  echo         con tsx. No pasa nada, funciona igual.
) else (
  echo [OK]   Proyecto compilado en dist\.
)

rem ---- 6) Dependencias Python del bridge ---------------------------
if "%PYOK%"=="1" echo [....] Instalando dependencias Python del bridge ^(MetaTrader5, flask^)...
if "%PYOK%"=="1" %PY_CMD% -m pip install --quiet MetaTrader5 flask >> logs\instalador.log 2>&1
if "%PYOK%"=="1" if errorlevel 1 (
  echo [AVISO] pip fallo - ejecuta instalar_bridge.bat mas tarde.
)

rem ---- 7) Arrancar --------------------------------------------------
echo.
echo ============================================================
echo     INSTALACION TERMINADA - arrancando el agente...
echo ============================================================
echo.
endlocal & set "SILENCIOSO=0" & set "ABRIR_DASH=1"
call "%~dp01-INICIAR-AGENTE.bat"
exit /b 0
