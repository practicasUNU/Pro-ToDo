import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { LlmProvider } from '@modules/nodes/strategies/interfaces/llm-provider.interface';
import {
  ERR_LLM_EMERGENCY_BRAKE,
  ERR_LLM_INTERPOLATION,
  ERR_LLM_MISSING_INPUT_TEXT,
  ERR_LLM_PROMPT_UNRESOLVED,
  ERR_LLM_PROVIDER_FAILURE,
  ERR_LLM_PROVIDER_UNSUPPORTED,
  LLM_OUTPUT_KEYS,
  LlmExtractorStrategy,
} from '@modules/nodes/strategies/llm-extractor.strategy';
import { MockLlmProvider } from '@modules/nodes/strategies/providers/mock-llm.provider';
import { createMockStatePayloadContext } from '@test/factories/state-payload-context.factory';

import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import type { AiPromptTemplate } from '@modules/ai-prompt-templates/entities/ai-prompt-template.entity';
import type { AiPromptTemplatesService } from '@modules/ai-prompt-templates/ai-prompt-templates.service';
import type {
  ILlmProviderClient,
  LlmResponsePayload,
} from '@modules/nodes/strategies/interfaces/llm-provider.interface';
import type { GeminiLlmProvider } from '@modules/nodes/strategies/providers/gemini-llm.provider';

const EXECUTION_ID = 'exec-11111111-1111-4111-8111-111111111111';
const OTHER_EXECUTION_ID = 'exec-22222222-2222-4222-8222-222222222222';
const WORKFLOW_ID = 'flow-33333333-3333-4333-8333-333333333333';
const NODE_ID = 'nodo_ia';
const TEMPLATE_ID = '9f1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const AUTHOR_ID = '1a2b3c4d-5e6f-4071-8283-94a5b6c7d8e9';

/** Cuerpo de correo tipico que `PARSER_PRE_IA` deja en su namespace. */
const CLEAN_BODY = 'El ayuntamiento aprueba el plan de innovacion para 2027.';

/** Cuerpo de articulo tipico que `EXTRACTOR_WEB` deja en el suyo. */
const ARTICLE_CONTENT = 'La comision presento el informe tecnico esta manana.';

/**
 * Doble de `AiPromptTemplatesService` acotado por `Pick`.
 *
 * Solo `findOneEntity` participa: la estrategia no usa `findByName` ni el CRUD,
 * y un mock de la clase entera obligaria a mantener metodos que esta prueba no
 * ejerce.
 */
type PromptServiceMock = jest.Mocked<
  Pick<AiPromptTemplatesService, 'findOneEntity'>
>;

const buildPromptService = (): PromptServiceMock => ({
  findOneEntity: jest.fn(),
});

/** Plantilla de prompt con los campos que la estrategia lee. */
const buildTemplate = (
  overrides: Partial<AiPromptTemplate> = {},
): AiPromptTemplate =>
  ({
    id: TEMPLATE_ID,
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
const buildStrategy = (
  promptService: PromptServiceMock,
  gemini: Partial<ILlmProviderClient> = {},
  mock: ILlmProviderClient = new MockLlmProvider(),
): LlmExtractorStrategy =>
  new LlmExtractorStrategy(
    promptService as unknown as AiPromptTemplatesService,
    mock as MockLlmProvider,
    gemini as GeminiLlmProvider,
  );

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
          modelUsed: 'gemini-1.5-flash',
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
        'parsed_email.clean_body',
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

    it('2.6 deberia rechazar un proveedor sin cliente implementado', async () => {
      // 1. Arrange
      const strategy = buildStrategy(buildPromptService());
      const context = buildContext({
        parsed_email: { clean_body: CLEAN_BODY },
      });

      // 2. Act
      const result = await strategy.execute(context, {
        inlinePrompt: 'Redacta una noticia breve.',
        provider: LlmProvider.ANTHROPIC,
      });

      // 3. Assert: NO cae al simulador. La salida simulada seguiria hasta el
      //    MAPEADOR_PLANTILLA, que la publicaria como si fuera real.
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_LLM_PROVIDER_UNSUPPORTED);
      expect(result.error?.level).toBe('GRAVE');
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
      expect(result.error?.code).toBe(ERR_LLM_PROVIDER_FAILURE);
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
            modelUsed: 'gemini-1.5-flash',
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
      expect(result.error?.code).toBe(ERR_LLM_PROVIDER_FAILURE);
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
      expect(firstOfHealthy.error?.code).toBe(ERR_LLM_PROVIDER_FAILURE);
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
          modelUsed: 'gemini-1.5-flash',
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
        inlinePrompt: 'Usa {{parsed_email.clean_title}} y {{scraped_web.byline}}.',
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

  describe('6. Completitud para activar', () => {
    it('6.1 deberia reclamar la instruccion cuando no hay ninguna', () => {
      // 1. Arrange
      const strategy = buildStrategy(buildPromptService());

      // 2. Act
      const incomplete = strategy.getIncompleteParams({});

      // 3. Assert
      expect(incomplete).toEqual(['templatePromptId | inlinePrompt']);
    });

    it('6.2 deberia considerarlo completo con cualquiera de las dos vias', () => {
      // 1. Arrange
      const strategy = buildStrategy(buildPromptService());

      // 2. Act & 3. Assert
      expect(strategy.getIncompleteParams({ inlinePrompt: 'Redacta.' })).toEqual(
        [],
      );
      expect(
        strategy.getIncompleteParams({ templatePromptId: TEMPLATE_ID }),
      ).toEqual([]);
    });
  });
});
