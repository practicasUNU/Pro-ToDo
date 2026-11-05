import {
  MULTIPLE_CARDINALITY_DIRECTIVE,
  PromptCardinality,
} from '@modules/prompts/prompt-meta.template';
import {
  OPTIMIZER_MAX_TOKENS_MULTIPLE,
  OPTIMIZER_MAX_TOKENS_SINGLE,
} from '@modules/prompts/prompt-optimizer.service';
import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';

import {
  ERR_LLM_PROVIDER_TRUNCATED,
  LlmProvider,
  LlmProviderException,
} from '@modules/nodes/strategies/interfaces/llm-provider.interface';
import {
  ERR_PROMPT_OPTIMIZER_EMPTY,
  PromptOptimizerService,
} from '@modules/prompts/prompt-optimizer.service';
import { AiCallStatus } from '@modules/telemetry/enums/ai-call-status.enum';
import { TelemetryOperationOrigin } from '@modules/telemetry/enums/telemetry-origin.enum';
import { UserRole } from '@modules/users/enums/user-role.enum';
import { createMockTelemetryService } from '@test/factories/telemetry-service.factory';

import type { AiDefaultsConfig } from '@core/config/ai-defaults.config';
import type { AuthenticatedUser } from '@modules/auth/interfaces/jwt-payload.interface';
import type { LlmModelDescriptor } from '@modules/nodes/dto/llm-catalog.dto';
import type { LlmProviderCatalogService } from '@modules/nodes/services/llm-provider-catalog.service';
import type { LlmResponsePayload } from '@modules/nodes/strategies/interfaces/llm-provider.interface';
import type { LlmProviderFactory } from '@modules/nodes/strategies/llm-provider.factory';
import type { TelemetryService } from '@modules/telemetry/telemetry.service';
import type { TelemetryServiceMock } from '@test/factories/telemetry-service.factory';

const EDITOR: AuthenticatedUser = {
  id: 'b27d9e10-4c3f-4a8b-9f21-6d5e4c3b2a19',
  email: 'editor@unuware.com',
  role: UserRole.EDITOR,
};

const DRAFT =
  'Resume la noticia de {{parsed_email.clean_title}} usando {{scraped_web.body}}.';

/** Catalogo minimo: un modelo libre, uno reservado a ADMIN y el simulador. */
const MODELS: LlmModelDescriptor[] = [
  {
    provider: LlmProvider.GEMINI,
    model: 'gemini-3.6-flash',
    label: 'Gemini 3.6 Flash',
    isAvailable: true,
    isTestOnly: false,
    supportsVision: true,
    contextWindow: 1_048_576,
  },
  {
    provider: LlmProvider.ANTHROPIC,
    model: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    isAvailable: true,
    isTestOnly: false,
    supportsVision: true,
    contextWindow: 1_000_000,
    minRoleRequired: UserRole.ADMIN,
  },
  {
    provider: LlmProvider.MOCK,
    model: 'mock-engine',
    label: 'Simulador',
    isAvailable: true,
    isTestOnly: true,
    supportsVision: true,
    contextWindow: 0,
  },
];

const buildPayload = (
  overrides: Partial<LlmResponsePayload> = {},
): LlmResponsePayload => ({
  headline: 'El borrador no define rol ni formato de salida.',
  summary:
    'Eres un redactor institucional. Resume en tres parrafos la noticia {{parsed_email.clean_title}} a partir de {{scraped_web.body}}.',
  body_paragraphs: [
    'Se anadio un rol explicito.',
    '  ',
    'Se fijo la extension de la salida.',
  ],
  metadata: {
    tokensPrompt: 1_200,
    tokensCompletion: 400,
    tokensReasoning: 100,
    usageReported: true,
    modelUsed: 'gemini-3.6-flash',
    isMock: false,
  },
  ...overrides,
});

interface Fixture {
  readonly service: PromptOptimizerService;
  readonly telemetry: TelemetryServiceMock;
  readonly generateCompletion: jest.Mock;
  readonly isProviderUsable: jest.Mock;
  readonly getTextDefaults: jest.Mock;
}

