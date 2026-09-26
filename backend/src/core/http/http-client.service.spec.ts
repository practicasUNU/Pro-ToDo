import { of, throwError } from 'rxjs';

import {
  DEFAULT_HTTP_BASE_DELAY_MS,
  ERR_HTTP_CLIENT_REJECTED,
  ERR_HTTP_TIMEOUT,
  ERR_HTTP_UPSTREAM_UNAVAILABLE,
  HttpClientService,
} from '@core/http/http-client.service';

import type { HttpService } from '@nestjs/axios';
import type { AxiosError, AxiosResponse } from 'axios';

/** URL neutra: ninguna prueba depende de su valor, solo de que viaje al mock. */
const TARGET_URL = 'https://proveedor.example/v1/generar';

/** Doble minimo de `HttpService`: la clase real solo aporta `request` aqui. */
type HttpServiceMock = jest.Mocked<Pick<HttpService, 'request'>>;

const buildHttpService = (): HttpServiceMock => ({ request: jest.fn() });

const buildClient = (httpService: HttpServiceMock): HttpClientService =>
  new HttpClientService(httpService as unknown as HttpService);

/** Respuesta 200 con el cuerpo dado, con el resto de campos en valores neutros. */
const buildResponse = <T>(data: T): AxiosResponse<T> =>
  ({
    data,
    status: 200,
    statusText: 'OK',
    headers: {},
    config: { headers: {} },
  }) as AxiosResponse<T>;

/**
 * Error de Axios sintetico.
 *
 * `isAxiosError: true` es lo que mira `axios.isAxiosError`, asi que basta con
 * ponerlo para que el servicio entre por la rama que se quiere probar sin
 * arrastrar la construccion real de un `AxiosError`.
 */
const buildAxiosError = (
  overrides: Partial<AxiosError> = {},
): AxiosError => {
  const error = new Error(
    overrides.message ?? 'fallo simulado',
  ) as unknown as AxiosError;

  return Object.assign(error, { isAxiosError: true }, overrides);
};

/** Respuesta con el estado dado, para provocar la clasificacion por codigo. */
const buildStatusError = (status: number): AxiosError =>
  buildAxiosError({
    message: `respuesta ${status}`,
    response: { status } as AxiosError['response'],
  });

