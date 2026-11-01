import { Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import sanitizeHtml from 'sanitize-html';

import { AcensApiConfig } from '@core/config/acens-api.config';
import {
  INTERPOLATION_PATTERN,
  MissingContextVariableException,
  collectNamespaceRoots,
} from '@core/fsm/context/state-payload.context';
import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { HttpClientService } from '@core/http/http-client.service';

import { BaseHttpDestinationStrategy } from './base/base-http-destination.strategy';
import {
  MAX_RESPONSE_BODY_CHARS,
  boundResponseBody,
  mapJsonStrings,
} from './base/http-destination.utils';

import {
  AcensHttpConfigDto,
  AcensHttpMethod,
  resolveAcensHttpConfig,
} from '../dto/acens-http-config.dto';

import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import type {
  NodeErrorDetail,
  NodeOutputField,
  NodeResult,
} from '@core/fsm/types/node-strategy.types';
import type { ResolvedAcensHttpConfig } from '../dto/acens-http-config.dto';
import type { ValidatorOptions } from 'class-validator';

/** Acens respondio 4xx o 5xx: el contrato que leen las rutas `onErrorStep`. */
export const ERR_DESTINO_ACENS_FAILED = 'ERR_DESTINO_ACENS_FAILED';

/** `params` invalidos, o el entorno no declara raiz https y clave. */
export const ERR_DESTINO_ACENS_CONFIG = 'ERR_DESTINO_ACENS_CONFIG';

/** Un `{{ns.campo}}` de la ruta, las cabeceras o el cuerpo no resuelve. */
export const ERR_DESTINO_ACENS_MISSING_CONTEXT =
  'ERR_DESTINO_ACENS_MISSING_CONTEXT';

/** Sin respuesta: DNS, timeout o conexion rechazada. */
export const ERR_DESTINO_ACENS_NETWORK = 'ERR_DESTINO_ACENS_NETWORK';

const ERROR_PREFIX = 'ERR_DESTINO_ACENS';

const VALIDATION_OPTIONS: ValidatorOptions = {
  whitelist: true,
  forbidNonWhitelisted: true,
};

/**
 * Reintentos dentro del cliente HTTP. Cero para POST: un envio masivo repetido
 * tras un timeout puede salir dos veces (mismo criterio que DESTINO_DRUPAL).
 */
const RETRIES_BY_METHOD: Readonly<Record<AcensHttpMethod, number>> = {
  [AcensHttpMethod.GET]: 3,
  [AcensHttpMethod.PUT]: 3,
  [AcensHttpMethod.DELETE]: 3,
  [AcensHttpMethod.POST]: 0,
};

/** Caracteres de control salvo tabulador y saltos de linea. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * Desinfeccion de un valor YA interpolado: fuera etiquetas y caracteres de
 * control. Se aplica al valor resuelto y no a la plantilla, porque lo que no es
 * de fiar es el contenido que llega del contexto (salida de la IA, correos).
 */
const sanitizeValue = (value: string): string =>
  sanitizeHtml(value, { allowedTags: [], allowedAttributes: {} }).replace(
    CONTROL_CHARS,
    '',
  );

interface ComposedRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly data: unknown;
}

const stackTraceOf = (error: Error): { stackTrace?: string } =>
  error.stack === undefined ? {} : { stackTrace: error.stack };

/**
 * Destino Acens (nodo DESTINO_ACENS): entrega el resultado del flujo a la API
 * de Acens/hosting.
 *
 * La URL base y la clave salen del ENTORNO (`AcensApiConfig`), nunca de los
 * `params`: el nodo solo declara verbo, ruta relativa, cabeceras extra, cuerpo
 * y espera. Por eso no pasa por la boveda ni por la guarda SSRF —el destino lo
 * fija la infraestructura, como en DESTINO_DRUPAL—; en su lugar se comprueba
 * que la URL compuesta conserve el origen de la raiz declarada.
 *
 * Todo 4xx/5xx sale como `ERR_DESTINO_ACENS_FAILED` (GRAVE, reintentable y
 * reanudable). Lo que no llego a tener respuesta sale como `_NETWORK`.
 */
@Injectable()
export class AcensHttpStrategy extends BaseHttpDestinationStrategy {
  public readonly nodeType = NodeType.DESTINO_ACENS;

  public readonly paramsSchema = AcensHttpConfigDto;

