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
export const GEMINI_API_KEY_VAR = 'GEMINI_API_KEY';

/** Raiz de la API REST de Google Generative Language. */
export const GEMINI_API_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Instruccion de formato que se antepone al prompt del operador.
 *
 * Va aqui y no en la plantilla de `plantillas_prompts_ia` porque describe el
 * CONTRATO TECNICO de salida, no la intencion editorial. Si viviera en la
 * plantilla, cada prompt que alguien escribiera tendria que acordarse de
 * repetirla, y el primero que la olvidase rompería el nodo.
 */
const RESPONSE_CONTRACT_INSTRUCTION = [
  'Responde EXCLUSIVAMENTE con un objeto JSON valido, sin texto adicional',
  'ni marcas de bloque de codigo, con exactamente estas claves:',
  '"headline" (string), "summary" (string) y "body_paragraphs" (array de strings).',
].join(' ');

/** Forma parcial de la respuesta de Gemini que este cliente consume. */
interface GeminiApiResponse {
  readonly candidates?: readonly {
    readonly content?: {
      readonly parts?: readonly { readonly text?: string }[];
    };
  }[];
  readonly usageMetadata?: {
    readonly promptTokenCount?: number;
    readonly candidatesTokenCount?: number;
  };
}

/** Contrato formal tal y como lo redacta el modelo, antes de completarlo. */
interface GeminiGeneratedContract {
  readonly headline?: unknown;
  readonly summary?: unknown;
  readonly body_paragraphs?: unknown;
}

/** Error del proveedor. Lo captura la estrategia para mover el freno. */
export class GeminiProviderException extends Error {
  constructor(message: string) {
    super(message);
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

    const model = config?.model ?? 'gemini-1.5-flash';

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
            parts: [{ text: this.buildSystemInstruction(systemPrompt) }],
          },
          generationConfig: {
            // Se le pide JSON al propio modelo en lugar de rescatarlo de un
            // texto libre a base de expresiones regulares. Eso ultimo es un
            // parser de formato ad hoc, justo lo que `security-and-scope.md` §3
            // prohibe construir.
            responseMimeType: 'application/json',
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
      );
    }

    return this.toPayload(outcome.data, model);
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

  /** Une la instruccion del operador con el contrato de formato obligatorio. */
  private buildSystemInstruction(systemPrompt?: string): string {
    const operatorInstruction = systemPrompt?.trim() ?? '';

    return operatorInstruction.length === 0
      ? RESPONSE_CONTRACT_INSTRUCTION
      : `${operatorInstruction}\n\n${RESPONSE_CONTRACT_INSTRUCTION}`;
  }

  /** Extrae el contrato formal de la respuesta cruda de la API. */
  private toPayload(
    response: GeminiApiResponse,
    model: string,
  ): LlmResponsePayload {
    const rawText = response.candidates?.[0]?.content?.parts?.[0]?.text;

    if (rawText === undefined || rawText.trim().length === 0) {
      throw new GeminiProviderException(
        'Gemini devolvio una respuesta sin contenido generado.',
      );
    }

    const generated = this.parseContract(rawText);

    return {
      headline: this.asText(generated.headline),
      summary: this.asText(generated.summary),
      body_paragraphs: this.asParagraphs(generated.body_paragraphs),
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
      const parsed: unknown = JSON.parse(rawText);

      if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('el JSON recibido no es un objeto');
      }

      return parsed;
    } catch (error) {
      throw new GeminiProviderException(
        `Gemini devolvio un cuerpo que no respeta el contrato JSON: ${
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
