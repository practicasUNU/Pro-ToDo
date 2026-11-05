import { Injectable } from '@nestjs/common';

import { NodeType } from '@core/fsm/types/pipeline-schema.types';

import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import type {
  INodeStrategy,
  NodeResult,
} from '@core/fsm/types/node-strategy.types';

/**
 * Estrategia de ANDAMIAJE: simula el disparador que inyecta el payload inicial.
 *
 * Devuelve sus propios `params` como salida, de modo que el esquema de prueba
 * declara los datos de entrada de forma declarativa, sin fuentes externas.
 *
 * NO se declara en ningun modulo de Nest y queda excluida de `tsconfig.build.json`:
 * es un doble para el runner y la suite e2e, no codigo de produccion. El
 * `@Injectable()` esta por coherencia estilistica; quien la usa la instancia con
 * `new` y la pasa a `NodeStrategyFactory.registerStrategy()`.
 *
 * Se registra bajo un `NodeType` REAL en vez de un tipo inventado: asi el
 * esquema dummy sigue siendo validable por `PipelineValidatorService`, y el dia
 * que exista la estrategia IMAP de verdad ocupara exactamente este hueco.
 */
@Injectable()
export class DummyInputStrategy implements INodeStrategy {
  public readonly nodeType = NodeType.TRIGGER_IMAP;

  public execute(
    _context: StatePayloadContext,
    params: Record<string, unknown>,
  ): Promise<NodeResult> {
    return Promise.resolve({ success: true, data: { ...params } });
  }
}
