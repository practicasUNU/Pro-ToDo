import { NodeStrategyFactory } from '@core/fsm/factories/node-strategy.factory';
import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { createTemplateRendererService } from '@test/factories/template-renderer.factory';

import { NodesModule } from './nodes.module';
import { CronTriggerStrategy } from './strategies/cron-trigger.strategy';
import { DrupalHttpStrategy } from './strategies/drupal-http.strategy';
import { AcensHttpStrategy } from './strategies/acens-http.strategy';
import { HttpGenericDestinationStrategy } from './strategies/http-generic-destination.strategy';
import { ImapTriggerStrategy } from './strategies/imap-trigger.strategy';
import { LlmExtractorStrategy } from './strategies/llm-extractor.strategy';
import { ParserEmailStrategy } from './strategies/parser-email.strategy';
import { PostIaSanitizerStrategy } from './strategies/post-ia-sanitizer.strategy';
import { OcrProcessorStrategy } from './strategies/ocr-processor.strategy';
import { PauseFlowStrategy } from './strategies/pause-flow.strategy';
import { SmtpAlertStrategy } from './strategies/smtp-alert.strategy';
import { TemplateMapperStrategy } from './strategies/template-mapper.strategy';
import { WebScraperStrategy } from './strategies/web-scraper.strategy';