  public readonly outputFields: readonly NodeOutputField[] = [
    {
      name: 'statusCode',
      type: 'number',
      description: 'Codigo HTTP de la respuesta de Acens; 0 si no la hubo',
    },
    {
      name: 'responseBody',
      type: 'object',
      description: `Cuerpo de la respuesta (JSON parseado o texto), recortado a ${MAX_RESPONSE_BODY_CHARS} caracteres`,
    },
    {
      name: 'dispatchedAt',
      type: 'text',
      description: 'Marca ISO del instante en que se despacho la peticion',
    },
  ];

  constructor(
    httpClient: HttpClientService,
    private readonly acensConfig: AcensApiConfig,
  ) {
    super(httpClient, AcensHttpStrategy.name);
  }

  public getRequiredNamespaces(
    params: Record<string, unknown>,
  ): readonly string[] {
    const config = this.resolveLoosely(params);

    return collectNamespaceRoots([
      config.endpointPath,
      config.headers,
      config.payloadTemplate,
    ]);
  }

  /** Lo unico imprescindible para EJECUTAR es la ruta. */
  public getIncompleteParams(
    params: Record<string, unknown>,
  ): readonly string[] {
    return this.resolveLoosely(params).endpointPath === null
      ? ['endpointPath']
      : [];
  }

  /** Sin interpolacion no hay variable de contexto que pueda faltar. */
  public getUnreachableErrorCodes(
    params: Record<string, unknown>,
  ): readonly string[] {
    return this.getRequiredNamespaces(params).length === 0
      ? [ERR_DESTINO_ACENS_MISSING_CONTEXT]
      : [];
  }

  public async execute(
    context: StatePayloadContext,
    params: Record<string, unknown>,
  ): Promise<NodeResult> {
    const resolution = await this.resolveConfig(params);

    if ('failure' in resolution) {
      return this.fail(resolution.failure);
    }

    const { config } = resolution;
    const composition = this.compose(context, config);

    if ('failure' in composition) {
      return this.fail(composition.failure);
    }

    const dispatchedAt = new Date().toISOString();
    const outcome = await this.httpClient.requestWithResponse<unknown>(
      {
        url: composition.request.url,
        method: config.method,
        headers: {
          ...composition.request.headers,
          Authorization: this.acensConfig.authHeader,
        },
        ...(composition.request.data === undefined
          ? {}
          : { data: composition.request.data }),
        // Sin redirecciones: un 302 llevaria la clave a otro host.
        maxRedirects: 0,
      },
      {
        timeoutMs: Math.min(config.timeoutMs, this.acensConfig.timeoutMs),
        maxRetries: RETRIES_BY_METHOD[config.method],
      },
    );

    if ('failure' in outcome) {
      const failure = this.mapHttpFailure(
        outcome.failure,
        outcome.status,
        ERROR_PREFIX,
        `enviar ${config.method} a Acens`,
      );
      const status = outcome.status ?? 0;

      return {
        success: false,
        data: this.buildPayload({ statusCode: status, dispatchedAt }),
        error:
          status >= 400
            ? { ...failure, code: ERR_DESTINO_ACENS_FAILED }
            : failure,
      };
    }

    return {
      success: true,
      data: this.buildPayload({
        statusCode: outcome.status,
        responseBody: boundResponseBody(outcome.data),
        dispatchedAt,
      }),
    };
  }

  // --- Configuracion -----------------------------------------------------

  /** `validate` y no `validateOrReject`: una excepcion acabaria en URGENTE. */
  private async resolveConfig(
    params: Record<string, unknown>,
  ): Promise<
    | { readonly config: ResolvedAcensHttpConfig }
    | { readonly failure: NodeErrorDetail }
  > {
    if (!this.acensConfig.isUsable) {
      return {
        failure: {
          level: 'GRAVE',
          code: ERR_DESTINO_ACENS_CONFIG,
          message:
            'El servidor no tiene configurado Acens: declara ACENS_API_BASE_URL (https) y ACENS_API_KEY en backend/.env y reinicia el backend.',
        },
      };
    }

    const dto = plainToInstance(AcensHttpConfigDto, params);
    const errors = await validate(dto, VALIDATION_OPTIONS);

    if (errors.length > 0) {
      return {
        failure: {
          level: 'GRAVE',
          code: ERR_DESTINO_ACENS_CONFIG,
          message: `Configuracion invalida del destino Acens: ${errors
            .flatMap((error) => Object.values(error.constraints ?? {}))
            .join(' ')}`,
          missingFields: errors.map((error) => error.property),
        },
      };
    }

    const incomplete = this.getIncompleteParams(params);

    if (incomplete.length > 0) {
      return {
        failure: {
          level: 'GRAVE',
          code: ERR_DESTINO_ACENS_CONFIG,
          message: `Al destino Acens le faltan parametros para ejecutarse: ${incomplete.join(', ')}.`,
          missingFields: [...incomplete],
        },
      };
    }

    return { config: resolveAcensHttpConfig(dto) };
  }

