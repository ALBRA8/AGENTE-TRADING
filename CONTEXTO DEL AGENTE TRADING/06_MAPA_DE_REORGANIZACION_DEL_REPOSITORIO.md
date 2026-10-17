# 06_MAPA_DE_REORGANIZACION_DEL_REPOSITORIO.md

## Objetivo

Separar claramente, dentro del repositorio `ALBRA8/AGENTE-TRADING`, la memoria documental del proyecto y el software. Este documento es un plan de trabajo: **no significa que los archivos se hayan movido**.

## Estructura actual verificada en la raíz de `main`

- `.env.example`
- `.github/`
- `.gitignore`
- `CONTEXTO DEL AGENTE TRADING/`
- `LICENSE`
- `README.md`
- `bridge.py`
- `deploy_trading.ps1`
- `docs/`
- `instalar_bridge.bat`
- `instrucciones.txt`
- `package-lock.json`
- `package.json`
- `public/`
- `public_adaptada/`
- `quick-test.mjs`
- `src/`
- `test-nvidia.mjs`
- `tests/`
- `tradingview/`
- `tsconfig.json`

## Destino propuesto

```text
AGENTE-TRADING/
├── .github/                         # Mantener en raíz: workflows y configuración GitHub
├── .gitignore                       # Mantener en raíz
├── LICENSE                          # Mantener en raíz
├── README.md                        # README de entrada: explicar las dos áreas
├── CONTEXTO DEL AGENTE TRADING/     # Memoria documental independiente
│   ├── 00_INDICE_Y_ESTADO.md
│   ├── 01_ARQUITECTURA_Y_DECISIONES.md
│   ├── 02_CONOCIMIENTO_DE_VIDEOS_Y_TRADING.md
│   ├── 03_EXECUTION_TRUTH_P0.md
│   ├── 04_ESTADO_ACTUAL_Y_PROXIMOS_PASOS.md
│   ├── 05_REGLAS_DE_CONTINUIDAD.md
│   └── 06_MAPA_DE_REORGANIZACION_DEL_REPOSITORIO.md
└── PROYECTO DE TRADING/             # Software; destino propuesto, aún no creado
    ├── .env.example
    ├── bridge.py
    ├── deploy_trading.ps1
    ├── docs/
    ├── instalar_bridge.bat
    ├── instrucciones.txt
    ├── package-lock.json
    ├── package.json
    ├── public/
    ├── public_adaptada/
    ├── quick-test.mjs
    ├── src/
    ├── test-nvidia.mjs
    ├── tests/
    ├── tradingview/
    └── tsconfig.json
```

## Clasificación preliminar

| Elemento actual | Destino propuesto | Estado / precaución |
|---|---|---|
| `CONTEXTO DEL AGENTE TRADING/` | Se queda donde está | Ya es una carpeta de primer nivel y su nombre está en mayúsculas. |
| `.github/` | Raíz | Mantener inicialmente; los workflows suelen asumir rutas desde la raíz. |
| `.gitignore`, `LICENSE` | Raíz | Archivos comunes del repositorio. |
| `README.md` | Raíz | Convertirlo en portada del repositorio con enlaces a contexto y proyecto; revisar su contenido antes de editar. |
| `.env.example`, `bridge.py`, scripts `.bat`/`.ps1` | `PROYECTO DE TRADING/` | Revisar rutas relativas y comandos de ejecución. |
| `package.json`, `package-lock.json`, `tsconfig.json` | `PROYECTO DE TRADING/` | Cambiar de ubicación puede afectar instalación, compilación y automatizaciones. |
| `src/`, `tests/`, `tradingview/`, `public/`, `public_adaptada/`, `docs/` | `PROYECTO DE TRADING/` | Revisar imports, referencias a recursos y configuración de pruebas. |
| `quick-test.mjs`, `test-nvidia.mjs`, `instrucciones.txt` | `PROYECTO DE TRADING/` | Confirmar si se usan en desarrollo, despliegue o documentación operativa. |

## Verificaciones necesarias antes de mover código

1. Leer `package.json`, `tsconfig.json`, `README.md`, scripts de instalación/despliegue y workflows de `.github/`.
2. Buscar rutas absolutas/relativas y referencias a los archivos que cambiarán de ubicación.
3. Definir si los workflows deben ejecutar comandos con `working-directory: PROYECTO DE TRADING` o si necesitan seguir en la raíz.
4. Mover en una rama de trabajo, conservando el historial mediante Git cuando sea posible.
5. Actualizar referencias y ejecutar instalación, compilación y pruebas disponibles.
6. Revisar el diff final antes de integrar los cambios en `main`.

## Regla de separación

- **CONTEXTO DEL AGENTE TRADING**: conocimiento, decisiones, fuentes, estado y continuidad documental del proyecto. No es la memoria interna/runtime del bot.
- **PROYECTO DE TRADING**: código, dependencias, pruebas, recursos e instrucciones para desarrollar o ejecutar el software.
- La documentación técnica que acompaña al código puede permanecer dentro de `PROYECTO DE TRADING/docs/`; no todo archivo Markdown pertenece al contexto.

## Estado

- [x] Consultado el listado actual de la raíz de `main`.
- [x] Consultado el listado actual de `CONTEXTO DEL AGENTE TRADING/`.
- [ ] Revisar dependencias, scripts y workflows.
- [ ] Preparar una rama de reorganización.
- [ ] Mover archivos y actualizar rutas.
- [ ] Ejecutar verificaciones y revisar el diff.
- [ ] Integrar en `main` solo después de validar.

**Importante:** hasta completar las verificaciones, no se debe afirmar que la nueva estructura ya está aplicada ni que el proyecto sigue funcionando tras una reorganización.
