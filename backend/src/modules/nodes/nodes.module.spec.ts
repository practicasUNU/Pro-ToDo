import { NodeStrategyFactory } from '@core/fsm/factories/node-strategy.factory';
import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { TemplateRendererService } from '@modules/templates/services/template-renderer.service';

import { NodesModule } from './nodes.module';
import { TemplateMapperStrategy } from './strategies/template-mapper.strategy';

import type { TemplatesService } from '@modules/templates/templates.service';

/**
 * Verifica el cableado del registro dinamico sin arrancar Nest ni PostgreSQL.
 *
 * El motor resuelve las estrategias contra la instancia de `NodeStrategyFactory`
 * que exporta `FsmModule`; si `onModuleInit` no la inscribiera, el nodo
 * MAPEADOR_PLANTILLA reventaria en ejecucion con `StrategyNotFoundException` y
 * no en el arranque, que es justo lo que este test adelanta.
 */
describe('NodesModule', () => {
  it('1.1 deberia registrar TemplateMapperStrategy en la factoria al iniciarse', () => {
    // 1. Arrange
    const factory = new NodeStrategyFactory();
    jest.spyOn(factory['logger'], 'log').mockImplementation(() => undefined);
    const strategy = new TemplateMapperStrategy(
      {} as TemplatesService,
      new TemplateRendererService(),
    );
    const module = new NodesModule(factory, strategy);

    // 2. Act
    module.onModuleInit();

    // 3. Assert
    expect(factory.getStrategy(NodeType.MAPEADOR_PLANTILLA)).toBe(strategy);
  });
});
