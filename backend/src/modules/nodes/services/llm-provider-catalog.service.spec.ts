import { describe, expect, it, jest } from '@jest/globals';

import {
  LlmProvider,
  LlmProviderException,
} from '@modules/nodes/strategies/interfaces/llm-provider.interface';
import { LlmProviderFactory } from '@modules/nodes/strategies/llm-provider.factory';
import { ANTHROPIC_API_KEY_VAR } from '@modules/nodes/strategies/providers/anthropic-llm.provider';
import {
  DEFAULT_GEMINI_MODEL,
  GEMINI_API_KEY_VAR,
} from '@modules/nodes/strategies/providers/gemini-llm.provider';
import {
  MOCK_LLM_MODEL,
  MockLlmProvider,
} from '@modules/nodes/strategies/providers/mock-llm.provider';
import {
  LlmProviderCatalogService,
  TELEMETRY_NOT_RECORDED_WARNING,
} from '@modules/nodes/services/llm-provider-catalog.service';
import { AiCallStatus } from '@modules/telemetry/enums/ai-call-status.enum';
import { TelemetryOperationOrigin } from '@modules/telemetry/enums/telemetry-origin.enum';
import { createMockTelemetryService } from '@test/factories/telemetry-service.factory';

import type { ConfigService } from '@nestjs/config';
import type { AnthropicLlmProvider } from '@modules/nodes/strategies/providers/anthropic-llm.provider';
import type { GeminiLlmProvider } from '@modules/nodes/strategies/providers/gemini-llm.provider';
import type { LlmResponsePayload } from '@modules/nodes/strategies/interfaces/llm-provider.interface';
import type { TelemetryService } from '@modules/telemetry/telemetry.service';
import type { TelemetryServiceMock } from '@test/factories/telemetry-service.factory';

/**
 * Suite del catalogo y del banco de pruebas.
 *
 * Dos cosas se fijan aqui por encima del resto: que `isAvailable` dependa del
 * entorno REAL y no de una constante, y que `testConnection` no lance jamas —
 * un fallo de conexion es el resultado que esa operacion viene a averiguar, no
 * una excepcion.
 */

const ANTHROPIC_MODEL = 'claude-sonnet-5-5';
const GEMINI_MODEL = 'gemini-3.6-flash';

/** Quien pulsa "Probar conexion": firma la fila de telemetria. */
const USER_ID = '0b9e2f4a-6c1d-4e8b-9a7f-3d5c2b1a0e9f';

/** Respuesta valida de un proveedor real. */
const buildPayload = (isMock = false): LlmResponsePayload => ({
  headline: 'Conexion verificada con el proveedor',
  summary: 'Resumen',
  body_paragraphs: [],
  metadata: {
    tokensPrompt: 5,
    tokensCompletion: 7,
    modelUsed: ANTHROPIC_MODEL,
    isMock,
  },
});

/**
 * Entorno simulado.
 *
 * El mapa recibido son las variables PRESENTES; cualquier otra devuelve
 * `undefined`, igual que un `.env` que no las declara.
 */
const buildConfig = (env: Record<string, string> = {}): ConfigService =>
  ({
    get: jest.fn((variable: string) => env[variable]),
  }) as unknown as ConfigService;

interface Harness {
  readonly service: LlmProviderCatalogService;
  readonly generateCompletion: jest.Mock<() => Promise<LlmResponsePayload>>;
  readonly telemetry: TelemetryServiceMock;
}

/**
 * Servicio con la factoria REAL y los clientes doblados.
 *
 * La factoria no se dobla porque su unica logica es el mapeo que esta prueba
 * necesita ejercer de verdad: con un doble, el catalogo diria que ANTHROPIC
 * tiene cliente porque se lo dijimos nosotros.
 */
