# 06 — DISEÑO PROPUESTO: DOBLE ESCENARIO Y EVOLUCIÓN DE ESTRATEGIAS

## Estado de este documento

**Estado: DISEÑO PROPUESTO / NO IMPLEMENTADO COMO SISTEMA COMPLETO.**

Este documento registra la idea acordada en conversación para que no se pierda entre sesiones. No afirma que la funcionalidad ya exista ni autoriza cambios automáticos en la operativa real.

Alcance: únicamente el repositorio **AGENTE-TRADING**.

## 1. Objetivo planteado

AGENTE-TRADING debe evolucionar hacia un sistema capaz de mantener una estrategia operativa de referencia mientras investiga muchas alternativas de forma simulada. El escenario experimental debe aprender de las pruebas, generar hipótesis y evaluar estrategias o variantes; la estrategia operativa no debe cambiar solo porque una prueba aislada haya salido bien.

La visión del usuario es que el escenario experimental pueda hacer tantas pruebas ficticias como permita la capacidad de cómputo/datos, buscar configuraciones y entradas más consistentes y, si la evidencia lo respalda, proponer una nueva versión de estrategia. La evolución puede ser autónoma dentro del entorno de experimentación, con barreras estrictas entre experimento y ejecución real.

## 2. Modelo conceptual de dos escenarios

### Escenario A — Operativa de referencia

- Ejecuta la versión de estrategia actualmente aprobada, en el modo habilitado (inicialmente SHADOW/demo según el estado de validación).
- Usa el Strategy Engine canónico existente: `src/strategy/engine.ts`.
- Produce decisiones, señales y resultados con trazabilidad.
- No debe cambiar silenciosamente de versión por los resultados de una sola operación ni por una recomendación del modelo.
- Su estado/versionado debe poder identificarse para comparar resultados de forma reproducible.

### Escenario B — Laboratorio de experimentación

- Realiza operaciones ficticias/simuladas; no envía órdenes al bróker.
- Puede evaluar muchas hipótesis, parámetros y variantes de estrategia en lotes reproducibles.
- Puede simular oportunidades que el escenario A no tomó (counterfactuals), siempre etiquetándolas como simuladas.
- Aprende de resultados simulados, backtests, counterfactuals y observaciones, manteniendo la procedencia de cada experiencia separada de `REAL_TRADE`.
- Compara candidatos contra la estrategia de referencia con los mismos datos y condiciones.
- Produce resultados, evidencia y candidatos versionados; no se concede a sí mismo permiso para promocionar una estrategia a operativa real.

**Separación obligatoria:** una entrada ficticia del escenario B nunca es una operación real, nunca se contabiliza como PnL realizado del bróker y nunca se etiqueta como `REAL_TRADE`.

## 3. Flujo de evolución deseado

```text
StrategyVersion vigente (baseline / Escenario A)
                    |
                    +----> decisiones y resultados observados
                    |
                    v
ExperienceRecord / CounterfactualExperience
                    |
                    v
LearningCandidate -> Hypothesis -> Experiment (Escenario B)
                                      |
                                      v
                           Backtest / replay / stress
                                      |
                                      v
                         Walk-forward + datos OOS
                                      |
                                      v
                         ValidationResult + evidencia
                                      |
                                      v
                      comparar con baseline y criterios
                                      |
                         +------------+------------+
                         |                         |
                      FALLA                     SUPERA GATES
                         |                         |
                    descartar/                 StrategyVersion
                    archivar                    candidata
                                                   |
                                                   v
                                    shadow/demo y revisión de
                                    ejecución/robustez adicionales
                                                   |
                                                   v
                                      promoción controlada
```

El nombre de las entidades refleja la arquitectura prevista en `01_ARQUITECTURA_Y_DECISIONES.md`; este flujo no implica que todos los pasos estén implementados actualmente.

## 4. Qué puede explorar el escenario B

En una primera etapa, es preferible experimentar con parámetros y reglas delimitadas de una estrategia versionada antes de permitir generación libre de estrategias completas. Ejemplos: condiciones de contexto, filtros de sesión, criterios de confirmación, parámetros de stop/target y reglas de gestión, siempre dentro de límites de riesgo predefinidos.

En etapas posteriores podría investigarse la generación de una estrategia nueva a partir de hipótesis y evidencia. Cada estrategia debe tener identidad, versión, configuración inmutable, procedencia y manifiesto de experimento.

### Indicador de TradingView / Pine Script

La generación automática de un Pine Script nuevo es una posibilidad futura, no una capacidad verificada del repositorio actual. Si se implementa, Pine Script sería una representación/adaptación opcional de una estrategia versionada, no la fuente de verdad ni un sustituto del Strategy Engine canónico.

Un script generado debe compilarse, probarse contra casos conocidos y compararse con la lógica canónica para detectar diferencias de señales. No debe publicarse, conectarse por webhook ni utilizarse para ejecutar órdenes automáticamente sin validación separada.

## 5. Criterios de validación y promoción

No basta con obtener rentabilidad en los datos usados para buscar la estrategia. Los candidatos deben evaluarse con controles como:

