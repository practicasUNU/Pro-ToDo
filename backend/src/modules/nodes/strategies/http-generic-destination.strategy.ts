import { Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  MissingContextVariableException,
  collectNamespaceRoots,
} from '@core/fsm/context/state-payload.context';
import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { HttpClientService } from '@core/http/http-client.service';
import {
  BlockedOutboundTargetError,
  OutboundTargetGuard,
} from '@core/http/outbound-url.guard';
import { CredentialsService } from '@modules/credentials/credentials.service';
import {
  ApiKeyPlacement,
  CredentialAuthType,
} from '@modules/credentials/enums/credential-auth-type.enum';

import { BaseHttpDestinationStrategy } from './base/base-http-destination.strategy';
import {
  MAX_RESPONSE_BODY_CHARS,
  boundResponseBody,
  mapJsonStrings,
} from './base/http-destination.utils';

import {
  HttpGenericAuthType,
  HttpGenericBodyType,
  HttpGenericDestinationConfigDto,
  resolveHttpGenericDestinationConfig,
} from '../dto/http-generic-destination-config.dto';

import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import type {
  NodeErrorDetail,
  NodeOutputField,
  NodeResult,
} from '@core/fsm/types/node-strategy.types';
import type { CredentialSecret } from '@modules/credentials/types/credential-secret.types';
import type { ResolvedHttpGenericDestinationConfig } from '../dto/http-generic-destination-config.dto';
import type { ValidatorOptions } from 'class-validator';

/** `params` invalidos o incompletos para ejecutar. */
export const ERR_HTTP_GENERIC_CONFIG = 'ERR_HTTP_GENERIC_CONFIG';

/** Un `{{ns.campo}}` de la URL, las cabeceras o el cuerpo no resuelve. */
export const ERR_HTTP_GENERIC_MISSING_CONTEXT =
  'ERR_HTTP_GENERIC_MISSING_CONTEXT';

/** La URL apunta a una red privada, local o reservada (proteccion SSRF). */
export const ERR_HTTP_GENERIC_TARGET_BLOCKED =
  'ERR_HTTP_GENERIC_TARGET_BLOCKED';

/** La credencial no existe, no descifra o no es del tipo que declara el nodo. */
export const ERR_HTTP_GENERIC_CREDENTIAL = 'ERR_HTTP_GENERIC_CREDENTIAL';

/** Familias de fallo HTTP, compuestas por `BaseHttpDestinationStrategy`. */
export const ERR_HTTP_GENERIC_AUTH = 'ERR_HTTP_GENERIC_AUTH';
export const ERR_HTTP_GENERIC_REQUEST = 'ERR_HTTP_GENERIC_REQUEST';
export const ERR_HTTP_GENERIC_SERVER = 'ERR_HTTP_GENERIC_SERVER';
export const ERR_HTTP_GENERIC_NETWORK = 'ERR_HTTP_GENERIC_NETWORK';

const ERROR_PREFIX = 'ERR_HTTP_GENERIC';

/** Re-exportado: los consumidores lo conocian desde esta estrategia. */
export { MAX_RESPONSE_BODY_CHARS };

/**
 * Cabeceras de respuesta que no se publican: `set-cookie` puede traer una
 * sesion del destino, y el namespace lo leen todos los nodos de despues, la
 * trazabilidad y el correo de alerta.
 */
const EXCLUDED_RESPONSE_HEADERS: ReadonlySet<string> = new Set(['set-cookie']);

const VALIDATION_OPTIONS: ValidatorOptions = {
  whitelist: true,
  forbidNonWhitelisted: true,
};

/** Tipo de credencial que exige cada `authType` del nodo. */
const CREDENTIAL_TYPE_BY_AUTH: Readonly<
  Record<
    Exclude<HttpGenericAuthType, HttpGenericAuthType.NONE>,
    CredentialAuthType
  >
> = {
  [HttpGenericAuthType.BEARER_TOKEN]: CredentialAuthType.BEARER_TOKEN,
  [HttpGenericAuthType.BASIC_AUTH]: CredentialAuthType.BASIC_AUTH,
  [HttpGenericAuthType.API_KEY]: CredentialAuthType.API_KEY,
};

