import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  buildResumeInstructions,
  buildResumeTokenExpiry,
  generateResumeToken,
  hashResumeToken,
} from '@common/utils/resume-token.util';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  MissingContextVariableException,
  extractNamespaceRoots,
} from '@core/fsm/context/state-payload.context';
import {
  ERROR_CONTEXT_NAMESPACE,
  NodeType,
} from '@core/fsm/types/pipeline-schema.types';
import { SmtpNodeMailerService } from '@common/services/smtp-node-mailer.service';
import {
  buildAlertEmailHtml,
  buildAlertEmailText,
} from '@common/utils/alert-email.template';
import {
  SmtpAlertConfigDto,
  resolveSmtpAlertConfig,
} from '@modules/nodes/dto/smtp-alert-config.dto';

import type { AlertEmailParams } from '@common/utils/alert-email.template';
import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import type {
  INodeStrategy,
  NodeErrorDetail,
  NodeOutputField,
  NodeResult,
} from '@core/fsm/types/node-strategy.types';
import type { ResolvedSmtpAlertConfig } from '@modules/nodes/dto/smtp-alert-config.dto';
import type { ValidatorOptions } from 'class-validator';

/** Codigos de fallo propios de este nodo. */
export const ERR_SMTP_CONFIG = 'ERR_SMTP_CONFIG';

/**
 * Fallo del transporte. YA NO SE EMITE, y se conserva a proposito.
 *
 * Desde que la caida del relay devuelve un exito degradado (`alert_sent:
 * false`), este nodo no puede fallar por culpa del servidor de correo. La
 * constante se mantiene porque es un valor PUBLICO: un `onErrorStep` con
 * `catchErrors: ['ERR_SMTP_SEND_FAILURE']` ya declarado en algun
 * `pipeline_schema` seguiria validando, solo que su ruta no se disparara nunca
 * —que es justo lo correcto, porque el nodo ya no falla por ahi—.
 */
export const ERR_SMTP_SEND_FAILURE = 'ERR_SMTP_SEND_FAILURE';

/**
 * Asunto que se aplica cuando el nodo no declara ninguno.
 *
 * Lleva marcador a proposito: cuando el flujo lo puede resolver, el asunto dice
 * de que flujo habla, que es lo unico que se lee en la lista del buzon antes de
 * abrir nada. Cuando no lo puede resolver, entra `SAFE_FALLBACK_SUBJECT` y el
 * aviso sale igual.
 */
export const DEFAULT_ALERT_SUBJECT =
  '[ALERTA PROTO-DO] Notificacion de incidencia en flujo {{trigger.flow_name}}';

/**
 * Respaldo cuando el asunto efectivo no resuelve contra el contexto.
 *
 * Es un asunto COMPLETO y no el original con huecos: un
 * "Incidencia en flujo  - Nodo " con dos agujeros parece un correo roto del
 * sistema, y quien lo recibe desconfia del aviso entero.
 */
export const SAFE_FALLBACK_SUBJECT =
  '[ALERTA PROTO-DO] Notificacion de incidencia en el flujo';

/** Opciones de validacion canonicas del repositorio. */
const VALIDATION_OPTIONS: ValidatorOptions = {
  whitelist: true,
  forbidNonWhitelisted: true,
};

/** Union discriminada: o hay configuracion, o hay un fallo que devolver. */
type SmtpConfigResolution =
  | { readonly config: ResolvedSmtpAlertConfig }
  | { readonly failure: NodeErrorDetail };

/** Asunto ya resuelto, con la variable que fallo si hubo respaldo. */
interface ResolvedSubject {
  readonly subject: string;
  readonly unresolvedVariable?: string;
}

/** Lee una clave de texto del namespace del fallo, si existe y es cadena. */
const readText = (
  source: Record<string, unknown> | undefined,
  key: string,
): string | undefined => {
  const value = source?.[key];

  return typeof value === 'string' && value.trim().length > 0
    ? value
    : undefined;
};

/** Lee una metrica numerica del contexto de error, si viene y es un numero. */
const readNumber = (
  source: Record<string, unknown> | undefined,
  key: string,
): number | undefined => {
  const value = source?.[key];

  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
};

