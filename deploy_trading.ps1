# Script de despliegue para AGENTE TRADING
Set-Location $PSScriptRoot
Write-Host "Compilando..."
npm run build
Write-Host "Iniciando Bridge..."
Start-Process python "bridge.py"
Write-Host "Iniciando Bot..."
Start-Process npm "start"
Write-Host "Desplegado correctamente."
