import { NotFoundException } from '@nestjs/common';

import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { LLM_RETRY_BASE_DELAY_MS } from '@modules/nodes/dto/llm-extractor-config.dto';
import { LlmProvider } from '@modules/nodes/strategies/interfaces/llm-provider.interface';
import {
  ERR_LLM_EMERGENCY_BRAKE,
  ERR_LLM_INTERPOLATION,
  ERR_LLM_MISSING_INPUT_TEXT,
  ERR_LLM_PROMPT_UNRESOLVED,
  ERR_LLM_MAX_RETRIES_EXCEEDED,
  LLM_OUTPUT_KEYS,
  LlmExtractorStrategy,
  MATERIAL_IN_INSTRUCTIONS_NOTICE,
} from '@modules/nodes/strategies/llm-extractor.strategy';
import {
  ERR_LLM_PROVIDER_TRUNCATED,
  LlmProviderException,
} from '@modules/nodes/strategies/interfaces/llm-provider.interface';
import { ERR_TELEMETRY_PERSIST_FAILED } from '@modules/telemetry/telemetry.service';
import { LlmProviderFactory } from '@modules/nodes/strategies/llm-provider.factory';
import { LlmProviderCatalogService } from '@modules/nodes/services/llm-provider-catalog.service';
import { MockLlmProvider } from '@modules/nodes/strategies/providers/mock-llm.provider';
import { GeminiProviderException } from '@modules/nodes/strategies/providers/gemini-llm.provider';
import {
  ERR_HTTP_CLIENT_REJECTED,
  ERR_HTTP_UPSTREAM_UNAVAILABLE,
} from '@core/http/http-client.service';
import { createMockStatePayloadContext } from '@test/factories/state-payload-context.factory';
import { AiCallStatus } from '@modules/telemetry/enums/ai-call-status.enum';
import { createMockTelemetryService } from '@test/factories/telemetry-service.factory';

import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import type { AiPromptTemplate } from '@modules/ai-prompt-templates/entities/ai-prompt-template.entity';
import type { AiDefaultsConfig } from '@core/config/ai-defaults.config';
import type { AiPromptTemplatesService } from '@modules/ai-prompt-templates/ai-prompt-templates.service';
import type {
  ILlmProviderClient,
  LlmResponsePayload,
} from '@modules/nodes/strategies/interfaces/llm-provider.interface';
import type { AnthropicLlmProvider } from '@modules/nodes/strategies/providers/anthropic-llm.provider';
import type { GeminiLlmProvider } from '@modules/nodes/strategies/providers/gemini-llm.provider';
import type { TelemetryService } from '@modules/telemetry/telemetry.service';
import type { TelemetryServiceMock } from '@test/factories/telemetry-service.factory';

const EXECUTION_ID = 'exec-11111111-1111-4111-8111-111111111111';
const OTHER_EXECUTION_ID = 'exec-22222222-2222-4222-8222-222222222222';
const WORKFLOW_ID = 'flow-33333333-3333-4333-8333-333333333333';
const NODE_ID = 'nodo_ia';
const TEMPLATE_ID = '9f1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const TEMPLATE_CODE = 'LICITACION_APERTURA_DEFAULT';
const AUTHOR_ID = '1a2b3c4d-5e6f-4071-8283-94a5b6c7d8e9';

/** Cuerpo de correo tipico que `PARSER_PRE_IA` deja en su namespace. */
const CLEAN_BODY = 'El ayuntamiento aprueba el plan de innovacion para 2027.';

/** Cuerpo de articulo tipico que `EXTRACTOR_WEB` deja en el suyo. */
const ARTICLE_CONTENT = 'La comision presento el informe tecnico esta manana.';

/**
 * Doble de `AiPromptTemplatesService` acotado por `Pick`.
 *
 * Solo participan las dos vias de resolucion que usa la estrategia
 * (`findOneEntity` por UUID y `findByCode` por clave de maquina): no toca
 * `findByName` ni el CRUD, y un mock de la clase entera obligaria a mantener
 * metodos que esta prueba no ejerce.
 */
type PromptServiceMock = jest.Mocked<
  Pick<AiPromptTemplatesService, 'findOneEntity' | 'findByCode'>
>;

const buildPromptService = (): PromptServiceMock => ({
  findOneEntity: jest.fn(),
  findByCode: jest.fn(),
});

/** Plantilla de prompt con los campos que la estrategia lee. */
const buildTemplate = (
  overrides: Partial<AiPromptTemplate> = {},
): AiPromptTemplate =>
  ({
    id: TEMPLATE_ID,
    code: TEMPLATE_CODE,
    name: 'Redaccion periodistica',
    description: null,
    promptText: 'Redacta una noticia breve y objetiva.',
    active: true,
    createdById: AUTHOR_ID,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  }) as AiPromptTemplate;

/** Contexto con el cursor ya posicionado en el nodo de IA. */
const buildContext = (
  namespaces: Record<string, Record<string, unknown>>,
  executionId: string = EXECUTION_ID,
): StatePayloadContext =>
  createMockStatePayloadContext({
    executionId,
    workflowId: WORKFLOW_ID,
    currentStep: NODE_ID,
    namespaces,
  });

/**
 * Construye la estrategia.
 *
 * `MockLlmProvider` va REAL y no mockeado: es una funcion pura y determinista
 * sin E/S, y sustituirlo por un doble convertiria el camino feliz en una prueba
 * de que el doble devuelve lo que se le dijo. El de Gemini si es un doble: sale
 * a la red.
 */
/** Doble del resolutor de defaults. Acotado a los dos metodos que se consultan. */
type AiDefaultsMock = jest.Mocked<
  Pick<
    AiDefaultsConfig,
    | 'getTextDefaults'
    | 'getOcrDefaults'
    | 'getTextHttpDefaults'
    | 'getOcrHttpDefaults'
  >
>;

/**
 * Entorno SIN defaults declarados: los dos pares devuelven `null`.
 *
 * Es el punto de partida de casi todas las pruebas, y a proposito: con ambos
 * pares vacios la estrategia cae en las constantes del DTO, que es el
 * comportamiento que tenia antes de que existieran las variables `AI_*`. Asi
 * estas pruebas siguen midiendo lo que median, y las que si ejercen el entorno
 * lo declaran explicitamente.
 */
const buildAiDefaults = (
  overrides: Partial<AiDefaultsMock> = {},
): AiDefaultsMock => ({
  getTextDefaults: jest.fn().mockReturnValue({ provider: null, model: null }),
  getOcrDefaults: jest.fn().mockReturnValue({ provider: null, model: null }),
  getTextHttpDefaults: jest
    .fn()
    .mockReturnValue({ timeoutMs: null, maxRetries: null }),
  getOcrHttpDefaults: jest
    .fn()
    .mockReturnValue({ timeoutMs: null, maxRetries: null }),
  ...overrides,
});

/**
 * Doble del catalogo, acotado a lo unico que la estrategia le pregunta.
 *
 * Por defecto TODOS los proveedores son usables, que es el escenario de la
 * mayoria de las pruebas: asi el respaldo dinamico esta disponible y cada caso
 * decide si lo ejerce o no. Restringir la lista es lo que permite comprobar que
 * sin alternativa usable el nodo falla en vez de inventarse una.
 */
const buildProviderCatalog = (
  usableProviders: readonly LlmProvider[] = Object.values(LlmProvider),
): LlmProviderCatalogService =>
  ({
    isProviderUsable: jest
      .fn()
      .mockImplementation((provider: LlmProvider) =>
        usableProviders.includes(provider),
      ),
  }) as unknown as LlmProviderCatalogService;

const buildStrategy = (
  promptService: PromptServiceMock,
  gemini: Partial<ILlmProviderClient> = {},
  mock: ILlmProviderClient = new MockLlmProvider(),
  aiDefaults: AiDefaultsMock = buildAiDefaults(),
  anthropic: Partial<ILlmProviderClient> = {},
  providerCatalog: LlmProviderCatalogService = buildProviderCatalog(),
  telemetry: TelemetryServiceMock = createMockTelemetryService(),
): LlmExtractorStrategy => {
  // Factoria REAL con los clientes doblados: su unica logica es un mapeo, y
  // doblarla devolveria lo que se le dijese, con lo que la prueba dejaria de
  // notar que un proveedor desaparece del indice.
  const factory = new LlmProviderFactory(
    mock as MockLlmProvider,
    gemini as GeminiLlmProvider,
    anthropic as AnthropicLlmProvider,
  );

  jest.spyOn(factory['logger'], 'warn').mockImplementation(() => undefined);

  return new LlmExtractorStrategy(
    promptService as unknown as AiPromptTemplatesService,
    mock as MockLlmProvider,
    factory,
    aiDefaults as unknown as AiDefaultsConfig,
    providerCatalog,
    telemetry as unknown as TelemetryService,
  );
};

/** Proveedor que siempre revienta, para ejercer el freno de emergencia. */
const buildFailingProvider = (): ILlmProviderClient => ({
  provider: LlmProvider.GEMINI,
  generateCompletion: jest
    .fn<Promise<LlmResponsePayload>, []>()
    .mockRejectedValue(new Error('el proveedor no responde')),
});

