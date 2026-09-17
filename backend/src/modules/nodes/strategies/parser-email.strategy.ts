import { Injectable, Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import {
  ParserEmailConfigDto,
  resolveParserEmailConfig,
} from '@modules/nodes/dto/parser-email-config.dto';
import { DEFAULT_ATTACHMENT_CONTENT_TYPE } from '@modules/nodes/interfaces/raw-email-attachment.interface';

import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import type {
  INodeStrategy,
  NodeErrorDetail,
  NodeResult,
} from '@core/fsm/types/node-strategy.types';
import type { ResolvedParserEmailConfig } from '@modules/nodes/dto/parser-email-config.dto';
import type { RawEmailAttachmentMetadata } from '@modules/nodes/interfaces/raw-email-attachment.interface';
import type { ValidatorOptions } from 'class-validator';

/** Codigos de fallo del nodo. Son lo que un `catchErrors` puede mencionar. */
export const ERR_PARSER_CONFIG = 'ERR_PARSER_CONFIG';
export const ERR_PARSER_SOURCE_MISSING = 'ERR_PARSER_SOURCE_MISSING';

/**
 * Opciones de validacion canonicas del repositorio (ver `PipelineValidatorService`).
 */
const VALIDATION_OPTIONS: ValidatorOptions = {
  whitelist: true,
  forbidNonWhitelisted: true,
};

/**
 * Tipos que un modelo con vision puede leer y un extractor de texto no.
 *
 * Las hojas de calculo y los CSV quedan FUERA a proposito: son texto que otro
 * nodo puede decodificar sin gastar un modelo multimodal, que es con diferencia
 * la llamada mas cara del pipeline.
 */
const MULTIMODAL_CONTENT_TYPE_PATTERN = /^(?:image\/|application\/pdf$)/;

/** Origen del cuerpo textual que el parser logro reunir. */
type BodySource = 'text' | 'html_pending_sanitize' | 'none';

/**
 * Payload determinista que el nodo expone en `parsed_email`.
 *
 * Todas las claves estan siempre presentes. `clean_body` es la unica que admite
 * `null`, y significa exactamente "no se extrajo texto"; conviene saber que
 * interpolar `{{parsed_email.clean_body}}` sobre ese `null` LANZA, igual que
 * sobre cualquier variable ausente. Quien monte una plantilla sobre este nodo
 * debe apoyarse en `body_source` para decidir.
 */
interface ParsedEmailPayload {
  readonly subject: string;
  readonly clean_body: string | null;
  readonly body_source: BodySource;
  readonly attachment_count: number;
  readonly attachments: readonly RawEmailAttachmentMetadata[];
  readonly requires_multimodal_fallback: boolean;
  readonly multimodal_reason: string;
}

/** Union discriminada: o hay configuracion, o hay un fallo que devolver. */
type ParserConfigResolution =
  | { readonly config: ResolvedParserEmailConfig }
  | { readonly failure: NodeErrorDetail };

/** Normaliza a cadena un valor de namespace de tipo desconocido. */
const asString = (value: unknown): string =>
  typeof value === 'string' ? value : '';

/**
 * Proyecta un elemento del inventario de adjuntos a sus metadatos.
 *
 * Trabaja sobre `unknown` porque lo que llega del contexto es
 * `Record<string, unknown>`: el namespace se rehidrata desde una columna jsonb y
 * nada garantiza su forma mas alla de lo que escribio el nodo anterior.
 */
const toAttachmentMetadata = (value: unknown): RawEmailAttachmentMetadata => {
  const record =
    typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : {};
  const size = record.size;

  return {
    filename: asString(record.filename),
    contentType:
      asString(record.contentType) || DEFAULT_ATTACHMENT_CONTENT_TYPE,
    size: typeof size === 'number' ? size : 0,
  };
};

/** Un adjunto que solo un modelo con vision puede interpretar. */
const isMultimodalCandidate = (
  attachment: RawEmailAttachmentMetadata,
): boolean => MULTIMODAL_CONTENT_TYPE_PATTERN.test(attachment.contentType);

/**
 * Nodo PARSER_PRE_IA: lee el correo crudo y decide si el pipeline puede seguir
 * con texto o necesita un modelo con vision.
 *
 * ESTA VERSION ES UN ESQUELETO. Hace inventario de adjuntos, reune el cuerpo
 * textual disponible y levanta `requires_multimodal_fallback`. Lo que todavia NO
 * hace es sanear el marcado: cuando el unico cuerpo es HTML, lo declara con
 * `body_source: 'html_pending_sanitize'` y deja `clean_body` a `null` en vez de
 * fingir un texto limpio. La rama de `cheerio` / `@mozilla/readability` rellenara
 * esa rama sin cambiar la forma del payload.
 *
 * NODO PURO: no escribe en el contexto ni toca namespaces ajenos. Devuelve
 * `data` y es `FsmEngineService` quien la deposita en el `outputNamespace`. En
 * particular NO libera el base64 de `raw_email`: esa es competencia exclusiva
 * del motor, que la aplica a cualquier nodo que produzca texto. El unico enlace
 * entre ambos es el nombre de la clave `clean_body`, que el motor reconoce como
 * senal de "ya hay texto"; el parser no sabe nada de la purga.
 *
 * TODOS los fallos son GRAVE: solo los GRAVE entran en la politica de reintentos
 * de `FsmEngineService.canRetry`, y tanto una configuracion mal escrita como un
 * namespace de origen ausente son corregibles por el operador con el flujo
 * PAUSADO (CU-09).
 */
@Injectable()
export class ParserEmailStrategy implements INodeStrategy {
  public readonly nodeType = NodeType.PARSER_PRE_IA;

  private readonly logger = new Logger(ParserEmailStrategy.name);

  public async execute(
    context: StatePayloadContext,
    params: Record<string, unknown>,
  ): Promise<NodeResult> {
    const resolution = await this.resolveConfig(params);

    if ('failure' in resolution) {
      return { success: false, error: resolution.failure };
    }

    const { config } = resolution;
    const source = context.getNamespace(config.sourceNamespace);

    // Guarda de precondicion: sin correo que leer no hay nada que decidir, y
    // continuar produciria un payload de ceros indistinguible de un correo vacio.
    if (source === undefined) {
      return {
        success: false,
        error: {
          level: 'GRAVE',
          code: ERR_PARSER_SOURCE_MISSING,
          message: `El namespace "${config.sourceNamespace}" no existe en el contexto: ningun nodo anterior lo ha escrito.`,
          missingFields: [config.sourceNamespace],
        },
      };
    }

    return { success: true, data: { ...this.toParsedEmail(source, config) } };
  }

  /**
   * Valida `params` y aplica los valores por defecto.
   *
   * Se usa `validate` y NO `validateOrReject`: esta ultima lanza, y el motor
   * normaliza toda excepcion a URGENTE, que `canRetry` nunca reintenta.
   */
  private async resolveConfig(
    params: Record<string, unknown>,
  ): Promise<ParserConfigResolution> {
    const dto = plainToInstance(ParserEmailConfigDto, params);
    const errors = await validate(dto, VALIDATION_OPTIONS);

    if (errors.length > 0) {
      const invalidFields = errors.map((error) => error.property);
      const constraints = errors.flatMap((error) =>
        Object.values(error.constraints ?? {}),
      );

      return {
        failure: {
          level: 'GRAVE',
          code: ERR_PARSER_CONFIG,
          message: `Configuracion invalida del nodo parser: ${constraints.join(' ')}`,
          missingFields: invalidFields,
        },
      };
    }

    return { config: resolveParserEmailConfig(dto) };
  }

  /** Proyecta el correo crudo al payload determinista de `parsed_email`. */
  private toParsedEmail(
    source: Record<string, unknown>,
    config: ResolvedParserEmailConfig,
  ): ParsedEmailPayload {
    const rawAttachments = source.attachments;
    const attachments = Array.isArray(rawAttachments)
      ? rawAttachments.map(toAttachmentMetadata)
      : [];

    const text = asString(source.text).trim();
    const html = asString(source.html);

    // El texto plano manda cuando existe. Si solo hay marcado, se declara
    // pendiente de sanear en vez de volcarlo crudo: entregar etiquetas como si
    // fueran prosa envenenaria el prompt del nodo de inferencia.
    const bodySource: BodySource =
      text.length > 0
        ? 'text'
        : html.length > 0
          ? 'html_pending_sanitize'
          : 'none';
    const cleanBody = bodySource === 'text' ? text : null;

    const multimodalCandidates = attachments.filter(isMultimodalCandidate);
    const bodyLength = cleanBody?.length ?? 0;

    // La bandera exige AMBAS condiciones. El AND es deliberado: un boletin con
    // el logo en PNG y cinco mil caracteres de texto no necesita vision, y
    // gastarla ahi seria la llamada mas cara del pipeline sin motivo. El caso
    // que si la merece es el contrario: un correo cuyo unico contenido real es
    // un PDF escaneado o una captura.
    const requiresMultimodal =
      multimodalCandidates.length > 0 && bodyLength < config.minBodyLength;

    if (requiresMultimodal) {
      this.logger.log(
        `Correo sin texto suficiente (${bodyLength} caracteres) con ${multimodalCandidates.length} adjunto(s) interpretable(s) por vision.`,
      );
    }

    return {
      subject: asString(source.subject),
      clean_body: cleanBody,
      body_source: bodySource,
      attachment_count: attachments.length,
      // Inventario SIN el base64: repetir los bytes en un segundo namespace
      // duplicaria los mismos megabytes dentro de la misma fila
      // `contexto_acumulado`, y ademas los reintroduciria despues de que el
      // motor los hubiese liberado de `raw_email`.
      attachments,
      requires_multimodal_fallback: requiresMultimodal,
      // Cadena vacia y nunca `null` cuando la bandera es `false`: un booleano
      // suelto en el checkpoint no explica nada seis horas despues.
      multimodal_reason: requiresMultimodal
        ? `Cuerpo de ${bodyLength} caracteres (umbral ${config.minBodyLength}) con ${multimodalCandidates.length} adjunto(s) de tipo imagen o PDF.`
        : '',
    };
  }
}
