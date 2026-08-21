# Habilidad: Estándar de Documentación y Comentarios de Código

Esta habilidad guía cómo documentar y estructurar internamente cualquier archivo (`.ts`, `.vue`) en Proto-Do.

---

## 1. 📑 Separadores Visuales de Sección

Cada archivo debe delimitar claramente sus bloques con comentarios de encabezado:

```typescript
// ============================================================================
// 1. IMPORTACIONES
// ============================================================================

// ============================================================================
// 2. CONSTANTES Y VARIABLES GLOBALES
// ============================================================================

// ============================================================================
// 3. CLASES Y MÉTODOS
// ============================================================================

// ============================================================================
// 4. LISTENERS Y EVENTOS
// ============================================================================

```

---

## 2. 📦 Comentarios en Importaciones

Agrupar y describir brevemente la responsabilidad de los módulos importados:

```typescript
// Librerías de NestJS para inyección de dependencias y controladores
import { Injectable, Logger } from '@nestjs/common';

// Estrategias y contratos del motor FSM
import type { INodeStrategy, NodeResult } from '@strategies/node-strategy.interface';
import { StatePayloadContext } from '@core/fsm/state-payload.context';

```

---

## 3. 🏷️ Variables y Constantes Clave

Comentar en una línea la función de las variables o constantes más importantes del archivo:

```typescript
// Tiempo límite en milisegundos antes de declarar timeout en la llamada a la IA
const MAX_AI_TIMEOUT_MS = 15000;

```

---

## 4. ⚙️ Clases, Funciones y Eventos (Resumen de 1 Línea)

Toda clase, función de utilidad o listener de eventos debe incluir un comentario conciso de una línea en español sobre su objetivo:

```typescript
/** Servicio encargado de ejecutar la estrategia de extracción de texto con modelos LLM. */
export class LlmExtractorStrategy implements INodeStrategy { ... }

/** Escucha los eventos de finalización de flujo para emitir notificaciones por WebSocket. */
onFlowCompleted(event: FlowEvent) { ... }

```

---

## 5. 🛠️ Métodos y Lógica Compleja (1 a 3 Líneas)

Los métodos deben detallar su flujo en un bloque TSDoc conciso (máximo 3 líneas) explicando el proceso, parámetros y retorno:

```typescript
  /**
   * Procesa el texto del correo mediante el LLM configurado y retorna el JSON estructurado.
   * Valida la presencia de texto limpio antes de despachar la petición a la API.
   * 
   * @param context Contexto transaccional inmutable del flujo activo.
   * @param config Parámetros del nodo (prompt, modelo y temperatura).
   * @returns Resultado tipado con el JSON generado o el nivel de error correspondiente.
   */
  async execute(
    context: StatePayloadContext,
    config: Record<string, unknown>
  ): Promise<NodeResult> {
    // ...
  }

```