/** Cabecera de tipo por defecto de cada cuerpo, si el operador no la fija. */
const CONTENT_TYPE_BY_BODY: Readonly<
  Partial<Record<HttpGenericBodyType, string>>
> = {
  [HttpGenericBodyType.JSON]: 'application/json',
  [HttpGenericBodyType.RAW_TEXT]: 'text/plain; charset=utf-8',
  [HttpGenericBodyType.FORM_DATA]: 'application/x-www-form-urlencoded',
};

/** Peticion ya compuesta, lista para el cliente HTTP. */
interface ComposedRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly params: Record<string, string>;
  readonly data: unknown;
}

type Composition =
  { readonly request: ComposedRequest } | { readonly failure: NodeErrorDetail };

const stackTraceOf = (error: Error): { stackTrace?: string } =>
  error.stack === undefined ? {} : { stackTrace: error.stack };

/**
 * Conector de salida HTTP generico (MOD-03, nodo DESTINO_HTTP_GENERICO).
 *
 * Envia el resultado del flujo a cualquier API REST publica con el verbo,
 * cabeceras, parametros y cuerpo que declare el nodo, interpolando
 * `{{ns.campo}}` contra el contexto. Hereda de `BaseHttpDestinationStrategy`
 * el reparto de fallos HTTP en familias GRAVE (`_AUTH`, `_REQUEST`, `_SERVER`,
 * `_NETWORK`), igual que DESTINO_DRUPAL.
 *
 * NO escribe en el contexto: devuelve `data` y el motor la deposita en el
 * `outputNamespace` del nodo (por defecto `http_generic_response`). Ese payload
 * es INMUTABLE por contrato: `{ statusCode, statusText, responseBody, headers,
 * dispatchedAt }`, en exito y en fallo, con valores neutros donde no aplican.
 * Las claves van en camelCase porque es la firma pedida para este conector;
 * el patron de interpolacion las admite igual que las de `snake_case`.
 *
 * SEGURIDAD, en tres capas:
 *
 * 1. SSRF: `OutboundTargetGuard` rechaza redes privadas, locales y reservadas
 *    antes de conectar, y su `lookup` repite la comprobacion al conectar.
 *    `maxRedirects: 0` impide que un 302 lleve la peticion a donde la guarda
 *    no miro.
 * 2. Secretos: la autenticacion SOLO entra por una credencial de la boveda,
 *    descifrada en `applyCredential` justo antes de despachar y descartada al
 *    salir del metodo. Nunca toca el contexto, el log ni el payload.
 * 3. Los parametros de consulta viajan en `params` y no en la URL: el cliente
 *    HTTP registra `config.url` en sus avisos, y una API key por query
 *    acabaria en el log de disco.
 */
@Injectable()
export class HttpGenericDestinationStrategy extends BaseHttpDestinationStrategy {
  public readonly nodeType = NodeType.DESTINO_HTTP_GENERICO;

  public readonly paramsSchema = HttpGenericDestinationConfigDto;

  public readonly outputFields: readonly NodeOutputField[] = [
    {
      name: 'statusCode',
      type: 'number',
      description:
        'Codigo HTTP de la respuesta; 0 si no llego a haber respuesta',
    },
    {
      name: 'statusText',
      type: 'text',
      description: 'Texto del estado HTTP (p. ej. "Created")',
    },
    {
      name: 'responseBody',
      type: 'object',
      description: `Cuerpo de la respuesta (JSON parseado o texto), recortado a ${MAX_RESPONSE_BODY_CHARS} caracteres`,
    },
    {
      name: 'headers',
      type: 'object',
      description: 'Cabeceras de la respuesta en minusculas, sin set-cookie',
    },
    {
      name: 'dispatchedAt',
      type: 'text',
      description: 'Marca ISO del instante en que se despacho la peticion',
    },
  ];

  constructor(
    httpClient: HttpClientService,
    private readonly credentialsService: CredentialsService,
    private readonly outboundGuard: OutboundTargetGuard,
  ) {
    super(httpClient, HttpGenericDestinationStrategy.name);
  }

