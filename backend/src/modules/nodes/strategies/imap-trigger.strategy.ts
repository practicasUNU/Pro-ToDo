import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import * as cheerio from 'cheerio';
import { simpleParser } from 'mailparser';

import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import {
  ImapTriggerConfigDto,
  resolveImapConfig,
} from '@modules/nodes/dto/imap-trigger-config.dto';
import {
  createImapClient,
  DOWNLOAD_SOCKET_TIMEOUT_MS,
} from '@modules/nodes/services/imap-client.factory';
import { FALLBACK_ATTACHMENT_NAME_PREFIX } from '@modules/nodes/interfaces/raw-email-attachment.interface';
import { foldDiacritics } from '@modules/nodes/utils/diacritics.util';

import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import type {
  INodeStrategy,
  NodeErrorDetail,
  NodeOutputField,
  NodeResult,
} from '@core/fsm/types/node-strategy.types';
import type { ResolvedImapConfig } from '@modules/nodes/dto/imap-trigger-config.dto';
import type { RawEmailAttachment } from '@modules/nodes/interfaces/raw-email-attachment.interface';
import type { ValidatorOptions } from 'class-validator';
import type { ImapFlow, MailboxLockObject, SearchObject } from 'imapflow';
import type { Attachment, AddressObject, ParsedMail } from 'mailparser';

/**
 * Estado devuelto cuando el buzon no tiene mensajes sin leer.
 *
 * Es un exito y no un fallo: el sondeo se ejecuta cada minuto y encontrar el
 * buzon vacio es el caso NORMAL. Devolver `success: false` dejaria el flujo
 * PAUSADO en su primer paso varias veces por hora.
 */
export const NO_MESSAGES_STATUS = 'NO_MESSAGES_FOUND';

/**
 * Estado devuelto cuando el asunto no casa con `subjectFilterRegex`.
 *
 * Comparte la via del buzon vacio —exito con `halt`— y no la del error LEVE por
 * la misma razon: descartar un correo que no interesa es el funcionamiento
 * NORMAL del filtro, no una incidencia. Un `success: false` escribiria un `.log`
 * en disco y una fila de trazabilidad por cada mensaje irrelevante del buzon
 * (`architecture-patterns.md` §4), ahogando las alertas reales.
 */
export const SUBJECT_FILTERED_STATUS = 'SUBJECT_FILTERED';

/**
 * Tope del marcado que viaja en el payload, en caracteres.
 *
 * Ya NO es la defensa contra las imagenes incrustadas: de esas se ocupa
 * `extractInlineImages`, que las saca del marcado antes de llegar aqui. Era una
 * mala defensa ademas, porque `slice()` corta a media `data:` URI y deja un
 * marcado roto con una imagen truncada que no sirve a nadie.
 *
 * Lo que queda es la red de seguridad para un marcado desmesurado SIN imagenes
 * —una firma corporativa con tablas anidadas, un boletin con estilos en linea—,
 * y sigue siendo el unico tope del camino: `client.download` no limita bytes, y
 * `DOWNLOAD_SOCKET_TIMEOUT_MS` solo corta la INACTIVIDAD del socket, no el
 * volumen de un flujo que avanza.
 *
 * 256 KB sobran para eso: un correo de aviso o de OTP pesa unos pocos KB.
 */
export const MAX_HTML_LENGTH = 262_144;

/**
 * Presupuesto ACUMULADO de adjuntos por correo, en bytes.
 *
 * `maxAttachmentBytes` acota UN adjunto; este acota la suma. Sin el, veinte
 * adjuntos de 5 MiB pasan el filtro individual uno por uno y escriben ~130 MB de
 * base64 en el mismo checkpoint.
 *
 * Vive aqui y no en el DTO por lo mismo que `MAX_HTML_LENGTH`: no es una
 * preferencia del flujo sino un limite estructural de lo que cabe con sensatez
 * en una fila de `ejecuciones_flujo`.
 */
export const MAX_TOTAL_ATTACHMENT_BYTES = 10_485_760;

/**
 * Tipos MIME que este nodo acepta ingerir. Lista CERRADA y falla cerrado.
 *
 * El nodo alimenta un pipeline que publica en un CMS: los unicos adjuntos con
 * sentido ahi son documentos ofimaticos, texto e imagenes. Todo lo demas —un
 * `.exe`, un `.zip`, un `.mp3`— seria a la vez superficie de ataque y peso
 * muerto, porque acabaria codificado en base64 dentro de `contexto_acumulado` y
 * se reserializaria en cada checkpoint.
 *
 * Es una lista blanca y no una negra a proposito: enumerar lo prohibido deja
 * fuera por defecto todo lo que nadie penso en anadir, que es exactamente al
 * reves de lo que conviene aqui.
 *
 * `application/msword` y `application/vnd.ms-powerpoint` estan FUERA, y no por
 * descuido: de un binario de Office 97-2003 no se sabe sacar texto, de modo que
 * admitirlo solo escribiria megabytes de base64 en `contexto_acumulado` —
 * reserializados en cada checkpoint posterior— para un fichero del que se sabe
 * de antemano que no va a aportar nada. El operador se entera igual, y antes:
 * el descarte de mas abajo deja su propio aviso LEVE con el tipo concreto.
 *
 * `image/gif` esta AUSENTE deliberadamente. Tiene consecuencia: como la purga
 * del marcado es incondicional, un GIF incrustado se borra del HTML y tampoco se
 * inventaria, asi que se pierde. Es la politica acordada, no un descuido.
 *
 * Constante de modulo y no propiedad de clase, igual que `TIMEOUT_ERROR_CODES`:
 * consultarla no necesita `this`, y exportarla deja que las pruebas aseveren
 * contra la lista REAL en vez de contra una copia que se desincroniza.
 */