/** Lee `partial_data`, que el motor siembra siempre pero puede venir vacio. */
const readPartialData = (
  source: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  const value = source?.partial_data;

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  const payload = value as Record<string, unknown>;

  return Object.keys(payload).length > 0 ? payload : undefined;
};

/**
 * Nodo `DESTINO_SMTP`: avisa por correo de lo que esta pasando en el flujo.
 *
 * Es el destino que da sentido practico a `onErrorStep`. Hasta ahora el motor
 * sabia desviar ante un fallo, pero todos los desvios posibles terminaban en
 * otro nodo automatico: no habia forma de que una incidencia alcanzase a una
 * persona sin que alguien abriese la trazabilidad por su cuenta. Su pareja
 * natural es el namespace `error_context`, que el motor siembra justo antes de
 * saltar y del que este nodo saca el que, el donde y el por que.
 *
 * NO esta limitado a la rama de error: es un nodo mas del grafo y puede
 * colocarse en el camino feliz para confirmar una publicacion. Lo que no hace es
 * decidir nada — es terminal por vocacion, y de ahi su categoria `DESTINO`.
 *
 * EL OPERADOR NO REDACTA EL AVISO. Configura destinatarios, asunto y una nota;
 * la carta la compone `buildAlertEmailHtml` con la identidad institucional y con
 * los datos del fallo leidos del contexto. El cuerpo libre que existia antes
 * (`bodyTemplate`) obligaba a reproducir en cada nodo lo que el sistema ya sabe
 * decir, y producia avisos que omitian justo el dato que hacia falta.
 *
 * NODO PURO: no escribe en el contexto ni conoce el transporte. Resuelve,
 * compone, delega en `SmtpNodeMailerService` y devuelve `data`; es
 * `FsmEngineService` quien la deposita en el `outputNamespace`.
 *
 * TODOS los fallos son GRAVE. Es el unico nivel que entra en la politica de
 * reintentos del motor, y los dos desenlaces malos que quedan lo justifican: una
 * configuracion incompleta la corrige el operador con el flujo PAUSADO (CU-09),
 * y un SMTP que no responde es el caso de manual para un reintento con backoff.
 */
@Injectable()
export class SmtpAlertStrategy implements INodeStrategy {
  public readonly nodeType = NodeType.DESTINO_SMTP;

  /**
   * Las seis claves que este nodo deposita en su namespace.
   *
   * `accepted_count` y `rejected_count` van como numeros y no como los arreglos
   * que devuelve el proveedor: lo que un nodo de aguas abajo o una plantilla
   * pueden querer interpolar es "a cuantos llego", y publicar las direcciones
   * las arrastraria al `contexto_acumulado` de cada checkpoint posterior. El
   * detalle nominal queda en la traza del envio.
   */
  public readonly outputFields: readonly NodeOutputField[] = [
    {
      name: 'alert_sent',
      type: 'text',
      description:
        'Si el correo llego a salir. `false` cuando el transporte SMTP fallo y el nodo degrado el desenlace para no enterrar la incidencia original',
    },
    { name: 'sent_to', type: 'object', description: 'Destinatarios del aviso' },
    { name: 'subject', type: 'text', description: 'Asunto ya interpolado' },
    {
      name: 'message_id',
      type: 'text',
      description: 'Identificador que devolvio el servidor SMTP',
    },
    { name: 'accepted_count', type: 'number' },
    { name: 'rejected_count', type: 'number' },
    { name: 'sent_at', type: 'text', description: 'Marca ISO-8601 del envio' },
    // `resume_token_hash` y `token_expires_at` SE PUBLICAN en el payload pero
    // NO se declaran aqui, y la omision es deliberada: `outputFields` es lo que
    // el explorador de variables ofrece para construir marcadores, y la huella
    // de una credencial no es un dato que ningun prompt ni ningun asunto deba
    // poder citar. Quien las lee es `InboundEmailResumeService`, que recorre el
    // contexto buscando la clave y no consulta este catalogo.
  ];

  /** El mismo DTO que valida `execute`, ahora tambien al GUARDAR el esquema. */
  public readonly paramsSchema = SmtpAlertConfigDto;

  private readonly logger = new Logger(SmtpAlertStrategy.name);

  constructor(
    private readonly mailer: SmtpNodeMailerService,
    private readonly configService: ConfigService,
  ) {}

