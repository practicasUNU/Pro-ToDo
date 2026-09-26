import { Injectable, Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  MissingContextVariableException,
  extractNamespaceRoots,
} from '@core/fsm/context/state-payload.context';
import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { SmtpNodeMailerService } from '@common/services/smtp-node-mailer.service';
import {
  SmtpAlertConfigDto,
  resolveSmtpAlertConfig,
} from '@modules/nodes/dto/smtp-alert-config.dto';

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
export const ERR_SMTP_INTERPOLATION = 'ERR_SMTP_INTERPOLATION';
export const ERR_SMTP_SEND_FAILURE = 'ERR_SMTP_SEND_FAILURE';

/** Opciones de validacion canonicas del repositorio. */
const VALIDATION_OPTIONS: ValidatorOptions = {
  whitelist: true,
  forbidNonWhitelisted: true,
};

/** Union discriminada: o hay configuracion, o hay un fallo que devolver. */
type SmtpConfigResolution =
  | { readonly config: ResolvedSmtpAlertConfig }
  | { readonly failure: NodeErrorDetail };

/** Union discriminada del mensaje ya interpolado contra el contexto. */
type MessageResolution =
  | { readonly subject: string; readonly text: string }
  | { readonly failure: NodeErrorDetail };

/** Traza completa del error, si la hay, lista para fusionar en el detalle. */
const stackTraceOf = (error: unknown): { stackTrace?: string } =>
  error instanceof Error && error.stack !== undefined
    ? { stackTrace: error.stack }
    : {};

