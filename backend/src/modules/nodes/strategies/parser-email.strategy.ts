import { Injectable, Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import {
  ParserEmailConfigDto,
  resolveParserEmailConfig,
} from '@modules/nodes/dto/parser-email-config.dto';
import { DEFAULT_ATTACHMENT_CONTENT_TYPE } from '@modules/nodes/interfaces/raw-email-attachment.interface';
import {
  cleanSubject,
  reductionPercentage,
  sanitizeEmailHtml,
  sanitizeEmailText,
} from '@modules/nodes/utils/email-sanitizer.util';

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

/**
 * Origen del cuerpo textual que el parser saneo.
 *
 * NOTA DE COMPATIBILIDAD: hasta el saneador existio un cuarto valor,
 * `'html_pending_sanitize'`, que declaraba marcado sin procesar. Ya no se emite,
 * pero las filas antiguas de `ejecuciones_flujo.contexto_acumulado` pueden
 * contenerlo. Cualquier lector que ramifique sobre esta clave debe tolerar
 * valores fuera de la union.
 */
type BodySource = 'text' | 'html' | 'none';

/**
 * Payload determinista que el nodo expone en `parsed_email`.
 *
 * Todas las claves estan siempre presentes y con su tipo. `clean_body` es
 * SIEMPRE una cadena: la cadena vacia, junto a `body_source: 'none'`, es la
 * forma honesta de decir "este correo no traia texto". Que ya no sea `null` no
 * es cosmetico —interpolar `{{parsed_email.clean_body}}` sobre un `null` lanzaba
 * igual que sobre una variable ausente, mientras que una cadena vacia no lanza—,
 * de modo que las plantillas montadas sobre este nodo pasan a ser seguras por
 * construccion. Aun asi, quien quiera ramificar deberia apoyarse en
 * `body_source`, que es la clave que explica POR QUE el cuerpo esta como esta.
 *
 * El ORDEN de las claves es parte del contrato: la prueba 1.1 lo compara
 * posicionalmente.
 */
interface ParsedEmailPayload {
  readonly subject: string;
  readonly clean_title: string;
  readonly clean_body: string;
  readonly body_source: BodySource;
  readonly character_count: number;
  readonly original_character_count: number;
  readonly reduction_percentage: number;
  readonly extracted_urls: readonly string[];
  readonly attachment_count: number;
  readonly attachments: readonly RawEmailAttachmentMetadata[];
  readonly requires_multimodal_fallback: boolean;
  readonly multimodal_reason: string;
}

/** Cuerpo ya saneado junto a todo lo que se deriva de la fuente elegida. */
interface ExtractedBody {
  readonly source: BodySource;
  readonly clean: string;
  readonly urls: readonly string[];
  /** Longitud de la fuente CONSUMIDA, no del correo entero. Ver `toParsedEmail`. */
  readonly originalLength: number;
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
 * Nodo PARSER_PRE_IA: sanea el correo crudo, extrae sus enlaces de contenido y
 * decide si el pipeline puede seguir con texto o necesita un modelo con vision.
 *
 * Su razon de existir es la ECONOMIA DE TOKENS (RNF-01): el `PROCESADOR_IA` no
 * debe pagar por etiquetas, hojas de estilo, hilos citados, firmas ni avisos
 * legales. Toda la maquinaria de limpieza vive en
 * `@modules/nodes/utils/email-sanitizer.util`, que son funciones puras; aqui
 * queda solo la composicion y el contrato del nodo.
 *
 * NODO PURO: no escribe en el contexto ni toca namespaces ajenos. Devuelve
 * `data` y es `FsmEngineService` quien la deposita en el `outputNamespace`. En
 * particular NO libera el base64 de `raw_email`: esa es competencia exclusiva
 * del motor. El unico enlace entre ambos son dos nombres de clave que el motor
 * reconoce —`clean_body`, que declara "ya hay texto", y
 * `requires_multimodal_fallback`, que veta la liberacion porque el binario sigue
 * siendo la unica fuente de datos—; el parser no sabe nada de la purga.
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

  /**
   * Resuelve la cascada texto -> marcado -> nada y devuelve todo lo derivado.
   *
   * El texto plano manda cuando existe: ya es texto, y saltarse el DOM ahorra la
   * operacion mas cara del nodo. El marcado es el plan B del
   * `multipart/alternative` sin parte `text/plain`, que es justamente el caso
   * habitual de un boletin institucional.
   *
   * En la ruta de texto plano `urls` queda VACIO a proposito. Rescatar enlaces
   * con un `https?://\S+` es posible, pero el texto plano de un correo parte las
   * URLs con saltos de linea a 78 columnas (RFC 5322) y produciria direcciones
   * truncadas que `EXTRACTOR_WEB` intentaria descargar y fallaria. Un arreglo
   * vacio y honesto es mejor que una lista de enlaces rotos.
   */
  private extractBody(text: string, html: string): ExtractedBody {
    if (text.trim().length > 0) {
      return {
        source: 'text',
        clean: sanitizeEmailText(text),
        urls: [],
        originalLength: text.length,
      };
    }

    if (html.trim().length > 0) {
      try {
        const sanitized = sanitizeEmailHtml(html);

        return {
          source: 'html',
          clean: sanitized.text,
          urls: sanitized.urls,
          originalLength: html.length,
        };
      } catch (error) {
        // Degradacion, no fallo. El motor normaliza toda excepcion a URGENTE,
        // que `canRetry` nunca reintenta y que deja el flujo FALLIDO: un correo
        // con marcado patologico no puede llevarse por delante la ejecucion
        // entera. El inventario de adjuntos y la decision multimodal siguen
        // siendo utiles sin cuerpo.
        const reason = error instanceof Error ? error.message : String(error);

        this.logger.warn(
          `No se pudo sanear el marcado del correo: ${reason}. Se continua sin cuerpo.`,
        );
      }
    }

    return { source: 'none', clean: '', urls: [], originalLength: 0 };
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

    const subject = asString(source.subject);
    const body = this.extractBody(asString(source.text), asString(source.html));

    const multimodalCandidates = attachments.filter(isMultimodalCandidate);
    const bodyLength = body.clean.length;

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
      subject,
      // El asunto crudo se conserva ADEMAS del limpio: la traza forense necesita
      // poder reconstruir que llego, y una plantilla que quiera el literal lo
      // tiene. Son dos datos distintos, no uno normalizado.
      clean_title: cleanSubject(subject),
      clean_body: body.clean,
      body_source: body.source,
      character_count: bodyLength,
      // La longitud de la FUENTE CONSUMIDA, no la del correo entero. La pareja
      // (original, final) tiene que ser la entrada y la salida de la MISMA
      // transformacion: medir siempre contra `html` daria una division por cero
      // en un correo text/plain puro, y medir siempre contra `text` daria 0% en
      // la ruta HTML, que es justo donde la reduccion es del 80-95% y donde
      // RNF-01 tiene algo que medir.
      original_character_count: body.originalLength,
      reduction_percentage: reductionPercentage(
        body.originalLength,
        bodyLength,
      ),
      extracted_urls: body.urls,
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