  public async execute(
    context: StatePayloadContext,
    params: Record<string, unknown>,
  ): Promise<NodeResult> {
    // GUARDA DE PERTINENCIA, y va ANTES de `resolveConfig` a proposito: si no
    // hay nada que alertar, no se valida la configuracion ni se abre el
    // transporte SMTP. Es la diferencia entre un no-op barato y una conexion
    // que puede tardar o fallar por un correo que nadie iba a querer.
    //
    // SE PREGUNTA POR LA EVIDENCIA, NO POR EL ESTADO. Comprobar literalmente
    // que la ejecucion este en PAUSADO no funcionaria: un DESTINO_SMTP colgado
    // de una ruta `onErrorStep` corre mientras la ejecucion sigue EN_PROCESO
    // —solo pasa a PAUSADO despues, cuando el motor aplica el protocolo de
    // resiliencia—, asi que esa comprobacion haria que la alerta no se enviara
    // NUNCA. `error_context` es el namespace que el motor siembra justo antes
    // de desviar el flujo, de modo que su presencia ES la condicion que
    // interesa. De paso, la estrategia no necesita repositorio de ejecuciones.
    const errorEvidence = context.getNamespace(ERROR_CONTEXT_NAMESPACE);

    if (
      errorEvidence === undefined ||
      Object.keys(errorEvidence).length === 0
    ) {
      this.logger.log(
        'Alerta SMTP omitida: la ejecucion no presenta error_context, de modo que no hay incidencia que notificar.',
      );

      return {
        success: true,
        data: { skipped: true, reason: 'EXECUTION_NOT_PAUSED' },
      };
    }

    // SEGUNDA GUARDA: la severidad. La anterior comprueba que haya incidencia;
    // esta, que merezca interrumpir a alguien. Un `LEVE` describe un fallo que
    // el motor cierra solo —no pausa, no reserva cursor y el sondeo vuelve en
    // un minuto—, de modo que un correo por cada uno llena el buzon del
    // operador de avisos que no exigen nada y acaba enterrando los GRAVE que si.
    // Va igualmente ANTES de `resolveConfig`, por el mismo motivo que la otra:
    // no abrir un transporte SMTP para un correo que no se va a mandar.
    const detectedLevel = readText(errorEvidence, 'error_level');

    if (detectedLevel !== 'GRAVE' && detectedLevel !== 'URGENTE') {
      this.logger.log(
        `Alerta SMTP omitida: la severidad detectada (${detectedLevel ?? 'NONE'}) no justifica interrumpir a nadie.`,
      );

      return {
        success: true,
        data: {
          skipped: true,
          reason: 'SEVERITY_NOT_ALERTABLE',
          detectedLevel: detectedLevel ?? 'NONE',
        },
      };
    }

    const resolution = await this.resolveConfig(params);

    if ('failure' in resolution) {
      return { success: false, error: resolution.failure };
    }

    const { config } = resolution;
    const { subject, unresolvedVariable } = this.resolveSubject(
      context,
      config,
    );

    // --- TESTIGO DE REANUDACION, solo cuando va a servir de algo.
    //
    // Dos condiciones, y las dos importan:
    //
    // 1. La severidad es GRAVE. Es la UNICA que acaba en una pausa reanudable:
    //    `closeTerminalState` llama a `pauseAt` para GRAVE y cierra sin cursor
    //    para URGENTE —irrecuperable— y para LEVE. Ofrecer un codigo de
    //    reanudacion sobre una ejecucion que no va a quedar PAUSADO es
    //    prometer una salida que no existe: quien respondiera al correo
    //    recibiria un rechazo por "testigo desconocido".
    //
    // 2. El canal de ordenes esta encendido. `INBOUND_RESUME_ENABLED` apagado
    //    significa que nadie lee ningun buzon de vuelta, asi que las
    //    instrucciones mandarian a la persona a escribir a un sitio donde no
    //    hay nadie. El testigo entra por la via del buzon del propio flujo
    //    (`ImapTriggerStrategy` delega) o por la del buzon de ordenes, pero
    //    las dos cuelgan de esta misma bandera.
    //
    // Del testigo solo se persiste la huella, igual que en `PAUSA_FLOW`: el
    // contexto acumulado se devuelve por la API y se escribe en cada
    // checkpoint, de modo que guardarlo en claro repartiria la credencial.
    // Es de un solo uso sin necesidad de tabla: al reanudar, la ejecucion deja
    // de estar PAUSADO y deja de ser candidata.
    const resumeToken =
      detectedLevel === 'GRAVE' &&
      this.configService.get<string>('INBOUND_RESUME_ENABLED') === 'true'
        ? generateResumeToken()
        : null;

    const letter = {
      ...this.buildLetterParams(context, config, unresolvedVariable),
      ...(resumeToken === null
        ? {}
        : { resumeInstructions: buildResumeInstructions(resumeToken) }),
    };

    try {
      const receipt = await this.mailer.sendNodeAlert({
        to: config.to,
        cc: config.cc,
        ...(config.replyTo !== null ? { replyTo: config.replyTo } : {}),
        subject,
        text: buildAlertEmailText(letter),
        html: buildAlertEmailHtml(letter),
      });

      this.logger.log(
        `Aviso entregado a ${receipt.accepted.length}/${config.to.length} destinatario(s). message_id=${receipt.messageId}`,
      );

      return {
        success: true,
        data: {
          alert_sent: true,
          sent_to: [...config.to],
          subject,
          message_id: receipt.messageId,
          accepted_count: receipt.accepted.length,
          rejected_count: receipt.rejected.length,
          sent_at: new Date().toISOString(),
          // La huella viaja en el namespace de ESTE nodo y no en uno reservado:
          // `InboundEmailResumeService.findExecutionByToken` recorre todos los
          // namespaces del contexto buscando la clave, asi que no hace falta
          // acordar un sitio fijo — y el motor hace checkpoint del contexto
          // entero al pausar, de modo que queda persistida sin tocar el motor.
          ...(resumeToken === null
            ? {}
            : {
                resume_token_hash: hashResumeToken(resumeToken),
                token_expires_at: buildResumeTokenExpiry(),
              }),
        },
      };
    } catch (error) {
      const reason =
        error instanceof Error
          ? error.message
          : 'Fallo desconocido al entregar el aviso por SMTP.';

      // EXITO DEGRADADO, y no un fallo del nodo. Este nodo SOLO corre como
      // contingencia —sus dos guardas exigen `error_context` y una severidad
      // alertable—, de modo que cuando llega aqui ya hay una incidencia en
      // curso que alguien tiene que atender.
      //
      // Devolver `GRAVE` hacia que el motor pausara EN EL NODO DE ALERTA,
      // enterrando el fallo que se estaba anunciando: la fila apuntaba al
      // mensajero y no al problema, y el reintento manual de CU-09 ofrecia
      // reenviar un correo en vez de reparar el paso que se rompio. Con un
      // exito degradado la ejecucion sigue hasta `closeTerminalState`, que pausa
      // en `contingency.failedNodeId` con la severidad ORIGINAL.
      //
      // Tampoco `LEVE`: aquel cierra la ejecucion como FALLIDO y SIN cursor, de
      // modo que se perderia esa misma reanudacion.
      //
      // El aviso queda en la traza y en el payload: `alert_sent` es lo que
      // permite a un nodo posterior —o a la trazabilidad— distinguir "no habia
      // nada que avisar" de "no se pudo avisar".
      this.logger.warn(
        `No se pudo despachar el correo de alerta a ${config.to.length} destinatario(s): ${reason}. La ejecucion continua; la incidencia original sigue siendo la que importa.`,
      );

      return {
        success: true,
        data: {
          alert_sent: false,
          reason,
          attempted_to: [...config.to],
          subject,
        },
      };
    }
  }

