import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { NodeStrategyFactory } from '@core/fsm/factories/node-strategy.factory';
import { FsmModule } from '@core/fsm/fsm.module';
import { NodeSandboxController } from '@modules/nodes/sandbox/node-sandbox.controller';
import { NodeSandboxService } from '@modules/nodes/sandbox/node-sandbox.service';
import { HttpCoreModule } from '@core/http/http-core.module';
import { AiPromptTemplatesModule } from '@modules/ai-prompt-templates/ai-prompt-templates.module';
import { CredentialsModule } from '@modules/credentials/credentials.module';
import { LogsModule } from '@modules/logs/logs.module';
import { TelemetryModule } from '@modules/telemetry/telemetry.module';
import { TemplatesModule } from '@modules/templates/templates.module';
import { Workflow } from '@modules/workflows/entities/workflow.entity';
import { WorkflowsModule } from '@modules/workflows/workflows.module';

import { BrowserModule } from './browser.module';
import { NodeCatalogEntry } from './entities/node-catalog.entity';
import { LlmCatalogController } from './controllers/llm-catalog.controller';
import { NodeCatalogController } from './controllers/node-catalog.controller';
import { CronSchedulingService } from './services/cron-scheduling.service';
import { ImapPollingService } from './services/imap-polling.service';
import { NodeCatalogService } from './services/node-catalog.service';
import { CronTriggerStrategy } from './strategies/cron-trigger.strategy';
import { DrupalHttpStrategy } from './strategies/drupal-http.strategy';
import { HttpGenericDestinationStrategy } from './strategies/http-generic-destination.strategy';
import { ImapTriggerStrategy } from './strategies/imap-trigger.strategy';
import { LlmExtractorStrategy } from './strategies/llm-extractor.strategy';
import { OcrProcessorStrategy } from './strategies/ocr-processor.strategy';
import { PauseFlowStrategy } from './strategies/pause-flow.strategy';
import { SmtpAlertStrategy } from './strategies/smtp-alert.strategy';
import { AiDefaultsConfig } from '@core/config/ai-defaults.config';
import { DrupalApiConfig } from '@core/config/drupal-api.config';
import { ParserEmailStrategy } from './strategies/parser-email.strategy';
import { PostIaSanitizerStrategy } from './strategies/post-ia-sanitizer.strategy';
import { LlmProviderFactory } from './strategies/llm-provider.factory';
import { LlmProviderCatalogService } from './services/llm-provider-catalog.service';
import { AnthropicLlmProvider } from './strategies/providers/anthropic-llm.provider';
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
    // Persistencia del consumo de tokens de los nodos de IA. Modulo hoja: no
    // importa nada de dominio, asi que tampoco cierra ningun ciclo.
    TelemetryModule,
    // Boveda cifrada: `HttpGenericDestinationStrategy` descifra ahi, y solo
    // ahi, la credencial de cada peticion. Hoja del grafo; no importa este.
    CredentialsModule,
    // El sondeo lee `flujos` para descubrir que buzones vigilar; el catalogo
    // sirve `GET /api/nodos`.
    TypeOrmModule.forFeature([Workflow, NodeCatalogEntry]),
  ],
  controllers: [
    NodeCatalogController,
    LlmCatalogController,
    NodeSandboxController,
  ],
  providers: [
    NodeSandboxService,
    TemplateMapperStrategy,
    PostIaSanitizerStrategy,
    ImapTriggerStrategy,
    CronTriggerStrategy,
    ParserEmailStrategy,
    WebScraperStrategy,
    LlmExtractorStrategy,
    PauseFlowStrategy,
    SmtpAlertStrategy,
    OcrProcessorStrategy,
    DrupalHttpStrategy,
    HttpGenericDestinationStrategy,
    AiDefaultsConfig,
    DrupalApiConfig,
    // Los clientes de LLM son providers del contenedor y no instancias que la
    // estrategia construya: `GeminiLlmProvider` necesita `HttpClientService` y
    // `ConfigService`, y fabricarlo a mano dejaria sin inyectar ambos.
    MockLlmProvider,
    GeminiLlmProvider,
    AnthropicLlmProvider,
    LlmProviderFactory,
    LlmProviderCatalogService,
    ImapPollingService,
    CronSchedulingService,
    NodeCatalogService,
  ],
  exports: [
    TemplateMapperStrategy,
    PostIaSanitizerStrategy,
    ImapTriggerStrategy,
    CronTriggerStrategy,
    ParserEmailStrategy,
    WebScraperStrategy,
    LlmExtractorStrategy,
    PauseFlowStrategy,
    SmtpAlertStrategy,
    OcrProcessorStrategy,
    DrupalHttpStrategy,
    HttpGenericDestinationStrategy,
    ImapPollingService,
    CronSchedulingService,
    NodeCatalogService,
    // La factoria si se exporta, al contrario que los clientes sueltos: es el
    // punto por el que otro modulo deberia pedir un cliente de LLM el dia que
    // lo necesite, sin volver a replicar el mapeo que PROT-21 acaba de unificar.
    LlmProviderFactory,
    // El catalogo (disponibilidad y politica de roles por modelo) y los
    // defaults de IA del entorno los necesita el asistente de prompts
    // (`PromptsModule`) para elegir proveedor igual que lo haria un nodo.
    LlmProviderCatalogService,
    AiDefaultsConfig,
    // Se re-exporta para no romper a quien ya importaba este modulo esperando
    // encontrar el navegador.
    BrowserModule,
  ],
})
export class NodesModule implements OnModuleInit {
  constructor(
    private readonly strategyFactory: NodeStrategyFactory,
    private readonly templateMapperStrategy: TemplateMapperStrategy,
    private readonly postIaSanitizerStrategy: PostIaSanitizerStrategy,
    private readonly imapTriggerStrategy: ImapTriggerStrategy,
    private readonly cronTriggerStrategy: CronTriggerStrategy,
    private readonly parserEmailStrategy: ParserEmailStrategy,
    private readonly webScraperStrategy: WebScraperStrategy,
    private readonly llmExtractorStrategy: LlmExtractorStrategy,
    private readonly smtpAlertStrategy: SmtpAlertStrategy,
    private readonly ocrProcessorStrategy: OcrProcessorStrategy,
    private readonly drupalHttpStrategy: DrupalHttpStrategy,
    private readonly pauseFlowStrategy: PauseFlowStrategy,
    private readonly httpGenericDestinationStrategy: HttpGenericDestinationStrategy,
  ) {}