const buildHarness = (env: Record<string, string> = {}): Harness => {
  const generateCompletion = jest.fn<() => Promise<LlmResponsePayload>>(() =>
    Promise.resolve(buildPayload()),
  );
  const anthropic = {
    provider: LlmProvider.ANTHROPIC,
    generateCompletion,
  } as unknown as AnthropicLlmProvider;
  const gemini = { provider: LlmProvider.GEMINI } as GeminiLlmProvider;

  const factory = new LlmProviderFactory(
    new MockLlmProvider(),
    gemini,
    anthropic,
  );
  jest.spyOn(factory['logger'], 'warn').mockImplementation(() => undefined);

  const telemetry = createMockTelemetryService();
  const service = new LlmProviderCatalogService(
    buildConfig(env),
    factory,
    telemetry as unknown as TelemetryService,
  );
  jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
  jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);

  return { service, generateCompletion, telemetry };
};

/** Localiza un modelo del catalogo por su identificador tecnico. */
const findModel = (
  service: LlmProviderCatalogService,
  model: string,
): { isAvailable: boolean; isTestOnly: boolean } => {
  const descriptor = service
    .getAvailableModels()
    .find((entry) => entry.model === model);

  if (descriptor === undefined) {
    throw new Error(`El catalogo no incluye "${model}"`);
  }

  return descriptor;
};

