@echo off
setlocal EnableExtensions EnableDelayedExpansion
title AGT - Iniciador
cd /d "%~dp0"

rem ================================================================
rem  1-INICIAR-AGENTE.bat - ARRANQUE CON DOBLE CLIC
rem  Inicia Bridge MT5 (puerto 5001) + Bot con Dashboard (puerto 4000)
rem  en ventanas minimizadas, con logs en la carpeta logs\.
rem  No hace falta abrir PowerShell ni escribir nada.
rem
rem  Variables (las cambia arranque_silencioso.vbs en el auto-arranque):
rem    SILENCIOSO=1  -> no muestra panel final ni pausas de error
rem    ABRIR_DASH=0  -> no abre el navegador al terminar
rem    ACTUALIZAR=0  -> salta el despliegue automatico de GitHub
rem  (alternativa: crea un fichero vacio NO_ACTUALIZAR.txt aqui)
rem ================================================================

if not defined SILENCIOSO set SILENCIOSO=0
if not defined ABRIR_DASH set ABRIR_DASH=1

set BRIDGE_PORT=5001
set DASH_PORT=4000

if not exist logs mkdir logs

echo ============================================================
echo     AGENTE TRADING - ARRANQUE AUTOMATICO
echo ============================================================
echo.

rem ------------------------------------------------------------
rem 1) Pre-vuelo: .env, Node, dependencias, build
rem ------------------------------------------------------------
if not exist ".env" (
  echo [ERROR] Falta el fichero .env en esta carpeta.
  echo         Copia .env.example a .env y rellena tus claves
  echo         ^(NVIDIA_API_KEY, TELEGRAM_BOT_TOKEN, etc.^).
  echo [%date% %time%] FALLO: falta .env >> logs\arranque.log
  if "%SILENCIOSO%"=="1" exit /b 1
  pause
  exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js no esta instalado o no esta en el PATH.
  echo [%date% %time%] FALLO: node no encontrado >> logs\arranque.log
  if "%SILENCIOSO%"=="1" exit /b 1
  pause
  exit /b 1
)

rem ------------------------------------------------------------
rem 1b) DESPLIEGUE AUTOMATICO: baja novedades de GitHub y las
rem     instala solo. Sin terminal y sin claves (repo publico).
rem     Se salta si: ACTUALIZAR=0  o  existe NO_ACTUALIZAR.txt
rem ------------------------------------------------------------
set FALTA_INSTALL=0
if not exist "node_modules" set FALTA_INSTALL=1

if not defined ACTUALIZAR set ACTUALIZAR=1
if exist "NO_ACTUALIZAR.txt" set ACTUALIZAR=0

if "%ACTUALIZAR%"=="1" if exist ".git" (
  echo [....] Comprobando novedades en GitHub...
  set "SHA_ANTES="
  for /f %%A in ('git rev-parse HEAD 2^>nul') do set "SHA_ANTES=%%A"
  git fetch https://github.com/ALBRA8/AGENTE-TRADING.git main >nul 2>&1
  if errorlevel 1 (
    echo [AVISO] Sin acceso a GitHub: arranco con tu version local.
  ) else (
    git merge --ff-only FETCH_HEAD >> logs\arranque.log 2>&1
    if errorlevel 1 (
      echo [AVISO] No pude actualizar solo ^(tienes cambios locales^): arranco con tu version.
    ) else (
      set "SHA_DESPUES="
      for /f %%A in ('git rev-parse HEAD 2^>nul') do set "SHA_DESPUES=%%A"
      if "!SHA_ANTES!"=="!SHA_DESPUES!" (
        echo [OK]   Codigo al dia.
      ) else (
        echo [OK]   DESPLIEGUE AUTOMATICO: instalada la ultima version de GitHub.
        echo [%date% %time%] UPDATE: novedades descargadas desde GitHub >> logs\arranque.log
        set FALTA_INSTALL=1
      )
    )
  )
)

if "%FALTA_INSTALL%"=="1" (
  echo [INFO] Instalando dependencias ^(npm install, la primera vez tarda^)...
  call npm install --no-audit --no-fund >> logs\install.log 2>&1
  if errorlevel 1 (
    echo [AVISO] npm install devolvio error: revisa logs\install.log
    echo         El agente intenta arrancar igualmente.
  )
)

set RUN_CMD=node dist\index.js
if not exist "dist\index.js" (
  echo [INFO] No hay build (dist\): arranco con tsx en directo.
  set RUN_CMD=npx tsx src\index.ts
)

