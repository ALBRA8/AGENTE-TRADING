# CONTEXTO DEL AGENTE TRADING

## Propósito

Esta carpeta es la **fuente persistente del contexto de trabajo** construido durante las conversaciones del proyecto AGENTE-TRADING.

Su objetivo es evitar que el avance conceptual, las decisiones arquitectónicas, el conocimiento de trading derivado de los vídeos y los contratos ya congelados se pierdan si una conversación se cierra.

## Regla de alcance

Este contexto contiene únicamente conocimiento y decisiones desarrollados en el trabajo del proyecto que se ha consolidado en la conversación. No debe inventarse información que no haya sido establecida.

Cuando un dato no esté confirmado, debe conservarse como UNKNOWN / pendiente de validación y no convertirse en hecho.

## Estado de referencia

- Repositorio: `ALBRA8/AGENTE-TRADING`
- Rama: `main`
- Último hito auditado: **P0 EXECUTION TRUTH**
- Commit P0: `bc3d24b7713950081b4113b483fe26f98c10b01a`
- Estado P0 declarado por el constructor: **PASS**
- P0: implementado, testeado e integrado; pendiente de validación prolongada con MT5 real antes de dinero real.

## Índice

1. `01_ARQUITECTURA_Y_DECISIONES.md` — arquitectura Trading, relación futura con AGENTE-GENERAL y decisiones congeladas.
2. `02_CONOCIMIENTO_DE_VIDEOS_Y_TRADING.md` — conocimiento de trading trabajado/derivado de los vídeos y base conceptual.
3. `03_EXECUTION_TRUTH_P0.md` — contrato e implementación P0 de verdad de ejecución MT5.
4. `04_ESTADO_ACTUAL_Y_PROXIMOS_PASOS.md` — qué está terminado, qué está pendiente y qué NO debe hacerse todavía.
5. `05_REGLAS_DE_CONTINUIDAD.md` — reglas para continuar el proyecto sin perder contexto ni duplicar arquitectura.

## Principio central

AGENTE-TRADING es un especialista de dominio. No debe convertirse en un segundo AGENTE-GENERAL.

Arquitectura objetivo:

`AGENTE-GENERAL + TRADING HARNESS = AGENTE-GENERAL con capacidad profesional de Trading`

El conocimiento de trading debe mantenerse portable, modular, versionado y separado de la infraestructura universal.

## Fuente de verdad de esta carpeta

Esta carpeta preserva **contexto de proyecto**, no sustituye al código ejecutable ni a los tests.

- Código = autoridad de implementación.
- Tests = autoridad de comportamiento probado.
- Contratos/documentación = autoridad de arquitectura acordada.
- Esta carpeta = memoria persistente del proyecto y de las decisiones tomadas en conversación.