  /**
   * Namespaces que este nodo necesita, derivados de su propio asunto.
   *
   * No hay lista fija porque no la puede haber: lo que el nodo lee depende por
   * completo de los marcadores que el operador haya escrito. Declarar un
   * conjunto fijo rechazaria como invalido un asunto legitimamente distinto.
   *
   * Solo mira `params.subject`. `customMessage` no se interpola, y `to`, `cc` y
   * `replyTo` son direcciones literales: que lo sigan siendo es lo que impide
   * que quien escribe al buzon del flujo elija a quien avisa el sistema.
   *
   * Un nodo SIN `subject` declarado no exige nada, aunque acabe usando
   * `DEFAULT_ALERT_SUBJECT` y este cite `trigger`. Es correcto por dos motivos
   * que se refuerzan: el motor ya excluye el namespace reservado del disparador
   * de esta comprobacion, y el asunto por defecto tiene respaldo, asi que no
   * poder resolverlo nunca impide la ejecucion.
   *
   * PURO Y SINCRONO, como exige el contrato.
   */
  public getRequiredNamespaces(
    params: Record<string, unknown>,
  ): readonly string[] {
    return typeof params.subject === 'string'
      ? [...new Set(extractNamespaceRoots(params.subject))]
      : [];
  }

  /**
   * Sin destinatario no hay aviso que enviar.
   *
   * Es el UNICO obligatorio. A quien avisar no lo puede adivinar el sistema; el
   * asunto si —`DEFAULT_ALERT_SUBJECT`— y el cuerpo lo compone entero. Exigir el
   * asunto bloquearia el asistente por un campo que el backend sabe rellenar,
   * que es un Poka-Yoke al reves.
   *
   * Lo consulta `assertActivatable`, de modo que el flujo se GUARDA a medias
   * —es un borrador, y una plantilla de flujo lo esta siempre— pero no se ACTIVA.
   */
  public getIncompleteParams(
    params: Record<string, unknown>,
  ): readonly string[] {
    return Array.isArray(params.to) && params.to.length > 0 ? [] : ['to'];
  }

