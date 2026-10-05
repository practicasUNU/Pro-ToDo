import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { HttpClientService } from '@core/http/http-client.service';
import {
  ERR_LLM_PROVIDER_CONTRACT,
  ERR_LLM_PROVIDER_TRUNCATED,
  LlmProvider,
  LlmProviderException,
  buildResponseContractInstruction,
} from '@modules/nodes/strategies/interfaces/llm-provider.interface';
import { stripCodeFence } from '@modules/nodes/utils/code-fence.util';
import { MockLlmProvider } from '@modules/nodes/strategies/providers/mock-llm.provider';

import type {
  ILlmProviderClient,
  LlmExecutionOptions,
  LlmInlineAttachment,
  LlmResponsePayload,
  LlmThinkingLevel,
} from '@modules/nodes/strategies/interfaces/llm-provider.interface';

/** Variable de entorno que porta la credencial. Ver `backend/.env.example`. */
export const GEMINI_API_KEY_VAR = 'GEMINI_API_KEY';

/** Raiz de la API REST de Google Generative Language. */
export const GEMINI_API_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Modelo por defecto del proveedor, y UNICA fuente de ese identificador.
 *
 * Centralizado desde PROT-23. Antes el literal estaba repetido en el `??` de
 * este cliente, en `DEFAULT_OCR_MODEL` y en `DEFAULT_LLM_MODEL`, y esa
 * dispersion es lo que permitio que caducara por partes: Google retiro
 * `gemini-1.5-flash` de `v1beta` y el nodo de OCR empezo a recibir un 404 de
 * «modelo no encontrado» que parecia un fallo de URL.
 *
 * El identificador va en el PATH de la peticion, no en el cuerpo, asi que un
 * modelo inexistente aqui no da un 400 de validacion sino un 404 de ruta —el
 * mismo que daria una URL mal construida—. Es la razon por la que conviene que
 * lo declare un solo sitio y que las pruebas fijen la URL completa.
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';

/**
 * Modelos que admiten el nivel de pensamiento `minimal`.
 *
 * Las familias 3.7 y 3.8 empiezan en `low`, y mandarles `minimal` devuelve un
 * 400 `INVALID_ARGUMENT` que parece un error de payload. Se rebaja en vez de
 * fallar: el nodo pidio "piensa lo menos posible" y `low` es lo mas cerca que
 * ese modelo puede estar de eso.
 *
 * Se comprueba por PREFIJO para que las variantes fechadas del mismo modelo
 * —`-preview-09-2025` y similares— no queden fuera por el sufijo.
 */
const MODELS_SUPPORTING_MINIMAL_THINKING: readonly string[] = [
  'gemini-3.5-flash',
  'gemini-3.6-flash',
];

/** Nivel al que se rebaja `minimal` en los modelos que no lo admiten. */
const FALLBACK_THINKING_LEVEL = 'low';

/** Motivo de corte que significa "el modelo termino de hablar". */
const HEALTHY_FINISH_REASON = 'STOP';

/*
 * La frase del contrato ya NO vive aqui: la construye
 * `buildResponseContractInstruction` en `llm-provider.interface.ts`, porque
 * desde `filled_markup` el contrato es CONDICIONAL y una rama escrita dos veces
 * diverge en silencio. Este cliente no adjunta esquema —la API de Gemini no lo
 * admite y se conforma con `responseMimeType`—, asi que la frase es TODO lo que
 * le dice al modelo que forma debe tener la respuesta.
 */

/** Forma parcial de la respuesta de Gemini que este cliente consume. */
interface GeminiApiResponse {
  readonly candidates?: readonly {
    readonly content?: {
      readonly parts?: readonly {
        readonly text?: string;
        /** Marca las partes de deliberacion, que no forman parte de la respuesta. */
        readonly thought?: boolean;
      }[];
    };
    /**
     * Por que dejo de generar el modelo.
     *
     * Se declara DESDE PROT-24. Sin el, un corte por `MAX_TOKENS` llegaba al
     * parser como JSON a medias y se reportaba como contrato roto, que manda a
     * revisar el prompt en vez del presupuesto. Anthropic ya declaraba su
     * `stop_reason` por este mismo motivo.
     */
    readonly finishReason?: string;
  }[];
  readonly usageMetadata?: {
    readonly promptTokenCount?: number;
    readonly candidatesTokenCount?: number;
    /** Tokens gastados deliberando; salen del mismo presupuesto que la respuesta. */
    readonly thoughtsTokenCount?: number;
  };
}

/** Contrato formal tal y como lo redacta el modelo, antes de completarlo. */
interface GeminiGeneratedContract {
  readonly headline?: unknown;
  readonly summary?: unknown;
  readonly body_paragraphs?: unknown;
  readonly filled_markup?: unknown;
}