- baseline identificado y comparación justa con mismos datos, periodo, costes y supuestos;
- separación temporal entre entrenamiento/in-sample (IS) y prueba out-of-sample (OOS);
- walk-forward corregido y validado;
- pruebas de estrés y sensibilidad a parámetros;
- costes, spread, slippage, gaps y reglas de ejecución realistas;
- resultados por régimen de mercado y consistencia entre ventanas;
- drawdown, exposición, frecuencia de operaciones y límites de riesgo;
- prevención de overfitting, leakage/look-ahead y selección sesgada del mejor candidato;
- manifiesto reproducible: dataset, rango temporal, parámetros, seed, versión de motor y métricas;
- comparación posterior en SHADOW/demo antes de considerar cualquier promoción.

Los umbrales cuantitativos deben definirse explícitamente antes de ejecutar la búsqueda; no se consideran definidos por este documento.

## 6. Dependencia crítica: Execution Truth

El roadmap actual exige validar P0 Execution Truth mediante MT5/SHADOW antes de comenzar la evolución completa de estrategias. Esta dependencia se mantiene.

La validación de ejecución y la investigación simulada son trabajos distintos:
- Se puede diseñar y preparar el laboratorio de experimentación sin habilitar órdenes reales.
- Los resultados de una estrategia candidata no demuestran que el adaptador de ejecución funcione.
- Los resultados de ejecución solo alimentan aprendizaje como `REAL_TRADE` si están realizados, reconciliados y respaldados por evidencia suficiente.
- Un resultado de ejecución `UNKNOWN` no se transforma en éxito, fallo ni motivo para repetir ciegamente una orden.

## 7. Reutilizar lo que ya existe

Antes de construir módulos nuevos, inspeccionar y reutilizar:

- `src/strategy/engine.ts`: motor estratégico canónico, sin crear otro;
- backtest existente, evaluando su convergencia futura hacia adapters del Strategy Engine;
- `walk_forward.ts`: existe, pero tiene deuda documentada que debe resolverse y probarse;
- stress testing: existe, pero requiere reproducibilidad y replay del motor canónico;
- `src/agent/self_improve.ts`: reflexión de experiencia y lecciones; es un puente de aprendizaje, no el sistema completo de evolución de estrategias;
- consolidación, trackrecord y counterfactuals existentes o previstos, después de verificar su implementación real;
- `StrategyVersion`, `Hypothesis`, `Experiment`, `ValidationResult` y `Promotion` como entidades de diseño previstas, sin asumir que todas están implementadas.

## 8. Límites de seguridad y operación

- Escenario B no tiene acceso a credenciales ni a rutas que envíen órdenes al bróker.
- Los experimentos no pueden alterar la configuración de A ni promocionarse a sí mismos.
- La promoción es una transición explícita, auditada y reversible a una versión identificada.
- Mantener límites de riesgo independientes de la estrategia; el optimizador no puede relajar esos límites para mejorar métricas.
- La versión anterior debe permanecer disponible para rollback.
- No habilitar LIVE solo por backtests positivos o tests de software verdes.
- MetaApi y cualquier otro adaptador aún no probado siguen siendo experimentales; no se asume que sustituyen el puente Python/MT5 documentado.

## 9. Estado actual conocido y preguntas abiertas

Según el contexto existente:
- Existe Strategy Engine canónico.
- Existe backtesting histórico con varias salvaguardas, aunque hay deuda técnica en los componentes de evaluación.
- Existe `self_improve.ts` para reflexionar sobre experiencias y producir lecciones con controles de recurrencia.
- Existe un roadmap de Strategy Evolution, todavía condicionado a validar Execution Truth.

**No está demostrado todavía** que exista un laboratorio completo que genere múltiples candidatos de estrategia de manera autónoma, ejecute pruebas masivas reproducibles, los clasifique contra un baseline y gestione la promoción de nuevas versiones. Tampoco está demostrado que el agente genere automáticamente indicadores Pine Script nuevos y equivalentes al motor canónico.

Pendiente de decidir/diseñar:
1. formato y persistencia de `Experiment`, `ValidationResult` y `StrategyVersion`;
2. límites de cómputo, paralelismo y tamaño del espacio de búsqueda;
3. métricas y umbrales de promoción predefinidos;
4. corrección y pruebas del walk-forward/stress testing;
5. protocolo para reproducir señales en Pine y comprobar paridad con el motor;
6. condiciones de promoción desde laboratorio a SHADOW/demo y, más adelante, a LIVE.

## 10. Próxima secuencia recomendada

1. Validar P0 Execution Truth en SHADOW/demo y auditar la genealogía de ejecución.
2. Auditar el código actual de backtest, walk-forward, stress test, trackrecord y counterfactuals; separar lo implementado de lo pendiente.
3. Definir contratos/datos del laboratorio y de versionado sin duplicar el Strategy Engine.
4. Corregir y validar el protocolo experimental y las métricas antes de una búsqueda masiva.
5. Implementar el escenario B aislado, con pruebas simuladas y reproducibles.
6. Evaluar candidatos contra baseline, IS/OOS y walk-forward.
7. Solo tras evidencia suficiente, pasar candidatos a SHADOW/demo y considerar una promoción controlada.

## Regla de continuidad para futuras sesiones

Antes de cambiar estrategia o implementar aprendizaje autónomo, leer este documento junto con `03_EXECUTION_TRUTH_P0.md`, `04_ESTADO_ACTUAL_Y_PROXIMOS_PASOS.md` y `05_REGLAS_DE_CONTINUIDAD.md`.

Este documento registra la intención y el diseño propuesto. **No convierte una capacidad planeada en una capacidad implementada, probada o aprobada para operar en real.**
