import { of, throwError } from 'rxjs';

import {
  DEFAULT_HTTP_BASE_DELAY_MS,
  ERR_HTTP_CLIENT_REJECTED,
  ERR_HTTP_TIMEOUT,
  ERR_HTTP_UPSTREAM_UNAVAILABLE,
  HttpClientService,
  MAX_REMOTE_BODY_CHARS,
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
const buildAxiosError = (overrides: Partial<AxiosError> = {}): AxiosError => {
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

/** Igual que el anterior, pero con cuerpo: lo que de verdad manda un proveedor. */
const buildStatusErrorWithBody = (status: number, data: unknown): AxiosError =>
  buildAxiosError({
    message: `respuesta ${status}`,
    response: { status, data } as AxiosError['response'],
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
        client.request(
          { url: TARGET_URL, method: 'POST' },
          { timeoutMs: 7_000 },
        ),
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

    it('2.5 deberia duplicar la espera en cada vuelta a partir de baseDelayMs', async () => {
      // 1. Arrange 📐: hasta ahora ninguna prueba aseveraba los retardos REALES
      //    del backoff — solo cuantas llamadas salian—, de modo que el factor
      //    exponencial no estaba fijado por nada. Importa desde que los nodos de
      //    IA y OCR pasan su propio `baseDelayMs` de 2 500 ms: contra un modelo
      //    que acaba de devolver un 429 de cuota, el medio segundo por defecto
      //    garantiza caer en el mismo limite y gastar el reintento en balde.
      const httpService = buildHttpService();
      httpService.request.mockReturnValue(
        throwError(() => buildAxiosError({ code: 'ECONNABORTED' })),
      );
      const client = buildClient(httpService);
      const scheduled = jest.spyOn(global, 'setTimeout');

      // 2. Act ⚙️
      await runPending(
        client.request(
          { url: TARGET_URL },
          { maxRetries: 3, baseDelayMs: 2_500 },
        ),
      );

      // 3. Assert 🎯: tres esperas para cuatro intentos, cada una el doble que
      //    la anterior.
      const delays = scheduled.mock.calls.map(([, delay]) => delay);

      expect(delays).toEqual([2_500, 5_000, 10_000]);
      expect(httpService.request).toHaveBeenCalledTimes(4);

      scheduled.mockRestore();
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

  describe('5. Diagnostico del remoto', () => {
    /** Mensaje del fallo, o cadena vacia si el desenlace fue exitoso. */
    const messageOf = (outcome: unknown): string =>
      typeof outcome === 'object' &&
      outcome !== null &&
      'failure' in outcome &&
      typeof (outcome as { failure: { message: unknown } }).failure.message ===
        'string'
        ? (outcome as { failure: { message: string } }).failure.message
        : '';

    it('5.1 deberia copiar el cuerpo de un 4xx al mensaje del fallo', async () => {
      // 1. Arrange 📐: es el caso que motiva todo esto. Google explica en el
      //    cuerpo que el modelo no existe, y hasta ahora solo llegaba al log el
      //    "Request failed with status code 404" de Axios, indistinguible de
      //    una URL mal construida.
      const httpService = buildHttpService();
      httpService.request.mockReturnValue(
        throwError(() =>
          buildStatusErrorWithBody(404, {
            error: {
              code: 404,
              message:
                'models/modelo-retirado is not found for API version v1beta',
              status: 'NOT_FOUND',
            },
          }),
        ),
      );
      const client = buildClient(httpService);

      // 2. Act ⚙️
      const outcome = await runPending(
        client.request({ url: TARGET_URL }, { maxRetries: 0 }),
      );

      // 3. Assert 🎯
      expect('failure' in outcome && outcome.failure.code).toBe(
        ERR_HTTP_CLIENT_REJECTED,
      );
      expect(messageOf(outcome)).toContain('is not found for API version');
    });

    it('5.2 deberia truncar un cuerpo desmesurado', async () => {
      // 1. Arrange 📐: el mensaje acaba en el `.log` de disco, que rota por
      //    TAMANO: un cuerpo sin tope se llevaria por delante la traza de todo
      //    lo demas justo cuando hace falta leerla.
      const httpService = buildHttpService();
      httpService.request.mockReturnValue(
        throwError(() =>
          buildStatusErrorWithBody(400, 'x'.repeat(MAX_REMOTE_BODY_CHARS * 3)),
        ),
      );
      const client = buildClient(httpService);

      // 2. Act ⚙️
      const outcome = await runPending(
        client.request({ url: TARGET_URL }, { maxRetries: 0 }),
      );

      // 3. Assert 🎯
      const message = messageOf(outcome);

      expect(message).toContain('[truncado]');
      expect(message.length).toBeLessThan(MAX_REMOTE_BODY_CHARS * 2);
    });

    it('5.3 deberia copiar tambien el cuerpo de un 5xx reintentable', async () => {
      // 1. Arrange 📐: un 503 con cuerpo suele traer la cuota o la ventana de
      //    espera, y es lo que decide si conviene reintentar a mano.
      const httpService = buildHttpService();
      httpService.request.mockReturnValue(
        throwError(() =>
          buildStatusErrorWithBody(503, { error: 'quota exhausted' }),
        ),
      );
      const client = buildClient(httpService);

      // 2. Act ⚙️
      const outcome = await runPending(
        client.request({ url: TARGET_URL }, { maxRetries: 0 }),
      );

      // 3. Assert 🎯
      expect('failure' in outcome && outcome.failure.code).toBe(
        ERR_HTTP_UPSTREAM_UNAVAILABLE,
      );
      expect(messageOf(outcome)).toContain('quota exhausted');
    });

    it('5.4 no deberia alterar el mensaje de un fallo SIN cuerpo', async () => {
      // 1. Arrange 📐: la mayoria de los 4xx no traen nada que contar, y el
      //    mensaje no debe ganar un sufijo vacio.
      const httpService = buildHttpService();
      httpService.request.mockReturnValue(
        throwError(() => buildStatusError(404)),
      );
      const client = buildClient(httpService);

      // 2. Act ⚙️
      const outcome = await runPending(
        client.request({ url: TARGET_URL }, { maxRetries: 0 }),
      );

      // 3. Assert 🎯
      expect(messageOf(outcome)).not.toContain('Respuesta del remoto');
    });
  });

  describe('6. requestWithStatus: el estado HTTP crudo', () => {
    it('6.1 deberia exponer el estado de una respuesta exitosa', async () => {
      // 1. Arrange 📐: el consumidor de Drupal publica este numero en su
      //    payload (`http_status`), asi que tiene que llegarle sin interpretar.
      const httpService = buildHttpService();
      httpService.request.mockReturnValue(of(buildResponse({ ok: true })));
      const client = buildClient(httpService);

      // 2. Act ⚙️
      const outcome = await runPending(
        client.requestWithStatus<{ ok: boolean }>({ url: TARGET_URL }),
      );

      // 3. Assert 🎯
      expect(outcome).toEqual({ data: { ok: true }, status: 200 });
    });

    it('6.2 deberia exponer el estado de un 401 junto al fallo', async () => {
      // 1. Arrange 📐: es la razon de ser del metodo. `toFailure` funde el 401 y
      //    el 404 en ERR_HTTP_CLIENT_REJECTED, y quien necesita distinguir una
      //    credencial caducada de una ruta inexistente solo puede hacerlo por el
      //    numero: el mensaje es texto libre y no es contrato.
      const httpService = buildHttpService();
      httpService.request.mockReturnValue(
        throwError(() => buildStatusError(401)),
      );
      const client = buildClient(httpService);

      // 2. Act ⚙️
      const outcome = await runPending(
        client.requestWithStatus({ url: TARGET_URL }, { maxRetries: 0 }),
      );

      // 3. Assert 🎯
      expect('failure' in outcome && outcome.failure.code).toBe(
        ERR_HTTP_CLIENT_REJECTED,
      );
      expect('status' in outcome && outcome.status).toBe(401);
    });

    it('6.3 deberia OMITIR el estado cuando no hubo respuesta', async () => {
      // 1. Arrange 📐: la ausencia es informacion. Un socket roto no tiene
      //    estado que clasificar, y es justo eso lo que permite al consumidor
      //    separar una averia de red de un rechazo del servidor remoto.
      const httpService = buildHttpService();
      httpService.request.mockReturnValue(
        throwError(() =>
          buildAxiosError({ message: 'el transporte se rompio' }),
        ),
      );
      const client = buildClient(httpService);

      // 2. Act ⚙️
      const outcome = await runPending(
        client.requestWithStatus({ url: TARGET_URL }, { maxRetries: 0 }),
      );

      // 3. Assert 🎯
      expect('failure' in outcome).toBe(true);
      expect('status' in outcome).toBe(false);
    });

    it('6.4 deberia reintentar un 503 con la misma politica que request', async () => {
      // 1. Arrange 📐: las dos entradas comparten `executeWithStatus`. Si el
      //    bucle se duplicara algun dia, este test lo detecta.
      const httpService = buildHttpService();
      httpService.request.mockReturnValue(
        throwError(() => buildStatusError(503)),
      );
      const client = buildClient(httpService);

      // 2. Act ⚙️
      const outcome = await runPending(
        client.requestWithStatus({ url: TARGET_URL }, { maxRetries: 2 }),
      );

      // 3. Assert 🎯: tres intentos, y el estado sobrevive al ultimo.
      expect(httpService.request).toHaveBeenCalledTimes(3);
      expect('status' in outcome && outcome.status).toBe(503);
    });

    it('6.5 request NO deberia filtrar el estado en su resultado', async () => {
      // 1. Arrange 📐: REGRESION de los dos proveedores de LLM. `request` se
      //    reescribio como adaptador sobre `executeWithStatus`, y devolver el
      //    objeto enriquecido tal cual habria colado `status` en runtime para
      //    todo consumidor existente.
      const httpService = buildHttpService();
      httpService.request.mockReturnValue(of(buildResponse({ ok: true })));
      const client = buildClient(httpService);

      // 2. Act ⚙️
      const outcome = await runPending(
        client.request<{ ok: boolean }>({ url: TARGET_URL }),
      );

      // 3. Assert 🎯
      expect(outcome).toEqual({ data: { ok: true } });
      expect('status' in outcome).toBe(false);
    });

    it('6.6 request NO deberia filtrar el estado en un fallo', async () => {
      // 1. Arrange 📐: hermano del anterior, por la otra rama de la union.
      const httpService = buildHttpService();
      httpService.request.mockReturnValue(
        throwError(() => buildStatusError(404)),
      );
      const client = buildClient(httpService);

      // 2. Act ⚙️
      const outcome = await runPending(
        client.request({ url: TARGET_URL }, { maxRetries: 0 }),
      );

      // 3. Assert 🎯
      expect(Object.keys(outcome)).toEqual(['failure']);
    });
  });
});