export const ALLOWED_ATTACHMENT_MIME_TYPES: ReadonlySet<string> = new Set([
  'application/pdf',
  // .docx
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  // .xlsx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  // .pptx
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // Excel y Outlook ponen este tipo tanto a un `.xls` binario como al `.csv`
  // que la propia hoja de calculo acaba de exportar. Sin el, esos CSV se
  // tiraban en la ingesta y el extractor nunca llegaba a verlos: la
  // desambiguacion por extension de `extractTextFromBuffer` solo sirve si el
  // fichero ENTRA. El `.xls` autentico que se cuele por aqui queda acotado por
  // `maxAttachmentBytes` y sale con su motivo de formato heredado.
  'application/vnd.ms-excel',
  'text/csv',
  'text/plain',
  'image/png',
  'image/jpeg',
  'image/webp',
]);

/**
 * Reduce un `Content-Type` a su `tipo/subtipo` comparable.
 *
 * `APPLICATION/PDF; charset=utf-8` -> `application/pdf`.
 *
 * `mailparser` ya entrega el tipo sin parametros y en minusculas, asi que para
 * los adjuntos del MIME esto es defensivo. Para las imagenes del marcado no lo
 * es en absoluto: ese valor sale de una `data:` URI que escribio el cliente
 * remitente, y ahi puede llegar con mayusculas o con parametros. Comparar sin
 * normalizar bloquearia un `IMAGE/PNG` perfectamente valido.
 */
const normalizeContentType = (value: unknown): string =>
  typeof value === 'string'
    ? (value.split(';')[0] ?? '').trim().toLowerCase()
    : '';

/**
 * Atributo que marca una `<img>` cuyo binario SI acabo en `attachments`.
 *
 * El contrato es un SI Y SOLO SI: esta presente exactamente cuando el adjunto
 * existe. Una imagen purgada del marcado pero no inventariada —ingesta apagada,
 * o fuera de presupuesto— no lo lleva, para que un nodo posterior no siga una
 * referencia que no apunta a nada.
 */
export const INLINE_ATTACHMENT_MARKER = 'data-attachment';

/** Raiz del nombre de las imagenes extraidas del marcado. */
const INLINE_IMAGE_NAME_PREFIX = 'inline-image';

/**
 * `data:image/png;base64,iVBOR...` -> [, 'image/png', 'iVBOR...'].
 *
 * El segundo grupo usa `[\s\S]` y no `.` porque el valor del atributo puede
 * traer los saltos de linea con los que venia plegado en el MIME, y `.` no los
 * cruza: con `.` un `data:` URI multilinea no casaria y la imagen se quedaria
 * incrustada, que es justo lo que este nodo existe para evitar.
 */
const DATA_URI_PATTERN = /^data:([^;,]+);base64,([\s\S]+)$/;

/**
 * Bytes reales que representa una cadena base64.
 *
 * Cada 4 caracteres codifican 3 bytes, menos los que ocupe el relleno. La
 * aproximacion habitual `length * 0.75` ignora ese relleno y se desvia hasta 2
 * bytes; aqui importa porque `size` es lo que se contrasta contra el tope y lo
 * que un operador lee en la trazabilidad.
 */
const base64ByteLength = (base64: string): number => {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;

  return Math.floor((base64.length * 3) / 4) - padding;
};

/**
 * Extension de archivo derivada del tipo MIME (`image/png` -> `png`).
 *
 * No se inventa nada cuando el subtipo no es utilizable —`image/svg+xml`, o un
 * tipo con parametros—: se cae a `bin`, porque un nombre con una extension
 * equivocada es peor que uno sin ella. El `contentType` real viaja intacto en su
 * propia clave del adjunto.
 */
const extensionFromContentType = (contentType: string): string => {
  const subtype = contentType.split('/')[1] ?? '';

  return /^[a-z0-9]+$/i.test(subtype) ? subtype.toLowerCase() : 'bin';
};

/** Codigos de fallo del nodo. Son lo que un `catchErrors` puede mencionar. */
export const ERR_IMAP_TIMEOUT = 'ERR_IMAP_TIMEOUT';
export const ERR_IMAP_CONFIG = 'ERR_IMAP_CONFIG';
export const ERR_IMAP_READ = 'ERR_IMAP_READ';

/**
 * Codigos con los que `imapflow` senala un tiempo de espera agotado.
 *
 * Se discrimina por `code` y no por el texto del mensaje porque ese texto vive
 * dentro de la libreria: un retoque suyo reclasificaria el error en silencio, y
 * ninguna prueba lo notaria.
 *
 * `CONNECT_TIMEOUT` cubre mas de lo que aparenta: `connection-deadline.js`
 * NORMALIZA a ese mismo codigo los vencimientos de DNS y de proxy, justamente
 * para que quien llama no tenga que saber que fase se bloqueo.
 *
 * `ETIMEOUT` y `ETIMEDOUT` NO son el mismo codigo, y hacen falta los dos: el
 * primero lo emite imapflow ante un socket inactivo y el segundo es el errno de
 * Node. Escribir solo uno deja fuera la mitad de los casos reales.
 */
const TIMEOUT_ERROR_CODES: ReadonlySet<string> = new Set([
  'CONNECT_TIMEOUT',
  'GREETING_TIMEOUT',
  'ETIMEOUT',
  'ETIMEDOUT',
]);

/**
 * Lee el `code` de un error de imapflow.
 *
 * Hace falta el guard porque `imap-flow.d.ts` no tipa la propiedad: los errores
 * de la libreria son `Error` a efectos de TypeScript, y acceder a `.code` sin
 * comprobar seria un `any` implicito.
 */
const errorCodeOf = (error: unknown): string | undefined => {
  if (!(error instanceof Error)) {
    return undefined;
  }

  const { code } = error as Error & { code?: unknown };

  return typeof code === 'string' ? code : undefined;
};

/**
 * Opciones de validacion canonicas del repositorio (ver `PipelineValidatorService`).
 *
 * `forbidNonWhitelisted` es la pieza que convierte la ausencia de `password` en
 * una barrera activa: un `params` que intente colar la contrasena en claro es
 * rechazado, no ignorado.
 */