/**
 * Nodo `DESTINO_SMTP`: avisa por correo de lo que esta pasando en el flujo.
 *
 * Es el destino que da sentido practico a `onErrorStep`. Hasta ahora el motor
 * sabia desviar ante un fallo, pero todos los desvios posibles terminaban en
 * otro nodo automatico: no habia forma de que una incidencia alcanzase a una
 * persona sin que alguien abriese la trazabilidad por su cuenta. Su pareja
 * natural es el namespace `error_context`, que el motor siembra justo antes de
 * saltar y del que este nodo interpola el que, el donde y el por que.
 *
 * NO esta limitado a la rama de error: es un nodo mas del grafo y puede
 * colocarse en el camino feliz para confirmar una publicacion. Lo que no hace es
 * decidir nada — es terminal por vocacion, y de ahi su categoria `DESTINO`.
 *
 * NODO PURO: no escribe en el contexto ni conoce el transporte. Interpola,
 * delega en `SmtpNodeMailerService` y devuelve `data`; es `FsmEngineService`
 * quien la deposita en el `outputNamespace`.
 *
 * TODOS los fallos son GRAVE. Es el unico nivel que entra en la politica de
 * reintentos del motor, y los tres desenlaces malos de este nodo lo justifican:
 * una configuracion incompleta y un marcador que no resuelve los corrige el
 * operador con el flujo PAUSADO (CU-09), y un SMTP que no responde es el caso
 * de manual para un reintento con backoff.
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
  ];

  /** El mismo DTO que valida `execute`, ahora tambien al GUARDAR el esquema. */
  public readonly paramsSchema = SmtpAlertConfigDto;

  private readonly logger = new Logger(SmtpAlertStrategy.name);

  constructor(private readonly mailer: SmtpNodeMailerService) {}

  public async execute(
    context: StatePayloadContext,
    params: Record<string, unknown>,
  ): Promise<NodeResult> {
    const resolution = await this.resolveConfig(params);

    if ('failure' in resolution) {
      return { success: false, error: resolution.failure };
    }

    const { config } = resolution;
    const message = this.buildMessage(context, config);

    if ('failure' in message) {
      return { success: false, error: message.failure };
    }

    try {
      const receipt = await this.mailer.sendNodeAlert({
        to: config.to,
        cc: config.cc,
        ...(config.replyTo !== null ? { replyTo: config.replyTo } : {}),
        subject: message.subject,
        text: message.text,
      });

      this.logger.log(
        `Aviso entregado a ${receipt.accepted.length}/${config.to.length} destinatario(s). message_id=${receipt.messageId}`,
      );

      return {
        success: true,
        data: {
          sent_to: [...config.to],
          subject: message.subject,
          message_id: receipt.messageId,
          accepted_count: receipt.accepted.length,
          rejected_count: receipt.rejected.length,
          sent_at: new Date().toISOString(),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          level: 'GRAVE',
          code: ERR_SMTP_SEND_FAILURE,
          message:
            error instanceof Error
              ? error.message
              : 'Fallo desconocido al entregar el aviso por SMTP.',
          ...stackTraceOf(error),
        },
      };
    }
  }

  /**
   * Namespaces que este nodo necesita, derivados de sus propias plantillas.
   *
   * No hay lista fija porque no la puede haber: lo que el nodo lee depende por
   * completo de los marcadores que el operador haya escrito en el asunto y el
   * cuerpo. Un aviso que solo cite `{{error_context.error_message}}` depende de
   * `error_context`; uno que resuma la publicacion, de `llm_response`. Declarar
   * un conjunto fijo rechazaria como invalido cualquiera de los dos.
   *
   * PURO Y SINCRONO, como exige el contrato: solo mira `params`. `to`, `cc` y
   * `replyTo` no se inspeccionan porque son direcciones literales, no plantillas.
   */
  public getRequiredNamespaces(
    params: Record<string, unknown>,
  ): readonly string[] {
    const templates = [params.subject, params.bodyTemplate].filter(
      (value): value is string => typeof value === 'string',
    );

    // `Set` para no declarar dos veces el mismo namespace cuando el asunto y el
    // cuerpo citan ambos `error_context`, que es el caso corriente.
    return [
      ...new Set(
        templates.flatMap((template) => extractNamespaceRoots(template)),
      ),
    ];
  }

  /**
   * Sin destinatario, asunto o cuerpo no hay aviso que enviar.
   *
   * Los tres son decisiones operativas concretas del flujo y no admiten defecto:
   * a quien avisar no lo puede adivinar el sistema. Lo consulta
   * `assertActivatable`, de modo que el flujo se GUARDA a medias —es un
   * borrador, y una plantilla de flujo lo esta siempre— pero no se ACTIVA asi.
   */
  public getIncompleteParams(
    params: Record<string, unknown>,
  ): readonly string[] {
    const missing: string[] = [];

    if (!Array.isArray(params.to) || params.to.length === 0) {
      missing.push('to');
    }

    for (const field of ['subject', 'bodyTemplate'] as const) {
      const value = params[field];

      if (typeof value !== 'string' || value.trim().length === 0) {
        missing.push(field);
      }
    }

    return missing;
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

    const config = resolveSmtpAlertConfig(dto);

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

    return { config };
  }

  /**
   * Interpola asunto y cuerpo contra el contexto acumulado.
   *
   * `getInterpolatedValue` LANZA si la ruta no resuelve, de modo que la
   * excepcion se captura aqui y se traduce a GRAVE: dejarla salir la
   * normalizaria el motor a URGENTE, que `canRetry` nunca reintenta y que el
   * operador no puede corregir desde el flujo PAUSADO.
   *
   * Los dos campos se resuelven juntos y el primer fallo corta: enviar un aviso
   * con el asunto bueno y el cuerpo a medias seria peor que no enviarlo, porque
   * quien lo reciba creeria estar leyendo la incidencia completa.
   */
  private buildMessage(
    context: StatePayloadContext,
    config: ResolvedSmtpAlertConfig,
  ): MessageResolution {
    try {
      return {
        subject: context.getInterpolatedValue(config.subject ?? ''),
        text: context.getInterpolatedValue(config.bodyTemplate ?? ''),
      };
    } catch (error) {
      if (error instanceof MissingContextVariableException) {
        return {
          failure: {
            level: 'GRAVE',
            code: ERR_SMTP_INTERPOLATION,
            message: `No se pudo resolver el aviso contra el contexto: ${error.message}`,
            missingFields: [error.variable],
            ...stackTraceOf(error),
          },
        };
      }

      // Imprevisto de verdad: que lo normalice el motor a URGENTE.
      throw error;
    }
  }
}