import type { ConfigService } from '@nestjs/config';
import type { InboundEmailResumeService } from '@modules/workflows/inbound-email-resume.service';
import type { AcensApiConfig } from '@core/config/acens-api.config';
import type { DrupalApiConfig } from '@core/config/drupal-api.config';
import type { HttpClientService } from '@core/http/http-client.service';
import type { OutboundTargetGuard } from '@core/http/outbound-url.guard';
import type { CredentialsService } from '@modules/credentials/credentials.service';
import type { AiDefaultsConfig } from '@core/config/ai-defaults.config';
import type { SmtpNodeMailerService } from '@common/services/smtp-node-mailer.service';
import type { AiPromptTemplatesService } from '@modules/ai-prompt-templates/ai-prompt-templates.service';
import type { WebScraperRunner } from '@modules/nodes/services/web-scraper.runner';
import type { LlmProviderFactory } from '@modules/nodes/strategies/llm-provider.factory';
import type { MockLlmProvider } from '@modules/nodes/strategies/providers/mock-llm.provider';
import type { LlmProviderCatalogService } from '@modules/nodes/services/llm-provider-catalog.service';
import type { TelemetryService } from '@modules/telemetry/telemetry.service';
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
  shield: PostIaSanitizerStrategy;
  imap: ImapTriggerStrategy;
  cron: CronTriggerStrategy;
  parser: ParserEmailStrategy;
  scraper: WebScraperStrategy;
  llm: LlmExtractorStrategy;
  smtp: SmtpAlertStrategy;
  ocr: OcrProcessorStrategy;
  drupal: DrupalHttpStrategy;
  pause: PauseFlowStrategy;
  httpGeneric: HttpGenericDestinationStrategy;
  acens: AcensHttpStrategy;
  module: NodesModule;
} => {
  const factory = new NodeStrategyFactory();
  jest.spyOn(factory['logger'], 'log').mockImplementation(() => undefined);

  const mapper = new TemplateMapperStrategy(
    {} as TemplatesService,
    createTemplateRendererService(),
  );
  // El renderer va REAL: es puro (sin repositorio, red ni estado) y es la unica
  // dependencia del escudo, asi que un doble no ahorraria nada.
  const shield = new PostIaSanitizerStrategy(createTemplateRendererService());
  // El servicio de ordenes va vacio por el mismo criterio que el resto:
  // inscribir la estrategia no atiende ningun correo.
  const imap = new ImapTriggerStrategy(
    {} as ConfigService,
    {} as InboundEmailResumeService,
  );
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
    {} as LlmProviderFactory,
    {} as AiDefaultsConfig,
    {} as LlmProviderCatalogService,
    {} as TelemetryService,
  );
  // El transporte va vacio: inscribir la estrategia no abre ninguna conexion
  // SMTP, y el pool de nodemailer es perezoso hasta el primer envio.
  const smtp = new SmtpAlertStrategy(
    {} as SmtpNodeMailerService,
    {} as ConfigService,
  );
  // Mismo criterio: inscribirla no llama a ningun modelo.
  const ocr = new OcrProcessorStrategy(
    {} as MockLlmProvider,
    {} as LlmProviderFactory,
    {} as AiDefaultsConfig,
    {} as LlmProviderCatalogService,
    {} as TelemetryService,
  );

  // Los dos colaboradores van vacios: inscribir la estrategia no emite ninguna
  // peticion a Drupal ni lee el entorno.
  const drupal = new DrupalHttpStrategy(
    {} as HttpClientService,
    {} as DrupalApiConfig,
  );

  // Mismo criterio que el nodo de alerta: el transporte va vacio porque
  // inscribir la estrategia no abre ninguna conexion.
  const pause = new PauseFlowStrategy({} as SmtpNodeMailerService);

  // Inscribirla no despacha nada ni abre la boveda.
  const httpGeneric = new HttpGenericDestinationStrategy(
    {} as HttpClientService,
    {} as CredentialsService,
    {} as OutboundTargetGuard,
  );

  // Inscribirla no lee el entorno ni despacha nada a Acens.
  const acens = new AcensHttpStrategy(
    {} as HttpClientService,
    {} as AcensApiConfig,
  );

  return {
    factory,
    mapper,
    shield,
    imap,
    cron,
    parser,
    scraper,
    llm,
    smtp,
    ocr,
    drupal,
    pause,
    httpGeneric,
    acens,
    module: new NodesModule(
      factory,
      mapper,
      shield,
      imap,
      cron,
      parser,
      scraper,
      llm,
      smtp,
      ocr,
      drupal,
      pause,
      httpGeneric,
      acens,
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

  it('1.9 deberia registrar PostIaSanitizerStrategy en la factoria al iniciarse', () => {
    // 1. Arrange
    const { factory, shield, module } = buildHarness();

    // 2. Act
    module.onModuleInit();

    // 3. Assert: sin este registro, `GET /api/nodos` seguiria marcando
    //    ESCUDO_POST_IA como `implemented: false` y el asistente lo deshabilitaria
    expect(factory.getStrategy(NodeType.ESCUDO_POST_IA)).toBe(shield);
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

  it('1.10 deberia registrar DrupalHttpStrategy en la factoria al iniciarse', () => {
    // 1. Arrange
    const { factory, drupal, module } = buildHarness();

    // 2. Act
    module.onModuleInit();

    // 3. Assert: este destino llevaba desde la migracion 005 en el enum sin
    // ninguna estrategia inscrita —la unica implementacion vivia en
    // `strategies/dummies/` y nadie la registra—, asi que `GET /api/nodos` lo
    // servia con `implemented: false` y un flujo que llegara a publicar
    // reventaba en su ultimo paso con `StrategyNotFoundException`, que el motor
    // normaliza a URGENTE y por tanto no reintenta.
    expect(factory.getStrategy(NodeType.DESTINO_DRUPAL)).toBe(drupal);
  });
  it('1.11 deberia registrar PauseFlowStrategy en la factoria al iniciarse', () => {
    // 1. Arrange 📐
    const { factory, pause, module } = buildHarness();

    // 2. Act ⚙️
    module.onModuleInit();

    // 3. Assert 🎯
    expect(factory.getStrategy(NodeType.PAUSA_FLOW)).toBe(pause);
  });

  it('1.12 deberia registrar HttpGenericDestinationStrategy en la factoria al iniciarse', () => {
    // 1. Arrange 📐
    const { factory, httpGeneric, module } = buildHarness();

    // 2. Act ⚙️
    module.onModuleInit();

    // 3. Assert 🎯
    expect(factory.getStrategy(NodeType.DESTINO_HTTP_GENERICO)).toBe(
      httpGeneric,
    );
  });

  it('1.13 deberia registrar AcensHttpStrategy en la factoria al iniciarse', () => {
    // 1. Arrange 📐
    const { factory, acens, module } = buildHarness();

    // 2. Act ⚙️
    module.onModuleInit();

    // 3. Assert 🎯
    expect(factory.getStrategy(NodeType.DESTINO_ACENS)).toBe(acens);
  });
});
