import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { HttpClientService } from '@core/http/http-client.service';
import { stripCodeFence } from '@modules/nodes/utils/code-fence.util';
import {
  ERR_LLM_PROVIDER_CONTRACT,
  LlmProvider,
  LlmProviderException,
  buildResponseContractInstruction,
  buildResponseJsonSchema,
} from '@modules/nodes/strategies/interfaces/llm-provider.interface';
import { MockLlmProvider } from '@modules/nodes/strategies/providers/mock-llm.provider';

import type {
  ILlmProviderClient,
  LlmExecutionOptions,
  LlmInlineAttachment,
  LlmResponsePayload,
} from '@modules/nodes/strategies/interfaces/llm-provider.interface';

/** Variable de entorno que porta la credencial. Ver `backend/.env.example`. */
export const ANTHROPIC_API_KEY_VAR = 'ANTHROPIC_API_KEY';

/** Endpoint de la Messages API de Anthropic. */
export const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

/**
 * Version del contrato de la API, obligatoria en cada peticion.
 *
 * Es una cabecera y no una ruta: Anthropic congela el comportamiento por fecha,
 * de modo que fijarla aqui protege al nodo de un cambio de forma en la
 * respuesta sin que nadie haya tocado este archivo.
 */
export const ANTHROPIC_VERSION = '2023-06-01';

/** Modelo por defecto cuando el nodo no declara uno. */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5-5';

/**
 * Techo de generacion por inferencia.
 *
 * `max_tokens` es obligatorio en esta API, al reves que en Gemini. No se expone
 * en el DTO del nodo porque el contrato de salida son tres campos de redaccion
 * y no un documento largo; 4096 cubre de sobra una noticia con sus parrafos.
 */
const ANTHROPIC_MAX_TOKENS = 4_096;

/*
 * La frase del contrato y el esquema de salida ya NO viven aqui: los construyen
 * `buildResponseContractInstruction` y `buildResponseJsonSchema`, en
 * `llm-provider.interface.ts`, porque desde `filled_markup` el contrato es
 * CONDICIONAL y una rama escrita dos veces diverge en silencio. El razonamiento
 * completo —y por que revierte la decision anterior de duplicarlos a proposito—
 * esta en el TSDoc de esos dos constructores.
 */

/** Forma parcial de la respuesta de Anthropic que este cliente consume. */
interface AnthropicApiResponse {
  readonly content?: readonly {
    readonly type?: string;
    readonly text?: string;
  }[];
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
  };
  readonly stop_reason?: string;
}

/** Contrato formal tal y como lo redacta el modelo, antes de completarlo. */
interface AnthropicGeneratedContract {
  readonly headline?: unknown;
  readonly summary?: unknown;
  readonly body_paragraphs?: unknown;
  readonly filled_markup?: unknown;
}

/** Error del proveedor. Lo captura la estrategia para mover el freno. */
export class AnthropicProviderException extends LlmProviderException {
  constructor(message: string, code: string) {
    super(message, code);
    this.name = 'AnthropicProviderException';
  }
}

/**
 * Cliente de Anthropic (Claude) sobre la Messages API.
 *
 * Se usa `HttpClientService` y NO `@anthropic-ai/sdk`, por el mismo motivo que
 * `GeminiLlmProvider` no usa el SDK de Google: el timeout, el backoff
 * exponencial y la clasificacion de errores ya estan resueltos ahi para todo el
 * backend. Con el SDK habria dos politicas de reintento conviviendo —la suya y
 * la del DTO del nodo— y `maxRetries` dejaria de significar lo mismo segun el
 * proveedor elegido, que es exactamente el tipo de sorpresa que el AVISO de
 * `LlmExtractorConfigDto` sobre los dos niveles de reintento intenta evitar.
 *
 * DEGRADACION A SIMULACION: sin `ANTHROPIC_API_KEY` en el entorno, delega en
 * `MockLlmProvider` con un aviso en el log. No lanza. La ausencia de la clave
 * es un estado NORMAL del entorno de desarrollo, y un backend que no pudiera
 * ejecutar un flujo entero por eso obligaria a repartir credenciales de pago
 * para probar la topologia de un pipeline. La respuesta lleva `isMock: true`,
 * de modo que la degradacion queda registrada en el namespace y es auditable.
 */