  /**
   * Raices citadas en URL, cabeceras, parametros y cuerpo, con el mismo helper
   * recursivo que usa el validador de topologia.
   */
  public getRequiredNamespaces(
    params: Record<string, unknown>,
  ): readonly string[] {
    const config = this.resolveLoosely(params);

    return collectNamespaceRoots([
      config.targetUrl,
      config.headers,
      config.queryParams,
      config.bodyTemplate,
    ]);
  }

  /** Lo que falta para EJECUTAR; lo consulta `assertActivatable`. */
  public getIncompleteParams(
    params: Record<string, unknown>,
  ): readonly string[] {
    const config = this.resolveLoosely(params);
    const missing: string[] = [];

    if (config.targetUrl === null) {
      missing.push('targetUrl');
    }

    if (
      config.authType !== HttpGenericAuthType.NONE &&
      config.credentialId === null
    ) {
      missing.push('authConfig.credentialId');
    }

    return missing;
  }

  /** Sin autenticacion no hay credencial que pueda fallar (regla 10). */
  public getUnreachableErrorCodes(
    params: Record<string, unknown>,
  ): readonly string[] {
    return this.resolveLoosely(params).authType === HttpGenericAuthType.NONE
      ? [ERR_HTTP_GENERIC_CREDENTIAL]
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

    try {
      await this.outboundGuard.assertPublicTarget(composition.request.url);
    } catch (error) {
      if (error instanceof BlockedOutboundTargetError) {
        return this.fail({
          level: 'GRAVE',
          code: ERR_HTTP_GENERIC_TARGET_BLOCKED,
          message: `Destino bloqueado por la proteccion SSRF: ${error.message}`,
        });
      }

      throw error;
    }

    const authorized = await this.applyCredential(config, composition.request);

    if ('failure' in authorized) {
      return this.fail(authorized.failure);
    }

    const dispatchedAt = new Date().toISOString();
    const outcome = await this.httpClient.requestWithResponse<unknown>(
      {
        url: authorized.request.url,
        method: config.method,
        headers: authorized.request.headers,
        params: authorized.request.params,
        ...(authorized.request.data === undefined
          ? {}
          : { data: authorized.request.data }),
        // Sin redirecciones: un 302 llevaria la peticion —y su credencial— a
        // un destino que la guarda SSRF no comprobo.
        maxRedirects: 0,
        lookup: this.outboundGuard.lookup,
      },
      {
        timeoutMs: config.timeoutMs,
        maxRetries: config.retryAttempts,
      },
    );

    if ('failure' in outcome) {
      const failure = this.mapHttpFailure(
        outcome.failure,
        outcome.status,
        ERROR_PREFIX,
        `enviar ${config.method} al destino HTTP`,
      );

      return {
        success: false,
        data: this.buildPayload({
          statusCode: outcome.status ?? 0,
          dispatchedAt,
        }),
        error:
          config.retryAttempts > 0
            ? {
                ...failure,
                // El presupuesto de reintentos YA se gasto en el cliente HTTP:
                // sin esto, `canRetry` le sumaria los del `retryPolicy` del
                // nodo y los intentos se multiplicarian.
                metadata: {
                  ...(failure.metadata ?? {}),
                  exhausted: true,
                  maxRetries: config.retryAttempts,
                },
              }
            : failure,
      };
    }

    return {
      success: true,
      data: this.buildPayload({
        statusCode: outcome.status,
        statusText: outcome.statusText,
        responseBody: boundResponseBody(outcome.data),
        headers: Object.fromEntries(
          Object.entries(outcome.headers).filter(
            ([name]) => !EXCLUDED_RESPONSE_HEADERS.has(name),
          ),
        ),
        dispatchedAt,
      }),
    };
  }

  // --- Configuracion -----------------------------------------------------

