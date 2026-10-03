import { NodeStrategyFactory } from '@core/fsm/factories/node-strategy.factory';
import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { createTemplateRendererService } from '@test/factories/template-renderer.factory';

import { NodesModule } from './nodes.module';
import { CronTriggerStrategy } from './strategies/cron-trigger.strategy';
import { ImapTriggerStrategy } from './strategies/imap-trigger.strategy';
import { LlmExtractorStrategy } from './strategies/llm-extractor.strategy';
import { ParserEmailStrategy } from './strategies/parser-email.strategy';
import { OcrProcessorStrategy } from './strategies/ocr-processor.strategy';
import { SmtpAlertStrategy } from './strategies/smtp-alert.strategy';
import { TemplateMapperStrategy } from './strategies/template-mapper.strategy';
import { WebScraperStrategy } from './strategies/web-scraper.strategy';

import type { ConfigService } from '@nestjs/config';
import type { AiDefaultsConfig } from '@core/config/ai-defaults.config';
import type { SmtpNodeMailerService } from '@common/services/smtp-node-mailer.service';
import type { AiPromptTemplatesService } from '@modules/ai-prompt-templates/ai-prompt-templates.service';
import type { WebScraperRunner } from '@modules/nodes/services/web-scraper.runner';
import type { AnthropicLlmProvider } from '@modules/nodes/strategies/providers/anthropic-llm.provider';
import type { GeminiLlmProvider } from '@modules/nodes/strategies/providers/gemini-llm.provider';
import type { MockLlmProvider } from '@modules/nodes/strategies/providers/mock-llm.provider';
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
  scraper: WebScraperStrategy;
  llm: LlmExtractorStrategy;
  smtp: SmtpAlertStrategy;
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
  // El runner va vacio: inscribir la estrategia no navega a ningun sitio, y el
  // arranque de Chromium es perezoso (primera llamada a `createContext`).
  const scraper = new WebScraperStrategy({} as WebScraperRunner);
  // Los tres colaboradores van vacios: inscribir la estrategia no consulta la
  // base de datos ni sale a ningun proveedor.
  const llm = new LlmExtractorStrategy(
    {} as AiPromptTemplatesService,
    {} as MockLlmProvider,
    {} as GeminiLlmProvider,
    {} as AnthropicLlmProvider,
    {} as AiDefaultsConfig,
  );
  // El transporte va vacio: inscribir la estrategia no abre ninguna conexion
  // SMTP, y el pool de nodemailer es perezoso hasta el primer envio.
  const smtp = new SmtpAlertStrategy({} as SmtpNodeMailerService);
  // Mismo criterio: inscribirla no llama a ningun modelo.
  const ocr = new OcrProcessorStrategy(
    {} as MockLlmProvider,
    {} as GeminiLlmProvider,
    {} as AiDefaultsConfig,
  );

  return {
    factory,
    mapper,
    imap,
    cron,
    parser,
    scraper,
    llm,
    smtp,
    ocr,
    module: new NodesModule(
      factory,
      mapper,
      imap,
      cron,
      parser,
      scraper,
      llm,
      smtp,
      ocr,
    ),
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

  it('1.5 deberia registrar WebScraperStrategy en la factoria al iniciarse', () => {
    // 1. Arrange
    const { factory, scraper, module } = buildHarness();

    // 2. Act
    module.onModuleInit();

    // 3. Assert: es ademas lo que hace que `GET /api/nodos` pase EXTRACTOR_WEB a
    //    `implemented: true`, porque el catalogo deriva esa marca de la factoria.
    expect(factory.getStrategy(NodeType.EXTRACTOR_WEB)).toBe(scraper);
  });

  it('1.6 deberia registrar LlmExtractorStrategy en la factoria al iniciarse', () => {
    // 1. Arrange
    const { factory, llm, module } = buildHarness();

    // 2. Act
    module.onModuleInit();

    // 3. Assert: PROCESADOR_IA llevaba desde la migracion 011 declarado en el
    //    enum y sin estrategia, asi que un esquema que lo incluyera se guardaba
    //    y reventaba en ejecucion con `StrategyNotFoundException`. Este registro
    //    es ademas lo que lo pasa a `implemented: true` en `GET /api/nodos`.
    expect(factory.getStrategy(NodeType.PROCESADOR_IA)).toBe(llm);
  });

  it('1.7 deberia registrar SmtpAlertStrategy en la factoria al iniciarse', () => {
    // 1. Arrange 📐
    const { factory, smtp, module } = buildHarness();

    // 2. Act ⚙️
    module.onModuleInit();

    // 3. Assert 🎯: sin este registro, un `onErrorStep` que apuntara al nodo de
    //    alerta desviaria el cursor hacia un `StrategyNotFoundException`, de
    //    modo que el fallo original quedaria enterrado bajo un segundo fallo
    //    —y sin avisar a nadie, que es justo lo contrario de lo que se pedia.
    expect(factory.getStrategy(NodeType.DESTINO_SMTP)).toBe(smtp);
  });

  it('1.8 deberia registrar OcrProcessorStrategy en la factoria al iniciarse', () => {
    // 1. Arrange
    const { factory, ocr, module } = buildHarness();

    // 2. Act
    module.onModuleInit();

    // 3. Assert: sin este registro, un flujo con la rama de contingencia se
    //    guardaria sin protestar y reventaria al ejecutarla con
    //    `StrategyNotFoundException`.
    expect(factory.getStrategy(NodeType.PROCESADOR_OCR)).toBe(ocr);
  });
});
