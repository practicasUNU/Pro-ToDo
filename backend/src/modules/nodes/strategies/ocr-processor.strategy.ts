import { Injectable, Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { AiDefaultsConfig } from '@core/config/ai-defaults.config';
import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import {
  OcrProcessorConfigDto,
  PROMPT_OCR_MULTIMODAL,
  resolveOcrProcessorConfig,
} from '@modules/nodes/dto/ocr-processor-config.dto';
import { LlmProvider } from '@modules/nodes/strategies/interfaces/llm-provider.interface';
import { GeminiLlmProvider } from '@modules/nodes/strategies/providers/gemini-llm.provider';
import { MockLlmProvider } from '@modules/nodes/strategies/providers/mock-llm.provider';
import { MULTIMODAL_CONTENT_TYPE_PATTERN } from '@modules/nodes/utils/parsed-email-payload.util';

import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import type {
  INodeStrategy,
  NodeErrorDetail,
  NodeOutputField,
  NodeResult,
} from '@core/fsm/types/node-strategy.types';
import type { ResolvedOcrProcessorConfig } from '@modules/nodes/dto/ocr-processor-config.dto';
import type {
  ILlmProviderClient,
  LlmInlineAttachment,
  LlmResponsePayload,
} from '@modules/nodes/strategies/interfaces/llm-provider.interface';
import type { ValidatorOptions } from 'class-validator';

export const ERR_OCR_CONFIG = 'ERR_OCR_CONFIG';
export const ERR_OCR_NO_ATTACHMENTS = 'ERR_OCR_NO_ATTACHMENTS';
export const ERR_OCR_PROVIDER_FAILURE = 'ERR_OCR_PROVIDER_FAILURE';
export const ERR_OCR_EMPTY_TRANSCRIPTION = 'ERR_OCR_EMPTY_TRANSCRIPTION';

const VALIDATION_OPTIONS: ValidatorOptions = {
  whitelist: true,
  forbidNonWhitelisted: true,
};

const RAW_EMAIL_NAMESPACE = 'raw_email';
const ATTACHMENTS_KEY = 'attachments';

/**
 * Tope de adjuntos que viajan al modelo en una sola llamada.
 *
 * El mismo tres que usaba el modo vision del nodo de redaccion, y por la misma
 * razon: cada adjunto va en base64 dentro de la peticion, y un correo con quince
 * escaneos agotaria la ventana del modelo antes de transcribir ninguno.
 */
const MAX_OCR_ATTACHMENTS = 3;

/** Estado con el que el nodo declara que la transcripcion salio adelante. */
const OCR_STATUS_COMPLETED = 'COMPLETED';

/** Traza completa del error, si la hay, lista para fusionar en el detalle. */
const stackTraceOf = (error: unknown): { stackTrace?: string } =>
  error instanceof Error && error.stack !== undefined
    ? { stackTrace: error.stack }
    : {};

/** Union discriminada de la configuracion ya validada. */
type OcrConfigResolution =
  | { readonly config: ResolvedOcrProcessorConfig }
  | { readonly failure: NodeErrorDetail };

/**
 * Nodo PROCESADOR_OCR: transcribe los adjuntos de un correo sin texto util.
 *
 * Es un tipo APARTE de `PROCESADOR_IA` y no un modo suyo, aunque los dos hablen
 * con un modelo. Transcribir una imagen y redactar una noticia son trabajos
 * distintos: piden modelos distintos —el bueno redactando no tiene por que ser
 * el bueno, ni el barato, haciendo OCR—, prompts distintos y presupuestos
 * distintos. Fundirlos obligaba a un solo juego de `params` para ambos, y a que
 * el nodo adivinase cual de los dos papeles le tocaba mirando `error_context`.
 *
 * Su namespace propio (`ocr_result`) es lo que permite que la rama de
 * contingencia se AUTO-APROVISIONE: un segundo nodo de IA chocaria con el
 * primero en `llm_response`, que la regla 5 del validador declara de un solo
 * dueno.
 *
 * NO levanta `requires_multimodal_fallback`. Esa bandera es el veto que impide
 * al motor tirar los binarios, y aqui ya se han usado: en cuanto este nodo
 * publica un `clean_body` con texto suficiente, `releaseAttachmentBinaries`
 * libera los megabytes del correo sin que este nodo tenga que pedirlo (RNF-01).
 */
@Injectable()
export class OcrProcessorStrategy implements INodeStrategy {
  public readonly nodeType = NodeType.PROCESADOR_OCR;

  private readonly logger = new Logger(OcrProcessorStrategy.name);

  public readonly paramsSchema = OcrProcessorConfigDto;

  /**
   * Contrato de salida.
   *
   * `clean_body` repite deliberadamente el nombre que usa el parser: es el mismo
   * dato —el cuerpo aprovechable del correo— obtenido por otra via, y el motor
   * lo reconoce en `EXTRACTED_TEXT_KEYS` para decidir que los binarios sobran.
   * Llamarlo de otra forma habria obligado a ampliar ese vocabulario en `@core`.
   */
  public readonly outputFields: readonly NodeOutputField[] = [
    { name: 'clean_body', type: 'text' },
    { name: 'character_count', type: 'number' },
    { name: 'ocr_status', type: 'text' },
  ];

  constructor(
    private readonly mockProvider: MockLlmProvider,
    private readonly geminiProvider: GeminiLlmProvider,
    private readonly aiDefaults: AiDefaultsConfig,
  ) {}

  public async execute(
    context: StatePayloadContext,
    params: Record<string, unknown>,
  ): Promise<NodeResult> {
    const resolution = await this.resolveConfig(params);

    if ('failure' in resolution) {
      return { success: false, error: resolution.failure };
    }

    const attachments = this.collectAttachments(context);

    // Sin adjuntos legibles no hay nada que transcribir. Es GRAVE y no LEVE
    // porque a este nodo solo se llega por una ruta de contingencia: si el
    // rescate no puede hacerse, el correo se queda sin contenido y alguien tiene
    // que mirarlo.
    if (attachments.length === 0) {
      return {
        success: false,
        error: {
          level: 'GRAVE',
          code: ERR_OCR_NO_ATTACHMENTS,
          message:
            'El correo no trae adjuntos de imagen o PDF que transcribir. Comprueba que el disparador tenga activada la ingesta de adjuntos.',
          missingFields: [`${RAW_EMAIL_NAMESPACE}.${ATTACHMENTS_KEY}`],
        },
      };
    }

    const config = this.applyEnvironmentDefaults(resolution.config, params);
    const client = this.resolveProvider(config);

    let response: LlmResponsePayload;

    try {
      response = await client.generateCompletion(
        PROMPT_OCR_MULTIMODAL,
        undefined,
        {
          model: config.model,
          timeoutMs: config.timeoutMs,
          maxRetries: config.maxRetries,
          mode: 'ocr',
        },
        attachments,
      );
    } catch (error) {
      return {
        success: false,
        error: {
          level: 'GRAVE',
          code: ERR_OCR_PROVIDER_FAILURE,
          message: `El proveedor de OCR fallo: ${error instanceof Error ? error.message : String(error)}`,
          ...stackTraceOf(error),
        },
      };
    }

    const cleanBody = this.flattenTranscription(response);

    // Una transcripcion vacia NO se publica como exito: dejaria `clean_body` en
    // blanco, el motor no liberaria los binarios —no hay texto util— y el nodo
    // de redaccion recibiria un contexto que parece bueno y no lo es.
    if (cleanBody.length === 0) {
      return {
        success: false,
        error: {
          level: 'GRAVE',
          code: ERR_OCR_EMPTY_TRANSCRIPTION,
          message:
            'El modelo no devolvio texto para los adjuntos enviados. Puede que la imagen no contenga texto legible.',
        },
      };
    }

    this.logger.log(
      `Transcripcion completada sobre ${attachments.length} adjunto(s): ${cleanBody.length} caracteres.`,
    );

    return {
      success: true,
      data: {
        clean_body: cleanBody,
        // DERIVADO y no un literal: un numero escrito a mano se convierte en
        // mentira a la primera edicion del texto.
        character_count: cleanBody.length,
        ocr_status: OCR_STATUS_COMPLETED,
      },
    };
  }

  /**
   * Adjuntos que un modelo con vision puede leer.
   *
   * Se filtra POR TIPO ademas de por contenido: pedirle a un modelo que lea un
   * `.xlsx` no lo arregla, y pagarlo seria tirar el dinero. El base64 puede ser
   * `null` —el motor lo libero en un paso anterior, o el adjunto nunca se
   * ingirio— y entonces no hay nada que mirar.
   */
  private collectAttachments(
    context: StatePayloadContext,
  ): readonly LlmInlineAttachment[] {
    const rawAttachments =
      context.getNamespace(RAW_EMAIL_NAMESPACE)?.[ATTACHMENTS_KEY];

    if (!Array.isArray(rawAttachments)) {
      return [];
    }

    const collected: LlmInlineAttachment[] = [];

    for (const raw of rawAttachments) {
      if (collected.length >= MAX_OCR_ATTACHMENTS) {
        break;
      }

      const record =
        typeof raw === 'object' && raw !== null
          ? (raw as Record<string, unknown>)
          : {};
      const contentBase64 = record.contentBase64;
      const contentType = record.contentType;

      if (
        typeof contentBase64 !== 'string' ||
        contentBase64.length === 0 ||
        typeof contentType !== 'string' ||
        !MULTIMODAL_CONTENT_TYPE_PATTERN.test(contentType)
      ) {
        continue;
      }

      collected.push({
        filename:
          typeof record.filename === 'string' ? record.filename : 'adjunto',
        contentType,
        contentBase64,
      });
    }

    return collected;
  }

  /**
   * Aplana la respuesta del proveedor en el texto transcrito.
   *
   * El contrato `LlmResponsePayload` lo comparten todos los proveedores y esta
   * pensado para una REDACCION (titular, resumen, parrafos). Una transcripcion
   * no tiene titular, asi que se recompone desde los parrafos y se cae al
   * resumen cuando el proveedor no los desglosa.
   */
  private flattenTranscription(response: LlmResponsePayload): string {
    const paragraphs = response.body_paragraphs
      .filter((paragraph) => paragraph.trim().length > 0)
      .join('\n\n')
      .trim();

    return paragraphs.length > 0 ? paragraphs : response.summary.trim();
  }

  private async resolveConfig(
    params: Record<string, unknown>,
  ): Promise<OcrConfigResolution> {
    const dto = plainToInstance(OcrProcessorConfigDto, params);
    const errors = await validate(dto, VALIDATION_OPTIONS);

    if (errors.length > 0) {
      const constraints = errors.flatMap((error) =>
        Object.values(error.constraints ?? {}),
      );

      return {
        failure: {
          level: 'GRAVE',
          code: ERR_OCR_CONFIG,
          message: `Configuracion invalida del nodo OCR: ${constraints.join(' ')}`,
          missingFields: errors.map((error) => error.property),
        },
      };
    }

    return { config: resolveOcrProcessorConfig(dto) };
  }

  /**
   * Completa proveedor y modelo con el par de OCR del entorno.
   *
   * PRECEDENCIA, de mas fuerte a mas debil: los `params` del nodo, el par
   * `AI_OCR_DEFAULT_*` del `.env`, y las constantes del DTO. Se comprueba contra
   * los `params` CRUDOS y no contra el DTO resuelto porque este ultimo ya trae
   * los defaults aplicados, y entonces seria imposible distinguir "el operador
   * eligio este modelo" de "nadie eligio nada".
   */
  private applyEnvironmentDefaults(
    config: ResolvedOcrProcessorConfig,
    params: Record<string, unknown>,
  ): ResolvedOcrProcessorConfig {
    const declaresProvider = this.declaresParam(params.provider);
    const declaresModel = this.declaresParam(params.model);

    // Con las dos cosas declaradas no hay nada que completar, y ni siquiera se
    // lee el entorno.
    if (declaresProvider && declaresModel) {
      return config;
    }

    const defaults = this.aiDefaults.getOcrDefaults();
    const envProvider = this.toProvider(defaults.provider);

    return {
      ...config,
      provider: declaresProvider
        ? config.provider
        : (envProvider ?? config.provider),
      model: declaresModel ? config.model : (defaults.model ?? config.model),
    };
  }

  /** Un `param` cuenta como declarado solo si trae contenido real. */
  private declaresParam(value: unknown): boolean {
    return typeof value === 'string' && value.trim().length > 0;
  }

  /** Cadena del entorno a valor del enum, o `null` si no corresponde a ninguno. */
  private toProvider(value: string | null): LlmProvider | null {
    if (value === null) {
      return null;
    }

    return Object.values(LlmProvider).includes(value as LlmProvider)
      ? (value as LlmProvider)
      : null;
  }

  /**
   * Cliente del proveedor. Siempre devuelve uno.
   *
   * Un proveedor sin implementar DEGRADA al simulador con un aviso en vez de
   * fallar: el flujo sigue y la salida queda marcada con `isMock`, que es mas
   * util que un nodo caido por una variable de entorno mal escrita.
   */
  private resolveProvider(
    config: ResolvedOcrProcessorConfig,
  ): ILlmProviderClient {
    if (config.dryRun || config.provider === LlmProvider.MOCK) {
      return this.mockProvider;
    }

    if (config.provider === LlmProvider.GEMINI) {
      return this.geminiProvider;
    }

    this.logger.warn(
      `El proveedor "${config.provider}" todavia no tiene cliente implementado. Se degrada a simulacion de coste cero; la salida llevara isMock: true.`,
    );

    return this.mockProvider;
  }
}
