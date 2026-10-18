@echo off
setlocal EnableExtensions
title AGT - Parar
cd /d "%~dp0"

rem ================================================================
rem  3-PARAR-AGENTE.bat - Detiene Bridge + Bot con doble clic.
rem  No toca MetaTrader 5 (ese lo cierras tu si quieres).
rem ================================================================

echo ============================================================
echo     AGENTE TRADING - PARANDO TODO
echo ============================================================
echo.

rem 1) Por titulo de ventana (lo que arranco 1-INICIAR-AGENTE.bat)
taskkill /F /T /FI "WINDOWTITLE eq AGT-Bridge*" >nul 2>&1
taskkill /F /T /FI "WINDOWTITLE eq AGT-Bot*" >nul 2>&1

rem 2) Residuos: si el puerto sigue ocupado, mato ese PID concreto
ping -n 3 127.0.0.1 >nul
call :kill_port 5001
call :kill_port 4000

echo.
call :port_up 5001
if "%PORT_UP%"=="1" (
  echo   [NO] Bridge sigue arriba ^(algo externo lo mantiene^), PID %PORT_PID%
) else (
  echo   [OK] Bridge MT5 parado.
)
call :port_up 4000
if "%PORT_UP%"=="1" (
  echo   [NO] Dashboard sigue arriba, PID %PORT_PID%
) else (
  echo   [OK] Bot + Dashboard parados.
)

echo.
echo   Listo. Para volver a arrancar: doble clic en 1-INICIAR-AGENTE.bat
echo.
ping -n 6 127.0.0.1 >nul
exit /b 0

:kill_port
call :port_up %~1
if "%PORT_UP%"=="1" taskkill /F /PID %PORT_PID% >nul 2>&1
exit /b

:port_up
set PORT_UP=0
set PORT_PID=
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /C:":%~1 " ^| findstr /C:"LISTENING"') do (
  set PORT_UP=1
  set PORT_PID=%%P
)
exit /b
