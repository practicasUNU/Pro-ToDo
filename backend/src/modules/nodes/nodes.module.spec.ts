import { NodeStrategyFactory } from '@core/fsm/factories/node-strategy.factory';
import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { createTemplateRendererService } from '@test/factories/template-renderer.factory';

import { NodesModule } from './nodes.module';
import { CronTriggerStrategy } from './strategies/cron-trigger.strategy';
import { ImapTriggerStrategy } from './strategies/imap-trigger.strategy';
import { ParserEmailStrategy } from './strategies/parser-email.strategy';
import { TemplateMapperStrategy } from './strategies/template-mapper.strategy';

import type { ConfigService } from '@nestjs/config';
import type { TemplatesService } from '@modules/templates/templates.service';

/**
 * Verifica el cableado del registro dinamico sin arrancar Nest ni PostgreSQL.
 *
 * El motor resuelve las estrategias contra la instancia de `NodeStrategyFactory`
 * que exporta `FsmModule`; si `onModuleInit` no la inscribiera, el nodo
 * MAPEADOR_PLANTILLA reventaria en ejecucion con `StrategyNotFoundException` y
 * no en el arranque, que es justo lo que este test adelanta.
 */
/** Factoria silenciada mas las estrategias reales del modulo. */
const buildHarness = (): {
  factory: NodeStrategyFactory;
  mapper: TemplateMapperStrategy;
  imap: ImapTriggerStrategy;
  cron: CronTriggerStrategy;
  parser: ParserEmailStrategy;
  module: NodesModule;
} => {
  const factory = new NodeStrategyFactory();
  jest.spyOn(factory['logger'], 'log').mockImplementation(() => undefined);

  const mapper = new TemplateMapperStrategy(
    {} as TemplatesService,
    createTemplateRendererService(),
  );
  const imap = new ImapTriggerStrategy({} as ConfigService);
  // Sin dependencias inyectadas: el nodo CRON no hace E/S ni lee secretos.
  const cron = new CronTriggerStrategy();
  // Tampoco el parser: solo lee el contexto que le entrega el motor.
  const parser = new ParserEmailStrategy();

  return {
    factory,
    mapper,
    imap,
    cron,
    parser,
    module: new NodesModule(factory, mapper, imap, cron, parser),
  };
};

describe('NodesModule', () => {
  it('1.1 deberia registrar TemplateMapperStrategy en la factoria al iniciarse', () => {
    // 1. Arrange
    const { factory, mapper, module } = buildHarness();

    // 2. Act
    module.onModuleInit();

    // 3. Assert
    expect(factory.getStrategy(NodeType.MAPEADOR_PLANTILLA)).toBe(mapper);
  });

  it('1.2 deberia registrar ImapTriggerStrategy en la factoria al iniciarse', () => {
    // 1. Arrange
    const { factory, imap, module } = buildHarness();

    // 2. Act
    module.onModuleInit();

    // 3. Assert: sin esto, el nodo TRIGGER_IMAP reventaria en ejecucion con
    //    `StrategyNotFoundException` y no en el arranque.
    expect(factory.getStrategy(NodeType.TRIGGER_IMAP)).toBe(imap);
  });

  it('1.3 deberia registrar CronTriggerStrategy en la factoria al iniciarse', () => {
    // 1. Arrange
    const { factory, cron, module } = buildHarness();

    // 2. Act
    module.onModuleInit();

    // 3. Assert: sin esto, el primer vencimiento del planificador moriria en el
    //    paso 1 con `StrategyNotFoundException`, normalizada a URGENTE.
    expect(factory.getStrategy(NodeType.TRIGGER_CRON)).toBe(cron);
  });

  it('1.4 deberia registrar ParserEmailStrategy en la factoria al iniciarse', () => {
    // 1. Arrange
    const { factory, parser, module } = buildHarness();

    // 2. Act
    module.onModuleInit();

    // 3. Assert: ademas de habilitar el nodo, este registro es lo que hace que
    //    `GET /api/nodos` devuelva PARSER_PRE_IA como implementado.
    expect(factory.getStrategy(NodeType.PARSER_PRE_IA)).toBe(parser);
  });
});