/** Error del proveedor. Lo captura la estrategia para mover el freno. */
export class GeminiProviderException extends LlmProviderException {
  constructor(message: string, code: string) {
    super(message, code);
    this.name = 'GeminiProviderException';
  }
}

/**
 * Cliente de Google Gemini sobre la API REST de Generative Language.
 *
 * Se usa `HttpClientService` y no el SDK oficial a proposito: el timeout, el
 * backoff exponencial y la clasificacion de errores ya estan resueltos ahi para
 * todo el backend, y con el SDK habria que reimplementarlos —o aceptar los
 * suyos, distintos de los que aplica el resto de los nodos.
 *
 * DEGRADACION A SIMULACION: sin `GEMINI_API_KEY` en el entorno, delega en
 * `MockLlmProvider` con un aviso en el log. No lanza. El motivo es que la
 * ausencia de la clave es un estado NORMAL del entorno de desarrollo, y un
 * backend que no pudiera ejecutar un flujo entero por eso obligaria a repartir
 * credenciales de pago para poder probar la topologia de un pipeline. La
 * respuesta lleva `isMock: true`, de modo que la degradacion queda registrada en
 * el namespace y es auditable: nadie puede confundirla con una redaccion real.
 */
@Injectable()
export class GeminiLlmProvider implements ILlmProviderClient {
  public readonly provider = LlmProvider.GEMINI;

  private readonly logger = new Logger(GeminiLlmProvider.name);

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
    const apiKey = this.configService.get<string>(GEMINI_API_KEY_VAR)?.trim();

    // Guarda de credencial. Antes de construir nada: sin clave no hay peticion
    // que preparar.
    if (apiKey === undefined || apiKey.length === 0) {
      this.logger.warn(
        `${GEMINI_API_KEY_VAR} no esta definida en el entorno. Se degrada a simulacion de coste cero; la salida llevara isMock: true.`,
      );

      return this.mockProvider.generateCompletion(
        prompt,
        systemPrompt,
        config,
        attachments,
      );
    }

    const model = config?.model ?? DEFAULT_GEMINI_MODEL;