  /**
   * Valida y aplica defectos. `validate` y no `validateOrReject`: esta lanza,
   * y el motor convertiria la excepcion en URGENTE, que nunca se reintenta.
   */
  private async resolveConfig(
    params: Record<string, unknown>,
  ): Promise<
    | { readonly config: ResolvedHttpGenericDestinationConfig }
    | { readonly failure: NodeErrorDetail }
  > {
    const dto = plainToInstance(HttpGenericDestinationConfigDto, params);
    const errors = await validate(dto, VALIDATION_OPTIONS);

    if (errors.length > 0) {
      const constraints = errors.flatMap((error) => [
        ...Object.values(error.constraints ?? {}),
        ...(error.children ?? []).flatMap((child) =>
          Object.values(child.constraints ?? {}),
        ),
      ]);

      return {
        failure: {
          level: 'GRAVE',
          code: ERR_HTTP_GENERIC_CONFIG,
          message: `Configuracion invalida del destino HTTP: ${constraints.join(' ')}`,
          missingFields: errors.map((error) => error.property),
        },
      };
    }

    const config = resolveHttpGenericDestinationConfig(dto);
    const incomplete = this.getIncompleteParams(params);

    if (incomplete.length > 0) {
      return {
        failure: {
          level: 'GRAVE',
          code: ERR_HTTP_GENERIC_CONFIG,
          message: `Al destino HTTP le faltan parametros para ejecutarse: ${incomplete.join(', ')}.`,
          missingFields: [...incomplete],
        },
      };
    }

    return { config };
  }

  /**
   * Defectos aplicados SIN validar, para los metodos declarativos.
   *
   * Son puros y sincronos por contrato, y `validate` es asincrono. Sobre
   * `params` malformados devuelven lo que puedan: el rechazo lo hace
   * `paramsSchema` en el validador, que corre en la misma pasada.
   */
  private resolveLoosely(
    params: Record<string, unknown>,
  ): ResolvedHttpGenericDestinationConfig {
    return resolveHttpGenericDestinationConfig(
      plainToInstance(HttpGenericDestinationConfigDto, params),
    );
  }

  // --- Composicion de la peticion ----------------------------------------

  /** Interpola URL, cabeceras, parametros y cuerpo contra el contexto. */
  private compose(
    context: StatePayloadContext,
    config: ResolvedHttpGenericDestinationConfig,
  ): Composition {
    const interpolate = (template: string): string =>
      context.getInterpolatedValue(template);

    try {
      const headers = Object.fromEntries(
        Object.entries(config.headers).map(([name, value]) => [
          name,
          interpolate(value),
        ]),
      );
      const params = Object.fromEntries(
        Object.entries(config.queryParams).map(([name, value]) => [
          name,
          interpolate(value),
        ]),
      );
      const contentType = CONTENT_TYPE_BY_BODY[config.bodyType];
      const declaresContentType = Object.keys(headers).some(
        (name) => name.toLowerCase() === 'content-type',
      );

      return {
        request: {
          // `targetUrl` no es null: lo garantiza `getIncompleteParams`.
          url: interpolate(config.targetUrl ?? ''),
          headers:
            contentType === undefined || declaresContentType
              ? headers
              : { ...headers, 'Content-Type': contentType },
          params,
          data: this.composeBody(config, interpolate),
        },
      };
    } catch (error) {
      if (error instanceof MissingContextVariableException) {
        return {
          failure: {
            level: 'GRAVE',
            code: ERR_HTTP_GENERIC_MISSING_CONTEXT,
            message: `No se pudo componer la peticion HTTP: ${error.message}`,
            missingFields: [error.variable],
            ...stackTraceOf(error),
          },
        };
      }

      throw error;
    }
  }

  /**
   * Cuerpo segun su tipo.
   *
   * JSON se interpola HOJA A HOJA sobre la plantilla ya parseada, nunca como
   * texto: un titular con comillas o un salto de linea romperia el JSON si se
   * sustituyera en crudo. La plantilla es JSON valido porque lo exige el DTO.
   */
  private composeBody(
    config: ResolvedHttpGenericDestinationConfig,
    interpolate: (template: string) => string,
  ): unknown {
    if (
      config.bodyType === HttpGenericBodyType.NONE ||
      config.bodyTemplate === null
    ) {
      return undefined;
    }

    if (config.bodyType === HttpGenericBodyType.RAW_TEXT) {
      return interpolate(config.bodyTemplate);
    }

    const parsed = mapJsonStrings(JSON.parse(config.bodyTemplate), interpolate);

    if (config.bodyType === HttpGenericBodyType.FORM_DATA) {
      return new URLSearchParams(parsed as Record<string, string>).toString();
    }

    return parsed;
  }