  /** Defectos SIN validar, para los metodos declarativos (puros y sincronos). */
  private resolveLoosely(
    params: Record<string, unknown>,
  ): ResolvedAcensHttpConfig {
    return resolveAcensHttpConfig(plainToInstance(AcensHttpConfigDto, params));
  }

  // --- Composicion de la peticion ----------------------------------------

  /**
   * Interpola y desinfecta ruta, cabeceras y cuerpo.
   *
   * En la ruta cada valor va ademas por `encodeURIComponent`: un `/` o un `?`
   * llegado del contexto no puede cambiar el recurso al que se apunta. El
   * cuerpo JSON se interpola hoja a hoja, nunca como texto.
   */
  private compose(
    context: StatePayloadContext,
    config: ResolvedAcensHttpConfig,
  ):
    | { readonly request: ComposedRequest }
    | { readonly failure: NodeErrorDetail } {
    // Marca a marca: solo el VALOR resuelto pasa por el filtro, nunca el
    // literal de la plantilla (mismo patron que `interpolateSelector` de Drupal).
    const resolveWith =
      (escape: (value: string) => string) =>
      (template: string): string =>
        template.replace(INTERPOLATION_PATTERN, (marker: string) =>
          escape(context.getInterpolatedValue(marker)),
        );
    const interpolate = resolveWith(sanitizeValue);

    try {
      const path = resolveWith((value) =>
        encodeURIComponent(sanitizeValue(value)),
      )(config.endpointPath ?? '');
      const url = this.joinWithBase(path);

      if (url === null) {
        return {
          failure: {
            level: 'GRAVE',
            code: ERR_DESTINO_ACENS_CONFIG,
            message: `La ruta "${path}" sale de la URL base de Acens; usa una ruta relativa.`,
            missingFields: ['endpointPath'],
          },
        };
      }

      const headers = Object.fromEntries(
        Object.entries(config.headers).map(([name, value]) => [
          name,
          interpolate(value),
        ]),
      );
      const data =
        config.payloadTemplate === null
          ? undefined
          : mapJsonStrings(JSON.parse(config.payloadTemplate), interpolate);
      const declaresContentType = Object.keys(headers).some(
        (name) => name.toLowerCase() === 'content-type',
      );

      return {
        request: {
          url,
          headers:
            data === undefined || declaresContentType
              ? headers
              : { ...headers, 'Content-Type': 'application/json' },
          data,
        },
      };
    } catch (error) {
      if (error instanceof MissingContextVariableException) {
        return {
          failure: {
            level: 'GRAVE',
            code: ERR_DESTINO_ACENS_MISSING_CONTEXT,
            message: `No se pudo componer la peticion a Acens: ${error.message}`,
            missingFields: [error.variable],
            ...stackTraceOf(error),
          },
        };
      }

      throw error;
    }
  }

  /**
   * Raiz del entorno + ruta, o `null` si el resultado cambia de origen o deja
   * de colgar de la ruta base (defensa en profundidad sobre el patron del DTO).
   */
  private joinWithBase(path: string): string | null {
    const base = new URL(`${this.acensConfig.baseUrl}/`);
    const joined = new URL(`${base.pathname.replace(/\/$/, '')}${path}`, base);

    return joined.origin === base.origin &&
      joined.pathname.startsWith(base.pathname.replace(/\/$/, ''))
      ? joined.toString()
      : null;
  }

  // --- Resultado -----------------------------------------------------------

  /** Misma forma en exito y en fallo: el asistente nunca ofrece una clave fantasma. */
  private buildPayload(fields: {
    readonly statusCode?: number;
    readonly responseBody?: unknown;
    readonly dispatchedAt?: string;
  }): Record<string, unknown> {
    return {
      statusCode: fields.statusCode ?? 0,
      responseBody: fields.responseBody ?? null,
      dispatchedAt: fields.dispatchedAt ?? '',
    };
  }

  private fail(error: NodeErrorDetail): NodeResult {
    return { success: false, data: this.buildPayload({}), error };
  }
}