const VALIDATION_OPTIONS: ValidatorOptions = {
  whitelist: true,
  forbidNonWhitelisted: true,
};

/**
 * Resultado de resolver la configuracion: o se obtuvo, o hay un fallo que
 * devolver dentro del contrato `NodeResult`.
 *
 * Union discriminada en vez de excepciones, igual que en `TemplateMapperStrategy`:
 * mantiene el fallo en el unico canal que el motor interpreta.
 */
/**
 * Inventario de adjuntos en construccion, con su presupuesto ya consumido.
 *
 * Existe porque el presupuesto tiene que sobrevivir a DOS fases —los adjuntos
 * del MIME y las imagenes extraidas del marcado— y ambas deben competir por los
 * mismos bytes. Con un contador local en cada una, un correo podria colar el
 * doble del tope declarado sin que ninguna de las dos lo notara.
 */
interface AttachmentCollection {
  readonly items: RawEmailAttachment[];
  usedBytes: number;
}

type ImapConfigResolution =
  | { readonly config: ResolvedImapConfig; readonly password: string }
  | { readonly failure: NodeErrorDetail };

/**
 * Payload determinista que el nodo expone en su namespace de salida.
 *
 * El cuerpo viaja por DUPLICADO, como texto y como marcado, porque hay correos
 * en los que solo existe una de las dos formas. `mailparser` deriva el texto del
 * HTML cuando el mensaje es un `text/html` suelto, pero NO cuando el HTML llega
 * dentro de un `multipart/alternative` sin parte `text/plain` —el caso de los
 * avisos y OTP institucionales—: ahi `text` queda vacio y el unico cuerpo
 * disponible es `html`. Exponer solo el texto dejaba esos correos sin contenido
 * que interpolar.
 *
 * Las seis claves de CABECERA Y CUERPO son planas y todas `string`, nunca `null`
 * ni `undefined`: el payload se interpola como `{{raw_email.campo}}`, y una
 * clave ausente rompe la resolucion mientras que una cadena vacia se resuelve
 * sola.
 *
 * `attachments` es la excepcion a la planitud, y solo a ella: es un INVENTARIO,
 * no un valor interpolable, y no existe forma sensata de aplanar una lista de
 * longitud variable. La invariante que si sobrevive es la otra, que es la que de
 * verdad protege la interpolacion: la clave esta SIEMPRE presente. Con
 * `includeAttachments` apagado vale `[]`, nunca `undefined`.
 *
 * Lo que sigue sin hacerse aqui es SANEAR. El marcado viaja crudo, con los
 * estilos y las etiquetas del cliente remitente, porque limpiarlo es
 * responsabilidad de `PARSER_PRE_IA`; lo unico que se le aplica es el tope de
 * `MAX_HTML_LENGTH`, que no es una regla de contenido sino de tamano.
 */
interface ExtractedEmail {
  readonly message_id: string;
  readonly from: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly date: string;
  readonly attachments: readonly RawEmailAttachment[];
}

/** Normaliza a cadena un campo que `mailparser` puede dejar sin definir. */
const asString = (value: string | undefined | false): string =>
  typeof value === 'string' ? value : '';

/**
 * Extrae la direccion de correo del remitente como cadena plana.
 *
 * Prohibido devolver el `AddressObject` tal cual: `StatePayloadContext` clona con
 * `structuredClone`, y un objeto de libreria acabaria degradado o roto en el
 * checkpoint JSONB. Se prefiere `value[0].address` (la direccion limpia) y se cae
 * a `text` (que incluye el nombre para mostrar) cuando el MIME no la trae.
 */
const extractFromAddress = (from: AddressObject | undefined): string => {
  const address = from?.value?.[0]?.address;

  if (typeof address === 'string' && address !== '') {
    return address;
  }

  return asString(from?.text);
};

/**
 * Nombre estable para un adjunto que no declara `filename`.
 *
 * No se fabrica una extension a partir del `contentType`: el tipo ya viaja en su
 * propia clave, e inventar un ".pdf" seria presentar como dato del correo algo
 * que el correo no envio. El indice empieza en 1 porque el nombre lo puede leer
 * un operador en la tabla de trazabilidad.
 */
const resolveAttachmentFilename = (
  attachment: Attachment,
  index: number,
): string =>
  typeof attachment.filename === 'string' && attachment.filename !== ''
    ? attachment.filename
    : `${FALLBACK_ATTACHMENT_NAME_PREFIX}-${index + 1}`;

/**
 * Traduce la configuracion del nodo a la consulta de IMAP SEARCH.
 *
 * Se exporta porque `ImapPollingService` la reutiliza: si el sondeo detectase
 * con un criterio y la estrategia extrajese con otro, el flujo se despertaria
 * por correos que luego no encuentra, y cada uno de esos ciclos dejaria una
 * ejecucion muerta en `ejecuciones_flujo`.
 *
 * Los criterios se combinan con AND, que es el comportamiento por defecto de
 * IMAP SEARCH: `from` y `subject` son subcadenas, no coincidencias exactas.
 *
 * EL CRITERIO `SUBJECT` CEDE ANTE `subjectFilterRegex`. Los dos filtran por
 * asunto, pero no son dos formas de lo mismo: este lo resuelve el SERVIDOR
 * —insensible a mayusculas, pero NO a acentos— y el otro se evalua en local con
 * plegado NFD. Al combinarse en AND y correr el servidor primero, un
 * `subjectFilter: "Verificacion"` impedia que el buzon devolviese siquiera
 * "Verificación de Títulos", de modo que `foldDiacritics` no llegaba a
 * ejecutarse y el formulario prometia una normalizacion que este criterio
 * rompia aguas arriba. El sintoma no era un error, sino un buzon que "nunca
 * tiene correo".
 *
 * Se resuelve aqui y no solo retirando el campo del formulario porque el fallo
 * vive en los flujos YA GUARDADOS, que seguirian mandando ambos criterios.
 *
 * CONTRAPARTIDA, asumida: sin el criterio `SUBJECT` el sondeo se trae el correo
 * mas reciente del buzon y lo descarta en OMITIDO si no casa el patron. Con los
 * valores por defecto (`unreadOnly` y `markAsRead` a `true`) el buzon se consume
 * de uno en uno y no se pierde nada; con `markAsRead: false` el flujo se atasca
 * en el mismo mensaje, que es el riesgo que el comentario de `execute` ya
 * describe y que corre igual cualquier flujo que hoy use solo el patron.
 */
