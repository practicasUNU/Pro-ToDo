import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
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

import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import type {
  INodeStrategy,
  NodeErrorDetail,
  NodeResult,
} from '@core/fsm/types/node-strategy.types';
import type { ResolvedImapConfig } from '@modules/nodes/dto/imap-trigger-config.dto';
import type { ValidatorOptions } from 'class-validator';
import type { ImapFlow, MailboxLockObject, SearchObject } from 'imapflow';
import type { AddressObject, ParsedMail } from 'mailparser';

/**
 * Estado devuelto cuando el buzon no tiene mensajes sin leer.
 *
 * Es un exito y no un fallo: el sondeo se ejecuta cada minuto y encontrar el
 * buzon vacio es el caso NORMAL. Devolver `success: false` dejaria el flujo
 * PAUSADO en su primer paso varias veces por hora.
 */
export const NO_MESSAGES_STATUS = 'NO_MESSAGES_FOUND';

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
type ImapConfigResolution =
  | { readonly config: ResolvedImapConfig; readonly password: string }
  | { readonly failure: NodeErrorDetail };

/**
 * Payload determinista que el nodo expone en su namespace de salida.
 *
 * Cinco claves y ninguna de marcado: el cuerpo viaja SOLO como texto plano. El
 * HTML del correo no se propaga a proposito —traeria estilos en linea, imagenes
 * incrustadas como `data:` URI y etiquetas del cliente remitente— y ni el
 * escudo pre-IA ni el mapeador de plantillas lo necesitan: `PARSER_PRE_IA`
 * trabaja sobre texto para ahorrar tokens, y el marcado final lo aporta la
 * plantilla del gestor, no el correo de origen.
 */
interface ExtractedEmail {
  readonly message_id: string;
  readonly from: string;
  readonly subject: string;
  readonly text: string;
  readonly date: string;
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
 * Traduce la configuracion del nodo a la consulta de IMAP SEARCH.
 *
 * Se exporta porque `ImapPollingService` la reutiliza: si el sondeo detectase
 * con un criterio y la estrategia extrajese con otro, el flujo se despertaria
 * por correos que luego no encuentra, y cada uno de esos ciclos dejaria una
 * ejecucion muerta en `ejecuciones_flujo`.
 *
 * Los criterios se combinan con AND, que es el comportamiento por defecto de
 * IMAP SEARCH: `from` y `subject` son subcadenas, no coincidencias exactas.
 */
export const buildImapSearchQuery = (
  config: ResolvedImapConfig,
): SearchObject => {
  const query: SearchObject = {
    ...(config.unreadOnly ? { seen: false } : {}),
    ...(config.fromFilter !== null ? { from: config.fromFilter } : {}),
    ...(config.subjectFilter !== null
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
 * El cuerpo se expone SOLO como texto plano (`text`), sin marcado. El HTML del
 * correo no se propaga: arrastraria estilos en linea, imagenes incrustadas como
 * `data:` URI y etiquetas del cliente remitente, y el marcado final lo aporta la
 * plantilla del gestor. Consecuencia a tener presente al configurar un flujo: un
 * correo que llegue unicamente en HTML, sin parte `text/plain`, dejara `text`
 * vacio.
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
        return { success: true, data: { status: NO_MESSAGES_STATUS } };
      }

      const parsed = await this.downloadAndParse(client, uid);

      // El marcado va DESPUES de parsear con exito. Al reves, un MIME que
      // reventase el parser quedaria como leido y nadie volveria a procesarlo.
      if (config.markAsRead) {
        await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
      }

      return { success: true, data: { ...this.toExtractedEmail(parsed) } };
    } catch (error) {
      // Red, autenticacion o timeout: GRAVE, no URGENTE, para que el motor lo
      // reintente segun la `retryPolicy` del nodo.
      return {
        success: false,
        error: {
          level: 'GRAVE',
          message: `Fallo la lectura del buzon "${config.mailbox}" en ${config.host}: ${error instanceof Error ? error.message : String(error)}`,
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
  private toExtractedEmail(parsed: ParsedMail): ExtractedEmail {
    return {
      message_id: asString(parsed.messageId),
      from: extractFromAddress(parsed.from),
      subject: asString(parsed.subject),
      // Solo la parte `text/plain` del MIME. Un correo que llegue unicamente en
      // HTML deja esta clave vacia: derivar texto del marcado seria sanitizar,
      // y eso es competencia de `PARSER_PRE_IA`, no del nodo de ingesta
      // (`security-and-scope.md` §3 mantiene este nodo sin transformaciones).
      text: asString(parsed.text),
      // Cadena vacia y nunca `undefined` cuando falta la cabecera `Date:`, para
      // que una plantilla que interpole la clave no falle por variable ausente.
      date: parsed.date instanceof Date ? parsed.date.toISOString() : '',
    };
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
