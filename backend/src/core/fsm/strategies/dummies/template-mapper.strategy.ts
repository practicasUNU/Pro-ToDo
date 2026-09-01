import { Injectable } from '@nestjs/common';

import { NodeType } from '@core/fsm/types/pipeline-schema.types';

import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import type {
  INodeStrategy,
  NodeResult,
} from '@core/fsm/types/node-strategy.types';

/**
 * Estrategia de ANDAMIAJE: interpola una plantilla contra el contexto acumulado.
 *
 * Es el doble del futuro `MAPEADOR_PLANTILLA`, y el unico nodo del pipeline de
 * prueba que ejercita `getInterpolatedValue`. Ver la nota sobre el andamiaje en
 * `DummyInputStrategy`.
 */
@Injectable()
export class DummyTemplateMapperStrategy implements INodeStrategy {
  public readonly nodeType = NodeType.MAPEADOR_PLANTILLA;

  public execute(
    context: StatePayloadContext,
    params: Record<string, unknown>,
  ): Promise<NodeResult> {
    const { template } = params;

    // Guarda de tipo en vez de un cast: `params` es Record<string, unknown> por
    // contrato de INodeStrategy, y una plantilla ausente es un fallo de
    // configuracion del nodo, no una excepcion inesperada.
    if (typeof template !== 'string') {
      return Promise.resolve({
        success: false,
        error: {
          level: 'GRAVE',
          message: 'El nodo requiere un parametro "template" de tipo cadena.',
          missingFields: ['template'],
        },
      });
    }

    return Promise.resolve({
      success: true,
      data: { compiled_text: context.getInterpolatedValue(template) },
    });
  }
}
