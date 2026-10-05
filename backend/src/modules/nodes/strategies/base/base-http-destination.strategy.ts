import { Logger } from '@nestjs/common';

import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import type {
  INodeStrategy,
  NodeErrorDetail,
  NodeResult,
} from '@core/fsm/types/node-strategy.types';
import type { NodeType } from '@core/fsm/types/pipeline-schema.types';
import type { HttpClientService } from '@core/http/http-client.service';
import type { ClassConstructor } from 'class-transformer';

/**
 * Estado HTTP neutro de los fallos sin respuesta (DNS, timeout, conexion
 * rechazada). `HttpClientStatusOutcome` deja `status` sin definir en ese caso.
 */
const NEUTRAL_STATUS = 0;

/**
 * Transporte comun de los nodos de DESTINO que publican por HTTP.
 *
 * Primera clase abstracta del backend: las demas estrategias implementan
 * `INodeStrategy` directamente. Se introduce aqui porque `DESTINO_DRUPAL` y el
 * futuro `DESTINO_ACENS` —que ya tiene fila en el catalogo `nodos` a la espera
 * de su estrategia— comparten exactamente dos cosas: el cliente HTTP con su
 * politica de reintentos y la traduccion del estado de respuesta a la taxonomia
 * de errores de la FSM. Todo lo demas (el dialecto de la API, la forma del
 * payload de salida) es de cada destino.
 *
 * ## Que NO sube aqui, y por que
 *
 * El armado del `NodeResult` se queda en cada subclase. `mapHttpFailure`
 * devuelve un `NodeErrorDetail` y no un `NodeResult` entero porque el `data` de
 * una respuesta fallida es una decision del nodo concreto: `DrupalHttpStrategy`
 * publica en TODOS sus resultados —exito y fallo— las seis claves que declara
 * en `outputFields`, de modo que el asistente nunca ofrezca una variable que en
 * fallo no exista. Un helper que devolviera `{ success: false, error }` a secas
 * borraria esa paridad en cada ruta de error.
 */
export abstract class BaseHttpDestinationStrategy implements INodeStrategy {
  /** Tipo del catalogo que esta estrategia atiende. Lo fija la subclase. */
  public abstract readonly nodeType: NodeType;

  /** DTO contra el que el validador de topologia comprueba los `params`. */
  public abstract readonly paramsSchema?: ClassConstructor<object>;

  protected readonly logger: Logger;

  /**
   * @param httpClient cliente con reintentos y backoff ya resueltos.
   * @param loggerContext nombre que precede a cada traza; la subclase pasa el
   *   suyo (`DrupalHttpStrategy.name`) para que el log siga nombrando a la
   *   clase concreta y no a esta base, que no le dice nada al operador.
   */
  constructor(
    protected readonly httpClient: HttpClientService,
    loggerContext: string,
  ) {
    this.logger = new Logger(loggerContext);
  }

  public abstract execute(
    context: StatePayloadContext,
    params: Record<string, unknown>,
  ): Promise<NodeResult>;

  /**
   * Traduce el estado HTTP crudo al par (codigo, nivel) del nodo.
   *
   * TODOS los niveles son GRAVE, y es una decision, no una simplificacion.
   * `FsmEngineService.canRetry` reintenta UNICAMENTE los GRAVE, y es ademas el
   * unico nivel que deja la ejecucion en PAUSADO conservando el `activeCursor`,
   * que es lo que habilita el reintento manual de CU-09.
   *
   * Las dos alternativas hacen lo contrario de lo que hace falta:
   *
   * - LEVE cierra la ejecucion en FALLIDO con `activeCursor: null`, de modo que
   *   no queda nada que reanudar. Un 503 marcado LEVE dejaria el contenido sin
   *   publicar y sin ninguna via —automatica ni manual— de recuperarlo.
   * - URGENTE declara el fallo irrecuperable, y un `socket hang up` o un
   *   timeout son justo lo contrario: una indisponibilidad pasajera que se
   *   resuelve sola en cuanto vuelve la conectividad.
   *
   * Los codigos SI se reparten, porque lo que enruta un `catchErrors` es el
   * `code` y cada familia manda al operador a un sitio distinto: el `.env`, el
   * CMS o la red.
   *
   * @param base fallo tal y como lo emitio `HttpClientService`.
   * @param status estado de la respuesta, o `undefined` si no hubo ninguna.
   * @param errorPrefix raiz de los codigos del nodo, sin barra final
   *   (`'ERR_DRUPAL'` produce `ERR_DRUPAL_AUTH`).
   * @param operation que se estaba haciendo, en infinitivo y en espanol, para
   *   componer el mensaje que leera el operador en la trazabilidad.
   */
  protected mapHttpFailure(
    base: NodeErrorDetail,
    status: number | undefined,
    errorPrefix: string,
    operation: string,
  ): NodeErrorDetail {
    return {
      ...base,
      level: 'GRAVE',
      code: this.resolveErrorCode(status, errorPrefix),
      message: `Fallo al ${operation}: ${base.message}`,
    };
  }

  /**
   * Reparto del codigo por familia de estado.
   *
   * El orden importa: la ausencia de estado se comprueba ANTES que los rangos,
   * porque `undefined` no es comparable con `>=` y caeria en la rama generica.
   */
  protected resolveErrorCode(
    status: number | undefined,
    errorPrefix: string,
  ): string {
    if (status === undefined || status === NEUTRAL_STATUS) {
      return `${errorPrefix}_NETWORK`;
    }

    if (status === 401 || status === 403) {
      return `${errorPrefix}_AUTH`;
    }

    if (status >= 500) {
      return `${errorPrefix}_SERVER`;
    }

    return `${errorPrefix}_REQUEST`;
  }
}