export const buildImapSearchQuery = (
  config: ResolvedImapConfig,
): SearchObject => {
  const query: SearchObject = {
    ...(config.unreadOnly ? { seen: false } : {}),
    ...(config.fromFilter !== null ? { from: config.fromFilter } : {}),
    ...(config.subjectFilter !== null && config.subjectFilterRegex === null
      ? { subject: config.subjectFilter }
      : {}),
  };

  // IMAP SEARCH exige al menos un criterio. Con `unreadOnly: false` y sin
  // filtros no queda ninguno, y `{}` seria una sentencia invalida: `all` es la
  // forma explicita de pedir el buzon entero.
  return Object.keys(query).length === 0 ? { all: true } : query;
};

/**
 * Nodo TRIGGER_IMAP: lee el correo mas reciente que casa con los criterios del
 * nodo (`unreadOnly`, `fromFilter`, `subjectFilter`) y lo expone como payload
 * crudo para el resto del pipeline.
 *
 * Los filtros deciden QUE correo entra, no como se transforma: el contenido no
 * se sanea a proposito, y viaja tal cual para alimentar
 * tanto la prueba directa contra `TemplateMapperStrategy`
 * (`{{raw_email.subject}}`, `{{raw_email.text}}`) como la sanitizacion posterior
 * en `PARSER_PRE_IA`. Meter aqui reglas de limpieza duplicaria la
 * responsabilidad de ese nodo.
 *
 * El cuerpo se expone por partida doble, `text` y `html`, porque no siempre
 * existen los dos: un `multipart/alternative` sin parte `text/plain` —lo que
 * envian los avisos y OTP institucionales— deja `text` vacio, y su unico cuerpo
 * es el marcado. El HTML viaja crudo, con los estilos y etiquetas del cliente
 * remitente; lo unico que se le aplica es el tope de `MAX_HTML_LENGTH`, porque
 * `simpleParser` incrusta las imagenes `cid:` como `data:` URI y el payload
 * acaba en el checkpoint JSONB.
 *
 * MODELO DE SEGURIDAD HIBRIDO: la contrasena NO esta en `params`. El nodo declara
 * `passwordEnvKey` y esta estrategia resuelve la variable con `ConfigService` en
 * cada ejecucion. Asi el secreto no entra en la columna JSONB ni viaja al
 * frontend (`security-and-scope.md` §0.1).
 *
 * NO escribe en el contexto: devuelve `data` y es `FsmEngineService` quien la
 * deposita en el `outputNamespace` declarado por el nodo en el `pipeline_schema`.
 * El campo homonimo del DTO es configuracion declarada del nodo y debe coincidir
 * con aquel; el efectivo es siempre el del esquema.
 *
 * TODOS los fallos son GRAVE y ninguno URGENTE: solo los GRAVE entran en la
 * politica de reintentos de `FsmEngineService.canRetry`, y un buzon caido o unas
 * credenciales caducadas son exactamente lo que merece reintentarse.
 */
@Injectable()
export class ImapTriggerStrategy implements INodeStrategy {
  public readonly nodeType = NodeType.TRIGGER_IMAP;

  /**
   * Las siete claves que este nodo deposita en su namespace.
   *
   * Replican `ExtractedEmail`, que es el contrato del payload y no una lista
   * paralela: el orden y los nombres son los mismos, y `toExtractedEmail`
   * garantiza que TODAS esten siempre presentes —cadena vacia o arreglo vacio
   * antes que `undefined`— para que una plantilla que las interpole no falle por
   * variable ausente.
   *
   * `status` NO se declara, y no es un olvido. Esa clave solo existe en la rama
   * del buzon vacio, que devuelve `halt`: el motor cierra la ejecucion en
   * OMITIDO y ningun nodo de aguas abajo llega a interpolar nada. Ofrecerla en
   * el selector prometeria un campo que nunca esta cuando hay algo que mapear.
   *
   * Ningun campo es `url`, pese a que `html` y `text` vienen llenos de enlaces.
   * Contienen direcciones, pero no SON una direccion, y extraerlas es trabajo de
   * PARSER_PRE_IA, que para eso publica `extracted_urls` como `url[]`. Declarar
   * `html` como `url` colaria el cuerpo entero de un correo en el selector del
   * EXTRACTOR_WEB, que es justo el error de tipeo que la regla 8 del validador
   * de topologia existe para impedir.
   */
  public readonly outputFields: readonly NodeOutputField[] = [
    {
      name: 'message_id',
      type: 'text',
      description: 'Identificador del mensaje en el buzon',
    },
    {
      name: 'from',
      type: 'text',
      description: 'Direccion del remitente, ya aplanada a cadena',
    },
    { name: 'subject', type: 'text', description: 'Asunto del correo' },
    {
      name: 'text',
      type: 'text',
      description: 'Parte text/plain, vacia si el correo solo traia marcado',
    },
    {
      name: 'html',
      type: 'text',
      description: 'Marcado crudo sin sanear, con las imagenes ya purgadas',
    },
    {
      name: 'date',
      type: 'text',
      description: 'Cabecera Date en ISO, vacia si el MIME no la trae',
    },
    {
      name: 'attachments',
      type: 'object',
      description: 'Inventario de adjuntos ingeridos; arreglo vacio si no hay',
    },
  ];

  private readonly logger = new Logger(ImapTriggerStrategy.name);

  constructor(private readonly configService: ConfigService) {}

