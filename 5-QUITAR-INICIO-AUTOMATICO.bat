@echo off
setlocal EnableExtensions
title AGT - Quitar inicio automatico

rem ================================================================
rem  5-QUITAR-INICIO-AUTOMATICO.bat
rem  Elimina la tarea de autoarranque creada por el numero 4.
rem  El agente sigue funcionando con doble clic manual.
rem ================================================================

echo ============================================================
echo     AGENTE TRADING - QUITAR INICIO AUTOMATICO
echo ============================================================
echo.

schtasks /Delete /TN "AGT-AgenteTrading" /F >nul 2>&1
if errorlevel 1 (
  echo [INFO] No habia ninguna tarea de autoarranque registrada.
) else (
  echo [OK] Tarea "AGT-AgenteTrading" eliminada.
  echo      El agente ya NO arrancara solo al encender el PC.
)
echo.
pause
exit /b 0
