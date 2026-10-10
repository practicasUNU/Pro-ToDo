import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Techos de saturacion del motor FSM, declarados en el entorno.
 *
 * Hasta ahora TODAS las barreras del sistema eran por flujo: la guarda de
 * reentrada de los disparadores, el cupo de `createExecution` y el indice unico
 * parcial `idx_flujo_activo`. Cincuenta flujos con una ejecucion cada uno las
 * respetan las tres y aun asi dejan el pool de PostgreSQL sin conexiones libres
 * y la memoria del proceso repartida entre cincuenta navegadores headless. Esta
 * clase aporta lo que faltaba: un limite que mira al motor ENTERO.
 *
 * Existe como clase y no como dos `configService.get(...)` sueltos por el mismo
 * motivo que `AiDefaultsConfig` y `DrupalApiConfig`: son valores de
 * INFRAESTRUCTURA, y tenerlos aqui permite instanciar el motor en una prueba con
 * un doble de dos getters en vez de con un `ConfigService` entero.
 *
 * NO valida en el constructor ni lanza si falta algo. Una errata en el `.env` no
 * puede impedir el arranque del contenedor: avisa y cae al valor por defecto.
 */

/** Ejecuciones EN_PROCESO simultaneas que admite el motor en su conjunto. */
export const MAX_GLOBAL_CONCURRENT_EXECUTIONS_VAR =
  'MAX_GLOBAL_CONCURRENT_EXECUTIONS';

/** Despachos que un disparador puede encadenar dentro de un mismo ciclo. */
export const MAX_EXECUTIONS_PER_POLL_TICK_VAR = 'MAX_EXECUTIONS_PER_POLL_TICK';

/**
 * Techo global por defecto.
 *
 * Cinco, y no mas, porque el pool de PostgreSQL vale diez (`DB_POOL_MAX`): cada
 * ejecucion viva consume al menos una conexion para su checkpoint, y dejar la
 * mitad del pool libre es lo que permite que el API siga respondiendo mientras
 * el motor trabaja a plena carga.
 */
export const DEFAULT_MAX_GLOBAL_CONCURRENT_EXECUTIONS = 5;

/**
 * Despachos por ciclo de sondeo por defecto.
 *
 * Son SECUENCIALES —`dispatchFlow` espera al pipeline entero antes de volver—,
 * asi que este numero no multiplica la concurrencia: multiplica el ritmo al que
 * se drena un buzon atrasado. Con uno solo, cien correos acumulados tardaban
 * cien ciclos en procesarse.
 */
export const DEFAULT_MAX_EXECUTIONS_PER_POLL_TICK = 3;

@Injectable()
export class FsmConfig {
  private readonly logger = new Logger(FsmConfig.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Ejecuciones EN_PROCESO simultaneas que admite el motor en su conjunto.
   *
   * Complementa, y no sustituye, a `MAX_CONCURRENT_EXECUTIONS_PER_FLOW`: aquel
   * impide que un flujo se pise a si mismo, este impide que la suma de todos
   * tumbe el proceso.
   */
  public get maxGlobalConcurrentExecutions(): number {
    return (
      this.readPositiveInt(MAX_GLOBAL_CONCURRENT_EXECUTIONS_VAR) ??
      DEFAULT_MAX_GLOBAL_CONCURRENT_EXECUTIONS
    );
  }

  /** Despachos que un disparador puede encadenar dentro de un mismo ciclo. */
  public get maxExecutionsPerPollTick(): number {
    return (
      this.readPositiveInt(MAX_EXECUTIONS_PER_POLL_TICK_VAR) ??
      DEFAULT_MAX_EXECUTIONS_PER_POLL_TICK
    );
  }

  /**
   * Entero ESTRICTAMENTE POSITIVO, o `null`.
   *
   * El cero se rechaza a proposito en los dos casos. Un techo global de cero no
   * limita: paraliza el motor entero sin que nada lo anuncie, y un lote de cero
   * deja el buzon sin sondear. Para apagar el disparo ya existe
   * `IMAP_POLLING_ENABLED`, que ademas lo dice por su nombre.
   *
   * Se rechaza tambien el decimal: `Number('2.5')` es finito, pero media
   * ejecucion no significa nada y dejarlo pasar solo esconde la errata.
   */
  private readPositiveInt(variable: string): number | null {
    const raw = this.configService.get<string>(variable)?.trim();

    if (raw === undefined || raw.length === 0) {
      return null;
    }

    const parsed = Number(raw);

    if (!Number.isInteger(parsed) || parsed < 1) {
      this.logger.warn(
        `${variable}="${raw}" no es un numero entero mayor o igual que 1. Se ignora y se usara el valor por defecto.`,
      );

      return null;
    }

    return parsed;
  }
}