  public async execute(
    _context: StatePayloadContext,
    params: Record<string, unknown>,
  ): Promise<NodeResult> {
    // 1. Configuracion y secreto, antes de abrir ningun socket.
    const resolution = await this.resolveConfig(params);

    if ('failure' in resolution) {
      return { success: false, error: resolution.failure };
    }

    const { config, password } = resolution;

    // 2. Lectura del buzon.
    return this.readLatestUnseen(config, password);
  }

  /**
   * Valida `params` y resuelve la contrasena desde el entorno.
   *
   * Se usa `validate` y NO `validateOrReject`: esta ultima lanza, y el motor
   * normaliza toda excepcion a nivel URGENTE, que `canRetry` nunca reintenta.
   * Una configuracion mal escrita es un error corregible por el operador, asi
   * que debe llegar como GRAVE para que el flujo quede PAUSADO y CU-09 permita
   * arreglarlo y reanudar.
   */
  private async resolveConfig(
    params: Record<string, unknown>,
  ): Promise<ImapConfigResolution> {
    const dto = plainToInstance(ImapTriggerConfigDto, params);
    const errors = await validate(dto, VALIDATION_OPTIONS);

    if (errors.length > 0) {
      const invalidFields = errors.map((error) => error.property);
      const constraints = errors.flatMap((error) =>
        Object.values(error.constraints ?? {}),
      );

      return {
        failure: {
          level: 'GRAVE',
          code: ERR_IMAP_CONFIG,
          message: `Configuracion invalida del nodo IMAP: ${constraints.join(' ')}`,
          missingFields: invalidFields,
        },
      };
    }

    const config = resolveImapConfig(dto);
    const password = this.configService.get<string>(config.passwordEnvKey);

    // Guarda de configuracion: la variable referenciada no existe o esta vacia.
    // No se registra ni el nombre del valor ni su longitud, solo la clave.
    if (typeof password !== 'string' || password === '') {
      return {
        failure: {
          level: 'GRAVE',
          code: ERR_IMAP_CONFIG,
          message: `La variable de entorno "${config.passwordEnvKey}" referenciada en passwordEnvKey no esta definida o esta vacia.`,
          missingFields: [config.passwordEnvKey],
        },
      };
    }

    return { config, password };
  }