describe('LlmExtractorStrategy', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('0.1 deberia declararse como el nodo PROCESADOR_IA', () => {
    // 1. Arrange & 2. Act
    const strategy = buildStrategy(buildPromptService());

    // 3. Assert
    expect(strategy.nodeType).toBe(NodeType.PROCESADOR_IA);
  });

  describe('1. Ejecucion exitosa con el proveedor simulado', () => {
    it('1.1 deberia devolver las cuatro claves del contrato formal', async () => {
      // 1. Arrange
      const promptService = buildPromptService();
      const strategy = buildStrategy(promptService);
      const context = buildContext({
        parsed_email: { clean_body: CLEAN_BODY },
      });

      // 2. Act
      const result = await strategy.execute(context, {
        inlinePrompt: 'Redacta una noticia breve.',
        provider: LlmProvider.MOCK,
      });

      // 3. Assert
      expect(result.success).toBe(true);
      expect(Object.keys(result.data ?? {}).sort()).toEqual(
        [...LLM_OUTPUT_KEYS].sort(),
      );
    });

    it('1.2 deberia marcar la salida como simulada para que sea auditable', async () => {
      // 1. Arrange
      const strategy = buildStrategy(buildPromptService());
      const context = buildContext({
        parsed_email: { clean_body: CLEAN_BODY },
      });

      // 2. Act
      const result = await strategy.execute(context, {
        inlinePrompt: 'Redacta una noticia breve.',
      });

      // 3. Assert: `isMock` es lo unico que distingue una redaccion real de una
      //    simulada al auditar la ejecucion.
      expect(result.data?.metadata).toEqual(
        expect.objectContaining({
          isMock: true,
          tokensPrompt: 0,
          tokensCompletion: 0,
        }),
      );
    });

    it('1.3 deberia derivar el contenido del texto de entrada, no del prompt', async () => {
      // 1. Arrange
      const strategy = buildStrategy(buildPromptService());
      const context = buildContext({
        parsed_email: { clean_body: CLEAN_BODY },
      });

      // 2. Act
      const result = await strategy.execute(context, {
        inlinePrompt: 'Redacta una noticia breve.',
      });

      // 3. Assert: el TEXTO va como prompt y la INSTRUCCION como systemPrompt,
      //    de modo que el contenido llega al modelo aunque la instruccion no
      //    interpole ningun marcador.
      expect(result.data?.headline).toContain('ayuntamiento');
    });

    it('1.4 deberia dar prioridad a la plantilla sobre el prompt en linea', async () => {
      // 1. Arrange
      const promptService = buildPromptService();
      promptService.findOneEntity.mockResolvedValue(buildTemplate());
      const generateCompletion = jest.fn().mockResolvedValue({
        headline: 'h',
        summary: 's',
        body_paragraphs: [],
        metadata: {
          tokensPrompt: 1,
          tokensCompletion: 2,
          modelUsed: 'gemini-3.6-flash',
          isMock: false,
        },
      });
      const strategy = buildStrategy(promptService, {
        provider: LlmProvider.GEMINI,
        generateCompletion,
      });
      const context = buildContext({
        parsed_email: { clean_body: CLEAN_BODY },
      });

      // 2. Act
      await strategy.execute(context, {
        templatePromptId: TEMPLATE_ID,
        inlinePrompt: 'Instruccion vieja de una prueba anterior.',
        provider: LlmProvider.GEMINI,
      });

      // 3. Assert
      expect(promptService.findOneEntity).toHaveBeenCalledWith(TEMPLATE_ID);
      expect(generateCompletion).toHaveBeenCalledWith(
        CLEAN_BODY,
        'Redacta una noticia breve y objetiva.',
        expect.anything(),
      );
    });

    it('1.5 deberia forzar la simulacion con dryRun aunque el proveedor sea de pago', async () => {
      // 1. Arrange
      const gemini = buildFailingProvider();
      const strategy = buildStrategy(buildPromptService(), gemini);
      const context = buildContext({
        parsed_email: { clean_body: CLEAN_BODY },
      });

      // 2. Act
      const result = await strategy.execute(context, {
        inlinePrompt: 'Redacta una noticia breve.',
        provider: LlmProvider.GEMINI,
        dryRun: true,
      });

      // 3. Assert: el interruptor de coste cero gana al proveedor configurado.
      expect(result.success).toBe(true);
      expect(gemini.generateCompletion).not.toHaveBeenCalled();
    });
  });

  describe('2. Fallos GRAVE', () => {
    it('2.1 deberia fallar si no hay clean_body ni full_article_content', async () => {
      // 1. Arrange
      const strategy = buildStrategy(buildPromptService());
      const context = buildContext({ cron_trigger: { fired_at: 'ayer' } });

      // 2. Act
      const result = await strategy.execute(context, {
        inlinePrompt: 'Redacta una noticia breve.',
      });

      // 3. Assert
      expect(result.success).toBe(false);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.code).toBe(ERR_LLM_MISSING_INPUT_TEXT);
      expect(result.error?.message).toContain('Falta contenido textual previo');
      expect(result.error?.missingFields).toEqual([
        'ocr_result.clean_body',
        'parsed_email.clean_body',
        'parsed_email.extracted_documents_text',
        'scraped_web.full_article_content',
      ]);
    });

    it('2.2 deberia tratar una cadena de solo espacios como ausencia', async () => {
      // 1. Arrange
      const strategy = buildStrategy(buildPromptService());
      const context = buildContext({ parsed_email: { clean_body: '   \n  ' } });

      // 2. Act
      const result = await strategy.execute(context, {
        inlinePrompt: 'Redacta una noticia breve.',
      });

      // 3. Assert: mandarla al modelo facturaria tokens por procesar nada.
      expect(result.error?.code).toBe(ERR_LLM_MISSING_INPUT_TEXT);
    });

    it('2.3 deberia recurrir a scraped_web cuando no hay correo previo', async () => {
      // 1. Arrange
      const strategy = buildStrategy(buildPromptService());
      const context = buildContext({
        scraped_web: { full_article_content: ARTICLE_CONTENT },
      });

      // 2. Act
      const result = await strategy.execute(context, {
        inlinePrompt: 'Redacta una noticia breve.',
      });

      // 3. Assert: un flujo disparado por cron no tiene correo y cae al segundo
      //    origen sin mas.
      expect(result.success).toBe(true);
      expect(result.data?.headline).toContain('comision');
    });

    it('2.4 deberia fallar sin plantilla ni prompt en linea', async () => {
      // 1. Arrange
      const strategy = buildStrategy(buildPromptService());
      const context = buildContext({
        parsed_email: { clean_body: CLEAN_BODY },
      });

      // 2. Act
      const result = await strategy.execute(context, {});

      // 3. Assert
      expect(result.success).toBe(false);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.code).toBe(ERR_LLM_PROMPT_UNRESOLVED);
      expect(result.error?.missingFields).toEqual([
        'templatePromptId',
        'promptCode',
        'inlinePrompt',
      ]);
    });

    it('2.5 deberia traducir la plantilla inexistente a un codigo propio', async () => {
      // 1. Arrange
      const promptService = buildPromptService();
      promptService.findOneEntity.mockRejectedValue(
        new Error(`Prompt con id "${TEMPLATE_ID}" no encontrado`),
      );
      const strategy = buildStrategy(promptService);
      const context = buildContext({
        parsed_email: { clean_body: CLEAN_BODY },
      });

      // 2. Act
      const result = await strategy.execute(context, {
        templatePromptId: TEMPLATE_ID,
      });

      // 3. Assert: un `catchErrors` del esquema no puede enrutar sobre el cajon
      //    comun `ERR_NODE_HTTP_FAILURE`.
      expect(result.error?.code).toBe(ERR_LLM_PROMPT_UNRESOLVED);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.missingFields).toEqual(['templatePromptId']);
    });

    it('2.6 deberia degradar al simulador un proveedor sin cliente, no fallar', async () => {
      // 1. Arrange 📐
      const strategy = buildStrategy(buildPromptService());
      const context = buildContext({
        parsed_email: { clean_body: CLEAN_BODY },
      });

      // 2. Act ⚙️
      const result = await strategy.execute(context, {
        inlinePrompt: 'Redacta una noticia breve.',
        provider: LlmProvider.OPENAI,
      });

      // 3. Assert 🎯: cambio de criterio deliberado. Antes devolvia
      //    ERR_LLM_PROVIDER_UNSUPPORTED para que una redaccion simulada no
      //    llegase al MAPEADOR_PLANTILLA disfrazada de real. Con los defaults
      //    por entorno, `AI_DEFAULT_PROVIDER` puede nombrar un proveedor aun sin
      //    cliente, y fallar habria pausado de golpe todo flujo que no declarase
      //    el suyo. Lo que sostiene ahora la auditoria es `isMock`, que viaja en
      //    el namespace, mas el aviso en el log.
      //
      //    Se ejerce con OPENAI porque desde PROT-20 es el UNICO proveedor sin
      //    cliente: ANTHROPIC ya tiene el suyo y lo cubre el bloque 10.
      //
      //    El AVISO en el log ya no se comprueba aqui: desde PROT-21 lo emite
      //    `LlmProviderFactory`, que es quien conoce el indice de clientes, y
      //    su propia suite lo fija (bloque 2.1). Lo que sigue siendo
      //    responsabilidad de esta estrategia es que la ejecucion no caiga y
      //    que la salida quede marcada.
      expect(result.success).toBe(true);
      expect(
        (result.data?.metadata as { isMock?: boolean } | undefined)?.isMock,
      ).toBe(true);
    });

    it('2.7 deberia devolver GRAVE en el primer fallo del proveedor', async () => {
      // 1. Arrange
      const strategy = buildStrategy(
        buildPromptService(),
        buildFailingProvider(),
      );
      const context = buildContext({
        parsed_email: { clean_body: CLEAN_BODY },
      });

      // 2. Act
      const result = await strategy.execute(context, {
        inlinePrompt: 'Redacta una noticia breve.',
        provider: LlmProvider.GEMINI,
        emergencyBrakeThreshold: 3,
      });

      // 3. Assert: un corte puntual no debe pausar un flujo; GRAVE si lo
      //    reintenta el motor.
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.code).toBe(ERR_LLM_MAX_RETRIES_EXCEEDED);
    });
  });

  describe('3. Freno de emergencia', () => {
    it('3.1 deberia devolver URGENTE al alcanzar el umbral de fallos consecutivos', async () => {
      // 1. Arrange
      const strategy = buildStrategy(
        buildPromptService(),
        buildFailingProvider(),
      );
      const context = buildContext({
        parsed_email: { clean_body: CLEAN_BODY },
      });
      const params = {
        inlinePrompt: 'Redacta una noticia breve.',
        provider: LlmProvider.GEMINI,
        emergencyBrakeThreshold: 3,
      };

      // 2. Act
      await strategy.execute(context, params);
      await strategy.execute(context, params);
      const result = await strategy.execute(context, params);

      // 3. Assert: URGENTE no lo reintenta `canRetry`, de modo que la ejecucion
      //    queda PAUSADA conservando el cursor.
      expect(result.success).toBe(false);
      expect(result.error?.level).toBe('URGENTE');
      expect(result.error?.code).toBe(ERR_LLM_EMERGENCY_BRAKE);
      expect(result.error?.message).toContain('Freno de emergencia activado');
      expect(result.error?.message).toContain('sobrecostes');
    });

    it('3.2 deberia frenar al primer fallo con el umbral en uno', async () => {
      // 1. Arrange
      const strategy = buildStrategy(
        buildPromptService(),
        buildFailingProvider(),
      );
      const context = buildContext({
        parsed_email: { clean_body: CLEAN_BODY },
      });

      // 2. Act
      const result = await strategy.execute(context, {
        inlinePrompt: 'Redacta una noticia breve.',
        provider: LlmProvider.GEMINI,
        emergencyBrakeThreshold: 1,
      });

      // 3. Assert
      expect(result.error?.code).toBe(ERR_LLM_EMERGENCY_BRAKE);
    });

    it('3.3 deberia reiniciar el contador tras una ejecucion exitosa', async () => {
      // 1. Arrange
      const generateCompletion = jest
        .fn()
        .mockRejectedValueOnce(new Error('corte puntual'))
        .mockRejectedValueOnce(new Error('corte puntual'))
        .mockResolvedValueOnce({
          headline: 'h',
          summary: 's',
          body_paragraphs: [],
          metadata: {
            tokensPrompt: 1,
            tokensCompletion: 2,
            modelUsed: 'gemini-3.6-flash',
            isMock: false,
          },
        })
        .mockRejectedValue(new Error('corte puntual'));
      const strategy = buildStrategy(buildPromptService(), {
        provider: LlmProvider.GEMINI,
        generateCompletion,
      });
      const context = buildContext({
        parsed_email: { clean_body: CLEAN_BODY },
      });
      const params = {
        inlinePrompt: 'Redacta una noticia breve.',
        provider: LlmProvider.GEMINI,
        emergencyBrakeThreshold: 3,
      };

      // 2. Act
      await strategy.execute(context, params);
      await strategy.execute(context, params);
      await strategy.execute(context, params);
      const result = await strategy.execute(context, params);

      // 3. Assert: el freno cuenta fallos CONSECUTIVOS. Sin el reinicio, este
      //    cuarto intento habria frenado por una racha ya rota.
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.code).toBe(ERR_LLM_MAX_RETRIES_EXCEEDED);
    });

    it('3.4 deberia aislar el contador entre ejecuciones concurrentes', async () => {
      // 1. Arrange
      const strategy = buildStrategy(
        buildPromptService(),
        buildFailingProvider(),
      );
      const params = {
        inlinePrompt: 'Redacta una noticia breve.',
        provider: LlmProvider.GEMINI,
        emergencyBrakeThreshold: 2,
      };
      const exhausted = buildContext(
        { parsed_email: { clean_body: CLEAN_BODY } },
        EXECUTION_ID,
      );
      const healthy = buildContext(
        { parsed_email: { clean_body: CLEAN_BODY } },
        OTHER_EXECUTION_ID,
      );

      // 2. Act: la primera ejecucion agota su umbral; la segunda entra limpia.
      await strategy.execute(exhausted, params);
      const braked = await strategy.execute(exhausted, params);
      const firstOfHealthy = await strategy.execute(healthy, params);

      // 3. Assert: la estrategia es un singleton compartido por todas las
      //    ejecuciones. Con un contador unico, el flujo sano habria quedado
      //    pausado sin un solo fallo propio que lo explique.
      expect(braked.error?.code).toBe(ERR_LLM_EMERGENCY_BRAKE);
      expect(firstOfHealthy.error?.code).toBe(ERR_LLM_MAX_RETRIES_EXCEEDED);
    });
  });

  describe('4. Interpolacion del prompt', () => {
    it('4.1 deberia resolver {{parsed_email.clean_title}} antes de llamar al proveedor', async () => {
      // 1. Arrange
      const generateCompletion = jest.fn().mockResolvedValue({
        headline: 'h',
        summary: 's',
        body_paragraphs: [],
        metadata: {
          tokensPrompt: 1,
          tokensCompletion: 2,
          modelUsed: 'gemini-3.6-flash',
          isMock: false,
        },
      });
      const strategy = buildStrategy(buildPromptService(), {
        provider: LlmProvider.GEMINI,
        generateCompletion,
      });
      const context = buildContext({
        parsed_email: {
          clean_body: CLEAN_BODY,
          clean_title: 'Plan de innovacion 2027',
        },
      });

      // 2. Act
      await strategy.execute(context, {
        inlinePrompt: 'Redacta sobre "{{parsed_email.clean_title}}" con rigor.',
        provider: LlmProvider.GEMINI,
      });

      // 3. Assert: el proveedor recibe el valor resuelto, nunca el marcador.
      expect(generateCompletion).toHaveBeenCalledWith(
        CLEAN_BODY,
        'Redacta sobre "Plan de innovacion 2027" con rigor.',
        expect.anything(),
        // Sin adjuntos: fuera del modo vision el cuarto argumento va vacio.
      );
    });

    it('4.2 deberia fallar en GRAVE si un marcador no resuelve', async () => {
      // 1. Arrange
      const strategy = buildStrategy(buildPromptService());
      const context = buildContext({
        parsed_email: { clean_body: CLEAN_BODY },
      });

      // 2. Act
      const result = await strategy.execute(context, {
        inlinePrompt: 'Redacta sobre {{scraped_web.article_title}}.',
      });

      // 3. Assert: dejar escapar la excepcion la normalizaria el motor a
      //    URGENTE, que `canRetry` nunca reintenta.
      expect(result.success).toBe(false);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.code).toBe(ERR_LLM_INTERPOLATION);
      expect(result.error?.missingFields).toEqual([
        'scraped_web.article_title',
      ]);
    });

    it('4.3 deberia declarar los namespaces que el prompt en linea necesita', () => {
      // 1. Arrange
      const strategy = buildStrategy(buildPromptService());

      // 2. Act
      const required = strategy.getRequiredNamespaces({
        inlinePrompt:
          'Usa {{parsed_email.clean_title}} y {{scraped_web.byline}}.',
      });

      // 3. Assert
      expect([...required].sort()).toEqual(['parsed_email', 'scraped_web']);
    });

    it('4.4 deberia no declarar namespaces cuando la instruccion es una plantilla', () => {
      // 1. Arrange
      const strategy = buildStrategy(buildPromptService());

      // 2. Act
      const required = strategy.getRequiredNamespaces({
        templatePromptId: TEMPLATE_ID,
      });

      // 3. Assert: el texto vive en `plantillas_prompts_ia` y leerlo seria E/S,
      //    mientras que este metodo debe ser puro y sincrono.
      expect(required).toEqual([]);
    });
  });

  describe('5. Inmutabilidad del contexto', () => {
    it('5.1 no deberia escribir en el contexto en una ejecucion exitosa', async () => {
      // 1. Arrange
      const strategy = buildStrategy(buildPromptService());
      const context = buildContext({
        parsed_email: { clean_body: CLEAN_BODY },
      });
      const before = context.getAllContext();

      // 2. Act
      await strategy.execute(context, {
        inlinePrompt: 'Redacta una noticia breve.',
      });

      // 3. Assert: escribir el namespace es trabajo del motor
      //    (`fsm-engine.service.ts`, `context.setNamespace(node.outputNamespace, ...)`).
      expect(context.getAllContext()).toEqual(before);
      expect(context.getNamespace('llm_response')).toBeUndefined();
    });
  });

  describe('12. Referencias a prompts guardados', () => {
    it('12.1 deberia declarar la referencia por id', () => {
      // 1. Arrange & 2. Act
      const strategy = buildStrategy(buildPromptService());

      // 3. Assert: es lo que permite al validador leer el prompt y ver que
      //    namespaces cita, algo que `getRequiredNamespaces` no puede hacer.
      expect(
        strategy.getPromptReferences({ templatePromptId: TEMPLATE_ID }),
      ).toEqual([{ kind: 'id', value: TEMPLATE_ID }]);
    });

    it('12.2 deberia declarar la referencia por codigo', () => {
      // 1. Arrange & 2. Act
      const strategy = buildStrategy(buildPromptService());

      // 3. Assert
      expect(
        strategy.getPromptReferences({ promptCode: TEMPLATE_CODE }),
      ).toEqual([{ kind: 'code', value: TEMPLATE_CODE }]);
    });

    it('12.3 deberia respetar la precedencia de resolvePrompt', () => {
      // 1. Arrange & 2. Act: con los dos declarados, la ejecucion lee el id y
      //    nunca el codigo. Devolver ambos haria que el validador exigiera los
      //    namespaces de un prompt que jamas se va a leer.
      const strategy = buildStrategy(buildPromptService());

      // 3. Assert
      expect(
        strategy.getPromptReferences({
          templatePromptId: TEMPLATE_ID,
          promptCode: TEMPLATE_CODE,
        }),
      ).toEqual([{ kind: 'id', value: TEMPLATE_ID }]);
    });

    it('12.4 no deberia declarar nada con un prompt en linea', () => {
      // 1. Arrange & 2. Act: su texto esta en los `params` y de el ya responde
      //    `getRequiredNamespaces`.
      const strategy = buildStrategy(buildPromptService());

      // 3. Assert
      expect(
        strategy.getPromptReferences({
          inlinePrompt: 'Redacta {{parsed_email.clean_body}}',
        }),
      ).toEqual([]);
    });

    it('12.5 no deberia declarar nada sin instruccion alguna', () => {
      // 1. Arrange & 2. Act
      const strategy = buildStrategy(buildPromptService());

      // 3. Assert
      expect(strategy.getPromptReferences({})).toEqual([]);
    });

    it('12.6 deberia ignorar una referencia en blanco', () => {
      // 1. Arrange & 2. Act: `resolvePrompt` trata el blanco como ausencia, y
      //    las dos lecturas deben coincidir.
      const strategy = buildStrategy(buildPromptService());

      // 3. Assert
      expect(strategy.getPromptReferences({ promptCode: '   ' })).toEqual([]);
    });
  });

  describe('6. Completitud para activar', () => {
    it('6.1 deberia reclamar la instruccion cuando no hay ninguna', () => {
      // 1. Arrange
      const strategy = buildStrategy(buildPromptService());

      // 2. Act
      const incomplete = strategy.getIncompleteParams({});

      // 3. Assert
      expect(incomplete).toEqual([
        'templatePromptId | promptCode | inlinePrompt',
      ]);
    });

    it('6.2 deberia considerarlo completo con cualquiera de las tres vias', () => {
      // 1. Arrange
      const strategy = buildStrategy(buildPromptService());

      // 2. Act & 3. Assert
      expect(
        strategy.getIncompleteParams({ inlinePrompt: 'Redacta.' }),
      ).toEqual([]);
      expect(
        strategy.getIncompleteParams({ templatePromptId: TEMPLATE_ID }),
      ).toEqual([]);
      expect(
        strategy.getIncompleteParams({ promptCode: TEMPLATE_CODE }),
      ).toEqual([]);
    });
  });

  describe('9. Resolucion del prompt por codigo', () => {
    it('9.1 deberia resolver promptCode e interpolar antes de llamar al proveedor', async () => {
      // 1. Arrange 📐: la plantilla de la base lleva un marcador sin resolver,
      //    que es justo lo que distingue una plantilla de un texto fijo.
      const promptService = buildPromptService();
      promptService.findByCode.mockResolvedValue(
        buildTemplate({
          promptText:
            'Extrae los datos de licitacion de "{{parsed_email.clean_title}}".',
        }),
      );
      const generateCompletion = jest.fn().mockResolvedValue({
        headline: 'h',
        summary: 's',
        body_paragraphs: [],
        metadata: {
          tokensPrompt: 1,
          tokensCompletion: 2,
          modelUsed: 'gemini-3.6-flash',
          isMock: false,
        },
      });
      const strategy = buildStrategy(promptService, {
        provider: LlmProvider.GEMINI,
        generateCompletion,
      });
      const context = buildContext({
        parsed_email: {
          clean_body: CLEAN_BODY,
          clean_title: 'Expediente 2027/014',
        },
      });

      // 2. Act ⚙️
      const result = await strategy.execute(context, {
        promptCode: TEMPLATE_CODE,
        provider: LlmProvider.GEMINI,
      });

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(promptService.findByCode).toHaveBeenCalledWith(TEMPLATE_CODE);
      // Lo que viaja al proveedor es el texto YA interpolado, no el marcador.
      expect(generateCompletion).toHaveBeenCalledWith(
        CLEAN_BODY,
        'Extrae los datos de licitacion de "Expediente 2027/014".',
        expect.anything(),
      );
    });

    it('9.2 deberia dar PRIORIDAD a templatePromptId sobre promptCode', async () => {
      // 1. Arrange 📐: declarar los dos es un error de configuracion, pero el
      //    desempate tiene que ser estable. Gana el UUID, la referencia mas
      //    especifica.
      const promptService = buildPromptService();
      promptService.findOneEntity.mockResolvedValue(
        buildTemplate({ promptText: 'Instruccion resuelta por UUID.' }),
      );
      const strategy = buildStrategy(promptService);
      const context = buildContext({
        parsed_email: { clean_body: CLEAN_BODY },
      });

      // 2. Act ⚙️
      const result = await strategy.execute(context, {
        templatePromptId: TEMPLATE_ID,
        promptCode: TEMPLATE_CODE,
      });

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(promptService.findOneEntity).toHaveBeenCalledWith(TEMPLATE_ID);
      expect(promptService.findByCode).not.toHaveBeenCalled();
    });

    it('9.3 deberia fallar en GRAVE cuando el codigo no existe', async () => {
      // 1. Arrange 📐
      const promptService = buildPromptService();
      promptService.findByCode.mockRejectedValue(
        new NotFoundException('Prompt con codigo "NO_EXISTE" no encontrado'),
      );
      const strategy = buildStrategy(promptService);
      const context = buildContext({
        parsed_email: { clean_body: CLEAN_BODY },
      });

      // 2. Act ⚙️
      const result = await strategy.execute(context, {
        promptCode: 'NO_EXISTE',
      });

      // 3. Assert 🎯: se nombra el `code` propio del nodo, y no el cajon comun
      //    de errores HTTP, para que un `catchErrors` del esquema pueda enrutar.
      expect(result.success).toBe(false);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.code).toBe(ERR_LLM_PROMPT_UNRESOLVED);
      expect(result.error?.missingFields).toContain('promptCode');
    });
  });

  describe('10. Proveedor ANTHROPIC', () => {
    it('10.1 deberia enrutar al cliente de Anthropic sin degradar al simulador', async () => {
      // 1. Arrange 📐: desde que existe `AnthropicLlmProvider`, declarar este
      //    proveedor ya no cae en la rama de degradacion de `resolveProvider`.
      const generateCompletion = jest.fn().mockResolvedValue({
        headline: 'Titular real',
        summary: 'Entradilla real',
        body_paragraphs: ['Parrafo'],
        metadata: {
          tokensPrompt: 10,
          tokensCompletion: 20,
          modelUsed: 'claude-sonnet-5-5',
          isMock: false,
        },
      });
      const strategy = buildStrategy(
        buildPromptService(),
        {},
        new MockLlmProvider(),
        buildAiDefaults(),
        { provider: LlmProvider.ANTHROPIC, generateCompletion },
      );
      const context = buildContext({
        parsed_email: { clean_body: CLEAN_BODY },
      });

      // 2. Act ⚙️
      const result = await strategy.execute(context, {
        inlinePrompt: 'Redacta la noticia.',
        provider: LlmProvider.ANTHROPIC,
      });

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(generateCompletion).toHaveBeenCalledTimes(1);
      expect(
        (result.data?.metadata as { isMock?: boolean } | undefined)?.isMock,
      ).toBe(false);
    });
  });
  describe('7. Rescate por OCR', () => {
    it('7.1 deberia dar PRIORIDAD a ocr_result sobre parsed_email', async () => {
      // 1. Arrange 📐: si `ocr_result` existe es porque el parser no encontro
      //    texto aprovechable y el nodo de transcripcion lo recupero de los
      //    adjuntos. Un `clean_body` residual del parser —el "Ver adjunto" que
      //    a veces acompana a un escaneo— no debe ganarle.
      const generateCompletion = jest.fn().mockResolvedValue({
        headline: 'h',
        summary: 's',
        body_paragraphs: [],
        metadata: {
          tokensPrompt: 0,
          tokensCompletion: 0,
          modelUsed: 'gemini-3.6-flash',
          isMock: false,
        },
      });
      const strategy = buildStrategy(buildPromptService(), {
        provider: LlmProvider.GEMINI,
        generateCompletion,
      });
      const context = buildContext({
        parsed_email: { clean_body: 'Ver adjunto.' },
        ocr_result: {
          clean_body: 'Texto completo recuperado del PDF escaneado.',
        },
      });

      // 2. Act ⚙️
      const result = await strategy.execute(context, {
        inlinePrompt: 'Redacta una noticia breve y objetiva.',
        provider: LlmProvider.GEMINI,
      });

      // 3. Assert 🎯: la transcripcion ENCABEZA el material. Ya no es una
      //    cascada excluyente —el "Ver adjunto." tambien viaja—, pero el orden
      //    sigue siendo el que importa: lo primero que lee el modelo es el
      //    texto real recuperado del escaneo, no la linea residual del parser.
      expect(result.success).toBe(true);

      const [material] = generateCompletion.mock.calls[0] as [string];

      expect(material.indexOf('Texto completo recuperado del PDF escaneado.')) //
        .toBeLessThan(material.indexOf('Ver adjunto.'));
      expect(material).toContain('Transcripcion OCR:');
      expect(material).toContain('Correo:');
    });

    it('7.2 NO deberia recolectar adjuntos por su cuenta', async () => {
      // 1. Arrange 📐: el modo vision interno se retiro. Transcribir es trabajo
      //    del nodo PROCESADOR_OCR, que tiene su propio modelo, su propio prompt
      //    y su propio presupuesto. Dos caminos para el mismo rescate eran dos
      //    sitios donde arreglarlo.
      const generateCompletion = jest.fn().mockResolvedValue({
        headline: 'h',
        summary: 's',
        body_paragraphs: [],
        metadata: {
          tokensPrompt: 0,
          tokensCompletion: 0,
          modelUsed: 'gemini-3.6-flash',
          isMock: false,
        },
      });
      const strategy = buildStrategy(buildPromptService(), {
        provider: LlmProvider.GEMINI,
        generateCompletion,
      });
      const context = buildContext({
        parsed_email: { clean_body: 'Cuerpo aprovechable del correo.' },
        raw_email: {
          attachments: [
            {
              filename: 'escaneo.png',
              contentType: 'image/png',
              contentBase64: 'QUJD',
            },
          ],
        },
      });

      // 2. Act ⚙️
      await strategy.execute(context, {
        inlinePrompt: 'Redacta.',
        provider: LlmProvider.GEMINI,
      });

      // 3. Assert 🎯: tres argumentos, sin cuarto de adjuntos.
      expect(generateCompletion).toHaveBeenCalledWith(
        'Cuerpo aprovechable del correo.',
        'Redacta.',
        expect.anything(),
      );
    });

    it('7.3 deberia seguir fallando sin ningun texto de entrada', async () => {
      // 1. Arrange 📐: la guarda de siempre sigue en pie, y ahora sin excepcion
      //    por adjuntos: sin texto no hay inferencia que preparar.
      const strategy = buildStrategy(buildPromptService());

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext({}), {
        inlinePrompt: 'Extrae la nota.',
      });

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_LLM_MISSING_INPUT_TEXT);
    });
  });

  describe('8. Defaults por entorno (AI_*)', () => {
    /** Opciones de ejecucion con las que se invoco al proveedor. Ver `attachmentsOf`. */
    const optionsOf = (
      generateCompletion: jest.Mock,
    ): Record<string, unknown> => {
      const call = generateCompletion.mock.calls[0] as
        | [string, string | undefined, Record<string, unknown>, unknown]
        | undefined;

      return call?.[2] ?? {};
    };

    it('8.1 deberia usar el par de TEXTO cuando el nodo no declara nada', async () => {
      // 1. Arrange 📐
      const generateCompletion = jest.fn().mockResolvedValue({
        headline: 'T',
        summary: 'S',
        body_paragraphs: [],
        metadata: {
          tokensPrompt: 0,
          tokensCompletion: 0,
          modelUsed: 'x',
          isMock: false,
        },
      });
      const aiDefaults = buildAiDefaults({
        getTextDefaults: jest
          .fn()
          .mockReturnValue({ provider: 'GEMINI', model: 'gemini-2.0-pro' }),
      });
      const strategy = buildStrategy(
        buildPromptService(),
        { provider: LlmProvider.GEMINI, generateCompletion },
        new MockLlmProvider(),
        aiDefaults,
      );

      // 2. Act ⚙️
      await strategy.execute(
        buildContext({ parsed_email: { clean_body: CLEAN_BODY } }),
        { inlinePrompt: 'Redacta.' },
      );

      // 3. Assert 🎯
      expect(aiDefaults.getTextDefaults).toHaveBeenCalledTimes(1);
      expect(aiDefaults.getOcrDefaults).not.toHaveBeenCalled();
      expect(optionsOf(generateCompletion)).toMatchObject({
        model: 'gemini-2.0-pro',
      });
    });

    it('8.2 NO deberia leer el par de OCR: ya no transcribe', async () => {
      // 1. Arrange 📐: `AI_OCR_DEFAULT_*` pertenece ahora a OcrProcessorStrategy.
      //    Que este nodo siguiera consultandolo dejaria dos duenos para la misma
      //    variable, y el que la cambiase moveria el modelo del otro sin saberlo.
      const aiDefaults = buildAiDefaults({
        getOcrDefaults: jest
          .fn()
          .mockReturnValue({ provider: 'GEMINI', model: 'gemini-3.6-flash' }),
      });
      const strategy = buildStrategy(
        buildPromptService(),
        undefined,
        new MockLlmProvider(),
        aiDefaults,
      );

      // 2. Act ⚙️
      await strategy.execute(
        buildContext({ parsed_email: { clean_body: CLEAN_BODY } }),
        { inlinePrompt: 'Redacta.' },
      );

      // 3. Assert 🎯
      expect(aiDefaults.getOcrDefaults).not.toHaveBeenCalled();
      expect(aiDefaults.getTextDefaults).toHaveBeenCalled();
    });

    it('8.3 NO deberia consultar el entorno si el nodo declara proveedor y modelo', async () => {
      // 1. Arrange 📐: el nodo manda siempre. Quien configuro un proveedor
      //    concreto tomo una decision que una variable de entorno no debe
      //    revocar a sus espaldas.
      const aiDefaults = buildAiDefaults();
      const strategy = buildStrategy(
        buildPromptService(),
        {},
        new MockLlmProvider(),
        aiDefaults,
      );

      // 2. Act ⚙️
      const result = await strategy.execute(
        buildContext({ parsed_email: { clean_body: CLEAN_BODY } }),
        {
          inlinePrompt: 'Redacta.',
          provider: LlmProvider.MOCK,
          model: 'modelo-elegido-a-mano',
        },
      );

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(aiDefaults.getTextDefaults).not.toHaveBeenCalled();
      expect(aiDefaults.getOcrDefaults).not.toHaveBeenCalled();
    });

    it('8.4 deberia ignorar un proveedor del entorno que no case con el enum', async () => {
      // 1. Arrange 📐: `AiDefaultsConfig` ya avisa por el log; aqui solo debe
      //    caerse al valor de siempre en vez de propagar una cadena invalida.
      const aiDefaults = buildAiDefaults({
        getTextDefaults: jest
          .fn()
          .mockReturnValue({ provider: 'INVENTADO', model: null }),
      });
      const strategy = buildStrategy(
        buildPromptService(),
        {},
        new MockLlmProvider(),
        aiDefaults,
      );

      // 2. Act ⚙️
      const result = await strategy.execute(
        buildContext({ parsed_email: { clean_body: CLEAN_BODY } }),
        { inlinePrompt: 'Redacta.' },
      );

      // 3. Assert 🎯: sigue corriendo sobre el defecto MOCK del DTO.
      expect(result.success).toBe(true);
      expect(
        (result.data?.metadata as { isMock?: boolean } | undefined)?.isMock,
      ).toBe(true);
    });

    it('8.5 deberia trasladar la espera del entorno a la llamada al proveedor', async () => {
      // 1. Arrange 📐: el caso que motiva la tanda. Una tabla de trece
      //    comisiones universitarias no cabe en los 15 s cableados, y el
      //    sintoma era un ERR_HTTP_TIMEOUT que solo se podia arreglar
      //    desplegando. Ahora `LLM_HTTP_TIMEOUT_MS` lo decide.
      const generateCompletion = jest.fn().mockResolvedValue({
        headline: 'T',
        summary: 'S',
        body_paragraphs: [],
        metadata: {
          tokensPrompt: 0,
          tokensCompletion: 0,
          modelUsed: 'x',
          isMock: false,
        },
      });
      const aiDefaults = buildAiDefaults({
        getTextHttpDefaults: jest
          .fn()
          .mockReturnValue({ timeoutMs: 60_000, maxRetries: 0 }),
      });
      const strategy = buildStrategy(
        buildPromptService(),
        { provider: LlmProvider.GEMINI, generateCompletion },
        new MockLlmProvider(),
        aiDefaults,
      );

      // 2. Act ⚙️
      await strategy.execute(
        buildContext({ parsed_email: { clean_body: CLEAN_BODY } }),
        { provider: LlmProvider.GEMINI, inlinePrompt: 'Redacta.' },
      );

      // 3. Assert 🎯: viaja ademas `baseDelayMs`, que es lo que separa los
      //    reintentos lo suficiente para no caer en el mismo 429 de cuota.
      expect(optionsOf(generateCompletion)).toMatchObject({
        timeoutMs: 60_000,
        maxRetries: 0,
        baseDelayMs: LLM_RETRY_BASE_DELAY_MS,
      });
    });

    it('8.6 el entorno deberia ELEVAR la espera que el flujo trae guardada', async () => {
      // 1. Arrange 📐: la razon de ser de la tanda. El asistente publica
      //    `timeoutMs` en el esquema aunque el operador no lo toque, de modo
      //    que todo flujo guardado llevaba 15 000 clavados y ganaba al `.env`.
      //    Ahora el entorno es un PISO y alcanza a lo ya guardado sin que haya
      //    que reabrir el flujo.
      const generateCompletion = jest.fn().mockResolvedValue({
        headline: 'T',
        summary: 'S',
        body_paragraphs: [],
        metadata: {
          tokensPrompt: 0,
          tokensCompletion: 0,
          modelUsed: 'x',
          isMock: false,
        },
      });
      const aiDefaults = buildAiDefaults({
        getTextHttpDefaults: jest
          .fn()
          .mockReturnValue({ timeoutMs: 60_000, maxRetries: 1 }),
      });
      const strategy = buildStrategy(
        buildPromptService(),
        { provider: LlmProvider.GEMINI, generateCompletion },
        new MockLlmProvider(),
        aiDefaults,
      );

      // 2. Act ⚙️
      await strategy.execute(
        buildContext({ parsed_email: { clean_body: CLEAN_BODY } }),
        {
          provider: LlmProvider.GEMINI,
          inlinePrompt: 'Redacta.',
          timeoutMs: 15_000,
          maxRetries: 3,
        },
      );

      // 3. Assert 🎯: la espera sube al piso del entorno y los reintentos bajan
      //    a su techo. Las dos direcciones en el mismo caso, porque es la
      //    asimetria lo que hay que fijar.
      expect(optionsOf(generateCompletion)).toMatchObject({
        timeoutMs: 60_000,
        maxRetries: 1,
      });
    });

    it('8.7 los params del nodo deberian mandar cuando piden MAS espera', async () => {
      // 1. Arrange 📐: es un piso, no una imposicion.
      const generateCompletion = jest.fn().mockResolvedValue({
        headline: 'T',
        summary: 'S',
        body_paragraphs: [],
        metadata: {
          tokensPrompt: 0,
          tokensCompletion: 0,
          modelUsed: 'x',
          isMock: false,
        },
      });
      const aiDefaults = buildAiDefaults({
        getTextHttpDefaults: jest
          .fn()
          .mockReturnValue({ timeoutMs: 60_000, maxRetries: 1 }),
      });
      const strategy = buildStrategy(
        buildPromptService(),
        { provider: LlmProvider.GEMINI, generateCompletion },
        new MockLlmProvider(),
        aiDefaults,
      );

      // 2. Act ⚙️
      await strategy.execute(
        buildContext({ parsed_email: { clean_body: CLEAN_BODY } }),
        {
          provider: LlmProvider.GEMINI,
          inlinePrompt: 'Redacta.',
          timeoutMs: 120_000,
        },
      );

      // 3. Assert 🎯
      expect(optionsOf(generateCompletion)).toMatchObject({
        timeoutMs: 120_000,
      });
    });
  });

  describe('11. Materia prima acumulada', () => {
    /** Tabla ofimatica tipica que `PARSER_PRE_IA` serializa desde un .docx. */
    const DOCUMENTS_TABLE = [
      '| Expediente | Importe |',
      '| --- | --- |',
      '| 2027/014 | 48500.00 |',
    ].join('\n');

    /** Proveedor doblado que solo sirve para capturar sus argumentos. */
    const buildSpyProvider = (): jest.Mock =>
      jest.fn().mockResolvedValue({
        headline: 'h',
        summary: 's',
        body_paragraphs: [],
        metadata: {
          tokensPrompt: 0,
          tokensCompletion: 0,
          modelUsed: 'gemini-3.6-flash',
          isMock: false,
        },
      });

    /** Primer argumento de la llamada: la materia prima ya ensamblada. */
    const materialOf = (generateCompletion: jest.Mock): string =>
      (generateCompletion.mock.calls[0] as [string])[0];

    it('11.1 deberia enviar el correo Y el texto de los adjuntos', async () => {
      // 1. Arrange 📐: el caso que motivo el cambio. El cuerpo del correo no
      //    dice nada por si solo —el dato esta en el adjunto— y hasta ahora
      //    ganaba la cascada y el adjunto no viajaba.
      const generateCompletion = buildSpyProvider();
      const strategy = buildStrategy(buildPromptService(), {
        provider: LlmProvider.GEMINI,
        generateCompletion,
      });
      const context = buildContext({
        parsed_email: {
          clean_body: 'Usando el adjunto',
          extracted_documents_text: DOCUMENTS_TABLE,
          attachment_count: 1,
        },
      });

      // 2. Act ⚙️: prompt en linea, SIN marcadores. Es el caso del operador que
      //    escribe la instruccion a mano y no cita ningun namespace.
      const result = await strategy.execute(context, {
        inlinePrompt: 'Extrae el importe.',
        provider: LlmProvider.GEMINI,
      });

      // 3. Assert 🎯
      expect(result.success).toBe(true);

      const material = materialOf(generateCompletion);

      expect(material).toContain('Correo:');
      expect(material).toContain('Usando el adjunto');
      expect(material).toContain('Documentos adjuntos:');
      expect(material).toContain(DOCUMENTS_TABLE);
      expect(material.indexOf('Usando el adjunto')).toBeLessThan(
        material.indexOf(DOCUMENTS_TABLE),
      );
    });

    it('11.2 deberia acumular correo, adjuntos y articulo en ese orden', async () => {
      // 1. Arrange 📐
      const generateCompletion = buildSpyProvider();
      const strategy = buildStrategy(buildPromptService(), {
        provider: LlmProvider.GEMINI,
        generateCompletion,
      });
      const context = buildContext({
        parsed_email: {
          clean_body: CLEAN_BODY,
          extracted_documents_text: DOCUMENTS_TABLE,
        },
        scraped_web: { full_article_content: ARTICLE_CONTENT },
      });

      // 2. Act ⚙️
      await strategy.execute(context, {
        inlinePrompt: 'Redacta.',
        provider: LlmProvider.GEMINI,
      });

      // 3. Assert 🎯
      const material = materialOf(generateCompletion);

      expect(material.indexOf(CLEAN_BODY)).toBeLessThan(
        material.indexOf(DOCUMENTS_TABLE),
      );
      expect(material.indexOf(DOCUMENTS_TABLE)).toBeLessThan(
        material.indexOf(ARTICLE_CONTENT),
      );
      expect(material).toContain('Articulo original:');
    });

    it('11.3 NO deberia repetir lo que el prompt ya interpola', async () => {
      // 1. Arrange 📐: duplicar el texto no aporta un dato nuevo y si duplica
      //    los tokens facturados de cada llamada. `LICITACION_APERTURA_DEFAULT` cita los
      //    adjuntos, asi que solo el correo debe ir como materia prima.
      const generateCompletion = buildSpyProvider();
      const promptService = buildPromptService();

      promptService.findByCode.mockResolvedValue(
        buildTemplate({
          promptText:
            'Extrae los importes de:\n{{parsed_email.extracted_documents_text}}',
        }),
      );

      const strategy = buildStrategy(promptService, {
        provider: LlmProvider.GEMINI,
        generateCompletion,
      });
      const context = buildContext({
        parsed_email: {
          clean_body: CLEAN_BODY,
          extracted_documents_text: DOCUMENTS_TABLE,
        },
      });

      // 2. Act ⚙️
      await strategy.execute(context, {
        promptCode: TEMPLATE_CODE,
        provider: LlmProvider.GEMINI,
      });

      // 3. Assert 🎯
      const [material, instruction] = generateCompletion.mock.calls[0] as [
        string,
        string,
      ];

      expect(material).toContain(CLEAN_BODY);
      expect(material).not.toContain(DOCUMENTS_TABLE);
      // Y sigue llegando al modelo: por la via del marcador, una sola vez.
      expect(instruction).toContain(DOCUMENTS_TABLE);
    });

    it('11.4 deberia avisar donde esta el material si el prompt lo cita todo', async () => {
      // 1. Arrange 📐: el caso de `VERIFICADOR_TITULOS_DEFAULT`, que interpola su unico
      //    origen. Mandar el `prompt` vacio dejaria una peticion sin contenido.
      const generateCompletion = buildSpyProvider();
      const promptService = buildPromptService();

      promptService.findByCode.mockResolvedValue(
        buildTemplate({
          promptText:
            'Procesa los paneles:\n{{parsed_email.extracted_documents_text}}',
        }),
      );

      const strategy = buildStrategy(promptService, {
        provider: LlmProvider.GEMINI,
        generateCompletion,
      });
      const context = buildContext({
        parsed_email: { extracted_documents_text: DOCUMENTS_TABLE },
      });

      // 2. Act ⚙️
      await strategy.execute(context, {
        promptCode: TEMPLATE_CODE,
        provider: LlmProvider.GEMINI,
      });

      // 3. Assert 🎯
      expect(materialOf(generateCompletion)).toBe(
        MATERIAL_IN_INSTRUCTIONS_NOTICE,
      );
    });

    it('11.5 deberia avisar de adjuntos que no aportaron texto, SIN fallar', async () => {
      // 1. Arrange 📐: un PDF escaneado no deja texto, y eso lo atiende
      //    PROCESADOR_OCR. Fallar aqui pausaria flujos correctos; callar deja
      //    al operador sin saber que el modelo no vio el adjunto.
      const generateCompletion = buildSpyProvider();
      const strategy = buildStrategy(buildPromptService(), {
        provider: LlmProvider.GEMINI,
        generateCompletion,
      });
      const warn = jest
        .spyOn(strategy['logger'], 'warn')
        .mockImplementation(() => undefined);
      const context = buildContext({
        parsed_email: {
          clean_body: CLEAN_BODY,
          extracted_documents_text: '',
          attachment_count: 2,
        },
      });

      // 2. Act ⚙️
      const result = await strategy.execute(context, {
        inlinePrompt: 'Redacta.',
        provider: LlmProvider.GEMINI,
      });

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('2 adjunto'));
    });

    it('11.6 NO deberia avisar cuando el OCR ya rescato el adjunto', async () => {
      // 1. Arrange 📐: ahi el adjunto SI aporto texto, por otra via. Avisar
      //    llenaria el log de advertencias sobre un flujo que funciona.
      const generateCompletion = buildSpyProvider();
      const strategy = buildStrategy(buildPromptService(), {
        provider: LlmProvider.GEMINI,
        generateCompletion,
      });
      const warn = jest
        .spyOn(strategy['logger'], 'warn')
        .mockImplementation(() => undefined);
      const context = buildContext({
        parsed_email: { clean_body: 'Ver adjunto.', attachment_count: 1 },
        ocr_result: { clean_body: 'Transcripcion del escaneo.' },
      });

      // 2. Act ⚙️
      await strategy.execute(context, {
        inlinePrompt: 'Redacta.',
        provider: LlmProvider.GEMINI,
      });

      // 3. Assert 🎯
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('11. Respaldo dinamico ante un proveedor saturado', () => {
    /** Cliente que revienta con el codigo indicado, como haria el real. */
    const buildThrowingProvider = (code: string): ILlmProviderClient => ({
      provider: LlmProvider.GEMINI,
      generateCompletion: jest
        .fn<Promise<LlmResponsePayload>, []>()
        .mockRejectedValue(
          new GeminiProviderException(`${code}: el remoto no atiende`, code),
        ),
    });

    /**
     * Cliente que responde correctamente, con su espia APARTE.
     *
     * El espia se devuelve suelto en vez de leerlo del objeto porque
     * `expect(cliente.generateCompletion)` separa el metodo de su objeto y le
     * quita el `this` (regla `unbound-method`).
     */
    const buildWorkingProvider = (): {
      client: ILlmProviderClient;
      completion: jest.Mock<Promise<LlmResponsePayload>, []>;
    } => {
      const completion = jest
        .fn<Promise<LlmResponsePayload>, []>()
        .mockResolvedValue({
          headline: 'Titular',
          summary: 'Resumen',
          body_paragraphs: ['Parrafo'],
          metadata: {
            tokensPrompt: 1,
            tokensCompletion: 2,
            modelUsed: 'claude-haiku-4-5',
            isMock: false,
          },
        });

      return {
        client: {
          provider: LlmProvider.ANTHROPIC,
          generateCompletion: completion,
        },
        completion,
      };
    };

    const PARAMS = {
      inlinePrompt: 'Redacta una noticia breve.',
      provider: LlmProvider.GEMINI,
    };

    const buildBody = (): ReturnType<typeof buildContext> =>
      buildContext({ parsed_email: { clean_body: CLEAN_BODY } });

    it('11.1 deberia completar la inferencia con el siguiente proveedor', async () => {
      // 1. Arrange 📐: este nodo no tenia NINGUNA cascada; un 429 de cuota lo
      //    tumbaba aunque hubiera otro proveedor con credencial.
      const anthropic = buildWorkingProvider();
      const strategy = buildStrategy(
        buildPromptService(),
        buildThrowingProvider(ERR_HTTP_UPSTREAM_UNAVAILABLE),
        new MockLlmProvider(),
        buildAiDefaults(),
        anthropic.client,
      );

      // 2. Act ⚙️
      const result = await strategy.execute(buildBody(), PARAMS);

      // 3. Assert 🎯
      expect(anthropic.completion).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
      expect(result.data?.metadata).toMatchObject({
        provider: LlmProvider.ANTHROPIC,
        fallbackFrom: LlmProvider.GEMINI,
      });
    });

    it('11.2 NO deberia mover el freno con un fallo del que se salio', async () => {
      // 1. Arrange 📐: el freno existe para detectar un proveedor que no
      //    responde. Aqui SI se respondio, y contar cada intento lo activaria
      //    —umbral 3— dentro de una sola ejecucion del nodo.
      const strategy = buildStrategy(
        buildPromptService(),
        buildThrowingProvider(ERR_HTTP_UPSTREAM_UNAVAILABLE),
        new MockLlmProvider(),
        buildAiDefaults(),
        buildWorkingProvider().client,
      );
      const context = buildBody();
      const params = { ...PARAMS, emergencyBrakeThreshold: 1 };

      // 2. Act ⚙️: tres pasadas, todas rescatadas.
      await strategy.execute(context, params);
      await strategy.execute(context, params);
      const result = await strategy.execute(context, params);

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('11.3 deberia contar UN solo fallo al agotar la cadena entera', async () => {
      // 1. Arrange 📐: con el umbral en 2, dos proveedores caidos no pueden
      //    frenar en la primera pasada; si el contador subiera por intento, si.
      const strategy = buildStrategy(
        buildPromptService(),
        buildThrowingProvider(ERR_HTTP_UPSTREAM_UNAVAILABLE),
        new MockLlmProvider(),
        buildAiDefaults(),
        buildThrowingProvider(ERR_HTTP_UPSTREAM_UNAVAILABLE),
      );
      const context = buildBody();
      const params = { ...PARAMS, emergencyBrakeThreshold: 2 };

      // 2. Act ⚙️
      const first = await strategy.execute(context, params);
      const second = await strategy.execute(context, params);

      // 3. Assert 🎯
      expect(first.error?.code).toBe(ERR_LLM_MAX_RETRIES_EXCEEDED);
      expect(second.error?.code).toBe(ERR_LLM_EMERGENCY_BRAKE);

      // Un UNICO fallo consolidado, con el presupuesto declarado agotado: el
      // motor no debe reintentar encima un nodo que ya recorrio la cadena de
      // proveedores entera, porque cada vuelta suya la repetiria completa y
      // emitiria un `node:error` mas por cada intento.
      expect(first.error?.level).toBe('GRAVE');
      expect(first.error?.metadata).toMatchObject({ exhausted: true });
      expect(typeof first.error?.metadata?.attempts).toBe('number');
      expect(typeof first.error?.metadata?.maxRetries).toBe('number');
      expect(first.error?.description).toContain('Causa raiz');
    });

    it('11.4 NO deberia conmutar ante un fallo que el destino repetiria', async () => {
      // 1. Arrange 📐
      const anthropic = buildWorkingProvider();
      const strategy = buildStrategy(
        buildPromptService(),
        buildThrowingProvider(ERR_HTTP_CLIENT_REJECTED),
        new MockLlmProvider(),
        buildAiDefaults(),
        anthropic.client,
      );

      // 2. Act ⚙️
      const result = await strategy.execute(buildBody(), PARAMS);

      // 3. Assert 🎯
      expect(anthropic.completion).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_LLM_MAX_RETRIES_EXCEEDED);
    });
  });

  /**
   * El circuito MAPEADOR_PLANTILLA -> PROCESADOR_IA -> ESCUDO_POST_IA.
   *
   * Lo que se verifica aqui es la BISAGRA: que el nodo reconozca que su prompt
   * lleva una plantilla base y, solo entonces, pida el marcado y eleve el
   * presupuesto de tokens.
   */
  describe('13. Plantilla base y filled_markup', () => {
    const MARKUP =
      '<h1 class="titular">Titular</h1><div class="cuerpo"><p>Texto.</p></div>';

    /** Doble que captura las opciones con las que se le invoca. */
    const buildCapturingProvider = (
      filledMarkup?: string,
    ): { client: ILlmProviderClient; completion: jest.Mock } => {
      const completion = jest.fn().mockResolvedValue({
        headline: 'h',
        summary: 's',
        body_paragraphs: [],
        ...(filledMarkup === undefined ? {} : { filled_markup: filledMarkup }),
        metadata: {
          tokensPrompt: 0,
          tokensCompletion: 0,
          modelUsed: 'gemini-3.6-flash',
          isMock: false,
        },
      });

      return {
        client: {
          provider: LlmProvider.GEMINI,
          generateCompletion: completion,
        },
        completion,
      };
    };

    /** Tercer argumento de la llamada: las opciones de ejecucion. */
    const optionsOf = (completion: jest.Mock): Record<string, unknown> =>
      (
        completion.mock.calls[0] as [string, string, Record<string, unknown>]
      )[2];

    it('13.1 deberia pedir el marcado cuando el prompt cita la plantilla base', async () => {
      // 1. Arrange
      const { client, completion } = buildCapturingProvider(MARKUP);
      const strategy = buildStrategy(buildPromptService(), client);
      const context = buildContext({
        parsed_email: { clean_body: CLEAN_BODY },
        rendered_html: { compiled_markup: '<h1 class="titular"></h1>' },
      });

      // 2. Act
      const result = await strategy.execute(context, {
        inlinePrompt:
          'Rellena {{rendered_html.compiled_markup}} con la noticia.',
        provider: LlmProvider.GEMINI,
      });

      // 3. Assert
      expect(optionsOf(completion).expectsFilledMarkup).toBe(true);
      expect(result.success).toBe(true);
      expect(result.data?.filled_markup).toBe(MARKUP);
    });

    it('13.2 deberia publicar null cuando el prompt no cita ninguna plantilla', async () => {
      // 1. Arrange
      const { client, completion } = buildCapturingProvider();
      const strategy = buildStrategy(buildPromptService(), client);
      const context = buildContext({
        parsed_email: { clean_body: CLEAN_BODY },
      });

      // 2. Act
      const result = await strategy.execute(context, {
        inlinePrompt: 'Redacta una noticia breve.',
        provider: LlmProvider.GEMINI,
      });

      // 3. Assert: la clave se publica IGUAL, para que el namespace no cambie
      //    de forma segun la configuracion
      expect(optionsOf(completion).expectsFilledMarkup).toBe(false);
      expect(result.success).toBe(true);
      expect(result.data?.filled_markup).toBeNull();
    });

    it('13.3 deberia detectar la plantilla venga del namespace que venga', async () => {
      // 1. Arrange: el `outputNamespace` es propiedad del NODO, no de su tipo, y
      //    `rendered_html` es solo el defecto que propone el asistente. La
      //    deteccion es LEXICA y no comprueba la lista cerrada a proposito: la
      //    regla 4 del validador de topologia ya la verifico al guardar.
      const { client, completion } = buildCapturingProvider(MARKUP);
      const strategy = buildStrategy(buildPromptService(), client);
      const context = buildContext({
        parsed_email: { clean_body: CLEAN_BODY },
        validated_drupal_json: { compiled_markup: '<h1></h1>' },
      });

      // 2. Act
      const result = await strategy.execute(context, {
        inlinePrompt: 'Rellena {{validated_drupal_json.compiled_markup}}.',
        provider: LlmProvider.GEMINI,
      });

      // 3. Assert
      expect(optionsOf(completion).expectsFilledMarkup).toBe(true);
      expect(result.data?.filled_markup).toBe(MARKUP);
    });

    it('13.4 deberia detectarla tambien por un prompt guardado', async () => {
      // 1. Arrange: `getRequiredNamespaces` no llega aqui —es puro y sincrono y
      //    solo ve `inlinePrompt`—, pero `execute` resuelve el texto antes de
      //    decidir, asi que la deteccion si alcanza las tres vias.
      const promptService = buildPromptService();
      promptService.findByCode.mockResolvedValue({
        promptText: 'Rellena {{rendered_html.compiled_markup}} con la noticia.',
      } as AiPromptTemplate);
      const { client, completion } = buildCapturingProvider(MARKUP);
      const strategy = buildStrategy(promptService, client);
      const context = buildContext({
        parsed_email: { clean_body: CLEAN_BODY },
        rendered_html: { compiled_markup: '<h1></h1>' },
      });

      // 2. Act
      await strategy.execute(context, {
        promptCode: 'NOTIWEB_DEFAULT',
        provider: LlmProvider.GEMINI,
      });

      // 3. Assert
      expect(optionsOf(completion).expectsFilledMarkup).toBe(true);
    });

    it('13.5 deberia elevar el presupuesto de tokens solo con plantilla', async () => {
      // 1. Arrange: quedarse corto corta la respuesta a media cadena JSON, y el
      //    nodo muere por contrato sin que el mensaje hable de presupuesto.
      const conPlantilla = buildCapturingProvider(MARKUP);
      const sinPlantilla = buildCapturingProvider();
      const context = buildContext({
        parsed_email: { clean_body: CLEAN_BODY },
        rendered_html: { compiled_markup: '<h1></h1>' },
      });

      // 2. Act
      await buildStrategy(buildPromptService(), conPlantilla.client).execute(
        context,
        {
          inlinePrompt: 'Rellena {{rendered_html.compiled_markup}}.',
          provider: LlmProvider.GEMINI,
        },
      );
      await buildStrategy(buildPromptService(), sinPlantilla.client).execute(
        context,
        { inlinePrompt: 'Redacta.', provider: LlmProvider.GEMINI },
      );

      // 3. Assert: sin plantilla se OMITE, no se fija un numero. Fijarlo
      //    recortaria en silencio flujos que hoy redactan articulos largos con
      //    el tope de 4096 que Anthropic aplica por su cuenta.
      expect(optionsOf(conPlantilla.completion).maxTokens).toBe(8_192);
      expect(optionsOf(sinPlantilla.completion)).not.toHaveProperty(
        'maxTokens',
      );
    });

    it('13.6 deberia respetar un maxTokens declarado por el nodo', async () => {
      // 1. Arrange
      const { client, completion } = buildCapturingProvider(MARKUP);
      const strategy = buildStrategy(buildPromptService(), client);
      const context = buildContext({
        parsed_email: { clean_body: CLEAN_BODY },
        rendered_html: { compiled_markup: '<h1></h1>' },
      });

      // 2. Act
      await strategy.execute(context, {
        inlinePrompt: 'Rellena {{rendered_html.compiled_markup}}.',
        provider: LlmProvider.GEMINI,
        maxTokens: 16_384,
      });

      // 3. Assert: lo que declara el nodo manda sobre el tope de marcado
      expect(optionsOf(completion).maxTokens).toBe(16_384);
    });

    it('13.7 deberia publicar null si el modelo devuelve marcado vacio', async () => {
      // 1. Arrange: una cadena en blanco no es markup, y publicarla dejaria al
      //    escudo auditando el vacio en vez de diagnosticarlo.
      const { client } = buildCapturingProvider('   ');
      const strategy = buildStrategy(buildPromptService(), client);
      const context = buildContext({
        parsed_email: { clean_body: CLEAN_BODY },
        rendered_html: { compiled_markup: '<h1></h1>' },
      });

      // 2. Act
      const result = await strategy.execute(context, {
        inlinePrompt: 'Rellena {{rendered_html.compiled_markup}}.',
        provider: LlmProvider.GEMINI,
      });

      // 3. Assert
      expect(result.success).toBe(true);
      expect(result.data?.filled_markup).toBeNull();
    });

    it('13.8 deberia maquetar tambien con el simulador, para el banco de pruebas', async () => {
      // 1. Arrange: MOCK es el proveedor por defecto y el destino de dryRun. Si
      //    no maquetara, el escudo no podria ejercitarse sin una clave de pago.
      const strategy = buildStrategy(buildPromptService());
      const context = buildContext({
        parsed_email: { clean_body: CLEAN_BODY },
        rendered_html: { compiled_markup: '<h1></h1>' },
      });

      // 2. Act
      const result = await strategy.execute(context, {
        inlinePrompt: 'Rellena {{rendered_html.compiled_markup}}.',
        provider: LlmProvider.MOCK,
      });

      // 3. Assert
      expect(result.success).toBe(true);
      expect(result.data?.filled_markup).toContain('<h1>');
    });

    it('13.9 deberia coincidir exactamente con las claves que emite execute', async () => {
      // 1. Arrange: el invariante que faltaba. `LLM_OUTPUT_KEYS` y
      //    `outputFields` eran dos fuentes paralelas del mismo contrato sin nada
      //    que las atara; el test 1.1 solo miraba la primera.
      const strategy = buildStrategy(buildPromptService());
      const context = buildContext({
        parsed_email: { clean_body: CLEAN_BODY },
      });

      // 2. Act
      const result = await strategy.execute(context, {
        inlinePrompt: 'Redacta una noticia breve.',
        provider: LlmProvider.MOCK,
      });

      // 3. Assert
      expect(Object.keys(result.data ?? {}).sort()).toEqual(
        strategy.outputFields.map((field) => field.name).sort(),
      );
    });
  });

  describe('14. Telemetria de tokens', () => {
    /** Respuesta real de Anthropic con contadores conocidos. */
    const buildAnthropicReply = (): jest.Mock =>
      jest.fn().mockResolvedValue({
        headline: 'Titular real',
        summary: 'Entradilla real',
        body_paragraphs: ['Parrafo'],
        metadata: {
          tokensPrompt: 1_000,
          tokensCompletion: 500,
          tokensReasoning: 0,
          usageReported: true,
          modelUsed: 'claude-sonnet-5-5',
          isMock: false,
        },
      });

    const runAnthropic = async (
      generateCompletion: jest.Mock,
      telemetry: TelemetryServiceMock,
    ) => {
      const strategy = buildStrategy(
        buildPromptService(),
        {},
        new MockLlmProvider(),
        buildAiDefaults(),
        { provider: LlmProvider.ANTHROPIC, generateCompletion },
        buildProviderCatalog(),
        telemetry,
      );

      return strategy.execute(
        buildContext({ parsed_email: { clean_body: CLEAN_BODY } }),
        {
          inlinePrompt: 'Redacta la noticia.',
          provider: LlmProvider.ANTHROPIC,
        },
      );
    };

    it('14.1 deberia publicar en llm_response.metadata los tokens y el coste estimado', async () => {
      // 1. Arrange 📐
      const telemetry = createMockTelemetryService();

      // 2. Act ⚙️
      const result = await runAnthropic(buildAnthropicReply(), telemetry);

      // 3. Assert 🎯: 1000 x 2 + 500 x 10 USD/MTok = 0.007 USD.
      expect(result.success).toBe(true);
      expect(result.data?.metadata).toMatchObject({
        provider: LlmProvider.ANTHROPIC,
        model: 'claude-sonnet-5-5',
        tokensPrompt: 1_000,
        tokensCompletion: 500,
        tokensReasoning: 0,
        totalTokens: 1_500,
        estimatedCostUSD: 0.007,
      });
    });

    it('14.2 deberia registrar el consumo con la ejecucion y el nodo del contexto', async () => {
      // 1. Arrange 📐
      const telemetry = createMockTelemetryService();

      // 2. Act ⚙️
      await runAnthropic(buildAnthropicReply(), telemetry);

      // 3. Assert 🎯: el nodo es el cursor y el proveedor el que RESPONDIO.
      expect(telemetry.recordTokenUsage).toHaveBeenCalledTimes(1);
      expect(telemetry.recordTokenUsage).toHaveBeenCalledWith({
        executionId: EXECUTION_ID,
        nodeId: NODE_ID,
        userId: null,
        aiProvider: LlmProvider.ANTHROPIC,
        aiModel: 'claude-sonnet-5-5',
        promptTokens: 1_000,
        completionTokens: 500,
        reasoningTokens: 0,
        usageReported: true,
        status: AiCallStatus.SUCCESS,
        errorMessage: null,
      });
    });

    it('14.3 deberia pausar con GRAVE si no se puede registrar el consumo', async () => {
      // 1. Arrange 📐: la BD no responde al INSERT de telemetria.
      const telemetry = createMockTelemetryService();
      telemetry.recordTokenUsage.mockRejectedValue(
        new Error('conexion perdida'),
      );

      // 2. Act ⚙️
      const result = await runAnthropic(buildAnthropicReply(), telemetry);

      // 3. Assert 🎯: sin trazabilidad del gasto el flujo no continua, y el
      //    motor no debe reintentar solo (volveria a cobrar la inferencia).
      expect(result.success).toBe(false);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.code).toBe(ERR_TELEMETRY_PERSIST_FAILED);
      expect(result.error?.metadata).toMatchObject({ exhausted: true });
    });

    it('14.4 no deberia registrar las inferencias del simulador', async () => {
      // 1. Arrange 📐
      const telemetry = createMockTelemetryService();
      const strategy = buildStrategy(
        buildPromptService(),
        {},
        new MockLlmProvider(),
        buildAiDefaults(),
        {},
        buildProviderCatalog(),
        telemetry,
      );

      // 2. Act ⚙️
      const result = await strategy.execute(
        buildContext({ parsed_email: { clean_body: CLEAN_BODY } }),
        { inlinePrompt: 'Redacta.', provider: LlmProvider.MOCK },
      );

      // 3. Assert 🎯: coste cero, pero la forma de `metadata` es la misma.
      expect(result.success).toBe(true);
      expect(telemetry.recordTokenUsage).not.toHaveBeenCalled();
      expect(result.data?.metadata).toMatchObject({
        totalTokens: 0,
        estimatedCostUSD: 0,
      });
    });

    it('14.5 deberia registrar el consumo de una respuesta truncada antes de pausar', async () => {
      // 1. Arrange 📐: el proveedor respondio (y facturo) pero la salida no
      //    sirve. El consumo viaja en el error.
      const telemetry = createMockTelemetryService();
      const truncated = new LlmProviderException(
        'corte por tope',
        ERR_LLM_PROVIDER_TRUNCATED,
      );
      truncated.usage = {
        modelUsed: 'claude-sonnet-5-5',
        tokensPrompt: 800,
        tokensCompletion: 4_096,
        tokensReasoning: 0,
        usageReported: true,
      };

      // 2. Act ⚙️
      const result = await runAnthropic(
        jest.fn().mockRejectedValue(truncated),
        telemetry,
      );

      // 3. Assert 🎯: primero el registro, despues el GRAVE de siempre.
      expect(telemetry.recordTokenUsage).toHaveBeenCalledWith(
        expect.objectContaining({ promptTokens: 800, completionTokens: 4_096 }),
      );
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_LLM_MAX_RETRIES_EXCEEDED);
    });
  });
});
