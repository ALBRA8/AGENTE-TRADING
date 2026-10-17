# 05 — REGLAS DE CONTINUIDAD

## Objetivo

Cualquier conversación futura que continúe AGENTE-TRADING debe poder recuperar este contexto antes de tomar decisiones arquitectónicas.

## 1. Leer primero

Antes de diseñar o implementar un nuevo bloque:

1. leer `CONTEXTO DEL AGENTE TRADING/00_INDICE_Y_ESTADO.md`;
2. leer `01_ARQUITECTURA_Y_DECISIONES.md`;
3. leer `02_CONOCIMIENTO_DE_VIDEOS_Y_TRADING.md`;
4. leer `03_EXECUTION_TRUTH_P0.md`;
5. leer `04_ESTADO_ACTUAL_Y_PROXIMOS_PASOS.md`.

## 2. No duplicar arquitectura

Si existe un sistema universal en AGENTE-GENERAL, Trading debe integrarlo mediante adapter/extension/contract en lugar de crear una segunda implementación universal.

## 3. No degradar UNKNOWN

Nunca convertir falta de evidencia en una conclusión conveniente.

`UNKNOWN` permanece UNKNOWN hasta que aparezca evidencia suficiente.

## 4. No tratar una fuente como verdad universal

El conocimiento de vídeos debe conservar procedencia y nivel de certeza.

Un concepto de una fuente puede ser:

- observado;
- explícito;
- consolidado;
- inferido;
- regla específica de estrategia;
- regla común;
- desconocido;
- conflictivo.

## 5. US30 V1 es una semilla

No asumir que sus parámetros son óptimos ni universales.

## 6. Una operación no valida una regla

La evolución debe apoyarse en muestras, experimentos y validación OOS.

## 7. Real trade vs counterfactual

No mezclar:

REAL_TRADE

con:

COUNTERFACTUAL

Una oportunidad no ejecutada no es una operación real.

## 8. Execution Truth antes de Learning Evolution

No utilizar resultados LIVE como experiencia de aprendizaje si no están:

REALIZED + RECONCILED + SUPPORTED BY EVIDENCE.

## 9. Cambios de estrategia

No modificar el Strategy Engine para resolver un problema de infraestructura.

No modificar infraestructura para cambiar una regla estratégica.

Mantener responsabilidades separadas.

## 10. Actualización de esta carpeta

Cada hito importante debe añadir o actualizar contexto aquí.

La actualización debe conservar:

- qué se decidió;
- por qué;
- qué quedó implementado;
- qué quedó pendiente;
- qué fue descartado;
- qué deuda sigue abierta;
- cuál es el siguiente paso.

## 11. Fuentes originales

Si se recuperan los vídeos/transcripciones/archivos originales, deben almacenarse como fuentes originales y nunca sobrescribirse con una interpretación posterior.

La interpretación consolidada puede evolucionar; la fuente original no.

## 12. Principio anti-pérdida

El chat es un espacio de trabajo.

GitHub es la persistencia.

Por eso las decisiones importantes no deben quedar únicamente en el chat.