@Injectable()
export class AnthropicLlmProvider implements ILlmProviderClient {
  public readonly provider = LlmProvider.ANTHROPIC;

  private readonly logger = new Logger(AnthropicLlmProvider.name);

  constructor(
    private readonly httpClient: HttpClientService,
    private readonly configService: ConfigService,
    private readonly mockProvider: MockLlmProvider,
  ) {}

  public async generateCompletion(
    prompt: string,
    systemPrompt?: string,
    config?: LlmExecutionOptions,
    attachments: readonly LlmInlineAttachment[] = [],
  ): Promise<LlmResponsePayload> {
    const apiKey = this.configService
      .get<string>(ANTHROPIC_API_KEY_VAR)
      ?.trim();

    // Guarda de credencial. Antes de construir nada: sin clave no hay peticion
    // que preparar.
    if (apiKey === undefined || apiKey.length === 0) {
      this.logger.warn(
        `${ANTHROPIC_API_KEY_VAR} no esta definida en el entorno. Se degrada a simulacion de coste cero; la salida llevara isMock: true.`,
      );

      return this.mockProvider.generateCompletion(
        prompt,
        systemPrompt,
        config,
        attachments,
      );
    }

    const model = config?.model ?? DEFAULT_ANTHROPIC_MODEL;

    const outcome = await this.httpClient.request<AnthropicApiResponse>(
      {
        url: ANTHROPIC_API_URL,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // La clave va en `x-api-key` y NUNCA como query string: un parametro
          // de URL acaba en los logs de acceso de cualquier proxy del camino.
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        data: {
          model,
          // `max_tokens` es OBLIGATORIO en esta API, al reves que en Gemini, de
          // modo que aqui no se puede omitir: el nodo manda si lo declara y si
          // no queda el tope del repositorio.
          max_tokens: config?.maxTokens ?? ANTHROPIC_MAX_TOKENS,
          // La temperatura si se omite cuando el nodo no la declara: el defecto
          // lo publica Anthropic y cambia con el modelo.
          ...(config?.temperature === undefined
            ? {}
            : { temperature: config.temperature }),
          // La instruccion del operador y el contrato de formato viajan juntos
          // en `system`, con el contrato el ultimo para que sea lo mas reciente
          // que el modelo lee antes de responder.
          system: this.buildSystemInstruction(
            systemPrompt,
            config?.expectsFilledMarkup ?? false,
          ),
          messages: [
            { role: 'user', content: this.buildContent(prompt, attachments) },
          ],
          output_config: {
            format: {
              type: 'json_schema',
              schema: buildResponseJsonSchema(
                config?.expectsFilledMarkup ?? false,
              ),
            },
          },
        },
      },
      {
        ...(config?.timeoutMs === undefined
          ? {}
          : { timeoutMs: config.timeoutMs }),
        ...(config?.maxRetries === undefined
          ? {}
          : { maxRetries: config.maxRetries }),
      },
    );

    // LANZA, al reves que una `INodeStrategy`. Lo exige el contrato de
    // `ILlmProviderClient`: la excepcion es la senal que alimenta el contador
    // del freno de emergencia de la estrategia.
    if ('failure' in outcome) {
      throw new AnthropicProviderException(
        `${outcome.failure.code}: ${outcome.failure.message}`,
        // El codigo viaja APARTE del mensaje: es lo que decide si conviene
        // probar con otro proveedor o si repetir seria gastar dos veces el
        // mismo error.
        outcome.failure.code,
      );
    }

    return this.toPayload(outcome.data, model);
  }

