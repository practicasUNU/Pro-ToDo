import { Injectable, Logger } from '@nestjs/common';
// Import de VALOR y no `import type`: `ConfigService` se inyecta por constructor,
// y con `emitDecoratorMetadata` un `import type` se borra al transpilar, dejando
// `design:paramtypes` en `Object`. Nest no podria resolver la dependencia.
import { ConfigService } from '@nestjs/config';
import { createLogger, format } from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

import type { NodeErrorSeverity } from '@core/fsm/types/node-strategy.types';
import type { Logger as WinstonLogger } from 'winston';

/** Directorio raiz de los volcados. Relativo al cwd del proceso. */
const LOG_DIR_KEY = 'LOG_DIR';
const DEFAULT_LOG_DIR = 'logs';

/** Retencion y tamano de la rotacion diaria. */
const LOG_MAX_FILES_KEY = 'LOG_MAX_FILES';
const DEFAULT_MAX_FILES = '14d';
const LOG_MAX_SIZE_KEY = 'LOG_MAX_SIZE';
const DEFAULT_MAX_SIZE = '20m';

/** Patron de fecha del archivo rotado; debe casar con `resolveCurrentPath`. */
const DATE_PATTERN = 'YYYY-MM-DD';

/** Prefijo del archivo de incidencias del motor. */
const FILE_PREFIX = 'fsm';

/**
 * Datos que acompanan a un volcado catastrofico.
 *
 * `payload` es el contexto acumulado en el momento del fallo. Se vuelca ENTERO y
 * no solo el namespace del nodo culpable: reproducir el fallo exige saber con que
 * entraba el nodo, y eso incluye lo que dejaron los anteriores.
 */
export interface CatastrophicFailureDetails {
  readonly executionId: string;
  readonly flowId: string;
  /** Nodo en el que se detuvo el cursor, o `null` si fallo antes de resolverlo. */
  readonly nodeId: string | null;
  readonly level: NodeErrorSeverity;
  readonly message: string;
  readonly stackTrace?: string | undefined;
  readonly payload: Record<string, Record<string, unknown>>;
}

/**
 * Volcado hibrido de fallos del motor FSM (`architecture-patterns.md` §4).
 *
 * HIBRIDO significa dos destinos con dos propositos distintos, y por eso el
 * servicio existe en lugar de un `logger.error` a secas:
 *
 * 1. **Archivo fisico** (aqui): el stack trace completo, el payload entrante y
 *    los metadatos tecnicos. Es el material forense, demasiado voluminoso para
 *    una columna y demasiado valioso para perderlo.
 * 2. **PostgreSQL** (el llamante): la fila de trazabilidad con la severidad y la
 *    RUTA de ese archivo. Es lo que la interfaz puede listar y filtrar.
 *
 * De ahi que `logCatastrophicFailure` DEVUELVA la ruta: es el unico eslabon que
 * une los dos destinos. Sin ese valor de retorno la fila de la base de datos
 * sabria que hubo un fallo pero no donde mirar, y el archivo seria un volcado
 * huerfano que nadie encontraria.
 *
 * El logger de Nest se conserva en paralelo para la salida por consola: en
 * desarrollo nadie mira el archivo, y en produccion el archivo es lo unico que
 * sobrevive al reinicio del contenedor.
 */
@Injectable()
export class HybridLoggerService {
  private readonly logger = new Logger(HybridLoggerService.name);

  private readonly winston: WinstonLogger;

  private readonly logDir: string;

  constructor(private readonly configService: ConfigService) {
    this.logDir =
      this.configService.get<string>(LOG_DIR_KEY) ?? DEFAULT_LOG_DIR;

    this.winston = createLogger({
      // Nivel fijo `error` y NO `LOG_LEVEL`: este logger existe solo para los
      // volcados forenses. Atarlo al nivel general significaria que subir la
      // aplicacion a `warn` haria desaparecer en silencio la traza de los fallos
      // catastroficos, que es justo la que nunca puede faltar.
      level: 'error',
      format: format.combine(
        format.timestamp(),
        // JSON y no texto plano: el volcado lleva el contexto acumulado, que es
        // un objeto anidado. En texto quedaria como "[object Object]".
        format.json(),
      ),
      transports: [
        new DailyRotateFile({
          dirname: this.logDir,
          filename: `${FILE_PREFIX}-%DATE%.log`,
          datePattern: DATE_PATTERN,
          maxFiles:
            this.configService.get<string>(LOG_MAX_FILES_KEY) ??
            DEFAULT_MAX_FILES,
          maxSize:
            this.configService.get<string>(LOG_MAX_SIZE_KEY) ??
            DEFAULT_MAX_SIZE,
          // El directorio puede no existir en un despliegue limpio.
          createSymlink: false,
        }),
      ],
    });
  }

  /**
   * Vuelca un fallo catastrofico a disco y devuelve la ruta del archivo.
   *
   * NO LANZA NUNCA. Se invoca desde el manejador de errores del motor, y una
   * excepcion aqui —disco lleno, permisos del volumen— sustituiria el fallo real
   * por uno de registro, dejando la ejecucion sin marcar y el diagnostico
   * original perdido. Si el volcado falla se registra por consola y se devuelve
   * `null`, que el llamante persiste tal cual: "hubo fallo, no hay archivo" es
   * informacion honesta, y "hubo fallo" sin fila es una perdida.
   *
   * @returns Ruta relativa del archivo, o `null` si no se pudo escribir.
   */
  public logCatastrophicFailure(
    details: CatastrophicFailureDetails,
  ): string | null {
    try {
      this.winston.error({
        message: details.message,
        level_fsm: details.level,
        executionId: details.executionId,
        flowId: details.flowId,
        nodeId: details.nodeId,
        stackTrace: details.stackTrace ?? null,
        payload: details.payload,
      });

      return this.resolveCurrentPath();
    } catch (error: unknown) {
      this.logger.error(
        `No se pudo volcar a disco el fallo de la ejecucion "${details.executionId}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      return null;
    }
  }

  /**
   * Ruta del archivo al que escribe la rotacion en este momento.
   *
   * Se COMPONE en vez de preguntarsela al transporte: `DailyRotateFile` solo
   * publica el nombre resuelto en su evento `new`, que es asincrono respecto a
   * la escritura, de modo que el primer volcado del dia devolveria `undefined`
   * justo cuando mas importa. La fecha se formatea a mano con el mismo
   * `DATE_PATTERN` que se le pasa al transporte; si uno cambia, cambia el otro.
   *
   * En hora LOCAL y no UTC, igual que hace el transporte por defecto: una ruta
   * que no case con el archivo real es peor que no tener ruta.
   */
  private resolveCurrentPath(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');

    return `${this.logDir}/${FILE_PREFIX}-${year}-${month}-${day}.log`;
  }
}
