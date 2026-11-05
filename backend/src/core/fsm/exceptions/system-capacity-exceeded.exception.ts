import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * El motor ya atiende el maximo de ejecuciones simultaneas que admite.
 *
 * NO es un fallo: es contrapresion. El trabajo rechazado sigue pendiente y
 * volvera a intentarse solo —el correo sigue sin leer en el buzon, el cron
 * vencera de nuevo—, asi que quien la recibe debe esperar, no diagnosticar.
 *
 * Extiende `HttpException` y no `Error`, a diferencia del resto de excepciones
 * propias del proyecto (`StrategyNotFoundException`, `LlmProviderException`), por
 * dos motivos concretos:
 *
 * 1. `createExecution` se alcanza tambien desde `POST /workflows/:id/execute-test`,
 *    y ahi el codigo de estado viaja al cliente: con un `Error` corriente ese
 *    endpoint devolveria un 500 en lugar del 429 que describe la situacion.
 * 2. Los `dispatchFlow` de los disparadores discriminan por `instanceof
 *    HttpException` para distinguir un rechazo del motor de una averia de red.
 *    Con un `Error` corriente la excepcion se propagaria hasta `pollInbox`, que
 *    la registraria como «falla critica de conexion IMAP» y levantaria una
 *    alerta GRAVE en `alertas_error` por cada ciclo saturado.
 *
 * Quien la capture debe hacerlo ANTES de su rama generica de `HttpException`:
 * esta clase tambien lo es, y la rama generica la absorberia primero.
 */
export class SystemCapacityExceededException extends HttpException {
  constructor(
    /** Ejecuciones EN_PROCESO en todo el motor al evaluar la guarda. */
    public readonly activeCount: number,
    /** Techo vigente, segun `MAX_GLOBAL_CONCURRENT_EXECUTIONS`. */
    public readonly maxAllowed: number,
  ) {
    super(
      `Capacidad del motor agotada: ${activeCount}/${maxAllowed} ejecuciones EN_PROCESO en todo el sistema. Reintentalo cuando alguna termine.`,
      HttpStatus.TOO_MANY_REQUESTS,
    );
    this.name = 'SystemCapacityExceededException';
  }
}