  /**
   * Compone el contenido del turno del usuario: el texto y, si los hay, los
   * adjuntos que el modelo debe mirar.
   *
   * El TEXTO va SIEMPRE primero, aunque venga vacio. El orden de los bloques es
   * significativo: la instruccion de que hacer con la imagen debe leerse antes
   * que la imagen, o el modelo la describe en vez de extraer lo que se le pide.
   *
   * Un PDF no es una imagen en esta API: viaja como bloque `document`. Mandarlo
   * como `image` lo rechaza con un 400, asi que se discrimina por MIME.
   *
   * Sin adjuntos el cuerpo queda con un solo bloque de texto, de modo que el
   * modo de siempre no cambia.
   */
  private buildContent(
    prompt: string,
    attachments: readonly LlmInlineAttachment[],
  ): readonly Record<string, unknown>[] {
    return [
      { type: 'text', text: prompt },
      ...attachments.map((attachment) => ({
        type:
          attachment.contentType === 'application/pdf' ? 'document' : 'image',
        source: {
          type: 'base64',
          media_type: attachment.contentType,
          data: attachment.contentBase64,
        },
      })),
    ];
  }

  /** Une la instruccion del operador con el contrato de formato obligatorio. */
  private buildSystemInstruction(
    systemPrompt: string | undefined,
    expectsFilledMarkup: boolean,
  ): string {
    const operatorInstruction = systemPrompt?.trim() ?? '';
    const contract = buildResponseContractInstruction(expectsFilledMarkup);

    return operatorInstruction.length === 0
      ? contract
      : `${operatorInstruction}\n\n${contract}`;
  }

  /** Extrae el contrato formal de la respuesta cruda de la API. */
  private toPayload(
    response: AnthropicApiResponse,
    model: string,
  ): LlmResponsePayload {
    // Se busca el primer bloque de texto en vez de tomar `content[0]`: la
    // respuesta puede abrir con bloques de otro tipo y un indice fijo leeria el
    // que no es.
    const rawText = response.content?.find(
      (block) => block.type === 'text' && typeof block.text === 'string',
    )?.text;

    if (rawText === undefined || rawText.trim().length === 0) {
      throw new AnthropicProviderException(
        `Anthropic devolvio una respuesta sin contenido generado (stop_reason: ${
          response.stop_reason ?? 'desconocido'
        }).`,
        ERR_LLM_PROVIDER_CONTRACT,
      );
    }

    const generated = this.parseContract(rawText);

    const filledMarkup = this.asOptionalText(generated.filled_markup);

    return {
      headline: this.asText(generated.headline),
      summary: this.asText(generated.summary),
      body_paragraphs: this.asParagraphs(generated.body_paragraphs),
      // Propagacion CONDICIONAL de la clave: cuando el modelo no la emite, el
      // payload no la menciona en vez de llevarla a `undefined` explicito. Asi
      // el contrato de tres claves sigue siendo literalmente el de tres claves.
      ...(filledMarkup === undefined ? {} : { filled_markup: filledMarkup }),
      metadata: {
        tokensPrompt: response.usage?.input_tokens ?? 0,
        tokensCompletion: response.usage?.output_tokens ?? 0,
        modelUsed: model,
        isMock: false,
      },
    };
  }

  /** `JSON.parse` con el fallo traducido al error del proveedor. */
  private parseContract(rawText: string): AnthropicGeneratedContract {
    try {
      // Misma red que en el cliente de Gemini: un objeto entregado dentro de
      // ```json ... ``` reventaba el parseo acusando al contrato.
      const parsed: unknown = JSON.parse(stripCodeFence(rawText));

      if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('el JSON recibido no es un objeto');
      }

      return parsed;
    } catch (error) {
      throw new AnthropicProviderException(
        `Anthropic devolvio un cuerpo que no respeta el contrato JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
        ERR_LLM_PROVIDER_CONTRACT,
      );
    }
  }

  /** Normaliza a cadena. Lo ausente se representa vacio, nunca `undefined`. */
  private asText(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  /**
   * Hermano de `asText` que distingue "no vino" de "vino vacio".
   *
   * `asText` colapsa los dos casos en `''`, que es lo correcto para un titular
   * obligatorio y lo contrario de lo que hace falta aqui: una cadena vacia en
   * `filled_markup` significa que el modelo no maqueto nada, y publicarla como
   * si fuera markup dejaria al escudo auditando el vacio.
   */
  private asOptionalText(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const trimmed = value.trim();

    return trimmed.length > 0 ? trimmed : undefined;
  }

  /** Normaliza a arreglo de cadenas no vacias, descartando lo demas. */
  private asParagraphs(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
}