  /**
   * Conecta, toma el mensaje sin leer mas reciente y lo parsea.
   *
   * El bloqueo de buzon (`getMailboxLock`) serializa el acceso: sin el, dos
   * ejecuciones concurrentes podrian descargar el MISMO UID y publicarlo dos
   * veces. El cierre va en `finally` para que un fallo a mitad de descarga no
   * deje el socket colgando contra el servidor de correo.
   */
  private async readLatestUnseen(
    config: ResolvedImapConfig,
    password: string,
  ): Promise<NodeResult> {
    // El oyente de 'error' lo exige la firma de la factoria: sin el, un evento
    // de socket derribaria el proceso. El fallo ya se refleja en el `NodeResult`
    // por la via del `catch`, asi que aqui solo se deja traza.
    const client = createImapClient(
      config,
      password,
      (error: Error) => {
        this.logger.warn(
          `Error de socket IMAP contra ${config.host}: ${error.message}`,
        );
      },
      DOWNLOAD_SOCKET_TIMEOUT_MS,
    );

    let lock: MailboxLockObject | undefined;

    try {
      await client.connect();
      lock = await client.getMailboxLock(config.mailbox);

      const uid = await this.findLatestMatchingUid(client, config);

      if (uid === null) {
        // Buzon vacio: exito con parada. `success: true` porque no ha fallado
        // nada —el sondeo corre cada minuto y lo habitual es no encontrar nada—
        // y `halt` para que el motor cierre la ejecucion en OMITIDO en vez de
        // pasar al nodo siguiente, que esperaria las claves de un correo.
        return {
          success: true,
          data: { status: NO_MESSAGES_STATUS },
          halt: {
            reason: 'El buzon no contiene mensajes nuevos que procesar.',
          },
        };
      }

      const parsed = await this.downloadAndParse(client, uid);

      // El marcado va DESPUES de parsear con exito. Al reves, un MIME que
      // reventase el parser quedaria como leido y nadie volveria a procesarlo.
      if (config.markAsRead) {
        await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
      }

      // El filtro se evalua tras el marcado a proposito: un correo descartado
      // que quedase sin leer volveria a descargarse en cada sondeo, un minuto
      // tras otro, y ningun mensaje posterior llegaria nunca a procesarse
      // porque `findLatestMatchingUid` reencontraria siempre el mismo.
      if (!this.matchesSubjectFilter(parsed, config)) {
        return {
          success: true,
          data: { status: SUBJECT_FILTERED_STATUS },
          halt: {
            reason: `El asunto no coincide con el filtro configurado (${String(config.subjectFilterRegex)}).`,
          },
        };
      }

      return {
        success: true,
        data: { ...this.toExtractedEmail(parsed, config) },
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const message = `Fallo la lectura del buzon "${config.mailbox}" en ${config.host}: ${detail}`;

      // Un tiempo de espera agotado es LEVE y no GRAVE. No es una concesion: es
      // que la incidencia se resuelve sola. El sondeo vuelve dentro de un
      // minuto, asi que tratarla como bloqueante dejaba el flujo PAUSADO
      // esperando un reintento manual que nadie tenia que dar, y una fila nueva
      // por cada tick mientras durase el corte.
      //
      // Sin `stackTrace`: una traza de una caida de red esperable no diagnostica
      // nada y solo ensucia el volcado.
      if (TIMEOUT_ERROR_CODES.has(errorCodeOf(error) ?? '')) {
        return {
          success: false,
          error: { level: 'LEVE', code: ERR_IMAP_TIMEOUT, message },
        };
      }

      // Todo lo demas —autenticacion, DNS, buzon inexistente, MIME corrupto—
      // sigue siendo GRAVE, para que el motor lo reintente segun la
      // `retryPolicy` del nodo y quede la traza completa.
      return {
        success: false,
        error: {
          level: 'GRAVE',
          code: ERR_IMAP_READ,
          message,
          ...(error instanceof Error && error.stack !== undefined
            ? { stackTrace: error.stack }
            : {}),
        },
      };
    } finally {
      // Cada cierre va aislado: si liberar el lock falla, todavia hay que cerrar
      // la sesion, y ninguno de los dos debe enmascarar el error que se estaba
      // devolviendo desde el `catch`.
      this.releaseQuietly(lock);
      await this.logoutQuietly(client);
    }
  }

  /**
   * UID del mensaje coincidente mas reciente, o `null` si no hay ninguno.
   *
   * Se toma el maximo y no el ultimo elemento: el orden de la respuesta del
   * servidor no esta garantizado por el protocolo, mientras que un UID mayor
   * siempre corresponde a un mensaje mas nuevo dentro del mismo UIDVALIDITY.
   */
  private async findLatestMatchingUid(
    client: ImapFlow,
    config: ResolvedImapConfig,
  ): Promise<number | null> {
    const uids = await client.search(buildImapSearchQuery(config), {
      uid: true,
    });

    if (uids === false || !Array.isArray(uids) || uids.length === 0) {
      return null;
    }

    return Math.max(...uids);
  }

  /** Descarga el MIME crudo del UID indicado y lo decodifica con mailparser. */
  private async downloadAndParse(
    client: ImapFlow,
    uid: number,
  ): Promise<ParsedMail> {
    const download = await client.download(String(uid), undefined, {
      uid: true,
    });

    return simpleParser(download.content);
  }

  /**
   * Proyecta el correo parseado al payload determinista del namespace.
   *
   * Todo campo se normaliza a `string`: `StatePayloadContext` clona con
   * `structuredClone` en entrada y salida, asi que un `Date` o un `Buffer` no
   * sobrevivirian intactos al checkpoint JSONB.
   */
  /**
   * Resuelve si el asunto del correo supera el filtro por expresion regular.
   *
   * Un patron que no compila NO bloquea el sondeo: se registra como LEVE y el
   * correo pasa. El motivo es que el patron puede venir de un `pipeline_schema`
   * guardado antes de que existiera la validacion del DTO, y negarse a leer el
   * buzon dejaria el flujo muerto sin una sola pista en la interfaz.
   *
   * Se compila con el flag `i` (insensible a mayusculas). Es lo que permite que
   * el asistente ofrezca los modos "contiene texto" y "empieza por" componiendo
   * un patron legible: expresar la insensibilidad dentro del propio texto
   * exigiria una clase de caracteres por letra (`[Ll][Ii]...`), imposible de
   * editar a mano desde el modo avanzado. Amplia el conjunto de asuntos que
   * casan en flujos ya guardados, nunca lo reduce.
   *
   * Por el mismo motivo se pliegan los acentos (`foldDiacritics`) a AMBOS
   * lados, patron y asunto. Plegar solo el asunto seria peor que no plegar: un
   * patron escrito con tilde —"Verificacion" tecleado correctamente— dejaria de
   * casar con el correo que antes atrapaba, porque el acento seguiria en el
   * patron y ya no estaria en el sujeto. Plegar solo el patron deja el caso
   * simetrico sin resolver. Con los dos lados plegados, "Verificación",
   * "VERIFICACION" y "verificacion" son el mismo filtro.
   *
   * El plegado se aplica al TEXTO del patron antes de compilarlo, no al
   * `RegExp` ya construido. Sobre una expresion regular eso es seguro porque
   * ningun metacaracter de la sintaxis lleva diacriticos: lo unico que cambia
   * son los literales que el operador escribio.
   */
  private matchesSubjectFilter(
    parsed: ParsedMail,
    config: ResolvedImapConfig,
  ): boolean {
    if (config.subjectFilterRegex === null) {
      return true;
    }

    let pattern: RegExp;

    try {
      pattern = new RegExp(foldDiacritics(config.subjectFilterRegex), 'i');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `LEVE | subjectFilterRegex no compila ("${config.subjectFilterRegex}": ${detail}); se procesa el correo sin filtrar.`,
      );
      return true;
    }

    return pattern.test(foldDiacritics(asString(parsed.subject)));
  }

  private toExtractedEmail(
    parsed: ParsedMail,
    config: ResolvedImapConfig,
  ): ExtractedEmail {
    const messageId = asString(parsed.messageId);

    // El ORDEN de estos tres pasos es la mitad del cambio, no un detalle de
    // estilo:
    //   1. los adjuntos del MIME reservan su parte del presupuesto,
    //   2. las imagenes del marcado compiten por lo que queda y se purgan,
    //   3. y solo entonces se mide la longitud.
    // Medir antes de purgar era lo que hacia que un correo de una sola imagen
    // acabase recortado a media `data:` URI.
    const collection: AttachmentCollection = { items: [], usedBytes: 0 };

    this.collectAttachments(parsed, collection, config, messageId);

    // El marcado real primero y la version que `mailparser` sintetiza desde el
    // texto plano despues: ese orden deja `html` util tanto en el correo que
    // solo trae HTML como en el que solo trae texto, y `''` si no hay ninguno
    // de los dos.
    const purgedHtml = this.extractInlineImages(
      asString(parsed.html) || asString(parsed.textAsHtml),
      collection,
      config,
      messageId,
    );

    return {
      message_id: messageId,
      from: extractFromAddress(parsed.from),
      subject: asString(parsed.subject),
      // Lo que `mailparser` haya podido extraer como texto: la parte
      // `text/plain` si existe, o la conversion del marcado si el mensaje era un
      // `text/html` suelto. Queda vacia en el `multipart/alternative` que solo
      // trae HTML, y para ese caso esta la clave `html`. No se rellena aqui
      // derivandola del marcado: seria contenido que el correo no envio, y
      // distinguir lo que mando el remitente de lo que nos inventamos importa.
      text: asString(parsed.text),
      html: this.clampHtml(purgedHtml, messageId),
      // Cadena vacia y nunca `undefined` cuando falta la cabecera `Date:`, para
      // que una plantilla que interpole la clave no falle por variable ausente.
      date: parsed.date instanceof Date ? parsed.date.toISOString() : '',
      attachments: collection.items,
    };
  }