const buildFixture = (
  options: { usable?: boolean; payload?: LlmResponsePayload } = {},
): Fixture => {
  const telemetry = createMockTelemetryService();
  const generateCompletion = jest
    .fn()
    .mockResolvedValue(options.payload ?? buildPayload());
  const isProviderUsable = jest
    .fn()
    .mockImplementation(
      (provider: LlmProvider) =>
        provider !== LlmProvider.MOCK && (options.usable ?? true),
    );
  const getTextDefaults = jest
    .fn()
    .mockReturnValue({ provider: 'GEMINI', model: 'gemini-3.6-flash' });

  const service = new PromptOptimizerService(
    {
      getClient: jest.fn(() => ({ generateCompletion })),
    } as unknown as LlmProviderFactory,
    {
      getAvailableModels: jest.fn(() => MODELS),
      isProviderUsable,
    } as unknown as LlmProviderCatalogService,
    { getTextDefaults } as unknown as AiDefaultsConfig,
    telemetry as unknown as TelemetryService,
  );

  return {
    service,
    telemetry,
    generateCompletion,
    isProviderUsable,
    getTextDefaults,
  };
};

describe('PromptOptimizerService', () => {
  describe('1. Optimizacion y telemetria financiera', () => {
    it('1.1 deberia registrar tokens y coste con PROMPT_OPTIMIZATION y el usuario', async () => {
      // 1. Arrange 📐
      const { service, telemetry } = buildFixture();

      // 2. Act ⚙️
      const result = await service.optimize(
        { draftPrompt: DRAFT, targetFormat: 'html' },
        EDITOR,
      );

      // 3. Assert 🎯
      expect(telemetry.recordAssistUsage).toHaveBeenCalledTimes(1);
      expect(telemetry.recordAssistUsage).toHaveBeenCalledWith({
        userId: EDITOR.id,
        origin: TelemetryOperationOrigin.PROMPT_OPTIMIZATION,
        aiProvider: LlmProvider.GEMINI,
        aiModel: 'gemini-3.6-flash',
        promptTokens: 1_200,
        completionTokens: 400,
        reasoningTokens: 100,
        usageReported: true,
        status: AiCallStatus.SUCCESS,
        errorMessage: null,
      });
      // Doble: 2 USD/MTok prompt, 10 completacion y razonamiento.
      expect(result.telemetry).toEqual({
        tokensPrompt: 1_200,
        tokensCompletion: 400,
        tokensReasoning: 100,
        estimatedCostUSD: 0.0074,
        isEstimated: false,
        provider: LlmProvider.GEMINI,
        model: 'gemini-3.6-flash',
      });
    });

    it('1.2 deberia devolver el prompt optimizado y las recomendaciones no vacias', async () => {
      // 1. Arrange 📐
      const { service } = buildFixture();

      // 2. Act ⚙️
      const result = await service.optimize(
        { draftPrompt: DRAFT, targetFormat: 'html' },
        EDITOR,
      );

      // 3. Assert 🎯
      expect(result.optimizedPrompt).toContain(
        'Eres un redactor institucional',
      );
      expect(result.recommendations).toEqual([
        'Se anadio un rol explicito.',
        'Se fijo la extension de la salida.',
      ]);
    });

    it('1.3 deberia enviar el meta-prompt del formato y el borrador delimitado', async () => {
      // 1. Arrange 📐
      const { service, generateCompletion } = buildFixture();

      // 2. Act ⚙️
      await service.optimize(
        { draftPrompt: DRAFT, targetFormat: 'json' },
        EDITOR,
      );

      // 3. Assert 🎯
      const [userPrompt, systemPrompt, options] = generateCompletion.mock
        .calls[0] as [string, string, { model: string; mode: string }];
      expect(userPrompt).toBe(`<borrador>\n${DRAFT}\n</borrador>`);
      expect(systemPrompt).toContain('formato de salida "json"');
      expect(systemPrompt).toContain('{{namespace.campo}}');
      expect(options).toMatchObject({
        model: 'gemini-3.6-flash',
        mode: 'text',
      });
    });

    it('1.3b deberia pasar al proveedor los limites ampliados', async () => {
      // 1. Arrange 📐: tres minutos de espera, 10_000 tokens de techo y tres
      //    reintentos. La espera llega entera al navegador porque
      //    `boot/axios.ts` no fija `timeout`; quien acota el abuso es el
      //    `ThrottlerGuard` del controlador, no estas constantes.
      const { service, generateCompletion } = buildFixture();

      // 2. Act ⚙️
      await service.optimize(
        { draftPrompt: DRAFT, targetFormat: 'text' },
        EDITOR,
      );

      // 3. Assert 🎯
      const [, , options] = generateCompletion.mock.calls[0] as [
        string,
        string,
        { timeoutMs: number; maxTokens: number; maxRetries: number },
      ];
      expect(options).toMatchObject({
        timeoutMs: 180_000,
        maxTokens: 10_000,
        maxRetries: 3,
      });
    });

    it('1.3c deberia inyectar la directiva de lote y reservar 16384 tokens con MULTIPLE', async () => {
      // 1. Arrange 📐
      const { service, generateCompletion } = buildFixture();

      // 2. Act ⚙️
      await service.optimize(
        {
          draftPrompt: DRAFT,
          targetFormat: 'html',
          cardinality: PromptCardinality.MULTIPLE,
        },
        EDITOR,
      );

      // 3. Assert 🎯
      const [, systemPrompt, options] = generateCompletion.mock.calls[0] as [
        string,
        string,
        { maxTokens: number },
      ];
      expect(systemPrompt).toContain(MULTIPLE_CARDINALITY_DIRECTIVE);
      expect(systemPrompt).toContain('"items"');
      expect(options.maxTokens).toBe(OPTIMIZER_MAX_TOKENS_MULTIPLE);
      expect(OPTIMIZER_MAX_TOKENS_MULTIPLE).toBe(16_384);
    });

    it('1.3d con SINGLE no deberia mencionar items y deberia conservar los 10 000 tokens', async () => {
      // 1. Arrange 📐: un elemento no baja a 8192; reintroduciria los
      //    truncados que motivaron subir el techo.
      const { service, generateCompletion } = buildFixture();

      // 2. Act ⚙️
      await service.optimize(
        {
          draftPrompt: DRAFT,
          targetFormat: 'html',
          cardinality: PromptCardinality.SINGLE,
        },
        EDITOR,
      );

      // 3. Assert 🎯
      const [, systemPrompt, options] = generateCompletion.mock.calls[0] as [
        string,
        string,
        { maxTokens: number },
      ];
      expect(systemPrompt).not.toContain('DIRECTIVA DE CARDINALIDAD');
      expect(systemPrompt).not.toContain('"items"');
      expect(options.maxTokens).toBe(OPTIMIZER_MAX_TOKENS_SINGLE);
    });

    it('1.4 deberia avisar si la propuesta pierde marcadores del borrador', async () => {
      // 1. Arrange 📐: el modelo "simplifico" quitando un marcador.
      const { service } = buildFixture({
        payload: buildPayload({
          summary: 'Resume la noticia de {{parsed_email.clean_title}}.',
        }),
      });

      // 2. Act ⚙️
      const result = await service.optimize(
        { draftPrompt: DRAFT, targetFormat: 'text' },
        EDITOR,
      );

      // 3. Assert 🎯
      expect(result.recommendations[0]).toContain('{{scraped_web.body}}');
      expect(result.recommendations[0]).not.toContain(
        '{{parsed_email.clean_title}}',
      );
    });

    it('1.4b deberia avisar si la propuesta degrada un marcador obligatorio a opcional', async () => {
      // 1. Arrange 📐: el modelo conservo la ruta pero quito el asterisco.
      const { service } = buildFixture({
        payload: buildPayload({
          summary: 'Resume {{scraped_web.body}}.',
        }),
      });

      // 2. Act ⚙️
      const result = await service.optimize(
        {
          draftPrompt: 'Resume {{ * scraped_web.body }}.',
          targetFormat: 'text',
        },
        EDITOR,
      );

      // 3. Assert 🎯
      expect(result.recommendations[0]).toContain('{{*scraped_web.body}}');
    });

    it('1.4c NO deberia avisar cuando la propuesta asciende una opcional a obligatoria', async () => {
      // 1. Arrange 📐: anteponer el asterisco es lo que el optimizador tiene
      //    permitido; no es una perdida del marcador.
      const { service } = buildFixture({
        payload: buildPayload({
          summary:
            'Resume {{*scraped_web.body}} titulado {{parsed_email.clean_title}}.',
        }),
      });

      // 2. Act ⚙️
      const result = await service.optimize(
        {
          draftPrompt:
            'Resume {{scraped_web.body}} titulado {{parsed_email.clean_title}}.',
          targetFormat: 'text',
        },
        EDITOR,
      );

      // 3. Assert 🎯
      expect(result.recommendations[0]).not.toContain('Atención');
    });

    it('1.4d deberia discriminar variables obligatorias y opcionales del prompt propuesto', async () => {
      // 1. Arrange 📐
      const { service } = buildFixture({
        payload: buildPayload({
          summary:
            'Redacta a partir de {{*parsed_email.clean_body}} y {{ * scraped_web.full_article_content }}. ' +
            'Fecha: {{scraped_web.published_at}}. Autor: {{scraped_web.byline}}. ' +
            'Repite {{*parsed_email.clean_body}} y {{parsed_email.clean_body}}.',
        }),
      });

      // 2. Act ⚙️
      const result = await service.optimize(
        { draftPrompt: DRAFT, targetFormat: 'html' },
        EDITOR,
      );

      // 3. Assert 🎯: sin llaves, sin duplicados, y la que aparece con
      //    asterisco en alguna ocurrencia cuenta como obligatoria.
      expect(result.recommendedVariables).toEqual({
        mandatory: [
          'parsed_email.clean_body',
          'scraped_web.full_article_content',
        ],
        optional: ['scraped_web.published_at', 'scraped_web.byline'],
      });
    });

    it('1.4e deberia devolver listas vacias si la propuesta no tiene variables', async () => {
      // 1. Arrange 📐
      const { service } = buildFixture({
        payload: buildPayload({
          summary: 'Eres un redactor. Resume el texto.',
        }),
      });

      // 2. Act ⚙️
      const result = await service.optimize(
        { draftPrompt: 'Resume el texto.', targetFormat: 'text' },
        EDITOR,
      );

      // 3. Assert 🎯
      expect(result.recommendedVariables).toEqual({
        mandatory: [],
        optional: [],
      });
    });

    it('1.4f deberia exponer el diagnostico del modelo como justificacion', async () => {
      // 1. Arrange 📐
      const { service } = buildFixture();

      // 2. Act ⚙️
      const result = await service.optimize(
        { draftPrompt: DRAFT, targetFormat: 'html' },
        EDITOR,
      );

      // 3. Assert 🎯
      expect(result.rationale).toBe(
        'El borrador no define rol ni formato de salida.',
      );
    });

    it('1.4g deberia pedir al modelo que clasifique las variables por necesidad', async () => {
      // 1. Arrange 📐
      const { service, generateCompletion } = buildFixture();

      // 2. Act ⚙️
      await service.optimize(
        { draftPrompt: DRAFT, targetFormat: 'html' },
        EDITOR,
      );

      // 3. Assert 🎯
      const [, systemPrompt] = generateCompletion.mock.calls[0] as [
        string,
        string,
      ];
      expect(systemPrompt).toContain('{{*parsed_email.clean_body}}');
      expect(systemPrompt).toContain('{{scraped_web.published_at}}');
      expect(systemPrompt).toContain('Nunca quites un asterisco existente');
    });

    it('1.5 NO deberia fallar si la telemetria no se puede persistir', async () => {
      // 1. Arrange 📐: la inferencia ya esta pagada; un 500 empujaria a pagarla dos veces.
      const { service, telemetry } = buildFixture();
      telemetry.recordAssistUsage.mockRejectedValue(new Error('BD caida'));

      // 2. Act ⚙️
      const result = await service.optimize(
        { draftPrompt: DRAFT, targetFormat: 'html' },
        EDITOR,
      );

      // 3. Assert 🎯: las metricas se calculan igual.
      expect(telemetry.computeUsage).toHaveBeenCalledTimes(1);
      expect(result.telemetry.estimatedCostUSD).toBe(0.0074);
    });
  });

  describe('2. Fallos del proveedor', () => {
    it('2.1 deberia registrar el consumo de una respuesta truncada y responder 502', async () => {
      // 1. Arrange 📐
      const { service, telemetry, generateCompletion } = buildFixture();
      const error = new LlmProviderException(
        'corte',
        ERR_LLM_PROVIDER_TRUNCATED,
      );
      error.usage = {
        modelUsed: 'gemini-3.6-flash',
        tokensPrompt: 1_000,
        tokensCompletion: 8_192,
        tokensReasoning: 0,
        usageReported: true,
      };
      generateCompletion.mockRejectedValue(error);

      // 2. Act ⚙️ + 3. Assert 🎯
      await expect(
        service.optimize({ draftPrompt: DRAFT, targetFormat: 'html' }, EDITOR),
      ).rejects.toThrow(BadGatewayException);
      expect(telemetry.recordAssistUsage).toHaveBeenCalledWith(
        expect.objectContaining({ completionTokens: 8_192 }),
      );
    });

    it('2.2 deberia registrar FAILED con ceros si el fallo fue de transporte', async () => {
      // 1. Arrange 📐
      const { service, telemetry, generateCompletion } = buildFixture();
      generateCompletion.mockRejectedValue(new Error('ECONNRESET'));

      // 2. Act ⚙️ + 3. Assert 🎯
      await expect(
        service.optimize({ draftPrompt: DRAFT, targetFormat: 'html' }, EDITOR),
      ).rejects.toThrow(BadGatewayException);
      expect(telemetry.recordAssistUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: EDITOR.id,
          promptTokens: 0,
          completionTokens: 0,
          usageReported: false,
          status: AiCallStatus.FAILED,
          errorMessage: 'ECONNRESET',
        }),
      );
    });

    it('2.3 deberia responder 502 ERR_PROMPT_OPTIMIZER_EMPTY sin prompt, pero registrar el gasto', async () => {
      // 1. Arrange 📐
      const { service, telemetry } = buildFixture({
        payload: buildPayload({ summary: '   ' }),
      });

      // 2. Act ⚙️
      const failure = service.optimize(
        { draftPrompt: DRAFT, targetFormat: 'html' },
        EDITOR,
      );

      // 3. Assert 🎯
      await expect(failure).rejects.toMatchObject({
        response: { code: ERR_PROMPT_OPTIMIZER_EMPTY },
      });
      expect(telemetry.recordAssistUsage).toHaveBeenCalledTimes(1);
    });
  });

  describe('2 bis. Consejo de recuperacion', () => {
    it('2b.1 deberia aconsejar acortar el borrador cuando se trunca', async () => {
      // 1. Arrange 📐: el mensaje crudo del proveedor describe la averia pero
      //    no dice que hacer, y quien pulso el boton no sabe si reintentar.
      const { service, generateCompletion } = buildFixture();
      generateCompletion.mockRejectedValue(
        new LlmProviderException('corte', ERR_LLM_PROVIDER_TRUNCATED),
      );

      // 2. Act ⚙️
      const failure = await service
        .optimize({ draftPrompt: DRAFT, targetFormat: 'text' }, EDITOR)
        .catch((error: { response: { message: string } }) => error.response);

      // 3. Assert 🎯
      expect(failure.message).toContain('acorta el borrador');
    });

    it('2b.2 deberia aconsejar reintentar cuando se agota la espera', async () => {
      // 1. Arrange 📐
      const { service, generateCompletion } = buildFixture();
      generateCompletion.mockRejectedValue(
        new LlmProviderException('sin respuesta', 'ERR_HTTP_TIMEOUT'),
      );

      // 2. Act ⚙️
      const failure = await service
        .optimize({ draftPrompt: DRAFT, targetFormat: 'text' }, EDITOR)
        .catch((error: { response: { message: string } }) => error.response);

      // 3. Assert 🎯
      expect(failure.message).toContain('tres minutos');
    });

    it('2b.3 NO deberia inventar consejo para un fallo sin salida conocida', async () => {
      // 1. Arrange 📐: un consejo generico ante una averia que no se entiende
      //    solo manda al operador a reintentar algo que no va a funcionar.
      const { service, generateCompletion } = buildFixture();
      generateCompletion.mockRejectedValue(new Error('ECONNRESET'));

      // 2. Act ⚙️
      const failure = await service
        .optimize({ draftPrompt: DRAFT, targetFormat: 'text' }, EDITOR)
        .catch((error: { response: { message: string } }) => error.response);

      // 3. Assert 🎯
      expect(failure.message).not.toContain('acorta el borrador');
      expect(failure.message).not.toContain('tres minutos');
    });
  });

  describe('3. Eleccion del modelo', () => {
    it('3.1 deberia responder 503 si no hay proveedor real con credencial', async () => {
      // 1. Arrange 📐
      const { service, generateCompletion } = buildFixture({ usable: false });

      // 2. Act ⚙️ + 3. Assert 🎯
      await expect(
        service.optimize({ draftPrompt: DRAFT, targetFormat: 'html' }, EDITOR),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(generateCompletion).not.toHaveBeenCalled();
    });

    it('3.2 no deberia usar nunca el simulador aunque sea el defecto del entorno', async () => {
      // 1. Arrange 📐: el simulador ignora el system prompt.
      const { service, getTextDefaults, generateCompletion } = buildFixture();
      getTextDefaults.mockReturnValue({ provider: 'MOCK', model: null });

      // 2. Act ⚙️
      await service.optimize(
        { draftPrompt: DRAFT, targetFormat: 'html' },
        EDITOR,
      );

      // 3. Assert 🎯: cae a Gemini.
      const [, , options] = generateCompletion.mock.calls[0] as [
        string,
        string,
        { model: string },
      ];
      expect(options).toMatchObject({ model: 'gemini-3.6-flash' });
    });

    it('3.3 deberia rechazar con 400 un modelo fuera del catalogo o el simulador', async () => {
      // 1. Arrange 📐
      const { service } = buildFixture();

      // 2. Act ⚙️ + 3. Assert 🎯
      await expect(
        service.optimize(
          { draftPrompt: DRAFT, targetFormat: 'html', model: 'gpt-99' },
          EDITOR,
        ),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.optimize(
          { draftPrompt: DRAFT, targetFormat: 'html', model: 'mock-engine' },
          EDITOR,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('3.4 deberia responder 403 si un EDITOR pide un modelo reservado a ADMIN', async () => {
      // 1. Arrange 📐
      const { service } = buildFixture();

      // 2. Act ⚙️ + 3. Assert 🎯
      await expect(
        service.optimize(
          {
            draftPrompt: DRAFT,
            targetFormat: 'html',
            model: 'claude-opus-5-5',
          },
          EDITOR,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('3.5 deberia permitir al ADMIN el modelo reservado', async () => {
      // 1. Arrange 📐
      const { service, telemetry } = buildFixture();

      // 2. Act ⚙️
      await service.optimize(
        { draftPrompt: DRAFT, targetFormat: 'html', model: 'claude-opus-5-5' },
        { ...EDITOR, role: UserRole.ADMIN },
      );

      // 3. Assert 🎯
      expect(telemetry.recordAssistUsage).toHaveBeenCalledWith(
        expect.objectContaining({ aiProvider: LlmProvider.ANTHROPIC }),
      );
    });

    it('3.6 deberia OMITIR la temperatura cuando el destino es Anthropic', async () => {
      // 1. Arrange 📐: Claude responde 400 "temperature is deprecated for this
      //    model"; era el fallo que tumbaba "Mejorar Prompt con IA".
      const { service, generateCompletion } = buildFixture();

      // 2. Act ⚙️
      await service.optimize(
        { draftPrompt: DRAFT, targetFormat: 'html', model: 'claude-opus-5-5' },
        { ...EDITOR, role: UserRole.ADMIN },
      );

      // 3. Assert 🎯
      const [, , options] = generateCompletion.mock.calls[0] as [
        string,
        string,
        Record<string, unknown>,
      ];
      expect(options).not.toHaveProperty('temperature');
    });

    it('3.7 deberia conservar la temperatura con Gemini', async () => {
      // 1. Arrange 📐: Gemini si la acepta; perderla volveria creativa la
      //    reescritura sin que nadie lo pidiera.
      const { service, generateCompletion } = buildFixture();

      // 2. Act ⚙️
      await service.optimize(
        { draftPrompt: DRAFT, targetFormat: 'text' },
        EDITOR,
      );

      // 3. Assert 🎯
      const [, , options] = generateCompletion.mock.calls[0] as [
        string,
        string,
        Record<string, unknown>,
      ];
      expect(options).toMatchObject({ temperature: 0.3 });
    });
  });
});