describe('LlmProviderCatalogService · catalogo de modelos y conectividad', () => {
  describe('1. Disponibilidad sin credenciales', () => {
    it('1.1 deberia marcar NO disponibles los proveedores comerciales', () => {
      // 1. Arrange 📐: entorno limpio, como el de un desarrollador sin claves
      //    de pago repartidas.
      const { service } = buildHarness();

      // 2. Act ⚙️ & 3. Assert 🎯
      expect(findModel(service, ANTHROPIC_MODEL).isAvailable).toBe(false);
      expect(findModel(service, GEMINI_MODEL).isAvailable).toBe(false);
    });

    it('1.2 deberia dejar el simulador SIEMPRE disponible y marcado como prueba', () => {
      // 1. Arrange 📐: es la via para ensayar la topologia de un flujo entero
      //    a coste cero, asi que no puede depender de ninguna variable.
      const { service } = buildHarness();

      // 2. Act ⚙️
      const mockEntry = findModel(service, MOCK_LLM_MODEL);

      // 3. Assert 🎯
      expect(mockEntry.isAvailable).toBe(true);
      expect(mockEntry.isTestOnly).toBe(true);
    });

    it('1.3 deberia listar OPENAI, pero nunca como disponible', () => {
      // 1. Arrange 📐: se lista a proposito. Un operador puede encontrarselo en
      //    un flujo heredado, y verlo marcado explica por que su salida sale
      //    simulada; omitirlo dejaria el sintoma sin pista.
      const { service } = buildHarness({ OPENAI_API_KEY: 'sk-lo-que-sea' });

      // 2. Act ⚙️
      const openAiEntries = service
        .getAvailableModels()
        .filter((entry) => entry.provider === LlmProvider.OPENAI);

      // 3. Assert 🎯: sin cliente, la credencial es irrelevante.
      expect(openAiEntries.length).toBeGreaterThan(0);
      expect(openAiEntries.every((entry) => !entry.isAvailable)).toBe(true);
    });
  });

  describe('2. Disponibilidad con credenciales', () => {
    it('2.1 deberia marcar disponible ANTHROPIC con su clave presente', () => {
      // 1. Arrange 📐
      const { service } = buildHarness({
        [ANTHROPIC_API_KEY_VAR]: 'sk-ant-clave',
      });

      // 2. Act ⚙️ & 3. Assert 🎯: solo ese proveedor, no todo el catalogo.
      expect(findModel(service, ANTHROPIC_MODEL).isAvailable).toBe(true);
      expect(findModel(service, GEMINI_MODEL).isAvailable).toBe(false);
    });

    it('2.2 deberia tratar una clave en blanco como ausente', () => {
      // 1. Arrange 📐: un `.env` con `GEMINI_API_KEY=` es tan comun como no
      //    declararla, y anunciarlo como configurado seria la mentira que este
      //    catalogo viene a eliminar.
      const { service } = buildHarness({ [GEMINI_API_KEY_VAR]: '   ' });

      // 2. Act ⚙️ & 3. Assert 🎯
      expect(findModel(service, GEMINI_MODEL).isAvailable).toBe(false);
    });

    it('2.3 deberia recalcular en cada llamada, no memorizar', () => {
      // 1. Arrange 📐: una clave anadida tras un reinicio debe notarse al
      //    recargar el asistente, no al siguiente despliegue.
      const env: Record<string, string> = {};
      const { service } = buildHarness(env);
      expect(findModel(service, ANTHROPIC_MODEL).isAvailable).toBe(false);

      // 2. Act ⚙️
      env[ANTHROPIC_API_KEY_VAR] = 'sk-ant-llegada-tarde';

      // 3. Assert 🎯
      expect(findModel(service, ANTHROPIC_MODEL).isAvailable).toBe(true);
    });
  });

  describe('3. Prueba de conectividad', () => {
    it('3.1 deberia devolver exito, latencia y una muestra de la respuesta', async () => {
      // 1. Arrange 📐
      const { service } = buildHarness({
        [ANTHROPIC_API_KEY_VAR]: 'sk-ant-clave',
      });

      // 2. Act ⚙️
      const result = await service.testConnection(
        {
          provider: LlmProvider.ANTHROPIC,
          model: ANTHROPIC_MODEL,
        },
        USER_ID,
      );

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(result.isMock).toBe(false);
      expect(result.outputPreview).toContain('Conexion verificada');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.error).toBeUndefined();
    });

    it('3.2 deberia pedir CERO reintentos y el timeout corto de la prueba', async () => {
      // 1. Arrange 📐: una prueba que reintenta sola miente sobre la latencia
      //    que acaba de medir y multiplica el coste de pulsar el boton.
      const { service, generateCompletion } = buildHarness();

      // 2. Act ⚙️
      await service.testConnection(
        {
          provider: LlmProvider.ANTHROPIC,
          model: ANTHROPIC_MODEL,
        },
        USER_ID,
      );

      // 3. Assert 🎯
      expect(generateCompletion).toHaveBeenCalledWith(
        expect.any(String),
        undefined,
        expect.objectContaining({
          model: ANTHROPIC_MODEL,
          maxRetries: 0,
          timeoutMs: 8_000,
        }),
      );
    });

    it('3.3 deberia delatar con isMock que respondio el simulador', async () => {
      // 1. Arrange 📐: sin credencial el cliente real no falla, degrada. Sin
      //    este campo el boton diria "conexion correcta" justo en el caso que
      //    viene a detectar.
      const { service, generateCompletion } = buildHarness();
      generateCompletion.mockResolvedValue(buildPayload(true));

      // 2. Act ⚙️
      const result = await service.testConnection(
        {
          provider: LlmProvider.ANTHROPIC,
          model: ANTHROPIC_MODEL,
        },
        USER_ID,
      );

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(result.isMock).toBe(true);
    });

    it('3.4 deberia devolver success:false ante un 401, SIN lanzar', async () => {
      // 1. Arrange 📐: mismo criterio que `WizardService.checkImap`. El 4xx
      //    queda para un cuerpo mal formado, que es lo unico que el cliente
      //    puede corregir reintentando.
      const { service, generateCompletion } = buildHarness({
        [ANTHROPIC_API_KEY_VAR]: 'sk-ant-caducada',
      });
      generateCompletion.mockRejectedValue(
        new Error(
          'ERR_HTTP_CLIENT_REJECTED: El servicio remoto rechazo la peticion con 401',
        ),
      );

      // 2. Act ⚙️
      const result = await service.testConnection(
        {
          provider: LlmProvider.ANTHROPIC,
          model: ANTHROPIC_MODEL,
        },
        USER_ID,
      );

      // 3. Assert 🎯: el mensaje original se conserva detras de la pista.
      expect(result.success).toBe(false);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.message).toContain('credencial');
      expect(result.error?.message).toContain('ERR_HTTP_CLIENT_REJECTED');
      expect(result.outputPreview).toBe('');
    });

    it('3.5 deberia traducir el timeout nombrando la espera de la prueba', async () => {
      // 1. Arrange 📐
      const { service, generateCompletion } = buildHarness();
      generateCompletion.mockRejectedValue(
        new Error('ERR_NODE_HTTP_TIMEOUT: se agoto la espera'),
      );

      // 2. Act ⚙️
      const result = await service.testConnection(
        {
          provider: LlmProvider.ANTHROPIC,
          model: ANTHROPIC_MODEL,
        },
        USER_ID,
      );

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('8000');
    });

    it('3.6 deberia cortar antes de llamar a nadie si el proveedor no tiene cliente', async () => {
      // 1. Arrange 📐: pedirselo a la factoria devolveria el simulador, y una
      //    prueba que responde "correcto" porque simulo la respuesta es peor
      //    que no tener boton.
      const { service, generateCompletion } = buildHarness();

      // 2. Act ⚙️
      const result = await service.testConnection(
        {
          provider: LlmProvider.OPENAI,
          model: 'gpt-4o',
        },
        USER_ID,
      );

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.isMock).toBe(false);
      expect(result.latencyMs).toBe(0);
      expect(result.error?.message).toContain('cliente implementado');
      expect(generateCompletion).not.toHaveBeenCalled();
    });

    it('3.7 deberia funcionar contra el simulador sin credencial alguna', async () => {
      // 1. Arrange 📐: es el unico proveedor contra el que se puede pulsar el
      //    boton sin gastar nada, y por tanto el que debe funcionar siempre.
      const { service } = buildHarness();

      // 2. Act ⚙️
      const result = await service.testConnection(
        {
          provider: LlmProvider.MOCK,
          model: MOCK_LLM_MODEL,
        },
        USER_ID,
      );

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(result.isMock).toBe(true);
    });
  });

  describe('5. Telemetria de la prueba (origen PROBAR_CONEXION)', () => {
    const ANTHROPIC_DTO = {
      provider: LlmProvider.ANTHROPIC,
      model: ANTHROPIC_MODEL,
    } as const;

    it('should persist SUCCESS telemetry record with origen PROBAR_CONEXION when test inference succeeds', async () => {
      // 1. Arrange 📐: el proveedor real responde con su consumo.
      const { service, telemetry } = buildHarness({
        [ANTHROPIC_API_KEY_VAR]: 'sk-ant-clave',
      });

      // 2. Act ⚙️
      const result = await service.testConnection(ANTHROPIC_DTO, USER_ID);

      // 3. Assert 🎯: una fila con el usuario, el modelo probado y los tokens.
      //    El coste lo calcula el servicio de telemetria con la tarifa vigente.
      expect(result.success).toBe(true);
      expect(result.telemetryWarning).toBeUndefined();
      expect(telemetry.recordAssistUsage).toHaveBeenCalledTimes(1);
      expect(telemetry.recordAssistUsage).toHaveBeenCalledWith({
        userId: USER_ID,
        origin: TelemetryOperationOrigin.CONNECTION_TEST,
        status: AiCallStatus.SUCCESS,
        errorMessage: null,
        aiProvider: LlmProvider.ANTHROPIC,
        aiModel: ANTHROPIC_MODEL,
        promptTokens: 5,
        completionTokens: 7,
        reasoningTokens: 0,
        usageReported: true,
      });
    });

    it('should persist FAILED telemetry record with error message when test inference throws API exception', async () => {
      // 1. Arrange 📐: credencial rechazada; la API no devolvio consumo.
      const { service, generateCompletion, telemetry } = buildHarness({
        [ANTHROPIC_API_KEY_VAR]: 'sk-ant-caducada',
      });
      generateCompletion.mockRejectedValue(
        new LlmProviderException(
          'ERR_HTTP_CLIENT_REJECTED: El servicio remoto rechazo la peticion con 401',
          'ERR_HTTP_CLIENT_REJECTED',
        ),
      );

      // 2. Act ⚙️
      const result = await service.testConnection(ANTHROPIC_DTO, USER_ID);

      // 3. Assert 🎯: fila FAILED con el mensaje de la API y todo a cero.
      expect(result.success).toBe(false);
      expect(telemetry.recordAssistUsage).toHaveBeenCalledWith({
        userId: USER_ID,
        origin: TelemetryOperationOrigin.CONNECTION_TEST,
        status: AiCallStatus.FAILED,
        errorMessage:
          'ERR_HTTP_CLIENT_REJECTED: El servicio remoto rechazo la peticion con 401',
        aiProvider: LlmProvider.ANTHROPIC,
        aiModel: ANTHROPIC_MODEL,
        promptTokens: 0,
        completionTokens: 0,
        reasoningTokens: 0,
        usageReported: false,
      });
    });

    it('5.3 deberia registrar el consumo que trae la excepcion si el proveedor llego a facturar', async () => {
      // 1. Arrange 📐: respuesta truncada; se cobro aunque no sirva.
      const { service, generateCompletion, telemetry } = buildHarness();
      const truncated = new LlmProviderException(
        'corte por tope',
        'ERR_LLM_PROVIDER_TRUNCATED',
      );
      truncated.usage = {
        modelUsed: ANTHROPIC_MODEL,
        tokensPrompt: 20,
        tokensCompletion: 64,
        tokensReasoning: 0,
        usageReported: true,
      };
      generateCompletion.mockRejectedValue(truncated);

      // 2. Act ⚙️
      await service.testConnection(ANTHROPIC_DTO, USER_ID);

      // 3. Assert 🎯
      expect(telemetry.recordAssistUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          status: AiCallStatus.FAILED,
          promptTokens: 20,
          completionTokens: 64,
        }),
      );
    });

    it('5.4 NO deberia registrar nada cuando responde el simulador', async () => {
      // 1. Arrange 📐: sin credencial el cliente degrada; coste cero.
      const { service, generateCompletion, telemetry } = buildHarness();
      generateCompletion.mockResolvedValue(buildPayload(true));

      // 2. Act ⚙️
      await service.testConnection(ANTHROPIC_DTO, USER_ID);
      await service.testConnection(
        { provider: LlmProvider.MOCK, model: MOCK_LLM_MODEL },
        USER_ID,
      );

      // 3. Assert 🎯
      expect(telemetry.recordAssistUsage).not.toHaveBeenCalled();
    });

    it('5.5 deberia avisar en la respuesta si no pudo registrar el consumo, sin lanzar', async () => {
      // 1. Arrange 📐: la prueba fue bien, pero el INSERT falla.
      const { service, telemetry } = buildHarness({
        [ANTHROPIC_API_KEY_VAR]: 'sk-ant-clave',
      });
      telemetry.recordAssistUsage.mockRejectedValue(new Error('BD caida'));

      // 2. Act ⚙️
      const result = await service.testConnection(ANTHROPIC_DTO, USER_ID);

      // 3. Assert 🎯: el resultado de la prueba se conserva y el aviso viaja.
      expect(result.success).toBe(true);
      expect(result.telemetryWarning).toBe(TELEMETRY_NOT_RECORDED_WARNING);
    });
  });

  describe('4. Coherencia con los defectos del sistema', () => {
    it('4.1 deberia listar el modelo Gemini que el sistema usa por defecto', () => {
      // 1. Arrange 📐: el catalogo es lo que el selector del asistente ofrece.
      //    Si el defecto no figura en el, un nodo recien creado nace citando un
      //    modelo que la interfaz marca «no catalogado» — y, cuando el defecto
      //    ademas esta retirado, con un 404 asegurado en la primera ejecucion.
      //    Es exactamente la divergencia que dejo `gemini-1.5-flash` vivo en
      //    tres constantes despues de que Google lo retirase.
      const { service } = buildHarness();

      // 2. Act ⚙️
      const models = service.getAvailableModels();

      // 3. Assert 🎯
      expect(models.some((model) => model.model === DEFAULT_GEMINI_MODEL)).toBe(
        true,
      );
    });
  });
});
