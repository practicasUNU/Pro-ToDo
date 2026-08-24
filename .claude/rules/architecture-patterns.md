# Reglas de Patrones de Arquitectura y Motor FSM

## 1. ⚙️ Ciclo de Vida del Motor FSM (`FsmEngineService`)
- El motor opera como una Máquina de Estados Finita basada en una tabla o arreglo declarativo de transiciones.
- **Estados del flujo:** `INACTIVO`, `EN_PROCESO`, `PAUSADO`, `EXITOSO`, `FALLIDO`.
- **Bucle de ejecución (`Execution Loop`):** 
  1. Identifica el paso activo mediante el `activeCursor`.
  2. Obtiene la estrategia adecuada usando `NodeStrategyFactory`.
  3. Ejecuta la estrategia pasando el `StatePayloadContext` y los parámetros de configuración.
  4. Si la ejecución es exitosa, almacena el resultado bajo su *namespace*, actualiza el punto de control (`checkpointing`) en PostgreSQL y avanza el cursor al siguiente estado.
  5. Si ocurre un fallo, activa el protocolo de detención y persistencia híbrida.

---

## 2. 🧩 Patrón Estrategia y Fábrica (`INodeStrategy` & `NodeStrategyFactory`)

Todo nodo funcional debe implementar la interfaz `INodeStrategy` y registrarse en la fábrica para permitir resolución polimórfica:

```typescript
// Contrato estándar de salida de nodo
export interface NodeResult {
  success: boolean;
  data?: Record<string, unknown>;
  error?: {
    level: 'LEVE' | 'GRAVE' | 'URGENTE';
    message: string;
    missingFields?: string[];
    stackTrace?: string;
  };
}

// Interfaz que implementan todas las estrategias
export interface INodeStrategy {
  readonly nodeType: string;
  execute(
    context: StatePayloadContext, 
    config: Record<string, unknown>
  ): Promise<NodeResult>;
}

```

---

## 3. 🧊 Contexto Inmutable y Namespaces (`StatePayloadContext`)

* **Inmutabilidad estricta:** Queda prohibido mutar datos existentes de pasos previos.
* **Uso de Namespaces:** Cada nodo escribe exclusivamente en su propio espacio de nombres usando el operador spread (`...`):

```typescript
export class StatePayloadContext {
  private readonly executionId: string;
  private currentStep: string;
  private namespaces: Record<string, Record<string, unknown>>;

  constructor(executionId: string, initialStep: string) {
    this.executionId = executionId;
    this.currentStep = initialStep;
    this.namespaces = {};
  }

  public setNamespace(namespace: string, data: Record<string, unknown>): void {
    this.namespaces = {
      ...this.namespaces,
      [namespace]: {
        ...(this.namespaces[namespace] ?? {}),
        ...data,
      },
    };
  }

  public getNamespace(namespace: string): Record<string, unknown> | undefined {
    return this.namespaces[namespace];
  }

  public getAllContext(): Record<string, Record<string, unknown>> {
    return { ...this.namespaces };
  }

  /**
   * Sustituye variables dinámicas (`{{nodo.campo}}`) en una cadena o plantilla HTML
   * resolviéndolas contra los namespaces almacenados.
   */
  public getInterpolatedValue(template: string): string {
    return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)\s*\}\}/g, (_, nodeKey, fieldKey) => {
      const value = this.namespaces[nodeKey]?.[fieldKey];
      return value !== undefined && value !== null ? String(value) : '';
    });
  }
}

```

---

## 4. 🛑 Protocolo de Resiliencia, Fallos y Persistencia Híbrida

Cuando un nodo retorna `success: false` o lanza una excepción no controlada, el `FsmEngineService` debe ejecutar este orden estricto de operaciones:

1. 📝 **Escritura en Archivo Físico (`.log`):** Volcar inmediatamente el *stack trace* completo, el payload entrante y los metadatos técnicos en el disco del servidor mediante Winston.
2. 💾 **Persistencia en PostgreSQL:** Insertar el registro en la tabla de trazabilidad/alertas con el nivel de severidad (`LEVE`, `GRAVE`, `URGENTE`), la ruta del archivo `.log` asociado y guardar el *checkpoint* del `StatePayloadContext` en su columna `jsonb`.
3. 🛑 **Transición y Pausa del Motor:** Cambiar el estado del flujo a `PAUSADO` y detener el bucle de ejecución, preservando el `activeCursor` en el paso que falló.
4. 🔌 **Notificación WebSocket:** Emitir el evento de error a la sala del flujo para que Quasar actualice la interfaz y permita el reintento (`CU-09`).

---

## 5. 📬 Desacoplamiento y Notificaciones en Tiempo Real

* **Colas Productor-Consumidor:** Las ejecuciones pesadas o disparadas por Cron/IMAP deben enviarse a colas de BullMQ para no bloquear el hilo de peticiones HTTP.
* **WebSockets Gateway:** Cada flujo ejecutándose debe emitir eventos (`node_started`, `node_completed`, `flow_finished`, `flow_failed`) a la sala correspondiente (`flow_${flowId}`).

---

## 6. 📚 Librerías Externas por Tipo de Nodo

* **Nodos de Ingesta:** `imapflow` (conexión IMAP) + `mailparser` (decodificación MIME de correos y adjuntos).
* **Nodos de Extracción Web / Sanitización Pre-IA:** `cheerio` (manipulación DOM), `playwright` (navegación headless anti-bloqueo), `@mozilla/readability` (aislamiento del contenido del artículo).
* **Nodos de Inferencia LLM:** `@anthropic-ai/sdk` (Claude) u `openai` (ChatGPT), según el proveedor configurado en el nodo.
* **Nodos de Validación / Mapeo a Drupal:** `ajv` (JSON Schema estricto), `validator` (sanitización de strings), `sanitize-html` (filtrado de tags) y `handlebars` (interpolación de plantillas, alternativa a `getInterpolatedValue` para casos complejos).