  /**
   * Proyecta los adjuntos del MIME al inventario del payload.
   *
   * Devuelve SIEMPRE un array, vacio cuando no hay nada que ingerir: la clave
   * forma parte del contrato del namespace y no puede faltar.
   *
   * Ningun descarte es bloqueante. Un PDF de 20 MB en el buzon es un problema
   * del remitente, no una averia del flujo, y dejar la ejecucion PAUSADA
   * esperando un reintento manual convertiria un correo raro en una incidencia
   * operativa. Se descarta, se deja traza LEVE y el flujo continua.
   */
  private collectAttachments(
    parsed: ParsedMail,
    collection: AttachmentCollection,
    config: ResolvedImapConfig,
    messageId: string,
  ): void {
    if (!config.includeAttachments) {
      return;
    }

    // Guarda estructural, no cosmetica: `@types/mailparser` declara
    // `attachments` como obligatorio, pero cualquier objeto construido con
    // `as ParsedMail` —empezando por los dobles de las pruebas— llega sin la
    // clave, y recorrer `undefined` derribaria el nodo.
    const candidates = Array.isArray(parsed.attachments)
      ? parsed.attachments
      : [];

    for (const [index, attachment] of candidates.entries()) {
      // Las imagenes incrustadas ya viajan dentro de `html` como `data:` URI,
      // puestas ahi por `simpleParser`: repetirlas aqui duplicaria los mismos
      // bytes en la misma fila. Se mira `related` —que es la marca que pone
      // mailparser cuando el `Content-ID` esta referenciado desde el marcado— y
      // no la mera presencia de `cid`, porque hay clientes que le ponen
      // `Content-ID` a adjuntos de verdad y esos si deben viajar.
      if (attachment.related === true) {
        continue;
      }

      const filename = resolveAttachmentFilename(attachment, index);
      const { content } = attachment;

      // Sin Buffer no hay nada que codificar. Es defensivo frente a un MIME que
      // mailparser no logre materializar; se deja traza porque un adjunto que
      // desaparece en silencio es indistinguible de un correo sin adjuntos.
      if (!Buffer.isBuffer(content)) {
        this.logger.warn(
          `LEVE | Adjunto "${filename}" sin contenido binario utilizable en el mensaje "${messageId}".`,
        );
        continue;
      }

      // Lista blanca ANTES de codificar. El orden importa: convertir 5 MiB de
      // un `.exe` a base64 —que ademas infla un 33% mientras dura— para tirarlo
      // en la linea siguiente es trabajo y memoria regalados.
      //
      // Un adjunto sin `Content-Type` declarado normaliza a cadena vacia y cae
      // aqui: la lista blanca falla CERRADO, y no saber que es algo no es razon
      // para dejarlo entrar.
      const contentType = normalizeContentType(attachment.contentType);

      if (!ALLOWED_ATTACHMENT_MIME_TYPES.has(contentType)) {
        this.logger.warn(
          `LEVE | Adjunto "${filename}" descartado por tipo MIME no autorizado (${contentType === '' ? 'sin declarar' : contentType}) en el mensaje "${messageId}".`,
        );
        continue;
      }

      // La longitud real del Buffer manda sobre `attachment.size`: es lo que de
      // verdad se va a codificar, y es el numero que hay que contrastar contra
      // el tope para que el presupuesto signifique algo.
      const bytes = content.length;

      const admitted = this.tryCollect(
        collection,
        {
          filename,
          // El ya normalizado, no el crudo: lo que se persiste debe ser el mismo
          // valor contra el que se decidio admitirlo.
          contentType,
          size: bytes,
          // Base64 PLANO: sin prefijo `data:` y sin saltos de linea. Quien lo
          // consuma decide como envolverlo; anadir el prefijo aqui obligaria a
          // recortarlo en cada consumidor.
          contentBase64: content.toString('base64'),
        },
        config,
        messageId,
      );

      // Agotar el presupuesto corta el recorrido: los adjuntos que siguen
      // tampoco van a caber, y probarlos uno a uno solo repetiria la traza.
      if (
        !admitted &&
        collection.usedBytes + bytes > MAX_TOTAL_ATTACHMENT_BYTES
      ) {
        break;
      }
    }
  }

  /**
   * Admite un adjunto si cabe, y deja traza si no.
   *
   * Punto UNICO donde se aplican las reglas de tamano, compartido por los
   * adjuntos del MIME y por las imagenes extraidas del marcado. Tenerlas en un
   * solo sitio es lo que garantiza que una imagen inline no pueda esquivar el
   * tope que si se le exige a un PDF.
   *
   * Ningun descarte es bloqueante: se registra LEVE y el flujo continua.
   *
   * @returns `true` si el adjunto entro en el inventario.
   */
  private tryCollect(
    collection: AttachmentCollection,
    candidate: RawEmailAttachment,
    config: ResolvedImapConfig,
    messageId: string,
  ): boolean {
    const { filename, size } = candidate;

    if (size > config.maxAttachmentBytes) {
      this.logger.warn(
        `LEVE | Adjunto "${filename}" descartado por tamano (${size} B > ${config.maxAttachmentBytes} B) en el mensaje "${messageId}".`,
      );

      return false;
    }

    if (collection.usedBytes + size > MAX_TOTAL_ATTACHMENT_BYTES) {
      this.logger.warn(
        `LEVE | Presupuesto de adjuntos agotado (${MAX_TOTAL_ATTACHMENT_BYTES} B) en el mensaje "${messageId}": se omiten los restantes.`,
      );

      return false;
    }

    collection.usedBytes += size;
    collection.items.push(candidate);

    return true;
  }