  /**
   * Valida `params` y aplica los valores por defecto.
   *
   * Se usa `validate` y NO `validateOrReject`: esta ultima lanza, y el motor
   * normaliza toda excepcion a URGENTE, que `canRetry` nunca reintenta.
   */
  private async resolveConfig(
    params: Record<string, unknown>,
  ): Promise<SmtpConfigResolution> {
    const dto = plainToInstance(SmtpAlertConfigDto, params);
    const errors = await validate(dto, VALIDATION_OPTIONS);

    if (errors.length > 0) {
      return {
        failure: {
          level: 'GRAVE',
          code: ERR_SMTP_CONFIG,
          message: `Configuracion invalida del nodo de alerta: ${errors
            .flatMap((error) => Object.values(error.constraints ?? {}))
            .join(' ')}`,
          missingFields: errors.map((error) => error.property),
        },
      };
    }

    // Guarda de COMPLETITUD, distinta de la del DTO. El DTO valida la forma de
    // lo que haya, y admite la ausencia para que una plantilla de flujo pueda
    // contener este nodo; esta comprobacion responde la otra pregunta, la que
    // solo importa al ejecutar. Reutiliza `getIncompleteParams` para que el
    // criterio de "completo" sea literalmente el mismo que aplica
    // `assertActivatable`, y no dos listas que diverjan a la primera correccion.
    const incomplete = this.getIncompleteParams(params);

    if (incomplete.length > 0) {
      return {
        failure: {
          level: 'GRAVE',
          code: ERR_SMTP_CONFIG,
          message: `Faltan params obligatorios del nodo de alerta: ${incomplete.join(', ')}.`,
          missingFields: [...incomplete],
        },
      };
    }

    return { config: resolveSmtpAlertConfig(dto) };
  }