  /**
   * Descifra la credencial y la aplica a una COPIA de la peticion.
   *
   * El secreto vive solo en este marco de llamada: se lee, se escribe en la
   * cabecera o el parametro, y la referencia muere al volver. No se registra
   * nunca, y los mensajes de error nombran la credencial por su id.
   */
  private async applyCredential(
    config: ResolvedHttpGenericDestinationConfig,
    request: ComposedRequest,
  ): Promise<
    | { readonly request: ComposedRequest }
    | { readonly failure: NodeErrorDetail }
  > {
    if (config.authType === HttpGenericAuthType.NONE) {
      return { request };
    }

    const credentialId = config.credentialId ?? '';
    const expectedType = CREDENTIAL_TYPE_BY_AUTH[config.authType];
    const resolution =
      await this.credentialsService.resolveSecret(credentialId);

    if ('reason' in resolution) {
      return {
        failure: {
          level: 'GRAVE',
          code: ERR_HTTP_GENERIC_CREDENTIAL,
          message: this.describeCredentialFailure(
            credentialId,
            resolution.reason,
          ),
        },
      };
    }

    const { secret } = resolution;

    if (secret.authType !== expectedType) {
      return {
        failure: {
          level: 'GRAVE',
          code: ERR_HTTP_GENERIC_CREDENTIAL,
          message: `La credencial ${credentialId} es de tipo ${secret.authType} y el nodo declara ${config.authType}. Elige una credencial del tipo correcto.`,
        },
      };
    }

    return { request: this.withCredential(request, secret) };
  }

  private withCredential(
    request: ComposedRequest,
    secret: CredentialSecret,
  ): ComposedRequest {
    switch (secret.authType) {
      case CredentialAuthType.BEARER_TOKEN:
        return {
          ...request,
          headers: {
            ...request.headers,
            Authorization: `Bearer ${secret.token}`,
          },
        };

      case CredentialAuthType.BASIC_AUTH:
        return {
          ...request,
          headers: {
            ...request.headers,
            Authorization: `Basic ${Buffer.from(`${secret.username}:${secret.password}`, 'utf8').toString('base64')}`,
          },
        };

      case CredentialAuthType.API_KEY:
        return secret.placement === ApiKeyPlacement.QUERY
          ? {
              ...request,
              params: { ...request.params, [secret.keyName]: secret.apiKey },
            }
          : {
              ...request,
              headers: { ...request.headers, [secret.keyName]: secret.apiKey },
            };
    }
  }

  private describeCredentialFailure(
    credentialId: string,
    reason: 'NOT_FOUND' | 'VAULT_UNAVAILABLE' | 'UNREADABLE',
  ): string {
    switch (reason) {
      case 'NOT_FOUND':
        return `La credencial ${credentialId} ya no existe en la boveda. Elige otra en el nodo.`;
      case 'VAULT_UNAVAILABLE':
        return 'La boveda de credenciales no esta disponible: falta CREDENTIALS_ENCRYPTION_KEY en el servidor.';
      case 'UNREADABLE':
        return `La credencial ${credentialId} no se pudo descifrar: la clave del servidor no es la que la cifro, o el dato se altero. Vuelve a guardar su secreto.`;
    }
  }

  // --- Resultado -----------------------------------------------------------

  /**
   * Unico constructor del payload: misma forma en exito y en fallo, para que
   * el asistente nunca ofrezca una variable que en fallo no exista.
   */
  private buildPayload(fields: {
    readonly statusCode?: number;
    readonly statusText?: string;
    readonly responseBody?: unknown;
    readonly headers?: Record<string, string>;
    readonly dispatchedAt?: string;
  }): Record<string, unknown> {
    return {
      statusCode: fields.statusCode ?? 0,
      statusText: fields.statusText ?? '',
      responseBody: fields.responseBody ?? null,
      headers: fields.headers ?? {},
      dispatchedAt: fields.dispatchedAt ?? '',
    };
  }

  private fail(error: NodeErrorDetail): NodeResult {
    return { success: false, data: this.buildPayload({}), error };
  }
}
