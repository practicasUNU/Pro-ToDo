import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { HttpClientService } from '@core/http/http-client.service';
import { LlmProvider } from '@modules/nodes/strategies/interfaces/llm-provider.interface';
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

/**
 * Instruccion de formato que se antepone al prompt del operador.
 *
 * Duplicada respecto a `GeminiLlmProvider` a proposito, y no extraida a un
 * modulo comun: describe el contrato tal y como lo entiende ESTE proveedor, y
 * compartir el literal invitaria a ajustarlo para uno rompiendo al otro. La
 * frontera de reutilizacion del nodo es `ILlmProviderClient`, no el texto.
 */
const RESPONSE_CONTRACT_INSTRUCTION = [
  'Responde EXCLUSIVAMENTE con un objeto JSON valido, sin texto adicional',
  'ni marcas de bloque de codigo, con exactamente estas claves:',
  '"headline" (string), "summary" (string) y "body_paragraphs" (array de strings).',
].join(' ');

/**
 * Esquema que se adjunta en `output_config.format`.
 *
 * Se le exige el JSON al modelo por esquema en lugar de rescatarlo de un texto
 * libre a base de expresiones regulares: eso ultimo es un parser de formato ad
 * hoc, justo lo que `security-and-scope.md` §3 prohibe construir.
 */
const RESPONSE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string' },
    summary: { type: 'string' },
    body_paragraphs: { type: 'array', items: { type: 'string' } },
  },
  required: ['headline', 'summary', 'body_paragraphs'],
  additionalProperties: false,
} as const;

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
}

/** Error del proveedor. Lo captura la estrategia para mover el freno. */
export class AnthropicProviderException extends Error {
  constructor(message: string) {
    super(message);
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
          max_tokens: ANTHROPIC_MAX_TOKENS,
          // La instruccion del operador y el contrato de formato viajan juntos
          // en `system`, con el contrato el ultimo para que sea lo mas reciente
          // que el modelo lee antes de responder.
          system: this.buildSystemInstruction(systemPrompt),
          messages: [
            { role: 'user', content: this.buildContent(prompt, attachments) },
          ],
          output_config: {
            format: { type: 'json_schema', schema: RESPONSE_JSON_SCHEMA },
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
  private buildSystemInstruction(systemPrompt?: string): string {
    const operatorInstruction = systemPrompt?.trim() ?? '';

    return operatorInstruction.length === 0
      ? RESPONSE_CONTRACT_INSTRUCTION
      : `${operatorInstruction}\n\n${RESPONSE_CONTRACT_INSTRUCTION}`;
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
      );
    }

    const generated = this.parseContract(rawText);

    return {
      headline: this.asText(generated.headline),
      summary: this.asText(generated.summary),
      body_paragraphs: this.asParagraphs(generated.body_paragraphs),
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
      const parsed: unknown = JSON.parse(rawText);

      if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('el JSON recibido no es un objeto');
      }

      return parsed;
    } catch (error) {
      throw new AnthropicProviderException(
        `Anthropic devolvio un cuerpo que no respeta el contrato JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Normaliza a cadena. Lo ausente se representa vacio, nunca `undefined`. */
  private asText(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
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
