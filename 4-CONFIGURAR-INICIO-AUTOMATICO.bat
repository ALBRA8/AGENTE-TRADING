@echo off
setlocal EnableExtensions
title AGT - Inicio automatico
cd /d "%~dp0"

rem ================================================================
rem  4-CONFIGURAR-INICIO-AUTOMATICO.bat
rem  Ejecutalo UNA sola vez: registra una tarea de Windows para que
rem  el agente arranque SOLO cada vez que enciendas el PC / inicies
rem  sesion (sin ventanas de configuracion, silencioso).
rem
rem  Para deshacerlo: 5-QUITAR-INICIO-AUTOMATICO.bat
rem ================================================================

echo ============================================================
echo     AGENTE TRADING - INICIO AUTOMATICO CON WINDOWS
echo ============================================================
echo.

if not exist "%~dp0arranque_silencioso.vbs" (
  echo [ERROR] No encuentro arranque_silencioso.vbs junto a este fichero.
  pause
  exit /b 1
)

schtasks /Create /F /TN "AGT-AgenteTrading" /SC ONLOGON /RL LIMITED /TR "wscript.exe \"%~dp0arranque_silencioso.vbs\"" >nul 2>&1
if errorlevel 1 (
  echo [ERROR] No se pudo crear la tarea. Prueba a ejecutar este fichero
  echo         con clic derecho -^> "Ejecutar como administrador".
  pause
  exit /b 1
)

echo [OK] Tarea "AGT-AgenteTrading" creada.
echo.
echo   A partir de ahora, al iniciar sesion en Windows:
echo     - Arranca el Bridge y el Bot solos (ventanas minimizadas)
echo     - NO abre el navegador (lo abres tu cuando quieras)
echo     - Todo queda logueado en la carpeta logs\
echo.
echo   Para comprobar el estado: 2-ESTADO-AGENTE.bat
echo   Para pararlo:             3-PARAR-AGENTE.bat
echo   Para quitar el autoarranque: 5-QUITAR-INICIO-AUTOMATICO.bat
echo.
pause
exit /b 0