  /**
   * Resuelve el asunto efectivo contra el contexto, SIN poder fallar.
   *
   * Dos escalones. El primero elige que se interpola: lo que el operador
   * declaro, o `DEFAULT_ALERT_SUBJECT` si lo dejo vacio —borrar el campo es una
   * accion legitima, no un error—.
   *
   * El segundo es el que define este nodo. `getInterpolatedValue` LANZA cuando
   * una ruta no resuelve, y en cualquier otro nodo eso debe detener el flujo:
   * publicar una noticia con el titular en blanco es peor que no publicarla.
   * Aqui la aritmetica se invierte. Este nodo es la ULTIMA via por la que una
   * persona se entera de la incidencia, asi que negarse a enviar por una errata
   * en el asunto deja el fallo original sin testigo ademas de sin arreglar. Se
   * envia con el asunto de respaldo.
   *
   * El diagnostico no se pierde, cambia de sitio: la variable culpable viaja al
   * pie de la carta y al log. En vez de un flujo PAUSADO que nadie mira, la
   * misconfiguracion llega impresa en el correo que la persona ya esta leyendo.
   *
   * Es tambien el motivo de que `ERR_SMTP_INTERPOLATION` ya no exista: era el
   * codigo de `bodyTemplate`, y mantenerlo exportado sin nada que lo emitiera
   * dejaria un codigo que `catchErrors` puede declarar y que no se disparara
   * jamas — el fallo mudo que la regla 10 del validador existe para impedir.
   */
  private resolveSubject(
    context: StatePayloadContext,
    config: ResolvedSmtpAlertConfig,
  ): ResolvedSubject {
    const declared = config.subject?.trim() ?? '';
    const effective = declared.length > 0 ? declared : DEFAULT_ALERT_SUBJECT;

    try {
      const subject = context.getInterpolatedValue(effective);

      // Una plantilla que interpola a nada deja el buzon con una linea en
      // blanco donde deberia estar el aviso. No puede pasar por resolver.
      return subject.trim().length > 0
        ? { subject }
        : { subject: SAFE_FALLBACK_SUBJECT };
    } catch (error) {
      if (!(error instanceof MissingContextVariableException)) {
        // Imprevisto de verdad: que lo normalice el motor a URGENTE.
        throw error;
      }

      this.logger.warn(
        `El asunto del aviso cita "${error.variable}", que no existe en el contexto. Se envia con el asunto de respaldo.`,
      );

      return {
        subject: SAFE_FALLBACK_SUBJECT,
        unresolvedVariable: error.variable,
      };
    }
  }

  /**
   * Reune lo que la carta necesita del contexto.
   *
   * Todo lo del fallo es OPCIONAL y se omite si no esta. `error_context` solo
   * existe cuando el motor desvio por `onErrorStep`; un `DESTINO_SMTP` en el
   * camino feliz llega aqui sin nada de eso, y la carta debe salir igual sin
   * escribir `undefined` en el correo que lee una persona.
   *
   * El identificador del flujo sale de `getWorkflowId()` y no de un namespace:
   * ni `trigger` ni `error_context` llevan identidad del flujo, y el getter es
   * el unico sitio donde esta.
   */
  private buildLetterParams(
    context: StatePayloadContext,
    config: ResolvedSmtpAlertConfig,
    unresolvedSubjectVariable?: string,
  ): AlertEmailParams {
    const errorContext = context.getNamespace(ERROR_CONTEXT_NAMESPACE);
    const partialData = readPartialData(errorContext);
    const note = config.customMessage?.trim() ?? '';

    return {
      flowId: context.getWorkflowId(),
      timestamp: new Date().toISOString(),
      ...(readText(errorContext, 'failed_node_id') !== undefined
        ? { failedNodeId: readText(errorContext, 'failed_node_id') }
        : {}),
      ...(readText(errorContext, 'failed_node_type') !== undefined
        ? { failedNodeType: readText(errorContext, 'failed_node_type') }
        : {}),
      ...(readText(errorContext, 'error_code') !== undefined
        ? { errorCode: readText(errorContext, 'error_code') }
        : {}),
      ...(readText(errorContext, 'error_level') !== undefined
        ? { errorLevel: readText(errorContext, 'error_level') }
        : {}),
      ...(readText(errorContext, 'error_message') !== undefined
        ? { errorMessage: readText(errorContext, 'error_message') }
        : {}),
      // El conteo de intentos viene del motor (`error_context.attempts`), que a
      // su vez prefiere el que declara la estrategia. Importa en el correo
      // porque cambia la decision de quien lo lee: "fallo una vez" invita a
      // reintentar a mano, "fallo tras agotar tres intentos" dice que el
      // problema esta en el otro extremo.
      ...(readNumber(errorContext, 'attempts') !== undefined
        ? { attempts: readNumber(errorContext, 'attempts') }
        : {}),
      ...(readNumber(errorContext, 'max_retries') !== undefined
        ? { maxRetries: readNumber(errorContext, 'max_retries') }
        : {}),
      ...(readText(errorContext, 'error_description') !== undefined
        ? { errorDescription: readText(errorContext, 'error_description') }
        : {}),
      ...(note.length > 0 ? { customNote: note } : {}),
      ...(partialData !== undefined ? { partialData } : {}),
      ...(unresolvedSubjectVariable !== undefined
        ? { unresolvedSubjectVariable }
        : {}),
    };
  }
}