rem ------------------------------------------------------------
rem 2) MetaTrader 5 abierto?
rem ------------------------------------------------------------
set MT5_OK=0
tasklist /FI "IMAGENAME eq terminal64.exe" 2>nul | find /I "terminal64.exe" >nul
if not errorlevel 1 set MT5_OK=1
if "%MT5_OK%"=="0" (
  echo [AVISO] MetaTrader 5 NO esta abierto.
  echo         El agente arranca igual (PAPER), pero el bridge no podra
  echo         hablar con MT5 hasta que abras el terminal.
)

rem --------------------------------------------------------------
rem 3) Bridge MT5 (puerto 5001)
rem ------------------------------------------------------------
rem Rotacion simple: si un log pasa de ~2 MB se guarda como .old
for %%F in ("logs\bridge.log") do if %%~zF GTR 2000000 move /y logs\bridge.log logs\bridge.old >nul 2>&1
for %%F in ("logs\bot.log") do if %%~zF GTR 2000000 move /y logs\bot.log logs\bot.old >nul 2>&1

set PY_CMD=python
where python >nul 2>&1
if errorlevel 1 set PY_CMD=py

call :port_up %BRIDGE_PORT%
if "%PORT_UP%"=="1" goto bridge_ok

echo [....] Iniciando Bridge MT5 (puerto %BRIDGE_PORT%)...
start "AGT-Bridge" /min cmd /c "%PY_CMD% bridge.py >> logs\bridge.log 2>&1"
ping -n 5 127.0.0.1 >nul
call :port_up %BRIDGE_PORT%
if "%PORT_UP%"=="1" goto bridge_ok

echo [FALLO] El Bridge no respondio en el puerto %BRIDGE_PORT%.
echo         Ultimas lineas de logs\bridge.log:
echo         --------------------------------------------------
if exist logs\bridge.log (type logs\bridge.log) else echo         (log vacio o inexistente)
echo [%date% %time%] FALLO: bridge no arranco >> logs\arranque.log
echo         --------------------------------------------------
if "%SILENCIOSO%"=="1" exit /b 1
pause
exit /b 1

:bridge_ok
echo [OK]   Bridge MT5 arriba (puerto %BRIDGE_PORT%).

rem ------------------------------------------------------------
rem 4) Bot + Dashboard (puerto 4000)
rem ------------------------------------------------------------
call :port_up %DASH_PORT%
if "%PORT_UP%"=="1" goto bot_ok

echo [....] Iniciando Bot + Dashboard (puerto %DASH_PORT%)...
start "AGT-Bot" /min cmd /c "%RUN_CMD% >> logs\bot.log 2>&1"
ping -n 7 127.0.0.1 >nul
call :port_up %DASH_PORT%
if "%PORT_UP%"=="1" goto bot_ok

echo [FALLO] El Bot/Dashboard no respondio en el puerto %DASH_PORT%.
echo         Ultimas lineas de logs\bot.log:
echo         --------------------------------------------------
if exist logs\bot.log (type logs\bot.log) else echo         (log vacio o inexistente)
echo [%date% %time%] FALLO: bot no arranco >> logs\arranque.log
echo         --------------------------------------------------
if "%SILENCIOSO%"=="1" exit /b 1
pause
exit /b 1

:bot_ok
echo [OK]   Bot + Dashboard arriba (puerto %DASH_PORT%).

echo.
echo ============================================================
echo     TODO ARRANCADO - puedes cerrar esta ventana
echo.
echo     Dashboard : http://127.0.0.1:%DASH_PORT%
echo     Bridge    : http://127.0.0.1:%BRIDGE_PORT%
echo     Logs      : carpeta logs\
echo     Parar     : doble clic en 3-PARAR-AGENTE.bat
echo     Estado    : doble clic en 2-ESTADO-AGENTE.bat
echo ============================================================
echo [%date% %time%] OK: bridge+bot arriba >> logs\arranque.log

if "%MT5_OK%"=="0" if "%SILENCIOSO%"=="0" (
  echo.
  echo  Recuerda: MT5 no estaba abierto - abrelo para operar real/PAPER con datos.
)

if "%ABRIR_DASH%"=="1" start "" http://127.0.0.1:%DASH_PORT%

if "%SILENCIOSO%"=="1" exit /b 0
ping -n 13 127.0.0.1 >nul
exit /b 0

rem ------------------------------------------------------------
:port_up
set PORT_UP=0
set PORT_PID=
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /C:":%~1 " ^| findstr /C:"LISTENING"') do (
  set PORT_UP=1
  set PORT_PID=%%P
)
exit /b
