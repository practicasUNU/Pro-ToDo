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
import {
  LlmProvider,
  LlmProviderException,
} from '@modules/nodes/strategies/interfaces/llm-provider.interface';
import {
  buildProviderAttempts,
  isFallbackWorthy,
} from '@modules/nodes/strategies/provider-fallback';
import { LlmProviderFactory } from '@modules/nodes/strategies/llm-provider.factory';
import { MockLlmProvider } from '@modules/nodes/strategies/providers/mock-llm.provider';
import { LlmProviderCatalogService } from '@modules/nodes/services/llm-provider-catalog.service';
import { MULTIMODAL_CONTENT_TYPE_PATTERN } from '@modules/nodes/utils/parsed-email-payload.util';
import { stripCodeFence } from '@modules/nodes/utils/code-fence.util';

import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import type {
  INodeStrategy,
  NodeErrorDetail,
  NodeOutputField,
  NodeResult,
} from '@core/fsm/types/node-strategy.types';
import type { ResolvedOcrProcessorConfig } from '@modules/nodes/dto/ocr-processor-config.dto';
import type { ProviderAttempt } from '@modules/nodes/strategies/provider-fallback';
import type {
  ILlmProviderClient,
  LlmInlineAttachment,
  LlmResponsePayload,
} from '@modules/nodes/strategies/interfaces/llm-provider.interface';
import type { ValidatorOptions } from 'class-validator';

export const ERR_OCR_CONFIG = 'ERR_OCR_CONFIG';
export const ERR_OCR_NO_ATTACHMENTS = 'ERR_OCR_NO_ATTACHMENTS';
/**
 * RETIRADO como salida de la estrategia: lo sustituye
 * `ERR_OCR_MAX_RETRIES_EXCEEDED`. Se conserva exportado porque un `catchErrors`
 * de un esquema ya guardado puede nombrarlo, pero este nodo ya no lo emite.
 */
export const ERR_OCR_PROVIDER_FAILURE = 'ERR_OCR_PROVIDER_FAILURE';

/**
 * El nodo agoto su presupuesto de reintentos de transcripcion.
 *
 * Viaja con `metadata.exhausted`, de modo que el motor no suma los suyos: al
 * llegar aqui ya corrieron los reintentos del transporte HTTP y la cascada de
 * proveedores entera.
 */
export const ERR_OCR_MAX_RETRIES_EXCEEDED = 'ERR_OCR_MAX_RETRIES_EXCEEDED';
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

/** Fila de tabla GFM: una linea que empieza por `|`. */
const TABLE_ROW_PATTERN = /^\s*\|/;

