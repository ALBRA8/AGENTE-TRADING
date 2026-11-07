@echo off
chcp 65001 > nul
title AGENTE DE TRADING INSTITUCIONAL (SMC)
color 0A

echo ============================================================
echo   🚀 INICIANDO SISTEMA DE TRADING INSTITUCIONAL (SMC)
echo ============================================================
echo.

cd /d "%~dp0"

echo [1/3] Verificando dependencias...
if not exist node_modules (
    echo Instalando paquetes npm...
    call npm install
)

echo.
echo [2/3] Levantando Servidor Bridge de MetaTrader 5 (Puerto 5001)...
start "MT5 Bridge Server (Puerto 5001)" /min cmd /k "python bridge.py"

echo.
echo [3/3] Levantando Agente de Trading y Dashboard Web (Puerto 4000)...
timeout /t 2 > nul
start http://localhost:4000

echo.
echo ============================================================
echo   SISTEMA EN LINEA
echo   - MT5 Bridge:  http://localhost:5001
echo   - Dashboard:   http://localhost:4000
echo   - Telegram:    Escuchando mensajes
echo ============================================================
echo.

npm run dev

pause
