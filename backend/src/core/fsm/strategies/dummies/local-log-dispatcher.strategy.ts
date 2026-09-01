import { Injectable, Logger } from '@nestjs/common';

import { NodeType } from '@core/fsm/types/pipeline-schema.types';

import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import type {
  INodeStrategy,
  NodeResult,
} from '@core/fsm/types/node-strategy.types';

/** Namespace del que este nodo lee el texto ya compilado. */
const RENDERED_NAMESPACE = 'rendered_message';

/**
 * Estrategia de ANDAMIAJE: sustituye la publicacion HTTP por un volcado a consola.
 *
 * Cierra el pipeline de prueba haciendo visible el resultado de la interpolacion,
 * que es justo lo que se quiere ver al ejecutar el runner manual. Ver la nota
 * sobre el andamiaje en `DummyInputStrategy`.
 *
 * El `Logger` se crea con `new` y no se inyecta por constructor: la clase vive
 * fuera del contenedor de Nest, asi que no hay inyeccion que resolver.
 */
@Injectable()
export class DummyLogDispatcherStrategy implements INodeStrategy {
  public readonly nodeType = NodeType.DESTINO_HTTP;

  private readonly logger = new Logger(DummyLogDispatcherStrategy.name);

  // Este nodo no consume `params`: TypeScript permite implementar el metodo con
  // menos argumentos que la interfaz, y omitirlo es mas limpio que arrastrar un
  // parametro sin usar.
  public execute(context: StatePayloadContext): Promise<NodeResult> {
    // Se lee por interpolacion y no con `getNamespace(...)?.compiled_text`:
    // aquello devuelve `unknown` y obligaria a castear, mientras que esto usa la
    // maquinaria del propio motor y ya entrega una cadena.
    const compiledText = context.getInterpolatedValue(
      `{{ ${RENDERED_NAMESPACE}.compiled_text }}`,
    );

    this.logger.log('='.repeat(72));
    this.logger.log(`[PROTO-DO MOTOR FSM] -> Salida generada: ${compiledText}`);
    this.logger.log('='.repeat(72));

    return Promise.resolve({
      success: true,
      data: { loggedAt: new Date().toISOString(), status: 'SUCCESS' },
    });
  }
}
