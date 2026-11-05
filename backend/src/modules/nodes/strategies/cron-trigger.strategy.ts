import { Injectable, Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CronTime } from 'cron';

import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import {
  CronTriggerConfigDto,
  resolveCronConfig,
} from '@modules/nodes/dto/cron-trigger-config.dto';

import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import type {
  INodeStrategy,
  NodeOutputField,
  NodeResult,
} from '@core/fsm/types/node-strategy.types';
import type { ResolvedCronTriggerConfig } from '@modules/nodes/dto/cron-trigger-config.dto';
import type { ValidatorOptions } from 'class-validator';

/** Codigo de fallo del nodo. Es lo que un `catchErrors` puede mencionar. */
export const ERR_CRON_CONFIG = 'ERR_CRON_CONFIG';

/**
 * Una clave desconocida en `params` es un rechazo y no una omision: un
 * `cronExpresion` mal escrito debe fallar aqui y no dejar el nodo corriendo con
 * una programacion que nadie configuro.
 */
const VALIDATION_OPTIONS: ValidatorOptions = {
  whitelist: true,
  forbidNonWhitelisted: true,
};

/**
 * Estrategia del nodo TRIGGER_CRON (disparador programado).
 *
 * ES UN NODO INFORMATIVO, y conviene entender por que. El disparo real no
 * ocurre aqui: lo hace `CronSchedulingService`, que mantiene un `CronJob` por
 * flujo y llama a `WorkflowsService.runAutomaticWorkflow(flowId)` cuando vence.
 * Ese camino crea la ejecucion con contexto VACIO y arranca el grafo por su
 * `entrypoint`, que es justamente este nodo. No existe ningun canal por el que
 * el planificador pueda inyectar datos del tick en la estrategia:
 * `execute(context, params)` solo recibe el contexto acumulado y los parametros
 * del esquema. Asi que este nodo no puede "recibir" el disparo, solo constatarlo
 * y publicar su marca temporal para los nodos de aguas abajo.
 *
 * Aun asi es obligatoria, y no por simetria: sin una estrategia registrada,
 * `NodeStrategyFactory.getStrategy(TRIGGER_CRON)` lanza `StrategyNotFoundException`
 * en el primer tick, el motor la normaliza a URGENTE y el flujo muere siempre en
 * su primer paso. Ademas es el unico punto que valida `params` en tiempo de
 * ejecucion por la via del contrato `NodeResult`: el planificador los valida por
 * su cuenta, pero puede estar deshabilitado por bandera, y `params` se persiste
 * como JSONB sin validacion por tipo.
 *
 * El `outputNamespace` del DTO es informativo y puede diferir del declarado en
 * el `pipeline_schema`; el efectivo para escribir es siempre el del esquema.
 *
 * TODOS los fallos son GRAVE, igual que en `ImapTriggerStrategy`. Aqui el nodo
 * no hace ninguna E/S, asi que en la practica la unica rama de fallo es la
 * validacion —y reintentar una configuracion invalida es inutil, porque `params`
 * no cambia entre reintentos—. Se mantiene GRAVE de todos modos porque lo que
 * importa no es el reintento sino el estado final: GRAVE deja el flujo PAUSADO y
 * reanudable por CU-09, mientras que URGENTE no lo seria.
 */
@Injectable()
export class CronTriggerStrategy implements INodeStrategy {
  public readonly nodeType = NodeType.TRIGGER_CRON;

  /**
   * Las cuatro claves que este nodo deposita en su namespace.
   *
   * El ORDEN y los nombres replican el `data` que construye `execute`, que es
   * la unica fuente: declarar aqui una lista que se escriba a mano por separado
   * es exactamente la desincronizacion que `INodeStrategy.outputFields` existe
   * para evitar.
   *
   * `next_run_at` se declara `text` aunque `resolveNextRun` degrade a `null`
   * cuando `CronTime` no sabe calcular el vencimiento: el tipo describe QUE ES
   * el campo para quien lo interpola, no si puede faltar. Una interpolacion de
   * un valor nulo resuelve a cadena vacia, que es el comportamiento de
   * `getInterpolatedValue` para cualquier clave ausente.
   *
   * Ninguna es `url`: una expresion cron y tres marcas de tiempo no son
   * direcciones, y ofrecerlas al selector del EXTRACTOR_WEB seria el error de
   * tipeo que la regla 8 del validador de topologia viene a impedir.
   */
  public readonly outputFields: readonly NodeOutputField[] = [
    {
      name: 'triggered_at',
      type: 'text',
      description: 'Marca ISO del instante de ejecucion, no del tick',
    },
    {
      name: 'cron_expression',
      type: 'text',
      description: 'Programacion configurada en el nodo',
    },
    {
      name: 'time_zone',
      type: 'text',
      description: 'Zona horaria con la que se interpreta la expresion',
    },
    {
      name: 'next_run_at',
      type: 'text',
      description: 'Proximo vencimiento en ISO, o vacio si no se pudo calcular',
    },
  ];

  private readonly logger = new Logger(CronTriggerStrategy.name);

  public async execute(
    _context: StatePayloadContext,
    params: Record<string, unknown>,
  ): Promise<NodeResult> {
    const dto = plainToInstance(CronTriggerConfigDto, params);
    const errors = await validate(dto, VALIDATION_OPTIONS);

    // Se usa `validate` y NO `validateOrReject`: esta ultima lanza, y el motor
    // normaliza toda excepcion a URGENTE, que `canRetry` nunca reintenta y que
    // no deja el flujo en el estado reanudable que CU-09 necesita.
    if (errors.length > 0) {
      const constraints = errors.flatMap((error) =>
        Object.values(error.constraints ?? {}),
      );

      return {
        success: false,
        error: {
          level: 'GRAVE',
          code: ERR_CRON_CONFIG,
          message: `Configuracion invalida del nodo CRON: ${constraints.join(' ')}`,
          missingFields: errors.map((error) => error.property),
        },
      };
    }

    const config = resolveCronConfig(dto);

    return {
      success: true,
      data: {
        // Claves en snake_case: la expresion de interpolacion de plantillas
        // (`{{nodo.campo}}`) solo reconoce `[a-zA-Z0-9_]`.
        //
        // Es el instante de EJECUCION, no el del tick que la origino: entre uno
        // y otro median la creacion de la ejecucion y el arranque del motor.
        // Quien necesite el instante teorico tiene la expresion y la zona.
        triggered_at: new Date().toISOString(),
        cron_expression: config.cronExpression,
        time_zone: config.timeZone,
        next_run_at: this.resolveNextRun(config),
      },
    };
  }

  /**
   * Calcula el proximo vencimiento, o `null` si no se puede.
   *
   * Degrada a `null` en lugar de fallar a proposito. `CronTime` lanza
   * `CronError` con una zona horaria que `Intl` acepta pero luxon no, y este
   * campo es puramente de observabilidad: hacer fallar el nodo por el seria
   * regalar un modo de fallo a cambio de nada.
   */
  private resolveNextRun(config: ResolvedCronTriggerConfig): string | null {
    try {
      const nextRun = new CronTime(
        config.cronExpression,
        config.timeZone,
      ).sendAt();

      return nextRun.toISO();
    } catch (error) {
      this.logger.warn(
        `No se pudo calcular el proximo vencimiento de "${config.cronExpression}" en la zona "${config.timeZone}": ${error instanceof Error ? error.message : String(error)}`,
      );

      return null;
    }
  }
}
