import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { NodeStrategyFactory } from '@core/fsm/factories/node-strategy.factory';
import { FsmModule } from '@core/fsm/fsm.module';
import { HttpCoreModule } from '@core/http/http-core.module';
import { AiPromptTemplatesModule } from '@modules/ai-prompt-templates/ai-prompt-templates.module';
import { LogsModule } from '@modules/logs/logs.module';
import { TemplatesModule } from '@modules/templates/templates.module';
import { Workflow } from '@modules/workflows/entities/workflow.entity';
import { WorkflowsModule } from '@modules/workflows/workflows.module';

import { BrowserModule } from './browser.module';
import { NodeCatalogEntry } from './entities/node-catalog.entity';
import { NodeCatalogController } from './node-catalog.controller';
import { CronSchedulingService } from './services/cron-scheduling.service';
import { ImapPollingService } from './services/imap-polling.service';
import { NodeCatalogService } from './services/node-catalog.service';
import { CronTriggerStrategy } from './strategies/cron-trigger.strategy';
import { ImapTriggerStrategy } from './strategies/imap-trigger.strategy';
import { LlmExtractorStrategy } from './strategies/llm-extractor.strategy';
import { OcrProcessorStrategy } from './strategies/ocr-processor.strategy';
import { SmtpAlertStrategy } from './strategies/smtp-alert.strategy';
import { AiDefaultsConfig } from '@core/config/ai-defaults.config';
import { ParserEmailStrategy } from './strategies/parser-email.strategy';
import { GeminiLlmProvider } from './strategies/providers/gemini-llm.provider';
import { MockLlmProvider } from './strategies/providers/mock-llm.provider';
import { TemplateMapperStrategy } from './strategies/template-mapper.strategy';
import { WebScraperStrategy } from './strategies/web-scraper.strategy';

import type { OnModuleInit } from '@nestjs/common';

/**
 * Modulo de nodos: agrupa las estrategias reales de la FSM y las inscribe en la
 * factoria (PROT-10/PROT-11.2/PROT-12).
 *
 * El registro se hace aqui, en `onModuleInit`, y no dentro de
 * `NodeStrategyFactory`: la factoria es deliberadamente agnostica de estrategias
 * concretas (registro explicito, sin descubrimiento automatico), y `FsmModule`
 * exporta la instancia justo para que los modulos de nodos escriban sobre la
 * MISMA que consume `FsmEngineService`.
 *
 * A diferencia de las estrategias de andamiaje de `strategies/dummies/`, estas
 * si se instancian por inyeccion: necesitan servicios del contenedor.
 *
 * Aloja ademas el UNICO controlador del modulo: `GET /api/nodos`, la lectura del
 * catalogo de tipos (tabla `nodos`). Vive aqui y no en un modulo propio porque
 * describe exactamente lo que este modulo implementa —los nodos ejecutables—, y
 * separarlo dejaria el catalogo y sus estrategias en sitios distintos.
 *
 * Importa `LogsModule` por `HybridLoggerService`: el worker de sondeo escala a
 * `alertas_error` la averia que le impide disparar el flujo. No cierra ciclo
 * —`LogsModule` no importa nada del dominio— y se declara explicito porque ese
 * modulo dejo de ser global al ganar repositorios propios.
 *
 * Importa `WorkflowsModule` por `WorkflowsService`, que es quien despacha el
 * flujo cuando el sondeo IMAP detecta correo nuevo. La dependencia va en un solo
 * sentido: `WorkflowsModule` NO importa este modulo a proposito (las estrategias
 * se inscriben solas en la factoria compartida), y esa asimetria es justo lo que
 * mantiene el grafo de modulos aciclico.
 */
@Module({
  imports: [
    // Modulo hoja con el Chromium compartido. Va aparte y no como provider
    // propio para que `WizardModule` pueda consumirlo sin importar este modulo
    // entero (ver el TSDoc de `BrowserModule`).
    BrowserModule,
    FsmModule,
    LogsModule,
    TemplatesModule,
    WorkflowsModule,
    // `HttpCoreModule` aporta el cliente saliente del proveedor de IA;
    // `AiPromptTemplatesModule` exporta `AiPromptTemplatesService`, que la
    // estrategia consulta para resolver `templatePromptId`. Ninguno de los dos
    // importa este modulo, asi que el grafo sigue siendo aciclico.
    HttpCoreModule,
    AiPromptTemplatesModule,
    // El sondeo lee `flujos` para descubrir que buzones vigilar; el catalogo
    // sirve `GET /api/nodos`.
    TypeOrmModule.forFeature([Workflow, NodeCatalogEntry]),
  ],
  controllers: [NodeCatalogController],
  providers: [
    TemplateMapperStrategy,
    ImapTriggerStrategy,
    CronTriggerStrategy,
    ParserEmailStrategy,
    WebScraperStrategy,
    LlmExtractorStrategy,
    SmtpAlertStrategy,
    OcrProcessorStrategy,
    AiDefaultsConfig,
    // Los clientes de LLM son providers del contenedor y no instancias que la
    // estrategia construya: `GeminiLlmProvider` necesita `HttpClientService` y
    // `ConfigService`, y fabricarlo a mano dejaria sin inyectar ambos.
    MockLlmProvider,
    GeminiLlmProvider,
    ImapPollingService,
    CronSchedulingService,
    NodeCatalogService,
  ],
  exports: [
    TemplateMapperStrategy,
    ImapTriggerStrategy,
    CronTriggerStrategy,
    ParserEmailStrategy,
    WebScraperStrategy,
    LlmExtractorStrategy,
    SmtpAlertStrategy,
    OcrProcessorStrategy,
    ImapPollingService,
    CronSchedulingService,
    NodeCatalogService,
    // Se re-exporta para no romper a quien ya importaba este modulo esperando
    // encontrar el navegador.
    BrowserModule,
  ],
})
export class NodesModule implements OnModuleInit {
  constructor(
    private readonly strategyFactory: NodeStrategyFactory,
    private readonly templateMapperStrategy: TemplateMapperStrategy,
    private readonly imapTriggerStrategy: ImapTriggerStrategy,
    private readonly cronTriggerStrategy: CronTriggerStrategy,
    private readonly parserEmailStrategy: ParserEmailStrategy,
    private readonly webScraperStrategy: WebScraperStrategy,
    private readonly llmExtractorStrategy: LlmExtractorStrategy,
    private readonly smtpAlertStrategy: SmtpAlertStrategy,
    private readonly ocrProcessorStrategy: OcrProcessorStrategy,
  ) {}

  public onModuleInit(): void {
    this.strategyFactory.registerStrategy(this.templateMapperStrategy);
    this.strategyFactory.registerStrategy(this.imapTriggerStrategy);
    this.strategyFactory.registerStrategy(this.cronTriggerStrategy);
    this.strategyFactory.registerStrategy(this.parserEmailStrategy);
    this.strategyFactory.registerStrategy(this.webScraperStrategy);
    this.strategyFactory.registerStrategy(this.llmExtractorStrategy);
    this.strategyFactory.registerStrategy(this.smtpAlertStrategy);
    this.strategyFactory.registerStrategy(this.ocrProcessorStrategy);
  }
}
