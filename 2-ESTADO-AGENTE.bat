@echo off
setlocal EnableExtensions
title AGT - Estado
cd /d "%~dp0"

rem ================================================================
rem  2-ESTADO-AGENTE.bat - Esta todo corriendo?
rem  Doble clic y mira. No escribe ni cambia nada.
rem ================================================================

echo ============================================================
echo     AGENTE TRADING - ESTADO
echo ============================================================
echo.

call :port_up 5001
if "%PORT_UP%"=="1" (
  echo   [OK]   Bridge MT5     : arriba  ^(puerto 5001, PID %PORT_PID%^)
) else (
  echo   [NO]   Bridge MT5     : PARADO  - ejecuta 1-INICIAR-AGENTE.bat
)

call :port_up 4000
if "%PORT_UP%"=="1" (
  echo   [OK]   Bot+Dashboard  : arriba  ^(puerto 4000, PID %PORT_PID%^)
  echo          http://127.0.0.1:4000
) else (
  echo   [NO]   Bot+Dashboard  : PARADO  - ejecuta 1-INICIAR-AGENTE.bat
)

echo.
tasklist /FI "IMAGENAME eq terminal64.exe" 2>nul | find /I "terminal64.exe" >nul
if not errorlevel 1 (
  echo   [OK]   MetaTrader 5   : abierto
) else (
  echo   [NO]   MetaTrader 5   : cerrado ^(abrelo para tener datos de mercado^)
)

echo.
echo   Ventanas del agente (minimizadas en la barra de tareas):
echo     AGT-Bridge  = consola del bridge      AGT-Bot = consola del bot
echo.
echo   Logs recientes en la carpeta logs\ ^(se abre el Explorador^):
if exist logs (start "" explorer "%~dp0logs") else echo     (todavia no hay carpeta logs)
echo.

pause
exit /b 0

:port_up
set PORT_UP=0
set PORT_PID=
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /C:":%~1 " ^| findstr /C:"LISTENING"') do (
  set PORT_UP=1
  set PORT_PID=%%P
)
exit /b
