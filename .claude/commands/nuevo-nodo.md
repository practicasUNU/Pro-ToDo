# Comando: /nuevo-nodo <nombre-nodo>

Genera el archivo de estrategia para un nuevo tipo de nodo, implementando la interfaz estándar `INodeStrategy` y registrándolo en la factoría correspondiente.

---

## 📋 Instrucciones de Ejecución

1. ✍️ **Validación del Nombre:**
   - Si no se proporcionó un nombre, solicítalo: *"Indica el nombre del nuevo nodo (ej. sanitizador-html, extractor-adjuntos):"*.
   - Normaliza el nombre a formatos `kebab-case` para archivos y `PascalCase` para clases.

2. 📁 **Creación del Archivo de Estrategia:**
   - Crea el archivo en `src/strategies/<nombre-nodo>.strategy.ts`.
   - Aplica los separadores de sección y comentarios TSDoc definidos en la regla de documentación.
   - Implementa el contrato base:

```typescript
// ============================================================================
// 1. IMPORTACIONES
// ============================================================================
import { Injectable } from '@nestjs/common';
import type { INodeStrategy, NodeResult } from '@core/fsm/interfaces/node-strategy.interface';
import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';

// ============================================================================
// 2. TIPOS Y CONFIGURACIÓN
// ============================================================================
export interface <NombreNodo>Config {
  [key: string]: unknown;
}

// ============================================================================
// 3. CLASE Y LÓGICA DE ESTRATEGIA
// ============================================================================
/**
 * Estrategia encargada de procesar la lógica de <nombre-nodo>.
 */
@Injectable()
export class <NombreNodo>Strategy implements INodeStrategy {
  public readonly nodeType = '<NOMBRE_NODO_UPPERCASE>';

  /**
   * Ejecuta la lógica del nodo usando el contexto inmutable.
   *
   * @param context Contexto transaccional de la ejecución activa.
   * @param config Configuración específica para este nodo.
   * @returns Resultado tipado indicando éxito o nivel de error.
   */
  async execute(
    context: StatePayloadContext,
    config: <NombreNodo>Config,
  ): Promise<NodeResult> {
    // Cláusula de guarda inicial
    // TODO: Validar entradas requeridas desde context.getNamespace(...)

    return {
      success: true,
      data: {},
    };
  }
}

```

3. 🏭 **Registro en la Factoría:**
* Importa y registra `<NombreNodo>Strategy` dentro de `src/core/fsm/factories/node-strategy.factory.ts`.


4. 📢 **Confirmación:**
* Notifica que el nodo fue creado y registrado exitosamente.