  public onModuleInit(): void {
    this.strategyFactory.registerStrategy(this.templateMapperStrategy);
    this.strategyFactory.registerStrategy(this.postIaSanitizerStrategy);
    this.strategyFactory.registerStrategy(this.imapTriggerStrategy);
    this.strategyFactory.registerStrategy(this.cronTriggerStrategy);
    this.strategyFactory.registerStrategy(this.parserEmailStrategy);
    this.strategyFactory.registerStrategy(this.webScraperStrategy);
    this.strategyFactory.registerStrategy(this.llmExtractorStrategy);
    this.strategyFactory.registerStrategy(this.smtpAlertStrategy);
    this.strategyFactory.registerStrategy(this.ocrProcessorStrategy);
    // Cierra el catalogo: este destino era el ultimo tipo del enum sin
    // estrategia. OJO si algun dia aparece un aviso de registro duplicado para
    // este tipo: `DummyLogDispatcherStrategy` (`@core/fsm/strategies/dummies/`)
    // declara el mismo `nodeType` y nadie la inscribe, pero `registerStrategy`
    // ante un duplicado solo avisa y SUSTITUYE, asi que ganaria la ultima.
    this.strategyFactory.registerStrategy(this.drupalHttpStrategy);
    // Nodo de CONTROL, no de destino: no entrega nada fuera y conserva su
    // `nextStep`, que es donde queda el cursor para que un operador reanude.
    this.strategyFactory.registerStrategy(this.pauseFlowStrategy);
    // Conector de salida generico (MOD-03): cualquier API REST publica, con
    // la credencial de la boveda y la guarda SSRF de `OutboundTargetGuard`.
    this.strategyFactory.registerStrategy(this.httpGenericDestinationStrategy);
  }
}