/** Ultima linea no vacia de un bloque, para decidir como unirlo con el siguiente. */
const lastLineOf = (text: string): string => {
  const lines = text.split('\n');

  return lines[lines.length - 1] ?? '';
};

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
 * publica un `extracted_text` con texto suficiente, `releaseAttachmentBinaries`
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
   * dato —el cuerpo aprovechable del correo— obtenido por otra via, y asi lo
   * leen aguas abajo el `PROCESADOR_IA` y quien interpole `ocr_result.clean_body`.
   *
   * `extracted_text` ES ESE MISMO TEXTO, repetido a proposito. Es la clave con
   * la que el motor reconoce que el texto SALIO DE UN ADJUNTO, y hace falta
   * justo porque `clean_body` ya no vale para eso: el parser publica uno con el
   * cuerpo del correo sin haber tocado los adjuntos, de modo que por nombre de
   * clave los dos casos eran indistinguibles y la purga se disparaba de mas.
   * Duplicar el valor es el precio de que `@core` siga decidiendo por
   * vocabulario de claves y no por tipo de nodo (ver `EXTRACTED_TEXT_KEYS`).
   */
  public readonly outputFields: readonly NodeOutputField[] = [
    { name: 'clean_body', type: 'text' },
    {
      name: 'extracted_text',
      type: 'text',
      description:
        'La transcripcion, repetida bajo la clave que libera los binarios',
    },
    { name: 'character_count', type: 'number' },
    { name: 'ocr_status', type: 'text' },
    {
      name: 'metadata',
      type: 'object',
      description: 'Proveedor, modelo, tokens consumidos y marca isMock',
    },
  ];

  constructor(
    private readonly mockProvider: MockLlmProvider,
    private readonly providerFactory: LlmProviderFactory,
    private readonly aiDefaults: AiDefaultsConfig,
    private readonly providerCatalog: LlmProviderCatalogService,
  ) {}

  public async execute(
    context: StatePayloadContext,
    params: Record<string, unknown>,
  ): Promise<NodeResult> {
    const resolution = await this.resolveConfig(params);

    if ('failure' in resolution) {
      return { success: false, error: resolution.failure };
    }

    const attachments = this.collectAttachments(
      context,
      resolution.config.allowedMimeTypes,
    );

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
    const attempts = this.resolveAttempts(config);

    let response: LlmResponsePayload | undefined;
    let usedProvider = config.provider;
    let usedModel = config.model;
    let lastError: unknown;

    // Bucle de RESILIENCIA ACTIVA. Hasta ahora la cascada se decidia una sola
    // vez antes de llamar, mirando si existia la variable de entorno: un
    // proveedor saturado tiene su credencial perfectamente puesta, asi que un
    // 429 de cuota tumbaba el nodo con una alternativa viva al lado.
    for (const [index, attempt] of attempts.entries()) {
      try {
        response = await this.resolveClient(
          attempt.provider,
          config.dryRun,
        ).generateCompletion(
          PROMPT_OCR_MULTIMODAL,
          undefined,
          {
            model: attempt.model,
            timeoutMs: config.timeoutMs,
            maxRetries: config.maxRetries,
            baseDelayMs: config.baseDelayMs,
            // La temperatura se resolvia y se tiraba hasta PROT-22: el nodo
            // declaraba 0.1 para transcribir con fidelidad y la llamada corria
            // con el defecto del modelo.
            temperature: config.temperature,
            maxTokens: config.maxTokens,
            // Transcribir no es deliberar: se quiere fidelidad a lo que pone en
            // el documento, no razonamiento. Y en Gemini 3.x lo que el modelo
            // piensa sale del mismo presupuesto que lo que escribe, asi que
            // cada token deliberado es texto que no se transcribe.
            thinkingLevel: 'minimal',
            mode: 'ocr',
          },
          attachments,
        );

        usedProvider = attempt.provider;
        usedModel = attempt.model;
        break;
      } catch (error) {
        lastError = error;

        const code =
          error instanceof LlmProviderException ? error.code : undefined;
        const next = attempts[index + 1];

        // Se rinde ante un fallo que otro proveedor repetiria igual —un payload
        // invalido, una credencial mala— y cuando ya no queda a quien recurrir.
        if (!isFallbackWorthy(code) || next === undefined) {
          return this.providerFailure(error, config);
        }

        this.logger.warn(
          `${attempt.provider} no pudo atender la transcripcion (${code}): ` +
            `se reintenta con ${next.provider} y ${next.model}.`,
        );
      }
    }

    // Defensivo: el bucle solo sale por `break` o por `return`. Si la lista de
    // intentos llegase vacia, rendirse es mejor que publicar un exito sin texto.
    if (response === undefined) {
      return this.providerFailure(lastError, config);
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
        // El mismo texto bajo la clave que el motor lee para liberar los
        // binarios del correo. Ver el TSDoc de `outputFields`.
        extracted_text: cleanBody,
        // DERIVADO y no un literal: un numero escrito a mano se convierte en
        // mentira a la primera edicion del texto.
        character_count: cleanBody.length,
        ocr_status: OCR_STATUS_COMPLETED,
        // `metadata` SE PUBLICA, y `isMock` es el motivo. Hasta PROT-22 este
        // nodo descartaba la metadata del proveedor, asi que una transcripcion
        // SIMULADA era indistinguible de una real para todo lo que viniera
        // despues: la noticia salia publicada con texto inventado y nada en el
        // contexto permitia auditarlo. El nodo de redaccion ya lo publicaba.
        metadata: {
          provider: usedProvider,
          model: response.metadata.modelUsed,
          tokensPrompt: response.metadata.tokensPrompt,
          tokensCompletion: response.metadata.tokensCompletion,
          isMock: response.metadata.isMock,
          // Solo cuando respondio OTRO: una transcripcion pagada en Anthropic
          // seria indistinguible de una gratuita en Gemini al auditar, que es
          // el mismo motivo por el que existe `isMock`.
          ...(usedProvider === config.provider
            ? {}
            : { fallbackFrom: config.provider, fallbackModel: usedModel }),
        },
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
    allowedMimeTypes: readonly string[],
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

      // DOS filtros, y el orden no es casual. El patron es el techo —lo que un
      // modelo multimodal sabe mirar— y la lista del nodo solo puede RECORTAR
      // dentro de el. Al reves, declarar `text/csv` en los params colaria un
      // adjunto que el proveedor rechazaria con un error que nadie sabria leer.
      if (
        typeof contentBase64 !== 'string' ||
        contentBase64.length === 0 ||
        typeof contentType !== 'string' ||
        !MULTIMODAL_CONTENT_TYPE_PATTERN.test(contentType) ||
        !allowedMimeTypes.includes(contentType)
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
   *
   * LA UNION ES CONSCIENTE DE TABLAS, y de ahi depende que el nodo sirva para
   * algo con un documento tabulado. El prompt pide la transcripcion entera en
   * un unico elemento, pero si el modelo la trocea por filas —una lectura
   * natural de "array de strings"— unirlas con la linea en blanco de siempre
   * rompe la tabla: el separador `|---|` deja de tocar las filas y GFM ya no la
   * reconoce. Cuando cualquiera de los dos lados de la costura es una fila de
   * tabla se usa un salto simple. Es una comparacion de prefijo literal, no un
   * parser de Markdown: construir uno seria exactamente lo que
   * `security-and-scope.md` §3 prohibe.
   *
   * EL SANEAMIENTO VA POR ELEMENTO ADEMAS DE AL FINAL. Con la salida troceada,
   * la valla de apertura puede venir en el primer fragmento y la de cierre en
   * el ultimo; limpiar solo la cadena ya unida acertaria unicamente cuando el
   * arreglo trae un elemento.
   */
  private flattenTranscription(response: LlmResponsePayload): string {
    const blocks = response.body_paragraphs
      .map((paragraph) => stripCodeFence(paragraph))
      .filter((paragraph) => paragraph.length > 0);

    const joined = blocks.reduce((accumulated, block, index) => {
      if (index === 0) {
        return block;
      }

      const separator =
        TABLE_ROW_PATTERN.test(lastLineOf(accumulated)) ||
        TABLE_ROW_PATTERN.test(block)
          ? '\n'
          : '\n\n';

      return `${accumulated}${separator}${block}`;
    }, '');

    const transcription = stripCodeFence(joined);

    return transcription.length > 0
      ? transcription
      : stripCodeFence(response.summary);
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

    return {
      config: resolveOcrProcessorConfig(
        dto,
        this.aiDefaults.getOcrHttpDefaults(),
      ),
    };
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
   *
   * Delega en `LlmProviderFactory` desde PROT-21. Antes repetia el mapeo a
   * mano y se habia quedado atras: no conocia `ANTHROPIC`, asi que un OCR
   * configurado con Claude degradaba al simulador aunque el cliente existiera
   * desde PROT-20, y lo hacia por la misma via que un proveedor inexistente —
   * indistinguible en el log. La guarda de `dryRun` se queda aqui porque es
   * una decision de este nodo, no del proveedor.
   */
  /**
   * Proveedores a los que llamar, en orden.
   *
   * Cubre las DOS razones por las que un proveedor se descarta, que antes
   * vivian en sitios distintos: la credencial ausente —conocida antes de
   * llamar— y el servicio saturado o caido, que solo se descubre llamando.
   *
   * Simular no es un fallo del que haya que recuperarse, asi que `dryRun` y
   * `MOCK` producen un unico intento. Y si no queda ningun proveedor usable, se
   * conserva el intento configurado para que `resolveClient` degrade al
   * simulador como siempre: que un entorno SIN NINGUNA clave siga transcribiendo
   * (marcado con `isMock`) es el comportamiento de PROT-22 y no cambia aqui. Lo
   * que no puede pasar es que el simulador recoja un fallo de EJECUCION, porque
   * entonces publicaria texto inventado tapando una incidencia real.
   */
  private resolveAttempts(
    config: ResolvedOcrProcessorConfig,
  ): readonly ProviderAttempt[] {
    const configured: ProviderAttempt = {
      provider: config.provider,
      model: config.model,
    };

    if (config.dryRun || config.provider === LlmProvider.MOCK) {
      return [configured];
    }

    const attempts = buildProviderAttempts(configured, (provider) =>
      this.providerCatalog.isProviderUsable(provider),
    );

    if (attempts.length === 0) {
      this.logger.warn(
        `Ningun proveedor usable para la transcripcion (configurado: ${config.provider}). ` +
          'Respondera el simulador y la salida ira marcada con isMock. ' +
          'Revisa las claves del .env si no era lo esperado.',
      );

      return [configured];
    }

    return attempts;
  }

  private resolveClient(
    provider: LlmProvider,
    dryRun: boolean,
  ): ILlmProviderClient {
    if (dryRun || provider === LlmProvider.MOCK) {
      return this.mockProvider;
    }

    return this.providerFactory.getClient(provider);
  }

  /**
   * Mismo `NodeResult` de siempre, ahora desde dos sitios del bucle.
   *
   * Se declara `exhausted` porque los dos sitios que lo invocan son finales: o
   * el fallo no lo arregla otro proveedor, o ya no queda ninguno al que
   * recurrir. Sin esa marca el motor reintentaria el nodo entero por su cuenta
   * —GRAVE es la severidad que `canRetry` acepta— y cada vuelta repetiria la
   * cascada completa contra los mismos proveedores caidos.
   */
  private providerFailure(
    error: unknown,
    config: ResolvedOcrProcessorConfig,
  ): NodeResult {
    const description = error instanceof Error ? error.message : String(error);

    return {
      success: false,
      error: {
        level: 'GRAVE',
        code: ERR_OCR_MAX_RETRIES_EXCEEDED,
        message: `Transcripcion fallida tras agotar ${config.maxRetries} reintentos`,
        description: `Se realizaron ${config.maxRetries} reintentos contra el modelo ${config.model} del proveedor ${config.provider}. Causa raiz: ${description}`,
        metadata: {
          attempts: config.maxRetries,
          maxRetries: config.maxRetries,
          exhausted: true,
          lastError: description,
        },
        ...stackTraceOf(error),
      },
    };
  }
}
