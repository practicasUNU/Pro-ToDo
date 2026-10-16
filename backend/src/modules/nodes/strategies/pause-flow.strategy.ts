import { Injectable, Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { SmtpNodeMailerService } from '@common/services/smtp-node-mailer.service';
import {
  buildAlertEmailHtml,
  buildAlertEmailText,
} from '@common/utils/alert-email.template';
import {
  PauseFlowConfigDto,
  PauseTriggerMode,
  resolvePauseFlowConfig,
} from '@modules/nodes/dto/pause-flow-config.dto';

import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import type {
  INodeStrategy,
  NodeOutputField,
  NodeResult,
} from '@core/fsm/types/node-strategy.types';
import type { ResolvedPauseFlowConfig } from '@modules/nodes/dto/pause-flow-config.dto';
import type { ValidatorOptions } from 'class-validator';

/** Configuracion invalida o incompleta del nodo de pausa. */
export const ERR_PAUSE_CONFIG = 'ERR_PAUSE_CONFIG';

/** Motivo que viaja en `NodeResult.pause` y en el evento `flow:paused`. */
export const PROGRAMMED_PAUSE_REASON = 'PROGRAMMED_AUTO_PAUSE';

/**
 * `whitelist` descarta claves desconocidas y `forbidNonWhitelisted` las delata.
 * Mismo criterio que el resto de estrategias: un `params` con una clave mal
 * escrita debe dar un diagnostico, no ignorarse en silencio.
 */
const VALIDATION_OPTIONS: ValidatorOptions = {
  whitelist: true,
  forbidNonWhitelisted: true,
};

/** Espera no bloqueante. Aislada para poder sustituirla en las pruebas. */
const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Detiene el flujo A PROPOSITO, dejandolo reanudable.
 *
 * NO ES UN FALLO, y esa es toda su razon de ser. Hasta ahora la unica forma de
 * que una ejecucion quedara en PAUSADO era que algo se rompiera, asi que un
 * flujo que debe esperar una validacion humana —el visto bueno de redaccion
 * antes de publicar— no tenia como expresarlo: o se publicaba solo, o alguien
 * desactivaba el flujo entero y perdia el contexto de la ejecucion en curso.
 *
 * El nodo devuelve `pause` y el motor hace el resto: deja la ejecucion en
 * PAUSADO con el cursor en el paso SIGUIENTE —no en este, que ya se ejecuto—,
 * pasa el flujo a PAUSADO y da de baja su sondeo. De ahi solo se sale por
 * CU-09, con un operador delante.
 *
 * `pauseMode` NO elige quien reanuda, sino CUANDO se congela: en el acto o tras
 * un retardo. El retardo transcurre dentro de `execute`, con la ejecucion viva
 * ocupando una plaza de la capacidad global, y por eso el DTO lo acota a
 * `MAX_PAUSE_DELAY_SECONDS`. Para detener un flujo durante horas la herramienta
 * correcta es darlo de baja, que no consume nada mientras espera.
 */
@Injectable()
export class PauseFlowStrategy implements INodeStrategy {
  public readonly nodeType = NodeType.PAUSA_FLOW;

  /**
   * Lo que este nodo deja en `pause_context`.
   *
   * Existe para que la trazabilidad pueda explicar una ejecucion que termina a
   * medias sin ningun error asociado: sin estas claves, un PAUSADO deliberado y
   * uno provocado por un fallo se leerian igual en la tabla.
   */
  public readonly outputFields: readonly NodeOutputField[] = [
    {
      name: 'paused_at',
      type: 'text',
      description: 'Marca ISO-8601 del momento en que se congelo el flujo',
    },
    {
      name: 'pause_mode',
      type: 'text',
      description: 'IMMEDIATE o DELAYED, segun lo configurado',
    },
    {
      name: 'delayed_seconds',
      type: 'number',
      description: 'Segundos que el nodo espero antes de congelar',
    },
    {
      name: 'message',
      type: 'text',
      description: 'Explicacion que el operador dejo configurada',
    },
    {
      name: 'notified',
      type: 'text',
      description: 'Destinatario avisado por correo, o cadena vacia',
    },
  ];

  /** El mismo DTO que valida `execute`, ahora tambien al GUARDAR el esquema. */
  public readonly paramsSchema = PauseFlowConfigDto;

  private readonly logger = new Logger(PauseFlowStrategy.name);

  constructor(private readonly mailer: SmtpNodeMailerService) {}

  public async execute(
    context: StatePayloadContext,
    params: Record<string, unknown>,
  ): Promise<NodeResult> {
    const dto = plainToInstance(PauseFlowConfigDto, params);
    const errors = await validate(dto, VALIDATION_OPTIONS);

    if (errors.length > 0) {
      return {
        success: false,
        error: {
          level: 'GRAVE',
          code: ERR_PAUSE_CONFIG,
          message: `Configuracion invalida del nodo de pausa: ${errors
            .flatMap((error) => Object.values(error.constraints ?? {}))
            .join(' ')}`,
          missingFields: errors.map((error) => error.property),
        },
      };
    }

    const config = resolvePauseFlowConfig(dto);
    const incomplete = this.getIncompleteParams(params);

    if (incomplete.length > 0) {
      return {
        success: false,
        error: {
          level: 'GRAVE',
          code: ERR_PAUSE_CONFIG,
          message: `El nodo de pausa esta incompleto: faltan [${incomplete.join(', ')}].`,
          missingFields: [...incomplete],
        },
      };
    }

    if (config.delaySeconds > 0) {
      this.logger.log(
        `Pausa diferida: el flujo se congelara en ${config.delaySeconds} s.`,
      );
      await sleep(config.delaySeconds * 1_000);
    }

    // El aviso va DESPUES de la espera y ANTES de devolver: se anuncia la pausa
    // que efectivamente ocurre, no la que estaba prevista. Un fallo de correo
    // NO convierte esto en un error —la pausa es el trabajo del nodo y el correo
    // una cortesia—, asi que se registra y se sigue.
    const notified = await this.notifyIfRequested(context, config);

    return {
      success: true,
      data: {
        paused_at: new Date().toISOString(),
        pause_mode: config.pauseMode,
        delayed_seconds: config.delaySeconds,
        message: config.message,
        notified,
        // Redundante con `pause` a proposito: aquel gobierna la transicion y
        // este deja el motivo legible en el contexto que persiste el checkpoint.
        shouldPause: true,
        pauseReason: PROGRAMMED_PAUSE_REASON,
      },
      pause: { reason: PROGRAMMED_PAUSE_REASON },
    };
  }

  /**
   * Sin destinatario no hay aviso que enviar, y sin retardo no hay pausa diferida.
   *
   * Los dos campos son condicionales: solo se exigen cuando el operador activo
   * la opcion que los necesita. Lo consulta `assertActivatable`, de modo que el
   * flujo se GUARDA a medias —una plantilla lo esta siempre— pero no se ACTIVA.
   */
  public getIncompleteParams(
    params: Record<string, unknown>,
  ): readonly string[] {
    const missing: string[] = [];

    if (
      params.notifyOnPause === true &&
      (typeof params.notificationRecipient !== 'string' ||
        params.notificationRecipient.trim().length === 0)
    ) {
      missing.push('notificationRecipient');
    }

    if (
      params.pauseMode === PauseTriggerMode.DELAYED &&
      typeof params.delaySeconds !== 'number'
    ) {
      missing.push('delaySeconds');
    }

    return missing;
  }

  /**
   * Envia el aviso informativo de pausa, si se pidio.
   *
   * Devuelve el destinatario avisado o cadena vacia, que es lo que acaba en
   * `pause_context.notified`. Reutiliza la carta institucional en vez de
   * redactar un correo suelto, pero cambiandole el titulillo: encabezar una
   * suspension deliberada con "Notificacion de Incidencia" diria justo lo
   * contrario de lo que ha pasado, y el enunciado del nodo es explicito en que
   * no debe alertar de gravedad tecnica.
   */
  private async notifyIfRequested(
    context: StatePayloadContext,
    config: ResolvedPauseFlowConfig,
  ): Promise<string> {
    if (!config.notifyOnPause || config.notificationRecipient === null) {
      return '';
    }

    const flowName = this.resolveFlowName(context);

    try {
      await this.mailer.sendNodeAlert({
        to: [config.notificationRecipient],
        subject: `[PROTO-DO] Flujo pausado: ${flowName}`,
        text: buildAlertEmailText({
          flowId: context.getWorkflowId(),
          timestamp: new Date().toISOString(),
          headline: 'Aviso de pausa programada',
          title: 'Flujo en suspension controlada',
          customNote: config.message,
        }),
        html: buildAlertEmailHtml({
          flowId: context.getWorkflowId(),
          timestamp: new Date().toISOString(),
          headline: 'Aviso de pausa programada',
          title: 'Flujo en suspension controlada',
          customNote: config.message,
        }),
      });

      return config.notificationRecipient;
    } catch (error: unknown) {
      this.logger.warn(
        `El aviso de pausa no pudo enviarse a ${config.notificationRecipient}: ${
          error instanceof Error ? error.message : 'causa desconocida'
        }. La pausa se aplica igualmente.`,
      );

      return '';
    }
  }

  /** Nombre legible del flujo, con el identificador como respaldo. */
  private resolveFlowName(context: StatePayloadContext): string {
    const trigger = context.getNamespace('trigger');
    const name = trigger?.flow_name;

    return typeof name === 'string' && name.trim().length > 0
      ? name
      : context.getWorkflowId();
  }
}