  /**
   * Saca del marcado las imagenes incrustadas y deja el DOM limpio.
   *
   * `simpleParser` sustituye cada imagen `cid:` por una `data:` URI en base64
   * dentro del HTML. Ese marcado acaba integro en el checkpoint JSONB, que el
   * motor reserializa ENTERO en cada transicion: un boletin con tres imagenes
   * infla la fila varios MB por ejecucion.
   *
   * LA PURGA ES INCONDICIONAL Y LA INGESTA NO. Limpiar el DOM es lo que protege
   * al motor, asi que ocurre siempre; guardar la imagen como adjunto depende de
   * `includeAttachments`, que es el opt-in acordado para los binarios. Con la
   * ingesta apagada la imagen se pierde, y es deliberado: antes de este cambio
   * tampoco sobrevivia intacta, porque `clampHtml` la cortaba a media cadena.
   *
   * No duplica bytes con `collectAttachments`: aquel EXCLUYE los adjuntos
   * `related`, que son exactamente estos. Cada imagen entra una sola vez, por
   * una via o por la otra.
   */
  private extractInlineImages(
    html: string,
    collection: AttachmentCollection,
    config: ResolvedImapConfig,
    messageId: string,
  ): string {
    // Salida temprana, y no es solo ahorro de CPU: evita que el round-trip por
    // el DOM normalice el marcado de todos los correos que no tienen ninguna
    // imagen que extraer. El nodo promete entregar el HTML CRUDO, y reescribirlo
    // sin necesidad romperia esa promesa.
    if (!html.includes('data:image')) {
      return html;
    }

    // Misma invocacion que `TemplateRendererService.auditPublishableMarkup`, y
    // por las mismas razones: `xml` como OBJETO elige htmlparser2 sin activar el
    // modo XML sensible a mayusculas, y el tercer parametro `false` es el modo
    // fragmento. Con parse5 en modo documento, `$.html()` sintetizaria
    // `<html><head><body>` en un correo que llego como fragmento.
    const $ = cheerio.load(html, { xml: { xmlMode: false } }, false);

    let recognized = 0;

    $('img[src^="data:image"]').each((_index, element) => {
      const image = $(element);
      // Los espacios se retiran ANTES de casar: un `data:` URI plegado en varias
      // lineas dentro del MIME llega con saltos que no forman parte del base64.
      const source = (image.attr('src') ?? '').replace(/\s+/g, '');
      const match = DATA_URI_PATTERN.exec(source);

      // Un `src` que empieza por `data:image` pero no casa el patron —base64
      // ausente, o una URI mal formada— se deja INTACTO. No se sabe que hay ahi,
      // y adivinar es peor que no tocarlo.
      if (match === null) {
        return;
      }

      const [, rawContentType = '', base64 = ''] = match;
      const contentType = normalizeContentType(rawContentType);

      recognized += 1;

      const filename = `${INLINE_IMAGE_NAME_PREFIX}-${recognized}.${extensionFromContentType(contentType)}`;

      // La misma lista blanca que los adjuntos del MIME. Es lo que cierra el
      // hueco por el que un `image/svg+xml` incrustado —y un SVG puede llevar
      // `<script>`— habria entrado en el inventario sin que nadie lo mirase.
      if (!ALLOWED_ATTACHMENT_MIME_TYPES.has(contentType)) {
        this.logger.warn(
          `LEVE | Imagen incrustada "${filename}" descartada por tipo MIME no autorizado (${contentType === '' ? 'sin declarar' : contentType}) en el mensaje "${messageId}".`,
        );
      }

      // La numeracion cuenta solo las imagenes RECONOCIDAS, no la posicion en el
      // DOM: asi un `src` mal formado no abre un hueco en la serie y los nombres
      // siguen siendo correlativos.
      //
      // Que el tipo no este permitido NO cancela la purga de mas abajo: limpiar
      // el marcado protege el checkpoint, y eso es independiente de si el
      // binario merece guardarse. Solo cancela el inventariado.
      const admitted =
        ALLOWED_ATTACHMENT_MIME_TYPES.has(contentType) &&
        config.includeAttachments &&
        this.tryCollect(
          collection,
          {
            filename,
            contentType,
            size: base64ByteLength(base64),
            contentBase64: base64,
          },
          config,
          messageId,
        );

      // El `src` se reescribe SIEMPRE: purgar no depende de que el binario se
      // haya guardado. El atributo marcador, en cambio, solo se pone cuando de
      // verdad hay un adjunto detras, para que nadie siga una referencia muerta.
      image.attr('src', filename);

      if (admitted) {
        image.attr(INLINE_ATTACHMENT_MARKER, filename);
      }
    });

    return $.html();
  }

  /**
   * Recorta el marcado al tope de `MAX_HTML_LENGTH`.
   *
   * El truncado se REGISTRA en vez de aplicarse en silencio: quien vea una
   * plantilla con el marcado cortado a la mitad necesita poder distinguir un
   * correo mal formado de un tope nuestro, y el `message_id` es lo que permite
   * volver al mensaje concreto en el buzon.
   */
  private clampHtml(html: string, messageId: string): string {
    if (html.length <= MAX_HTML_LENGTH) {
      return html;
    }

    this.logger.warn(
      `GRAVE | Marcado recortado a ${MAX_HTML_LENGTH} caracteres (original: ${html.length}) en el mensaje "${messageId}".`,
    );

    return html.slice(0, MAX_HTML_LENGTH);
  }

  /** Libera el bloqueo del buzon sin dejar escapar errores de cierre. */
  private releaseQuietly(lock: MailboxLockObject | undefined): void {
    if (lock === undefined) {
      return;
    }

    try {
      lock.release();
    } catch (error) {
      this.logger.warn(
        `No se pudo liberar el bloqueo del buzon: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Cierra la sesion IMAP sin dejar escapar errores de cierre. */
  private async logoutQuietly(client: ImapFlow): Promise<void> {
    try {
      await client.logout();
    } catch (error) {
      this.logger.warn(
        `No se pudo cerrar la sesion IMAP limpiamente: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