describe('HttpClientService', () => {
  beforeEach(() => {
    // Las esperas del backoff son reales y suman segundos a la suite. Se
    // simulan aqui, no en cada prueba, porque ninguna asevera sobre el reloj:
    // lo que importa es CUANTAS veces se llamo al transporte, no cuando.
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  /** Agota los temporizadores pendientes mientras la promesa sigue viva. */
  const runPending = async <T>(pending: Promise<T>): Promise<T> => {
    await jest.runAllTimersAsync();

    return pending;
  };

  describe('1. Camino feliz', () => {
    it('1.1 deberia devolver la data ya desempaquetada de Axios', async () => {
      // 1. Arrange
      const httpService = buildHttpService();
      httpService.request.mockReturnValue(
        of(buildResponse({ headline: 'Titular' })),
      );
      const client = buildClient(httpService);

      // 2. Act
      const outcome = await runPending(
        client.request<{ headline: string }>({ url: TARGET_URL }),
      );

      // 3. Assert
      expect(outcome).toEqual({ data: { headline: 'Titular' } });
      expect(httpService.request).toHaveBeenCalledTimes(1);
    });

    it('1.2 deberia aplicar el timeout por defecto sin pisar la config recibida', async () => {
      // 1. Arrange
      const httpService = buildHttpService();
      httpService.request.mockReturnValue(of(buildResponse({})));
      const client = buildClient(httpService);

      // 2. Act
      await runPending(
        client.request({ url: TARGET_URL, method: 'POST' }, { timeoutMs: 7_000 }),
      );

      // 3. Assert
      expect(httpService.request).toHaveBeenCalledWith(
        expect.objectContaining({
          url: TARGET_URL,
          method: 'POST',
          timeout: 7_000,
        }),
      );
    });
  });

  describe('2. Reintentos con backoff', () => {
    it('2.1 deberia reintentar un timeout hasta agotar maxRetries', async () => {
      // 1. Arrange
      const httpService = buildHttpService();
      httpService.request.mockReturnValue(
        throwError(() => buildAxiosError({ code: 'ECONNABORTED' })),
      );
      const client = buildClient(httpService);

      // 2. Act
      const outcome = await runPending(
        client.request(
          { url: TARGET_URL },
          { maxRetries: 2, baseDelayMs: DEFAULT_HTTP_BASE_DELAY_MS },
        ),
      );

      // 3. Assert
      // maxRetries cuenta REINTENTOS: 2 reintentos son 3 llamadas en total.
      expect(httpService.request).toHaveBeenCalledTimes(3);
      expect('failure' in outcome && outcome.failure.code).toBe(
        ERR_HTTP_TIMEOUT,
      );
      expect('failure' in outcome && outcome.failure.level).toBe('GRAVE');
    });

    it('2.2 deberia reintentar un 503 del proveedor', async () => {
      // 1. Arrange
      const httpService = buildHttpService();
      httpService.request.mockReturnValue(
        throwError(() => buildStatusError(503)),
      );
      const client = buildClient(httpService);

      // 2. Act
      const outcome = await runPending(
        client.request({ url: TARGET_URL }, { maxRetries: 1 }),
      );

      // 3. Assert
      expect(httpService.request).toHaveBeenCalledTimes(2);
      expect('failure' in outcome && outcome.failure.code).toBe(
        ERR_HTTP_UPSTREAM_UNAVAILABLE,
      );
    });

    it('2.3 deberia reintentar un 429 por cuota agotada', async () => {
      // 1. Arrange
      const httpService = buildHttpService();
      httpService.request.mockReturnValue(
        throwError(() => buildStatusError(429)),
      );
      const client = buildClient(httpService);

      // 2. Act
      const outcome = await runPending(
        client.request({ url: TARGET_URL }, { maxRetries: 1 }),
      );

      // 3. Assert
      expect(httpService.request).toHaveBeenCalledTimes(2);
      expect('failure' in outcome && outcome.failure.code).toBe(
        ERR_HTTP_UPSTREAM_UNAVAILABLE,
      );
    });

    it('2.4 deberia devolver la data si un reintento posterior acierta', async () => {
      // 1. Arrange
      const httpService = buildHttpService();
      httpService.request
        .mockReturnValueOnce(throwError(() => buildStatusError(500)))
        .mockReturnValueOnce(of(buildResponse({ ok: true })));
      const client = buildClient(httpService);

      // 2. Act
      const outcome = await runPending(
        client.request<{ ok: boolean }>({ url: TARGET_URL }, { maxRetries: 3 }),
      );

      // 3. Assert
      expect(outcome).toEqual({ data: { ok: true } });
      expect(httpService.request).toHaveBeenCalledTimes(2);
    });
  });

  describe('3. Fallos que NO se reintentan', () => {
    it('3.1 deberia abandonar un 401 en el primer intento', async () => {
      // 1. Arrange
      const httpService = buildHttpService();
      httpService.request.mockReturnValue(
        throwError(() => buildStatusError(401)),
      );
      const client = buildClient(httpService);

      // 2. Act
      const outcome = await runPending(
        client.request({ url: TARGET_URL }, { maxRetries: 5 }),
      );

      // 3. Assert
      // Una credencial invalida es determinista: insistir cinco veces gasta
      // tiempo y, con un proveedor de pago detras, dinero.
      expect(httpService.request).toHaveBeenCalledTimes(1);
      expect('failure' in outcome && outcome.failure.code).toBe(
        ERR_HTTP_CLIENT_REJECTED,
      );
    });

    it('3.2 deberia abandonar un 400 de peticion malformada', async () => {
      // 1. Arrange
      const httpService = buildHttpService();
      httpService.request.mockReturnValue(
        throwError(() => buildStatusError(400)),
      );
      const client = buildClient(httpService);

      // 2. Act
      const outcome = await runPending(
        client.request({ url: TARGET_URL }, { maxRetries: 3 }),
      );

      // 3. Assert
      expect(httpService.request).toHaveBeenCalledTimes(1);
      expect('failure' in outcome && outcome.failure.code).toBe(
        ERR_HTTP_CLIENT_REJECTED,
      );
    });
  });

  describe('4. Traduccion a NodeErrorDetail', () => {
    it('4.1 deberia clasificar como GRAVE cualquier fallo, nunca como URGENTE', async () => {
      // 1. Arrange
      const httpService = buildHttpService();
      httpService.request.mockReturnValue(
        throwError(() => buildStatusError(500)),
      );
      const client = buildClient(httpService);

      // 2. Act
      const outcome = await runPending(
        client.request({ url: TARGET_URL }, { maxRetries: 0 }),
      );

      // 3. Assert
      // Solo los GRAVE entran en `FsmEngineService.canRetry`. URGENTE queda
      // reservado a quien pueda afirmar que insistir es contraproducente.
      expect('failure' in outcome && outcome.failure.level).toBe('GRAVE');
    });

    it('4.2 deberia emitir un code con el formato ERR_ del contrato', async () => {
      // 1. Arrange
      const httpService = buildHttpService();
      httpService.request.mockReturnValue(
        throwError(() => buildAxiosError({ code: 'ECONNREFUSED' })),
      );
      const client = buildClient(httpService);

      // 2. Act
      const outcome = await runPending(
        client.request({ url: TARGET_URL }, { maxRetries: 0 }),
      );

      // 3. Assert
      expect('failure' in outcome && outcome.failure.code).toMatch(
        /^ERR_[A-Z_]+$/,
      );
    });

    it('4.3 deberia traducir una excepcion ajena a Axios sin dejarla escapar', async () => {
      // 1. Arrange
      const httpService = buildHttpService();
      httpService.request.mockReturnValue(
        throwError(() => new TypeError('el transporte se rompio')),
      );
      const client = buildClient(httpService);

      // 2. Act
      const outcome = await runPending(
        client.request({ url: TARGET_URL }, { maxRetries: 0 }),
      );

      // 3. Assert
      // No lanza: si lo hiciera, `toDomainFailure` marcaria la ejecucion FALLIDO.
      expect('failure' in outcome).toBe(true);
      expect('failure' in outcome && outcome.failure.code).toBe(
        ERR_HTTP_UPSTREAM_UNAVAILABLE,
      );
      expect('failure' in outcome && outcome.failure.stackTrace).toBeDefined();
    });
  });
});