    const outcome = await this.httpClient.request<GeminiApiResponse>(
      {
        url: `${GEMINI_API_BASE_URL}/${model}:generateContent`,
        method: 'POST',
        // La clave viaja en cabecera y NO como `?key=`: un query string acaba
        // en los logs de acceso de cualquier proxy que haya por el camino.
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        data: {
          contents: [
            { role: 'user', parts: this.buildParts(prompt, attachments) },
          ],
          // La instruccion del operador y el contrato de formato viajan
          // JUNTAS en `systemInstruction`, y el contrato va el ultimo para que
          // sea lo mas reciente que el modelo lee antes de responder.
          systemInstruction: {
            parts: [
              {
                text: this.buildSystemInstruction(
                  systemPrompt,
                  config?.expectsFilledMarkup ?? false,
                ),
              },
            ],
          },
          generationConfig: {
            // Se le pide JSON al propio modelo en lugar de rescatarlo de un
            // texto libre a base de expresiones regulares. Eso ultimo es un
            // parser de formato ad hoc, justo lo que `security-and-scope.md` §3
            // prohibe construir.
            responseMimeType: 'application/json',
            // Ambos se OMITEN cuando el nodo no los declara, en vez de
            // mandarse con un valor propio: el defecto de cada modelo lo
            // publica Google y cambia con el modelo, y fijarlo aqui seria
            // congelar hoy una decision que no es de este repositorio.
            ...(config?.temperature === undefined
              ? {}
              : { temperature: config.temperature }),
            ...(config?.maxTokens === undefined
              ? {}
              : { maxOutputTokens: config.maxTokens }),
            // El nombre de campo NO es `thinkingLevel` suelto ni
            // `thinking_level`: la API los rechaza con un 400 "Cannot find
            // field". La forma que acepta es este objeto anidado, comprobada
            // contra el endpoint real.
            ...(config?.thinkingLevel === undefined
              ? {}
              : {
                  thinkingConfig: {
                    thinkingLevel: this.resolveThinkingLevel(
                      config.thinkingLevel,
                      model,
                    ),
                  },
                }),
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
      throw new GeminiProviderException(
        `${outcome.failure.code}: ${outcome.failure.message}`,
        // El codigo viaja APARTE del mensaje: es lo que decide si conviene
        // probar con otro proveedor o si repetir seria gastar dos veces el
        // mismo error.
        outcome.failure.code,
      );
    }

    return this.toPayload(outcome.data, model, config?.maxTokens);
  }

  /**
   * Compone las partes del turno del usuario: el texto y, si los hay, los
   * adjuntos que el modelo debe mirar.
   *
   * `inline_data` con el base64 va en `snake_case` porque es el nombre del campo
   * en la API REST de Google, no una eleccion de este repositorio; el SDK lo
   * expone camelizado, pero aqui se habla REST directamente.
   *
   * El TEXTO va SIEMPRE primero, aunque venga vacio. El orden de las partes es
   * significativo para el modelo: la instruccion de que hacer con la imagen debe
   * leerse antes que la imagen, o el modelo la describe en vez de extraer lo que
   * se le pide.
   *
   * Sin adjuntos el cuerpo queda EXACTAMENTE como estaba —una sola parte de
   * texto—, de modo que el modo de siempre no cambia ni un byte.
   */
  private buildParts(
    prompt: string,
    attachments: readonly LlmInlineAttachment[],
  ): readonly Record<string, unknown>[] {
    return [
      { text: prompt },
      ...attachments.map((attachment) => ({
        inline_data: {
          mime_type: attachment.contentType,
          data: attachment.contentBase64,
        },
      })),
    ];
  }

  /**
   * Acota el nivel pedido a lo que el modelo concreto admite.
   *
   * Rebajar en vez de fallar: el nodo pidio "piensa lo menos posible", y en un
   * modelo que no conoce `minimal` lo mas cerca de eso es `low`. Fallar aqui
   * convertiria una preferencia de coste en un 400 que parece un error de
   * payload.
   */
  private resolveThinkingLevel(
    requested: LlmThinkingLevel,
    model: string,
  ): LlmThinkingLevel {
    if (requested !== 'minimal') {
      return requested;
    }

    const supportsMinimal = MODELS_SUPPORTING_MINIMAL_THINKING.some(
      (supported) => model.startsWith(supported),
    );

    return supportsMinimal ? requested : FALLBACK_THINKING_LEVEL;
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
    response: GeminiApiResponse,
    model: string,
    maxTokens?: number,
  ): LlmResponsePayload {
    const candidate = response.candidates?.[0];

    // El texto sale de TODAS las partes, no de `parts[0]`. Los modelos de
    // pensamiento anaden partes propias y una salida larga se trocea; quedarse
    // con la primera entregaba al parser un JSON cortado por la mitad.
    const rawText = (candidate?.content?.parts ?? [])
      .filter((part) => part.thought !== true)
      .map((part) => part.text ?? '')
      .join('');

    // ANTES de parsear: un corte por tope de tokens produce un JSON a medias, y
    // diagnosticarlo como contrato roto manda a revisar el prompt cuando lo que
    // falta es presupuesto. Se nombra el motivo y el tope vigente para que la
    // causa se lea en el log en vez de deducirse.
    const finishReason = candidate?.finishReason;

    if (
      finishReason !== undefined &&
      finishReason !== HEALTHY_FINISH_REASON &&
      rawText.trim().length > 0
    ) {
      throw new GeminiProviderException(
        `Gemini corto la respuesta (finishReason: ${finishReason}` +
          `${maxTokens === undefined ? '' : `, maxOutputTokens: ${maxTokens}`}` +
          `${
            response.usageMetadata?.thoughtsTokenCount === undefined
              ? ''
              : `, tokens de pensamiento: ${response.usageMetadata.thoughtsTokenCount}`
          }). ` +
          'Sube el tope de tokens del nodo o baja su nivel de pensamiento.',
        ERR_LLM_PROVIDER_TRUNCATED,
      );
    }

    if (rawText.trim().length === 0) {
      throw new GeminiProviderException(
        `Gemini devolvio una respuesta sin contenido generado (finishReason: ${
          finishReason ?? 'desconocido'
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
      // Condicional, igual que en Anthropic: sin la clave, el payload sigue
      // describiendo literalmente el contrato de tres claves.
      ...(filledMarkup === undefined ? {} : { filled_markup: filledMarkup }),
      metadata: {
        tokensPrompt: response.usageMetadata?.promptTokenCount ?? 0,
        tokensCompletion: response.usageMetadata?.candidatesTokenCount ?? 0,
        modelUsed: model,
        isMock: false,
      },
    };
  }

  /** `JSON.parse` con el fallo traducido al error del proveedor. */
  private parseContract(rawText: string): GeminiGeneratedContract {
    try {
      // El modelo a veces entrega el objeto envuelto en ```json ... ``` pese a
      // pedirsele JSON puro, y eso reventaba el parseo con un error que acusaba
      // al contrato en vez de a la envoltura.
      const parsed: unknown = JSON.parse(stripCodeFence(rawText));

      if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('el JSON recibido no es un objeto');
      }

      return parsed;
    } catch (error) {
      throw new GeminiProviderException(
        `Gemini devolvio un cuerpo que no respeta el contrato JSON: ${
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
   * `asText` colapsa los dos casos en `''`, correcto para un titular
   * obligatorio y justo lo contrario de lo que hace falta aqui: una cadena
   * vacia en `filled_markup` significa que el modelo no maqueto nada.
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
