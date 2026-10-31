import { Injectable } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { DrupalApiConfig } from '@core/config/drupal-api.config';
import {
  INTERPOLATION_PATTERN,
  MissingContextVariableException,
  extractNamespaceRoots,
} from '@core/fsm/context/state-payload.context';
import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { HttpClientService } from '@core/http/http-client.service';

import { BaseHttpDestinationStrategy } from './base/base-http-destination.strategy';
import {
  planPanelDispatch,
  resolvePanelContainer,
} from './drupal-universities';
import { selectVisibleTarget } from '../utils/visible-target.util';
import {
  expedienteSelector,
  readExpediente,
  selectorPinsExpediente,
  wrapTenderBlock,
} from '../utils/tender-block.util';
import {
  escapeSelectorString,
  isSafeLinkValue,
  replaceLinkAttribute,
} from '../utils/link-attribute.util';

import {
  DRUPAL_NEWS_BUNDLE,
  DRUPAL_NEWS_TAXONOMY_TYPES,
  DrupalHttpConfigDto,
  DrupalOperationMode,
  resolveDrupalHttpConfig,
} from '../dto/drupal-http-config.dto';

import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import type {
  NodeErrorDetail,
  NodeOutputField,
  NodeResult,
} from '@core/fsm/types/node-strategy.types';
import type { HttpClientStatusOutcome } from '@core/http/http-client.service';
import type { PanelDispatch } from './drupal-universities';
import type { ResolvedDrupalHttpConfig } from '../dto/drupal-http-config.dto';
import type { Cheerio, CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { ValidatorOptions } from 'class-validator';

/**
 * Codigos de fallo del nodo.
 *
 * Viven junto a la estrategia y no en `@core` por el motivo escrito en
 * `node-strategy.types.ts`: el motor no debe conocerlos, y centralizarlos
 * obligaria a tocar el nucleo cada vez que se anade un nodo.
 *
 * Se separan en siete pese a compartir TODOS el mismo nivel, y eso no los hace
 * redundantes: lo que enruta un `onErrorStep` selectivo es el `code`, no el
 * `level`, y cada uno manda al operador a un sitio distinto —`AUTH` al `.env`,
 * `DOM_TARGET` al selector del nodo, `MISSING_PAYLOAD` al paso de delante,
 * `SERVER` a esperar—. Fundirlos impediria para siempre distinguirlos.
 */
export const ERR_DRUPAL_CONFIG = 'ERR_DRUPAL_CONFIG';
export const ERR_DRUPAL_MISSING_PAYLOAD = 'ERR_DRUPAL_MISSING_PAYLOAD';
export const ERR_DRUPAL_AUTH = 'ERR_DRUPAL_AUTH';
export const ERR_DRUPAL_REQUEST = 'ERR_DRUPAL_REQUEST';
export const ERR_DRUPAL_SERVER = 'ERR_DRUPAL_SERVER';
export const ERR_DRUPAL_DOM_TARGET = 'ERR_DRUPAL_DOM_TARGET';
export const ERR_DRUPAL_NETWORK = 'ERR_DRUPAL_NETWORK';

/** Las mismas que aplica `PipelineValidatorService` al guardar el esquema. */
const VALIDATION_OPTIONS: ValidatorOptions = {
  whitelist: true,
  forbidNonWhitelisted: true,
};

/**
 * Valor de `operation_applied` cuando el traslado quedo a medias.
 *
 * Es un valor DISTINTO del modo y no un matiz del mensaje: permite a un
 * `onErrorStep` —o a una consulta de trazabilidad— ramificar sobre el estado
 * real sin parsear texto libre. Significa exactamente «el bloque ya esta en la
 * pagina de destino, pero no se pudo retirar de la de origen».
 */
export const TRANSFER_PARTIAL_OPERATION = 'TRANSFER_HTML_BLOCK_PARTIAL';

/** Texto neutro de un campo que este modo no puede rellenar. */
const NEUTRAL_TEXT = '';

/** Drupal numera los nodos desde 1, asi que un 0 no se confunde con un nid. */
const NEUTRAL_NID = 0;

/** «No hubo respuesta HTTP que clasificar». */
const NEUTRAL_STATUS = 0;

/** Dia ISO al principio de un valor: `2026-10-29` o `2026-10-29T08:00:00Z`. */
const ISO_DAY_PATTERN =
  /^(\d{4}-\d{2}-\d{2})(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** Primera letra en mayuscula, para abrir un mensaje con un fragmento. */
const capitalize = (text: string): string =>
  text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Coincidencias de un selector, o `null` si cheerio no sabe leerlo.
 *
 * Un selector invalido LANZA, y una excepcion que sale de la estrategia la
 * normaliza el motor a URGENTE, que no se reintenta nunca.
 */
const querySelectorSafely = (
  $: CheerioAPI,
  selector: string,
): Cheerio<AnyNode> | null => {
  try {
    return $(selector);
  } catch {
    return null;
  }
};

/** Texto recortado, o `null` si no hay texto: Drupal guarda `null`, no `""`. */
const emptyToNull = (value: string | null): string | null => {
  const trimmed = value?.trim() ?? '';

  return trimmed.length === 0 ? null : trimmed;
};

/** Campos del payload, antes de pasar por el constructor que fija la paridad. */
interface DrupalResultFields {
  readonly nodeId?: string;
  readonly internalNid?: number;
  readonly pathAlias?: string;
  readonly operationApplied?: string;
  readonly httpStatus?: number;
  readonly publishedAt?: string;
  readonly attachmentUrl?: string;
}

/**
 * Forma minima de una entidad devuelta por JSON:API.
 *
 * Solo se declara lo que este nodo lee. Todo opcional porque la respuesta llega
 * de un sistema externo: un bundle sin alias de ruta no trae `path`, y dar por
 * segura su presencia convertiria una configuracion ajena en una excepcion.
 */
interface DrupalEntityResponse {
  readonly data?: {
    readonly id?: string;
    readonly attributes?: Record<string, unknown>;
    readonly relationships?: Record<string, unknown>;
  };
}

/** Entidad ya leida, con lo que los cuatro modos necesitan de ella. */
interface FetchedNode {
  readonly uuid: string;
  readonly internalNid: number;
  readonly pathAlias: string;
  readonly bodyHtml: string;
  /** Referencias declaradas por el bundle; de aqui sale el campo de fichero. */
  readonly relationships: Record<string, unknown>;
}

/** Resultado de resolver la configuracion: o hay config, o hay fallo. */
type ConfigResolution =
  | { readonly config: ResolvedDrupalHttpConfig }
  | { readonly failure: NodeErrorDetail };

/** Lectura de una entidad: o la entidad, o el fallo listo para devolver. */
type FetchResolution =
  | { readonly node: FetchedNode }
  | { readonly failure: NodeErrorDetail; readonly status: number };

/** Binario listo para enviar, ya validado. */
interface ResolvedAttachment {
  readonly contentBase64: string;
  readonly filename: string;
}

/** Fichero ya subido: lo que hace falta para construir el enlace. */
interface UploadedAttachment {
  readonly url: string;
  readonly filename: string;
}

/** O hay adjunto que subir, o hay un motivo por el que no lo hay. */
type AttachmentResolution =
  | { readonly attachment: ResolvedAttachment }
  | { readonly failure: NodeErrorDetail };

/** Icono con el que se ilustra el enlace al pliego. */
const PDF_ICON_SRC = '/modules/file/icons/application-pdf.png';

/**
 * Clases con las que un portal oculta un contenedor vacio.
 *
 * Son DOS porque la version de Bootstrap de la pagina no coincide con la de la
 * plantilla, y ninguna de las dos es negociable desde aqui: el portal presenta
 * `.panel`, `.panel-default` y `.panel-heading`, que son Bootstrap 3 —donde la
 * utilidad se llama `hidden`—, mientras que la plantilla sembrada emite
 * `data-bs-toggle`, que es Bootstrap 5 —donde se llama `d-none`—.
 *
 * Quitar una clase que no esta no hace nada, asi que listar las dos no tiene
 * coste; acertar solo una si lo tendria, y del peor tipo: el panel se publica,
 * el nodo devuelve EXITOSO y nadie lo ve en la pagina.
 */
const HIDDEN_UTILITY_CLASSES = 'd-none hidden';

/**
 * Nombres de campo de fichero que se buscan cuando el configurado no existe.
 *
 * `field_fichero_adjunto` va PRIMERO porque es el unico VERIFICADO: el sondeo
 * `probe:drupal:upload` lo encontro en las relaciones de `node--page` en la
 * instalacion de Madrid+D. Los otros siete son conjeturas por convencion de
 * nombre, y por eso van detras: ante un bundle que declarase dos, se prueba
 * antes el que se sabe que existe.
 *
 * Es una HEURISTICA y no un contrato, y conviene no olvidarlo: en JSON:API
 * `relationships` enumera TODAS las referencias de entidad del nodo —`uid`,
 * `type`, `revision_uid`, terminos de taxonomia—, no solo los campos de
 * fichero. Que uno de estos nombres este presente no demuestra que admita
 * bytes; si un bundle usara `field_documentos` como referencia a taxonomia, el
 * POST devolveria 422. El riesgo se acepta porque el fallo cae en la
 * degradacion controlada, nunca en una ejecucion pausada.
 *
 * Se EXPORTA para que `probe-drupal-file-upload.ts` sondee exactamente esta
 * lista. Antes la replicaba, con un comentario que avisaba de lo que pasaria si
 * las dos divergian; divergieron en cuanto se anadio el primer candidato.
 */
export const COMMON_FILE_FIELD_CANDIDATES = [
  'field_fichero_adjunto',
  'field_adjuntos',
  'field_archivos',
  'field_documentos',
  'field_ficheros',
  'field_documentacion',
  'field_archivo',
  'field_pdf',
] as const;

/** Carga de cheerio con las banderas CANONICAS del proyecto. */
const loadFragment = (html: string): CheerioAPI =>
  cheerio.load(html, { xml: { xmlMode: false } }, false);

/** `stackTrace` solo cuando de verdad lo hay (`exactOptionalPropertyTypes`). */
const stackTraceOf = (error: unknown): { stackTrace?: string } =>
  error instanceof Error && error.stack !== undefined
    ? { stackTrace: error.stack }
    : {};

/** Entero no negativo de un valor desconocido, o el neutro. */
const toNumber = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/** Cadena de un valor desconocido, o el neutro. */
const toText = (value: unknown, fallback: string): string =>
  typeof value === 'string' ? value : fallback;

/**
 * Nombre de fichero seguro para una cabecera `Content-Disposition`.
 *
 * NO es cosmetico. `RawEmailAttachment.filename` es, por contrato escrito, una
 * cadena que controla quien ENVIA el correo, y aqui acaba dentro de una
 * cabecera HTTP: un `\r\n` en ese nombre parte la cabecera e inyecta las que
 * quiera el remitente. Se descartan tambien las comillas —que cerrarian el
 * valor entrecomillado antes de tiempo— y los separadores de ruta.
 */
const sanitizeFilename = (filename: string): string => {
  const cleaned = filename
    .replace(/[\r\n"\\/]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned.length === 0 ? 'adjunto' : cleaned.slice(0, 180);
};

/**
 * Nodo DESTINO_DRUPAL: publicacion final en el Drupal institucional (JSON:API).
 *
 * POR QUE ESTE NOMBRE. El tipo viajo de `DESTINO_DRUPAL` a `DESTINO_HTTP` en la
 * migracion 005 —para admitir otros destinos por HTTP— y la 027 lo devolvio a
 * `DESTINO_DRUPAL`. El motivo del viaje de vuelta es que el generico nunca
 * llego: lo que esta clase implementa es el dialecto JSON:API de Drupal, no un
 * POST cualquiera, y sus hermanos del catalogo (`DESTINO_SMTP`, `DESTINO_ACENS`)
 * nombran el destino y no el transporte. Lo que de verdad es generico vive
 * ahora en `BaseHttpDestinationStrategy`, que es donde lo heredara Acens.
 *
 * CINCO MODOS, que son cinco trabajos distintos y no variantes del mismo:
 *
 * 1. `CREATE_NODE` crea una entidad propia por cada contenido (Notiweb).
 * 2. `APPEND_HTML_BLOCK` antepone un bloque al `body.value` de una pagina
 *    AGREGADORA. Las licitaciones no son nodos: viven acumuladas dentro del
 *    HTML de una sola pagina, asi que abrir una es una mutacion del DOM remoto.
 * 3. `TRANSFER_HTML_BLOCK` mueve uno de esos bloques de la pagina de abiertas a
 *    la de cerradas. Ver el orden invertido en `runTransferHtmlBlock`.
 * 4. `UPDATE_LINK_SOURCE` cambia el `href` o el `src` de UN elemento de una
 *    pagina (Innodays), sin tocar nada mas de su HTML.
 * 5. `UPLOAD_ATTACHMENT` sube un binario y devuelve su URL publica.
 *
 * NO escribe en el contexto: devuelve `data` y es `FsmEngineService` quien la
 * deposita en el `outputNamespace` declarado por el nodo.
 *
 * LIMITACION CONOCIDA. Drupal JSON:API no expone `If-Match`/ETag sobre nodos,
 * de modo que entre el GET y el PATCH de los modos de HTML cabe la edicion de
 * un humano, y gana el ultimo que escribe. No hay mitigacion en esta capa; se
 * deja escrito para que nadie lo descubra en produccion.
 */
@Injectable()
export class DrupalHttpStrategy extends BaseHttpDestinationStrategy {
  public readonly nodeType = NodeType.DESTINO_DRUPAL;

  /** Validacion estricta de los `params` al guardar y al activar el flujo. */
  public readonly paramsSchema = DrupalHttpConfigDto;

  /**
   * Las seis claves que este nodo deposita en su namespace.
   *
   * Los CUATRO modos emiten las seis, con valores neutros donde no aplican. Es
   * lo que permite que un nodo de aguas abajo —o la trazabilidad— interpole
   * `{{http_result.node_id}}` sin saber con que modo corrio el destino.
   */
  public readonly outputFields: readonly NodeOutputField[] = [
    {
      name: 'node_id',
      type: 'text',
      description: 'UUID de la entidad creada o mutada en Drupal',
    },
    {
      name: 'drupal_internal__nid',
      type: 'number',
      description:
        'Identificador interno numerico del nodo; 0 cuando la operacion no afecta a un nodo (p. ej. la subida de un fichero)',
    },
    {
      name: 'path_alias',
      type: 'text',
      description:
        'Ruta publica del recurso. En UPLOAD_ATTACHMENT lleva la URL del fichero subido, que es el dato util de ese modo',
    },
    {
      name: 'operation_applied',
      type: 'text',
      description: `Modo ejecutado; "${TRANSFER_PARTIAL_OPERATION}" si el traslado quedo a medias`,
    },
    {
      name: 'http_status',
      type: 'number',
      description:
        'Codigo HTTP de la peticion decisiva; 0 si no llego a haber respuesta',
    },
    {
      name: 'published_at',
      type: 'text',
      description: 'Marca ISO del instante en que Drupal confirmo la escritura',
    },
    {
      name: 'attachment_url',
      type: 'text',
      description:
        'URL publica del fichero subido; vacia si el modo no sube nada o si la subida se omitio',
    },
  ];

  constructor(
    httpClient: HttpClientService,
    private readonly drupalApiConfig: DrupalApiConfig,
  ) {
    // El contexto del logger es el de ESTA clase y no el de la base: al
    // operador le sirve leer `DrupalHttpStrategy` en la traza, no el nombre del
    // andamiaje compartido.
    super(httpClient, DrupalHttpStrategy.name);
  }

  /**
   * Namespaces sin los cuales este nodo no puede operar.
   *
   * Se deduce de la CONFIGURACION y no del tipo, como exige el contrato. El
   * caso que lo justifica es `TRANSFER_HTML_BLOCK`: ese modo no consume
   * contexto en absoluto —el bloque se extrae del DOM que devuelve Drupal—, y
   * exigirle `validated_drupal_json` haria que la regla 7 del validador
   * rechazara AL GUARDAR un cierre de licitacion perfectamente valido.
   *
   * Puro y sincrono: solo mira `params`.
   */
  public getRequiredNamespaces(
    params: Record<string, unknown>,
  ): readonly string[] {
    const config = resolveDrupalHttpConfig(
      plainToInstance(DrupalHttpConfigDto, params),
    );
    const required = new Set<string>();

    // Las raices citadas en las plantillas, con el MISMO helper que usa el
    // validador de topologia: una segunda expresion regular equivalente
    // acabaria divergiendo de la que de verdad interpola.
    for (const template of [
      config.titleTemplate,
      config.summaryTemplate,
      config.authorTemplate,
      config.dateTemplate,
      config.linkSelector,
      config.linkValueTemplate,
      config.expedienteTemplate,
      config.itemSelector,
    ]) {
      if (template !== null) {
        for (const root of extractNamespaceRoots(template)) {
          required.add(root);
        }
      }
    }

    if (
      config.operationMode === DrupalOperationMode.CREATE_NODE ||
      config.operationMode === DrupalOperationMode.APPEND_HTML_BLOCK
    ) {
      required.add(config.sourceNamespace);
    }

    // El namespace del binario tambien hace falta cuando el APPEND lo sube: sin
    // esto, la regla 7 del validador no avisaria de un flujo que pide subir un
    // adjunto por un namespace que nadie publica aguas arriba.
    if (
      config.operationMode === DrupalOperationMode.UPLOAD_ATTACHMENT ||
      (config.operationMode === DrupalOperationMode.APPEND_HTML_BLOCK &&
        config.uploadAttachment)
    ) {
      required.add(config.attachmentNamespace);
    }

    return [...required];
  }

  /**
   * `params` que faltan para EJECUTAR, que no son los que faltan para guardar.
   *
   * Todos los campos del DTO son opcionales para que una plantilla de flujo
   * —una topologia sin operativa, con `params: {}`— se pueda guardar. Lo que
   * cada modo necesita de verdad se exige aqui, y lo consulta
   * `assertActivatable`.
   */
  public getIncompleteParams(
    params: Record<string, unknown>,
  ): readonly string[] {
    const config = resolveDrupalHttpConfig(
      plainToInstance(DrupalHttpConfigDto, params),
    );
    const missing: string[] = [];

    switch (config.operationMode) {
      case DrupalOperationMode.CREATE_NODE:
        if (config.titleTemplate === null) {
          missing.push('titleTemplate');
        }
        break;

      case DrupalOperationMode.APPEND_HTML_BLOCK:
      case DrupalOperationMode.UPLOAD_ATTACHMENT:
        if (config.targetNodeUuid === null) {
          missing.push('targetNodeUuid');
        }
        break;

      case DrupalOperationMode.TRANSFER_HTML_BLOCK:
        if (config.targetNodeUuid === null) {
          missing.push('targetNodeUuid');
        }
        if (config.destinationNodeUuid === null) {
          missing.push('destinationNodeUuid');
        }
        if (config.itemSelector === null) {
          missing.push('itemSelector');
        }
        break;

      case DrupalOperationMode.UPDATE_LINK_SOURCE:
        if (config.targetNodeUuid === null) {
          missing.push('targetNodeUuid');
        }
        if (config.linkSelector === null) {
          missing.push('linkSelector');
        }
        if (config.linkValueTemplate === null) {
          missing.push('linkValueTemplate');
        }
        break;
    }

    return missing;
  }

  /**
   * Codigos que este nodo NO puede emitir con estos `params`.
   *
   * Solo los modos que tocan el DOM remoto pueden fallar por un selector. Una
   * ruta de recuperacion declarada contra `ERR_DRUPAL_DOM_TARGET` en un
   * `CREATE_NODE` seria un nodo de respaldo que jamas corre, y el sintoma es
   * mudo. La regla 10 del validador usa esto para rechazarlo al guardar.
   */
  public getUnreachableErrorCodes(
    params: Record<string, unknown>,
  ): readonly string[] {
    const config = resolveDrupalHttpConfig(
      plainToInstance(DrupalHttpConfigDto, params),
    );

    const touchesDom =
      config.operationMode === DrupalOperationMode.APPEND_HTML_BLOCK ||
      config.operationMode === DrupalOperationMode.TRANSFER_HTML_BLOCK ||
      config.operationMode === DrupalOperationMode.UPDATE_LINK_SOURCE;

    return touchesDom ? [] : [ERR_DRUPAL_DOM_TARGET];
  }

  public async execute(
    context: StatePayloadContext,
    params: Record<string, unknown>,
  ): Promise<NodeResult> {
    const resolution = await this.resolveConfig(params);

    if ('failure' in resolution) {
      return { success: false, error: resolution.failure };
    }

    // Borrador forzado en Sandbox, pero solo si el entorno esta GUARDADO en
    // los params: los flujos anteriores al toggle no traen la clave y se
    // resuelven a Sandbox por defecto, y apagarles la publicacion en silencio
    // convertiria cada noticia de produccion en un borrador olvidado.
    const config =
      params.isSandbox === true
        ? { ...resolution.config, publishStatus: false }
        : resolution.config;

    // Guarda de credencial, antes de construir ninguna peticion: sin ella la
    // respuesta de Drupal seria un 401 indistinguible de una cuenta caducada.
    if (!this.drupalApiConfig.isUsable) {
      return {
        success: false,
        error: {
          level: 'GRAVE',
          code: ERR_DRUPAL_CONFIG,
          // El mensaje nombra la variable que falta y no un generico, porque
          // en modo BASIC son dos y confundirlas cuesta una corrida entera.
          message: this.describeMissingCredentials(),
        },
      };
    }

    const productionTarget =
      params.isSandbox === true ? this.findProductionTarget(config) : null;

    if (productionTarget !== null) {
      return {
        success: false,
        error: {
          level: 'GRAVE',
          code: ERR_DRUPAL_CONFIG,
          message: `El nodo esta en el entorno Sandbox pero ${productionTarget.param} apunta a una pagina del portal (${productionTarget.uuid}). No se ha enviado ninguna peticion.`,
          missingFields: [productionTarget.param],
        },
      };
    }

    switch (config.operationMode) {
      case DrupalOperationMode.CREATE_NODE:
        return this.runCreateNode(context, config);

      case DrupalOperationMode.APPEND_HTML_BLOCK:
        return this.runAppendHtmlBlock(context, config);

      case DrupalOperationMode.TRANSFER_HTML_BLOCK:
        return this.runTransferHtmlBlock(context, config);

      case DrupalOperationMode.UPDATE_LINK_SOURCE:
        return this.runUpdateLinkSource(context, config);

      case DrupalOperationMode.UPLOAD_ATTACHMENT:
        return this.runUploadAttachment(context, config);
    }
  }

  /**
   * Valida `params` y aplica los valores por defecto.
   *
   * Se usa `validate` y NO `validateOrReject`: esta ultima lanza, y el motor
   * normaliza toda excepcion a URGENTE, que `canRetry` nunca reintenta.
   */
  private async resolveConfig(
    params: Record<string, unknown>,
  ): Promise<ConfigResolution> {
    const dto = plainToInstance(DrupalHttpConfigDto, params);
    const errors = await validate(dto, VALIDATION_OPTIONS);

    if (errors.length > 0) {
      const constraints = errors.flatMap((error) =>
        Object.values(error.constraints ?? {}),
      );

      return {
        failure: {
          level: 'GRAVE',
          code: ERR_DRUPAL_CONFIG,
          message: `Configuracion invalida del destino Drupal: ${constraints.join(' ')}`,
          missingFields: errors.map((error) => error.property),
        },
      };
    }

    return { config: resolveDrupalHttpConfig(dto) };
  }

  // --- Modos -------------------------------------------------------------

  /** Crea una entidad independiente (Notiweb). */
  private async runCreateNode(
    context: StatePayloadContext,
    config: ResolvedDrupalHttpConfig,
  ): Promise<NodeResult> {
    const markup = this.readSourceMarkup(context, config);

    if (typeof markup !== 'string') {
      return { success: false, error: markup };
    }

    const title = this.interpolate(context, config.titleTemplate);

    if (title !== null && typeof title !== 'string') {
      return { success: false, error: title };
    }

    if (title === null) {
      return {
        success: false,
        error: {
          level: 'GRAVE',
          code: ERR_DRUPAL_CONFIG,
          message:
            'titleTemplate es obligatorio para crear una entidad en Drupal.',
          missingFields: ['titleTemplate'],
        },
      };
    }

    const summary = this.interpolate(context, config.summaryTemplate);

    if (summary !== null && typeof summary !== 'string') {
      return { success: false, error: summary };
    }

    // El resumen viaja DENTRO del campo de cuerpo (`body.summary`): el bundle
    // de noticias no declara ningun campo de resumen propio, el cuerpo es un
    // texto con resumen. El antiguo `field_resumen` suelto provocaba un 422 en
    // cuanto se rellenaba la plantilla.
    const attributes: Record<string, unknown> = {
      title,
      [config.bodyFieldName]: {
        value: markup,
        format: config.bodyFormat,
        summary: emptyToNull(summary),
      },
      status: config.publishStatus,
    };

    const news = this.buildNewsFields(context, config);

    if ('failure' in news) {
      return { success: false, error: news.failure };
    }

    Object.assign(attributes, news.attributes);

    const document: Record<string, unknown> = {
      type: config.bundle,
      attributes,
      ...(Object.keys(news.relationships).length > 0
        ? { relationships: news.relationships }
        : {}),
    };

    const outcome =
      await this.httpClient.requestWithStatus<DrupalEntityResponse>(
        {
          url: `${this.drupalApiConfig.baseUrl}/${this.resolveEntityPath(config.bundle)}`,
          method: 'POST',
          headers: this.buildJsonApiHeaders(),
          data: { data: document },
        },
        // Sin reintentos: un POST repetido tras un 5xx que SI se aplico crea una
        // segunda noticia. La idempotencia aqui no la da el verbo, asi que la
        // decision de reintentar es del operador y no del cliente HTTP.
        { timeoutMs: this.drupalApiConfig.timeoutMs, maxRetries: 0 },
      );

    if ('failure' in outcome) {
      return this.failWith(outcome, config, 'crear la entidad');
    }

    const attributesOut = outcome.data.data?.attributes ?? {};

    return {
      success: true,
      data: this.buildPayload(
        {
          nodeId: toText(outcome.data.data?.id, NEUTRAL_TEXT),
          internalNid: toNumber(
            attributesOut.drupal_internal__nid,
            NEUTRAL_NID,
          ),
          pathAlias: this.readPathAlias(attributesOut),
          httpStatus: outcome.status,
          publishedAt: this.readChangedAt(attributesOut),
        },
        config.operationMode,
      ),
    };
  }

  /** Antepone un bloque al HTML acumulado de una pagina agregadora. */
  private async runAppendHtmlBlock(
    context: StatePayloadContext,
    config: ResolvedDrupalHttpConfig,
  ): Promise<NodeResult> {
    const markup = this.readSourceMarkup(context, config);

    if (typeof markup !== 'string') {
      return { success: false, error: markup };
    }

    const uuid = config.targetNodeUuid;

    if (uuid === null) {
      return this.missingParam('targetNodeUuid');
    }

    const fetched = await this.fetchNode(uuid, config);

    if ('failure' in fetched) {
      return this.failFetched(fetched, config, 'leer la pagina agregadora');
    }

    // Subida DESPUES del GET, y no antes, por dos razones que apuntan al mismo
    // sitio: el campo de destino se descubre en las relaciones que devuelve esa
    // misma respuesta, y si el GET falla no queda un fichero huerfano colgando
    // de Drupal por una publicacion que nunca llego a ocurrir.
    const uploaded = config.uploadAttachment
      ? await this.tryUploadAttachment(context, config, uuid, fetched.node)
      : null;

    const enriched =
      uploaded === null
        ? markup
        : this.tryInjectAttachmentLink(markup, uploaded, config);

    // Envoltorio estandar de licitacion (`div.pd-licitacion-block`), salvo en
    // los paneles de acordeon, que se reparten por universidad y no son
    // licitaciones. El expediente sale del propio marcado o de la plantilla.
    const expediente = this.interpolate(context, config.expedienteTemplate);

    if (expediente !== null && typeof expediente !== 'string') {
      return { success: false, error: expediente };
    }

    const block =
      planPanelDispatch(enriched).length > 0
        ? enriched
        : wrapTenderBlock(enriched, expediente);

    const inserted = this.insertBlock(fetched.node.bodyHtml, block, config);

    if (typeof inserted !== 'string') {
      return { success: false, error: inserted };
    }

    const patched = await this.patchNodeBody(uuid, inserted, config);

    if ('failure' in patched) {
      return this.failWith(patched, config, 'actualizar la pagina agregadora');
    }

    return {
      success: true,
      data: this.buildPayload(
        {
          nodeId: uuid,
          // El nid sale del GET y no de la respuesta del PATCH: una instalacion
          // de Drupal puede responder `204 No Content` a un PATCH, y entonces
          // no habria atributos que leer. El GET ya es obligatorio en este modo.
          internalNid: fetched.node.internalNid,
          pathAlias: fetched.node.pathAlias,
          attachmentUrl: uploaded?.url ?? NEUTRAL_TEXT,
          httpStatus: patched.status,
          publishedAt: this.readChangedAt(patched.data.data?.attributes ?? {}),
        },
        config.operationMode,
      ),
    };
  }

  /**
   * Cambia el `href` o el `src` de UN elemento de una pagina (Innodays).
   *
   * GET de la pagina, cirugia sobre el texto original (`replaceLinkAttribute`)
   * y PATCH. El HTML que vuelve a Drupal es el mismo byte a byte salvo el
   * atributo: re-serializar el DOM entero con cheerio cambiaria comillas y
   * entidades de toda la pagina, y el diff de la revision en Drupal mostraria
   * cientos de cambios donde solo hubo uno.
   *
   * El valor se valida ANTES de leer la pagina: si la plantilla no resuelve o
   * produce un esquema peligroso (`javascript:`), no hay nada que publicar y
   * no se gasta ninguna peticion.
   */
  private async runUpdateLinkSource(
    context: StatePayloadContext,
    config: ResolvedDrupalHttpConfig,
  ): Promise<NodeResult> {
    const uuid = config.targetNodeUuid;

    if (uuid === null) {
      return this.missingParam('targetNodeUuid');
    }
    if (config.linkSelector === null) {
      return this.missingParam('linkSelector');
    }

    const selector = this.interpolateSelector(context, config.linkSelector);

    if (typeof selector !== 'string') {
      return { success: false, error: selector };
    }

    const interpolated = this.interpolate(context, config.linkValueTemplate);

    if (interpolated === null) {
      return this.missingParam('linkValueTemplate');
    }
    if (typeof interpolated !== 'string') {
      return { success: false, error: interpolated };
    }

    const value = interpolated.trim();

    if (!isSafeLinkValue(value, config.linkAttribute)) {
      return {
        success: false,
        error: {
          level: 'GRAVE',
          code: ERR_DRUPAL_MISSING_PAYLOAD,
          message: `El nuevo valor de "${config.linkAttribute}" esta vacio o usa un esquema no permitido ("${value.slice(0, 80)}"). Solo se admiten rutas relativas y http(s)${config.linkAttribute === 'href' ? ' o mailto' : ''}.`,
          missingFields: ['linkValueTemplate'],
        },
      };
    }

    const fetched = await this.fetchNode(uuid, config);

    if ('failure' in fetched) {
      return this.failFetched(fetched, config, 'leer la pagina del enlace');
    }

    const update = replaceLinkAttribute(
      fetched.node.bodyHtml,
      selector,
      config.linkAttribute,
      value,
    );

    if ('invalidSelector' in update || 'matches' in update) {
      const detail =
        'invalidSelector' in update
          ? 'no es un selector CSS valido'
          : `encuentra ${update.matches} elementos y debe encontrar exactamente uno`;

      return {
        success: false,
        error: {
          level: 'GRAVE',
          code: ERR_DRUPAL_DOM_TARGET,
          message: `El selector "${selector}" ${detail} en la pagina ${uuid}. No se ha modificado nada.`,
          missingFields: [selector],
        },
      };
    }

    // Ya apuntaba ahi: no hay revision que crear. Reintentar el nodo despues
    // de un PATCH que si llego a aplicarse converge sin escribir de nuevo.
    if (update.previousValue === value) {
      return {
        success: true,
        data: this.buildPayload(
          {
            nodeId: uuid,
            internalNid: fetched.node.internalNid,
            pathAlias: fetched.node.pathAlias,
            httpStatus: NEUTRAL_STATUS,
            publishedAt: new Date().toISOString(),
          },
          config.operationMode,
        ),
      };
    }

    const patched = await this.patchNodeBody(uuid, update.html, config);

    if ('failure' in patched) {
      return this.failWith(
        patched,
        config,
        'actualizar el enlace de la pagina',
      );
    }

    return {
      success: true,
      data: this.buildPayload(
        {
          nodeId: uuid,
          internalNid: fetched.node.internalNid,
          pathAlias: fetched.node.pathAlias,
          httpStatus: patched.status,
          publishedAt: this.readChangedAt(patched.data.data?.attributes ?? {}),
        },
        config.operationMode,
      ),
    };
  }

  /**
   * Mueve un bloque de la pagina de abiertas a la de cerradas.
   *
   * ORDEN INVERTIDO respecto a la secuencia «natural», y es la decision central
   * de este modo. Lo natural seria retirar de origen y despues escribir en
   * destino; hecho asi, el fallo de la segunda escritura PIERDE el bloque: ya
   * no esta en abiertas y nunca llego a cerradas. Ese bloque solo existia
   * dentro del `body.value` de la agregadora —no es una entidad con revisiones
   * que se pueda recuperar—, de modo que la perdida es silenciosa e
   * irreversible: la licitacion desaparece del portal y nadie se entera.
   *
   * Escribiendo PRIMERO en cerradas, la unica ventana de fallo produce un
   * DUPLICADO: el bloque aparece en las dos paginas. Es visible para cualquier
   * lector, se arregla con una edicion y —lo decisivo— es autoconvergente, por
   * la guarda de idempotencia del paso 2: un reintento detecta que cerradas ya
   * lo tiene, se salta la escritura y solo retira de abiertas.
   *
   * JSON:API no ofrece transaccion multi-entidad, asi que la ventana no se
   * puede eliminar. Solo se puede elegir de que lado cae.
   *
   * LA IDEMPOTENCIA SE DECIDE POR IDENTIDAD, no por el selector. Antes,
   * «ya trasladado» era «el `itemSelector` casa en destino», y con el selector
   * generico del preset (`.pd-licitacion-block, .licitacion-entry`) la pagina
   * de cerradas casaba SIEMPRE por las licitaciones que ya tenia: se saltaba la
   * escritura en destino, se retiraba el bloque de origen y el nodo terminaba
   * EXITOSO con la licitacion perdida. Ahora solo cuenta el `data-expediente`
   * del bloque concreto; sin expediente se escribe siempre, y lo peor que puede
   * pasar es un duplicado visible.
   */
  private async runTransferHtmlBlock(
    context: StatePayloadContext,
    config: ResolvedDrupalHttpConfig,
  ): Promise<NodeResult> {
    const sourceUuid = config.targetNodeUuid;
    const destinationUuid = config.destinationNodeUuid;

    if (sourceUuid === null) {
      return this.missingParam('targetNodeUuid');
    }
    if (destinationUuid === null) {
      return this.missingParam('destinationNodeUuid');
    }
    if (config.itemSelector === null) {
      return this.missingParam('itemSelector');
    }

    // Interpolable para poder cerrar UNA licitacion concreta
    // (`[data-expediente="{{llm_response.headline}}"]`); cada valor se escapa.
    const selector = this.interpolateSelector(context, config.itemSelector);

    if (typeof selector !== 'string') {
      return { success: false, error: selector };
    }

    // --- 1. Origen: localizar y aislar el bloque.
    const source = await this.fetchNode(sourceUuid, config);

    if ('failure' in source) {
      return this.failFetched(source, config, 'leer la pagina de origen');
    }

    const sourceDom = loadFragment(source.node.bodyHtml);
    const sourceMatches = querySelectorSafely(sourceDom, selector);

    if (sourceMatches === null) {
      return this.invalidSelector(selector, 'itemSelector');
    }

    const block = sourceMatches.first();

    const destination = await this.fetchNode(destinationUuid, config);

    if ('failure' in destination) {
      return this.failFetched(destination, config, 'leer la pagina de destino');
    }

    const destinationDom = loadFragment(destination.node.bodyHtml);

    if (block.length === 0) {
      // No esta en origen. Solo es «ya trasladado» si el selector nombra UN
      // expediente y ese esta en destino: un intento anterior llego a
      // completarse y repetirlo no tiene sentido. Con un selector generico,
      // que destino case no prueba nada —la pagina de cerradas siempre tiene
      // licitaciones—, y dar el traslado por hecho ocultaria que no habia nada
      // que mover.
      const alreadyCompleted =
        selectorPinsExpediente(selector) &&
        (querySelectorSafely(destinationDom, selector)?.length ?? 0) > 0;

      if (alreadyCompleted) {
        return {
          success: true,
          data: this.buildPayload(
            {
              nodeId: destinationUuid,
              internalNid: destination.node.internalNid,
              pathAlias: destination.node.pathAlias,
              httpStatus: NEUTRAL_STATUS,
              publishedAt: new Date().toISOString(),
            },
            config.operationMode,
          ),
        };
      }

      return {
        success: false,
        error: {
          level: 'GRAVE',
          code: ERR_DRUPAL_DOM_TARGET,
          message: `El selector "${selector}" no encuentra ningun bloque que trasladar en la pagina de origen (${sourceUuid}). No se ha modificado ninguna pagina.`,
          missingFields: [selector],
        },
      };
    }

    const blockHtml = sourceDom.html(block);
    const expediente = readExpediente(block);

    // Identidad del bloque CONCRETO. Sin expediente no hay forma de saber si
    // destino ya lo tiene, y se escribe: un duplicado se ve y se corrige, una
    // licitacion borrada de las dos paginas no.
    const alreadyMoved =
      expediente !== null &&
      destinationDom(expedienteSelector(expediente)).length > 0;

    // --- 2. Destino PRIMERO. Un fallo aqui no pierde nada: el bloque sigue
    //        intacto en origen y el nodo entero se puede reintentar.
    let destinationStatus = NEUTRAL_STATUS;
    let destinationChangedAt = new Date().toISOString();

    if (!alreadyMoved) {
      // El contenedor de la pagina RECEPTORA, si se declaro: en un traslado
      // hay dos paginas y el `containerSelector` del nodo no tiene por que
      // existir en la de destino. Si no casa, `insertBlock` falla con
      // ERR_DRUPAL_DOM_TARGET ANTES de cualquier PATCH, y el bloque sigue
      // intacto en origen.
      const merged = this.insertBlock(
        destination.node.bodyHtml,
        blockHtml,
        config.targetContainerSelector === null
          ? config
          : { ...config, containerSelector: config.targetContainerSelector },
        {
          page: `la pagina de destino (${destinationUuid})`,
          consequence:
            'No se ha escrito en ninguna pagina: el bloque sigue en la de origen.',
        },
      );

      if (typeof merged !== 'string') {
        return { success: false, error: merged };
      }

      const patchedDestination = await this.patchNodeBody(
        destinationUuid,
        merged,
        config,
      );

      if ('failure' in patchedDestination) {
        return this.failWith(
          patchedDestination,
          config,
          'anadir el bloque a la pagina de destino',
        );
      }

      destinationStatus = patchedDestination.status;
      destinationChangedAt = this.readChangedAt(
        patchedDestination.data.data?.attributes ?? {},
      );
    }

    // --- 3. Origen despues. Un fallo aqui deja el bloque DUPLICADO, no perdido.
    block.remove();

    const patchedSource = await this.patchNodeBody(
      sourceUuid,
      sourceDom.html(),
      config,
    );

    if ('failure' in patchedSource) {
      const failure = this.mapHttpFailure(
        patchedSource.failure,
        patchedSource.status,
        DrupalHttpStrategy.ERROR_PREFIX,
        'retirar el bloque de la pagina de origen en Drupal',
      );

      // Se devuelve `data` AUNQUE el nodo falle: el motor publica el namespace
      // cuando hay payload y ademas lo copia en `error_context.partial_data`,
      // que es de donde una alerta saca el UUID concreto que hay que limpiar.
      // Sin esto, el operador recibe «fallo el PATCH» y ningun sitio al que ir.
      return {
        success: false,
        data: this.buildPayload(
          {
            nodeId: destinationUuid,
            internalNid: destination.node.internalNid,
            pathAlias: destination.node.pathAlias,
            operationApplied: TRANSFER_PARTIAL_OPERATION,
            httpStatus: patchedSource.status,
            publishedAt: destinationChangedAt,
          },
          config.operationMode,
        ),
        error: {
          ...failure,
          message: `${failure.message} | El bloque "${selector}" YA esta publicado en la pagina de destino (${destinationUuid}) pero NO se pudo retirar de la de origen (${sourceUuid}): aparece DUPLICADO, no perdido. Reintentar este nodo es seguro e idempotente; si no, retirarlo a mano de la pagina de origen.`,
        },
      };
    }

    return {
      success: true,
      data: this.buildPayload(
        {
          nodeId: destinationUuid,
          internalNid: destination.node.internalNid,
          pathAlias: destination.node.pathAlias,
          // El estado decisivo es el de la escritura en DESTINO: es la que
          // publica la licitacion cerrada. La de origen solo limpia.
          httpStatus:
            destinationStatus === NEUTRAL_STATUS
              ? patchedSource.status
              : destinationStatus,
          publishedAt: destinationChangedAt,
        },
        config.operationMode,
      ),
    };
  }

  /** Sube un binario adjunto y resuelve su URL publica descargable. */
  /**
   * Localiza el binario del adjunto pedido, o explica por que no esta.
   *
   * Se separa del modo porque los DOS consumidores necesitan exactamente estas
   * tres guardas y ninguna mas: `UPLOAD_ATTACHMENT`, que convierte el fallo en
   * un `NodeResult` fallido, y `APPEND_HTML_BLOCK`, que lo degrada a un aviso.
   * Quien decide la gravedad es el modo; esta funcion solo averigua.
   */
  private resolveAttachmentBinary(
    context: StatePayloadContext,
    config: ResolvedDrupalHttpConfig,
  ): AttachmentResolution {
    const namespace = context.getNamespace(config.attachmentNamespace);
    const inventory = namespace?.[config.attachmentField];

    if (!Array.isArray(inventory) || inventory.length === 0) {
      return {
        failure: {
          level: 'GRAVE',
          code: ERR_DRUPAL_MISSING_PAYLOAD,
          message: `No hay adjuntos en "${config.attachmentNamespace}.${config.attachmentField}". Recuerde que el binario solo vive en "raw_email": "parsed_email" publica el inventario SIN los bytes.`,
          missingFields: [
            `${config.attachmentNamespace}.${config.attachmentField}`,
          ],
        },
      };
    }

    const attachment = inventory[config.attachmentIndex] as
      Record<string, unknown> | undefined;

    if (attachment === undefined) {
      return {
        failure: {
          level: 'GRAVE',
          code: ERR_DRUPAL_MISSING_PAYLOAD,
          message: `El inventario de adjuntos tiene ${inventory.length} elemento(s) y se pidio el indice ${config.attachmentIndex}.`,
          missingFields: [
            `${config.attachmentNamespace}.${config.attachmentField}[${config.attachmentIndex}]`,
          ],
        },
      };
    }

    const contentBase64 = attachment.contentBase64;
    const filename = toText(attachment.filename, 'adjunto');

    // El binario puede haber sido LIBERADO por el motor. No es un fallo del
    // adjunto sino de la topologia del flujo, y el mensaje tiene que decirlo:
    // el operador vera un inventario perfectamente formado y sin bytes.
    if (typeof contentBase64 !== 'string' || contentBase64.length === 0) {
      return {
        failure: {
          level: 'GRAVE',
          code: ERR_DRUPAL_MISSING_PAYLOAD,
          message: `El binario de "${filename}" ya fue liberado por el motor: se descarta en cuanto un nodo anterior publica texto extraido de los adjuntos. Coloque este nodo ANTES del PARSER_PRE_IA, o encienda en el su "skipDocumentExtraction".`,
          missingFields: [
            `${config.attachmentNamespace}.${config.attachmentField}[${config.attachmentIndex}].contentBase64`,
          ],
        },
      };
    }

    return { attachment: { contentBase64, filename } };
  }

  /**
   * Elige el campo de fichero del bundle leyendo sus relaciones.
   *
   * Evita el 404/422 de subir contra un campo que la instalacion no declara:
   * la peticion condenada se descarta ANTES de tocar la red, que es la clausula
   * de guarda de siempre aplicada a un recurso remoto.
   */
  private resolveTargetFileField(
    configuredField: string,
    relationships: Record<string, unknown>,
  ): string | null {
    if (configuredField in relationships) {
      return configuredField;
    }

    for (const candidate of COMMON_FILE_FIELD_CANDIDATES) {
      if (candidate in relationships) {
        this.logger.log(
          `INFO | DRUPAL_FIELD_AUTODISCOVERED | El campo "${configuredField}" no existe en el bundle. Se usara la relacion detectada "${candidate}".`,
        );

        return candidate;
      }
    }

    this.logger.warn(
      `WARN | DRUPAL_NO_FILE_RELATIONSHIP | El bundle no declara relaciones de fichero compatibles. Candidatos evaluados: ${COMMON_FILE_FIELD_CANDIDATES.join(', ')}.`,
    );

    return null;
  }

  /** Envia los bytes al endpoint de campo de fichero de JSON:API. */
  private async postAttachmentBinary(
    uuid: string,
    fileFieldName: string,
    attachment: ResolvedAttachment,
    config: ResolvedDrupalHttpConfig,
  ): Promise<HttpClientStatusOutcome<DrupalEntityResponse>> {
    return this.httpClient.requestWithStatus<DrupalEntityResponse>(
      {
        url: `${this.drupalApiConfig.baseUrl}/${this.resolveEntityPath(config.bundle)}/${uuid}/${fileFieldName}`,
        method: 'POST',
        headers: {
          ...this.buildJsonApiHeaders(),
          // Sobrescriben las de JSON:API: este endpoint recibe bytes crudos.
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `file; filename="${sanitizeFilename(attachment.filename)}"`,
        },
        data: Buffer.from(attachment.contentBase64, 'base64'),
      },
      // Sin reintentos, por el mismo motivo que `CREATE_NODE`: un POST repetido
      // deja dos copias del fichero colgando del mismo campo.
      { timeoutMs: this.drupalApiConfig.timeoutMs, maxRetries: 0 },
    );
  }

  /** URL publica del fichero recien subido, o el neutro. */
  private readUploadedUrl(response: DrupalEntityResponse): string {
    const attributes = response.data?.attributes ?? {};
    const uri = attributes.uri as Record<string, unknown> | undefined;

    return toText(uri?.url, NEUTRAL_TEXT);
  }

  /**
   * Cuelga el enlace al fichero de la lista de pliegos del bloque.
   *
   * Opera sobre el markup que se va a INSERTAR, no sobre el HTML remoto, y en
   * modo `append`: la plantilla sembrada deja `ul.licitacion-pliegos` vacia
   * porque es la IA quien genera un `<li>` por cada pliego que cita el correo.
   * Reemplazar ahi dentro borraria ese trabajo; el fichero subido es un pliego
   * mas, no el unico.
   */
  private injectAttachmentLink(
    markup: string,
    url: string,
    filename: string,
    config: ResolvedDrupalHttpConfig,
  ): string | null {
    const $ = loadFragment(markup);
    const list = $(config.attachmentListSelector);

    if (list.length === 0) {
      return null;
    }

    const safeName = sanitizeFilename(filename);

    list
      .first()
      .append(
        `<li><img style="border:0px;vertical-align:baseline;" src="${PDF_ICON_SRC}" alt="Icono PDF" title="application/pdf"> <a class="pliego-link" href="${url}" target="_blank">${safeName}</a></li>`,
      );

    return $.html();
  }

  /**
   * Intenta subir el adjunto; ante cualquier tropiezo AVISA y devuelve `null`.
   *
   * Es la diferencia de caracter con `UPLOAD_ATTACHMENT`: alli la subida es el
   * trabajo entero y no hacerla es un fallo, mientras que aqui es un extra
   * sobre una publicacion que tiene valor por si sola. Pausar el flujo por un
   * PDF dejaria la licitacion sin publicar, que es peor que publicarla sin el
   * enlace.
   *
   * El coste de esta decision hay que asumirlo con los ojos abiertos: un 403 de
   * credenciales o un campo mal configurado NO pausan la ejecucion. Quedan en
   * el `warn` y en un `attachment_url` vacio, y hay que ir a buscarlos.
   */
  private async tryUploadAttachment(
    context: StatePayloadContext,
    config: ResolvedDrupalHttpConfig,
    uuid: string,
    node: FetchedNode,
  ): Promise<UploadedAttachment | null> {
    const resolved = this.resolveAttachmentBinary(context, config);

    if ('failure' in resolved) {
      this.logger.warn(
        `WARN | DRUPAL_ATTACHMENT_SKIPPED | ${resolved.failure.message} Se publica el bloque sin enlace al fichero.`,
      );

      return null;
    }

    const fileField = this.resolveTargetFileField(
      config.fileFieldName,
      node.relationships,
    );

    if (fileField === null) {
      return null;
    }

    const outcome = await this.postAttachmentBinary(
      uuid,
      fileField,
      resolved.attachment,
      config,
    );

    if ('failure' in outcome) {
      this.logger.warn(
        `WARN | DRUPAL_ATTACHMENT_UPLOAD_FAILED | No se pudo subir "${resolved.attachment.filename}" a "${fileField}": ${outcome.failure.message}`,
      );

      return null;
    }

    const url = this.readUploadedUrl(outcome.data);

    if (url.length === 0) {
      this.logger.warn(
        'WARN | DRUPAL_ATTACHMENT_NO_URL | Drupal acepto el fichero pero no devolvio "attributes.uri.url".',
      );

      return null;
    }

    return { url, filename: resolved.attachment.filename };
  }

  /** Inyecta el enlace, o deja el bloque intacto si no hay donde colgarlo. */
  private tryInjectAttachmentLink(
    markup: string,
    uploaded: UploadedAttachment,
    config: ResolvedDrupalHttpConfig,
  ): string {
    const enriched = this.injectAttachmentLink(
      markup,
      uploaded.url,
      uploaded.filename,
      config,
    );

    if (enriched === null) {
      this.logger.warn(
        `WARN | DRUPAL_ATTACHMENT_LIST_MISSING | El bloque no contiene "${config.attachmentListSelector}". El fichero quedo subido pero sin enlace.`,
      );

      return markup;
    }

    return enriched;
  }

  private async runUploadAttachment(
    context: StatePayloadContext,
    config: ResolvedDrupalHttpConfig,
  ): Promise<NodeResult> {
    const uuid = config.targetNodeUuid;

    if (uuid === null) {
      return this.missingParam('targetNodeUuid');
    }

    const resolved = this.resolveAttachmentBinary(context, config);

    if ('failure' in resolved) {
      return { success: false, error: resolved.failure };
    }

    const outcome = await this.postAttachmentBinary(
      uuid,
      config.fileFieldName,
      resolved.attachment,
      config,
    );

    if ('failure' in outcome) {
      return this.failWith(outcome, config, 'subir el adjunto');
    }

    const uploadedUrl = this.readUploadedUrl(outcome.data);

    return {
      success: true,
      data: this.buildPayload(
        {
          nodeId: toText(outcome.data.data?.id, NEUTRAL_TEXT),
          // Un fichero no tiene `nid`: su identificador interno es un `fid`, y
          // fingir lo contrario daria un numero que no resuelve ninguna ruta.
          internalNid: NEUTRAL_NID,
          // La URL publica viaja en `path_alias` porque es el campo cuya
          // semantica la admite, y se repite en `attachment_url` para que un
          // consumidor no tenga que saber en que modo corrio el nodo.
          pathAlias: uploadedUrl,
          attachmentUrl: uploadedUrl,
          httpStatus: outcome.status,
          publishedAt: this.readChangedAt(outcome.data.data?.attributes ?? {}),
        },
        config.operationMode,
      ),
    };
  }

  // --- Auxiliares de red --------------------------------------------------

  /** Lee una entidad y proyecta de ella lo que los modos necesitan. */
  private async fetchNode(
    uuid: string,
    config: ResolvedDrupalHttpConfig,
  ): Promise<FetchResolution> {
    const outcome =
      await this.httpClient.requestWithStatus<DrupalEntityResponse>(
        {
          url: `${this.drupalApiConfig.baseUrl}/${this.resolveEntityPath(config.bundle)}/${uuid}`,
          method: 'GET',
          headers: this.buildJsonApiHeaders(),
        },
        { timeoutMs: this.drupalApiConfig.timeoutMs },
      );

    if ('failure' in outcome) {
      return {
        failure: outcome.failure,
        status: outcome.status ?? NEUTRAL_STATUS,
      };
    }

    const attributes = outcome.data.data?.attributes ?? {};
    const body = attributes[config.bodyFieldName] as
      Record<string, unknown> | undefined;

    return {
      node: {
        uuid,
        internalNid: toNumber(attributes.drupal_internal__nid, NEUTRAL_NID),
        pathAlias: this.readPathAlias(attributes),
        bodyHtml: toText(body?.value, NEUTRAL_TEXT),
        relationships: outcome.data.data?.relationships ?? {},
      },
    };
  }

  /** Escribe el HTML completo en el campo de texto de una entidad. */
  private async patchNodeBody(
    uuid: string,
    html: string,
    config: ResolvedDrupalHttpConfig,
  ): Promise<HttpClientStatusOutcome<DrupalEntityResponse>> {
    return this.httpClient.requestWithStatus<DrupalEntityResponse>(
      {
        url: `${this.drupalApiConfig.baseUrl}/${this.resolveEntityPath(config.bundle)}/${uuid}`,
        method: 'PATCH',
        headers: this.buildJsonApiHeaders(),
        data: {
          data: {
            type: config.bundle,
            // `id` es OBLIGATORIO en un PATCH de JSON:API y debe coincidir con
            // el UUID de la URL; omitirlo devuelve un 422 cuyo cuerpo no deja
            // claro que es eso lo que falta.
            id: uuid,
            attributes: {
              [config.bodyFieldName]: {
                value: html,
                format: config.bodyFormat,
              },
            },
          },
        },
      },
      // CON reintentos, al contrario que los POST: el PATCH envia el
      // `body.value` entero ya calculado, asi que repetirlo converge al mismo
      // estado. Es idempotente por construccion.
      { timeoutMs: this.drupalApiConfig.timeoutMs },
    );
  }

  /**
   * Cabeceras del dialecto JSON:API, con la credencial del entorno.
   *
   * El esquema (`Basic` o `Bearer`) lo decide `DrupalApiConfig.authHeader`, no
   * este metodo: los cuatro modos pasan por aqui, y repartir el `if` por cada
   * uno significaria que el quinto se olvidara de aplicarlo.
   */
  private buildJsonApiHeaders(): Record<string, string> {
    return {
      Authorization: this.drupalApiConfig.authHeader,
      Accept: 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
    };
  }

  /** `node--noticias` -> `node/noticias`. */
  private resolveEntityPath(bundle: string): string {
    return bundle.replace('--', '/');
  }

  // --- Auxiliares de dominio ----------------------------------------------

  /**
   * Inserta un bloque en el fragmento HTML de una pagina.
   *
   * Dos rutas, y cual se toma lo decide el MARCADO ENTRANTE, no la
   * configuracion del nodo:
   *
   * - Si trae paneles que declaran su propio destino —un acordeon de varias
   *   universidades—, cada uno va al suyo. Ver `insertDispatchedPanels`.
   * - Si no, el fragmento entero va al `containerSelector`, que es como ha
   *   funcionado siempre y es lo que necesitan los demas flujos que publican
   *   por este modo (licitaciones, Notiweb): sus bloques no son paneles y no
   *   declaran destino ninguno.
   *
   * Devuelve el HTML resultante, o el `NodeErrorDetail` si algun destino no
   * existe. `where` nombra la pagina en el mensaje: en un traslado hay dos, y
   * «el contenedor no existe» sin decir en cual obliga a abrir las dos.
   */
  private insertBlock(
    currentHtml: string,
    blockHtml: string,
    config: ResolvedDrupalHttpConfig,
    where: { readonly page: string; readonly consequence: string } = {
      page: 'el HTML actual de la pagina',
      consequence: 'No se ha modificado nada.',
    },
  ): string | NodeErrorDetail {
    const $ = loadFragment(currentHtml);
    const plan = planPanelDispatch(blockHtml);

    if (plan.length > 0) {
      return this.insertDispatchedPanels($, plan, config);
    }

    // Sin `containerSelector` se opera sobre la raiz del fragmento, que es el
    // caso normal: la pagina agregadora es una lista de bloques hermanos.
    // `selectVisibleTarget` y no `$(...)` a secas: la pagina trae una plantilla
    // de muestra escondida en un subarbol `.d-none` que DUPLICA los
    // contenedores del portal, y el duplicado aparece antes en el documento. El
    // `.first()` de mas abajo se quedaba con el, de modo que el bloque se
    // publicaba dentro de la muestra oculta —PATCH 200, nodo EXITOSO— y no se
    // veia en la pagina.
    let container: Cheerio<AnyNode>;

    try {
      container =
        config.containerSelector === null
          ? $.root()
          : selectVisibleTarget($, config.containerSelector);
    } catch {
      // Un selector que cheerio no sabe leer lanzaba, y el motor convertia la
      // excepcion en URGENTE sin reintento. Es el mismo desenlace que un
      // contenedor ausente —no hay donde insertar— y se informa igual.
      return {
        level: 'GRAVE',
        code: ERR_DRUPAL_DOM_TARGET,
        message: `El contenedor "${config.containerSelector ?? ''}" no es un selector CSS valido para ${where.page}. ${where.consequence}`,
        missingFields: [config.containerSelector ?? ''],
      };
    }

    if (container.length === 0) {
      return {
        level: 'GRAVE',
        code: ERR_DRUPAL_DOM_TARGET,
        message: `${capitalize(where.page)} no contiene el contenedor esperado "${config.containerSelector ?? ''}". ${where.consequence}`,
        missingFields: [config.containerSelector ?? ''],
      };
    }

    if (config.insertPosition === 'APPEND') {
      container.first().append(blockHtml);
    } else {
      container.first().prepend(blockHtml);
    }

    return $.html();
  }

  /**
   * Reparte cada panel dentro del sub-acordeon de SU universidad.
   *
   * TODO O NADA, y es la decision de diseno de este metodo. Si un solo panel no
   * tiene donde ir, no se inserta ninguno y el nodo falla nombrandolo. La
   * alternativa que parecia amable —mandar los huerfanos al `containerSelector`
   * del nodo— es exactamente la averia que esto viene a arreglar: el panel
   * aterriza en la raiz del acordeon, fuera de su universidad, la ejecucion se
   * marca EXITOSA y el unico rastro es un aviso en el log que nadie mira a
   * tiempo. Un error con el codigo del comite dentro llega antes.
   *
   * Que falte el destino significa una de dos, y las dos quiere verlas una
   * persona: el modelo no sustituyo el relleno de la plantilla, o la pagina no
   * tiene a esa universidad. Ninguna se arregla publicando igualmente.
   */
  private insertDispatchedPanels(
    $: CheerioAPI,
    plan: readonly PanelDispatch[],
    config: ResolvedDrupalHttpConfig,
  ): string | NodeErrorDetail {
    // Se resuelven TODOS antes de tocar nada: es lo que hace el todo o nada.
    const placements = plan.map((panel) => ({
      panel,
      container: resolvePanelContainer($, panel),
    }));

    const unplaceable = placements
      .filter((placement) => placement.container === null)
      .map((placement) => placement.panel);

    if (unplaceable.length > 0) {
      const detail = unplaceable
        .map(
          (panel) =>
            `"${panel.committeeCode}" -> ${panel.targetSelector ?? 'sin destino declarado'}`,
        )
        .join('; ');

      return {
        level: 'GRAVE',
        code: ERR_DRUPAL_DOM_TARGET,
        message:
          `No existe en la pagina el contenedor de ${unplaceable.length} de los ${plan.length} paneles recibidos: ${detail}. ` +
          'No se ha modificado nada. Revisa el mapeo de universidades del prompt o la estructura de la pagina agregadora.',
        // El CODIGO DEL COMITE y no el selector: es lo que permite localizar el
        // panel en el material de origen, que es donde esta la correccion.
        missingFields: unplaceable.map((panel) => panel.committeeCode),
      };
    }

    for (const { panel, container } of placements) {
      // `container` no puede ser null aqui: la guarda de arriba ya devolvio en
      // ese caso. La comprobacion es para el compilador, no para el flujo.
      // `resolvePanelContainer` ya prefiere, entre varios candidatos, el que no
      // cuelga de un subarbol oculto; si TODOS cuelgan de uno, devuelve el
      // primero igual y lo destapa el `removeClass` de aqui abajo.
      if (container === null) continue;

      // Un sub-acordeon al que todavia no se le ha inyectado ningun comite
      // puede venir oculto, y entonces el primero que reciba se publicaria sin
      // verse. Es el mismo fallo de "publicado pero invisible" que obligo a
      // cambiar este preset de CREATE_NODE a APPEND_HTML_BLOCK, y no se
      // manifiesta en ninguna respuesta HTTP: el PATCH devuelve 200.
      //
      // Se retira SOLO la utilidad de ocultacion, no la clase entera: el
      // contenedor lleva ademas las suyas propias —`panel-group` y demas— y
      // vaciarlas romperia la maquetacion del portal.
      container.removeClass(HIDDEN_UTILITY_CLASSES);

      if (config.insertPosition === 'APPEND') {
        container.append(panel.html);
      } else {
        container.prepend(panel.html);
      }

      this.logger.debug(
        `Panel "${panel.committeeCode}" inyectado en ${panel.targetSelector ?? ''}.`,
      );
    }

    return $.html();
  }

  /** Lee el markup a publicar del namespace de origen. */
  private readSourceMarkup(
    context: StatePayloadContext,
    config: ResolvedDrupalHttpConfig,
  ): string | NodeErrorDetail {
    const namespace = context.getNamespace(config.sourceNamespace);

    if (namespace === undefined) {
      return {
        level: 'GRAVE',
        code: ERR_DRUPAL_MISSING_PAYLOAD,
        message: `El namespace "${config.sourceNamespace}" no existe en el contexto: el nodo que deberia producirlo no llego a ejecutarse.`,
        missingFields: [config.sourceNamespace],
      };
    }

    const markup = namespace[config.sourceField];

    if (typeof markup !== 'string' || markup.trim().length === 0) {
      return {
        level: 'GRAVE',
        code: ERR_DRUPAL_MISSING_PAYLOAD,
        message: `"${config.sourceNamespace}.${config.sourceField}" esta vacio o no es texto. Publicar asi dejaria una entidad en blanco en Drupal.`,
        missingFields: [`${config.sourceNamespace}.${config.sourceField}`],
      };
    }

    return markup;
  }

  /**
   * Interpola una plantilla contra el contexto.
   *
   * Devuelve `null` si no hay plantilla que interpolar, la cadena resuelta, o
   * un `NodeErrorDetail` si falta alguna variable. `getInterpolatedValue` LANZA
   * ante una variable ausente —a proposito, para no publicar un titular en
   * blanco—, asi que aqui se atrapa y se convierte al contrato del nodo.
   */
  private interpolate(
    context: StatePayloadContext,
    template: string | null,
  ): string | NodeErrorDetail | null {
    if (template === null) {
      return null;
    }

    try {
      return context.getInterpolatedValue(template);
    } catch (error) {
      if (error instanceof MissingContextVariableException) {
        return {
          level: 'GRAVE',
          code: ERR_DRUPAL_MISSING_PAYLOAD,
          message: `No se pudo componer el texto a publicar: ${error.message}`,
          missingFields: [error.variable],
          ...stackTraceOf(error),
        };
      }

      throw error;
    }
  }

  /**
   * Interpola un selector CSS escapando CADA valor por separado.
   *
   * No basta con interpolar la plantilla entera y escapar el resultado: eso
   * escaparia tambien la sintaxis que escribio el operador (`:contains('...')`)
   * y el selector dejaria de serlo. Se resuelve marca a marca y solo el VALOR
   * pasa por `escapeSelectorString`, de modo que un nombre de evento con
   * comillas o parentesis casa como texto literal y no abre otra clausula.
   *
   * La `replace` exterior recoge todas las coincidencias antes de llamar a la
   * funcion de sustitucion, asi que reutilizar el mismo patron global dentro
   * de `getInterpolatedValue` no le mueve el `lastIndex`.
   */
  private interpolateSelector(
    context: StatePayloadContext,
    template: string,
  ): string | NodeErrorDetail {
    try {
      return template.replace(INTERPOLATION_PATTERN, (marker: string) =>
        escapeSelectorString(context.getInterpolatedValue(marker)),
      );
    } catch (error) {
      if (error instanceof MissingContextVariableException) {
        return {
          level: 'GRAVE',
          code: ERR_DRUPAL_MISSING_PAYLOAD,
          message: `No se pudo componer el selector del enlace: ${error.message}`,
          missingFields: [error.variable],
          ...stackTraceOf(error),
        };
      }

      throw error;
    }
  }

  /**
   * Atributos y relaciones propios de una noticia de Notiweb.
   *
   * Solo para `node--noticias`: los demas bundles no declaran estos campos y
   * Drupal responde 422 a un atributo desconocido. Cada taxonomia viaja SOLO
   * si su UUID esta configurado; una relacion vacia borraria la que el editor
   * ponga despues a mano en una noticia ya creada.
   */
  private buildNewsFields(
    context: StatePayloadContext,
    config: ResolvedDrupalHttpConfig,
  ):
    | {
        readonly attributes: Record<string, unknown>;
        readonly relationships: Record<string, unknown>;
      }
    | { readonly failure: NodeErrorDetail } {
    if (config.bundle !== DRUPAL_NEWS_BUNDLE) {
      return { attributes: {}, relationships: {} };
    }

    const author = this.interpolate(context, config.authorTemplate);

    if (author !== null && typeof author !== 'string') {
      return { failure: author };
    }

    const date = this.interpolate(context, config.dateTemplate);

    if (date !== null && typeof date !== 'string') {
      return { failure: date };
    }

    const fecha = emptyToNull(date);

    // `field_fecha` es una fecha sin hora: Drupal rechaza con 422 cualquier
    // otra forma, y su mensaje no dice que campo era. Se recorta un instante
    // ISO a su dia y se rechaza aqui todo lo demas, nombrando el param.
    const day =
      fecha === null ? null : (ISO_DAY_PATTERN.exec(fecha)?.[1] ?? '');

    if (day === '') {
      return {
        failure: {
          level: 'GRAVE',
          code: ERR_DRUPAL_MISSING_PAYLOAD,
          message: `La fecha de la noticia debe resolverse a AAAA-MM-DD y se resolvio a "${(fecha ?? '').slice(0, 40)}".`,
          missingFields: ['dateTemplate'],
        },
      };
    }

    const terms: Record<
      keyof typeof DRUPAL_NEWS_TAXONOMY_TYPES,
      string | null
    > = {
      field_fuente_noticia: config.newsSourceTermUuid,
      field_noticia_seccion: config.newsSectionTermUuid,
      field_noticia_tipo: config.newsTypeTermUuid,
    };

    const relationships = Object.fromEntries(
      Object.entries(terms)
        .filter(
          (entry): entry is [keyof typeof DRUPAL_NEWS_TAXONOMY_TYPES, string] =>
            entry[1] !== null,
        )
        .map(([field, id]) => [
          field,
          { data: { type: DRUPAL_NEWS_TAXONOMY_TYPES[field], id } },
        ]),
    );

    return {
      attributes: {
        // El respaldo cubre el correo sin nombre de remitente: `from_name`
        // llega vacio y la noticia saldria sin autor.
        field_autor: emptyToNull(author) ?? config.authorFallback,
        field_fecha: day,
        field_orden: config.orderValue,
      },
      relationships,
    };
  }

  /**
   * Primera pagina del portal a la que apunta un nodo en Sandbox, o `null`.
   *
   * `execute` solo lo consulta cuando el entorno esta GUARDADO como Sandbox,
   * por el mismo motivo que el borrador forzado: los flujos sin la clave se
   * resuelven a Sandbox por defecto y negarles su pagina de produccion los
   * romperia.
   */
  private findProductionTarget(
    config: ResolvedDrupalHttpConfig,
  ): { readonly param: string; readonly uuid: string } | null {
    const production = this.drupalApiConfig.productionNodeUuids;

    for (const [param, uuid] of [
      ['targetNodeUuid', config.targetNodeUuid],
      ['destinationNodeUuid', config.destinationNodeUuid],
    ] as const) {
      if (uuid !== null && production.has(uuid.toLowerCase())) {
        return { param, uuid };
      }
    }

    return null;
  }

  // --- Construccion de resultados ----------------------------------------

  /**
   * Unico constructor del payload. Es lo que garantiza la paridad.
   *
   * TODAS las ramas pasan por aqui —las cuatro de exito y las de fallo con
   * datos—, de modo que es imposible que un modo emita cinco claves y otro
   * seis. El selector del asistente ofrece lo que declara `outputFields`, y una
   * divergencia le haria ofrecer variables irresolubles.
   */
  private buildPayload(
    fields: DrupalResultFields,
    mode: DrupalOperationMode,
  ): Record<string, unknown> {
    return {
      node_id: fields.nodeId ?? NEUTRAL_TEXT,
      drupal_internal__nid: fields.internalNid ?? NEUTRAL_NID,
      path_alias: fields.pathAlias ?? NEUTRAL_TEXT,
      operation_applied: fields.operationApplied ?? mode,
      http_status: fields.httpStatus ?? NEUTRAL_STATUS,
      published_at: fields.publishedAt ?? NEUTRAL_TEXT,
      attachment_url: fields.attachmentUrl ?? NEUTRAL_TEXT,
    };
  }

  /**
   * Prefijo de los codigos de error de este nodo.
   *
   * `BaseHttpDestinationStrategy.resolveErrorCode` lo concatena con la familia
   * (`_AUTH`, `_SERVER`, `_NETWORK`, `_REQUEST`). Las constantes exportadas
   * arriba siguen siendo la fuente de verdad para quien las importe; esto es
   * solo la raiz comun con la que se componen.
   */
  private static readonly ERROR_PREFIX = 'ERR_DRUPAL';

  /** Fallo de una peticion cualquiera, con el payload neutro del modo. */
  private failWith(
    outcome: { readonly failure: NodeErrorDetail; readonly status?: number },
    config: ResolvedDrupalHttpConfig,
    operation: string,
  ): NodeResult {
    return {
      success: false,
      data: this.buildPayload(
        { httpStatus: outcome.status ?? NEUTRAL_STATUS },
        config.operationMode,
      ),
      error: this.mapHttpFailure(
        outcome.failure,
        outcome.status,
        DrupalHttpStrategy.ERROR_PREFIX,
        // El sufijo mantiene el mensaje identico al de antes del refactor: la
        // base no puede saber contra que CMS se estaba hablando.
        `${operation} en Drupal`,
      ),
    };
  }

  /** Hermano del anterior para la lectura de una entidad. */
  private failFetched(
    fetched: { readonly failure: NodeErrorDetail; readonly status: number },
    config: ResolvedDrupalHttpConfig,
    operation: string,
  ): NodeResult {
    return this.failWith(fetched, config, operation);
  }

  /**
   * Que credencial falta, con el nombre exacto de la variable de entorno.
   *
   * En modo BASIC hacen falta DOS, y un mensaje que solo nombrara el token
   * mandaria al operador a revisar la que ya estaba bien.
   */
  private describeMissingCredentials(): string {
    const { authType, token, user } = this.drupalApiConfig;

    if (token.length === 0) {
      return `DRUPAL_API_TOKEN no esta definida en el entorno. El nodo no puede autenticarse contra Drupal (modo ${authType}).`;
    }

    if (authType === 'BASIC' && user.length === 0) {
      return 'DRUPAL_AUTH_TYPE es BASIC pero DRUPAL_API_USER esta vacia. La autenticacion basica exige usuario y contrasena; declara la cuenta de servicio o cambia a DRUPAL_AUTH_TYPE=BEARER.';
    }

    return 'Las credenciales de Drupal estan incompletas en el entorno.';
  }

  /** Selector que cheerio no sabe leer: se informa antes de escribir nada. */
  private invalidSelector(selector: string, param: string): NodeResult {
    return {
      success: false,
      error: {
        level: 'GRAVE',
        code: ERR_DRUPAL_DOM_TARGET,
        message: `"${selector}" no es un selector CSS valido (${param}). No se ha modificado ninguna pagina.`,
        missingFields: [param],
      },
    };
  }

  /** Param obligatorio ausente en ejecucion pese a `getIncompleteParams`. */
  private missingParam(name: string): NodeResult {
    return {
      success: false,
      error: {
        level: 'GRAVE',
        code: ERR_DRUPAL_CONFIG,
        message: `"${name}" es obligatorio para este modo de operacion.`,
        missingFields: [name],
      },
    };
  }

  /** Alias de ruta de una entidad, si el bundle lo declara. */
  private readPathAlias(attributes: Record<string, unknown>): string {
    const path = attributes.path as Record<string, unknown> | undefined;

    return toText(path?.alias, NEUTRAL_TEXT);
  }

  /** Instante que Drupal sella al escribir, o el de aqui si no lo devuelve. */
  private readChangedAt(attributes: Record<string, unknown>): string {
    return (
      toText(attributes.changed, '') ||
      toText(attributes.created, '') ||
      new Date().toISOString()
    );
  }
}
