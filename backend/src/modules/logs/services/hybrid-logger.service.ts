import { Injectable, Logger } from '@nestjs/common';
// Import de VALOR y no `import type`: `ConfigService` se inyecta por constructor,
// y con `emitDecoratorMetadata` un `import type` se borra al transpilar, dejando
// `design:paramtypes` en `Object`. Nest no podria resolver la dependencia.
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createLogger, format } from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

import { LogNodo, NodeLogStatus } from '@modules/logs/entities/log-nodo.entity';

import type { NodeErrorSeverity } from '@core/fsm/types/node-strategy.types';
import type { Repository } from 'typeorm';
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
 * Prefijo del archivo de trazas por nodo.
 *
 * Fichero aparte del de incidencias, y no un nivel mas dentro del mismo: aquel
 * lleva el contexto acumulado ENTERO y se consulta cuando algo se rompio; este
 * es un caudal continuo de una linea por nodo ejecutado. Mezclarlos obligaria a
 * filtrar el ruido de miles de lineas correctas para encontrar la autopsia.
 */
const EXECUTION_FILE_PREFIX = 'execution';

/** Longitud de `logs_nodo.codigo_error`. */
const ERROR_CODE_MAX_LENGTH = 100;

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
 * Desenlace de un nodo, tal como lo observa el motor.
 *
 * `payloadSnapshot` es opcional y va SOLO al archivo, nunca a la columna: el
 * contexto acumulado crece con cada nodo, y guardarlo en cada fila multiplicaria
 * la tabla por el tamano del payload sin aportar nada que el archivo no tenga.
 */
export interface NodeExecutionDetails {
  readonly executionId: string;
  readonly nodeId: string | null;
  readonly nodeType: string | null;
  readonly status: NodeLogStatus;
  readonly severity?: NodeErrorSeverity | undefined;
  readonly errorCode?: string | undefined;
  readonly message?: string | undefined;
  readonly stackTrace?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly payloadSnapshot?: Record<string, unknown> | undefined;
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

  /** Volcados forenses de los fallos catastroficos. */
  private readonly winston: WinstonLogger;

  /** Traza continua, una linea por nodo ejecutado. */
  private readonly executionWinston: WinstonLogger;

  private readonly logDir: string;

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(LogNodo)
    private readonly logNodoRepo: Repository<LogNodo>,
  ) {
    this.logDir =
      this.configService.get<string>(LOG_DIR_KEY) ?? DEFAULT_LOG_DIR;

    this.winston = createLogger({
      // Nivel fijo `error` y NO `LOG_LEVEL`: este logger existe solo para los
      // volcados forenses. Atarlo al nivel general significaria que subir la
      // aplicacion a `warn` haria desaparecer en silencio la traza de los fallos
      // catastroficos, que es justo la que nunca puede faltar.
      level: 'error',
      format: this.buildFormat(),
      transports: [this.buildTransport(FILE_PREFIX)],
    });

    this.executionWinston = createLogger({
      // `info` y no `error`, y esto NO es intercambiable: la traza por nodo
      // incluye los nodos que terminan bien, y sobre un logger a nivel `error`
      // una linea de exito se descartaria EN SILENCIO. El fichero quedaria con
      // solo los fallos y pareceria que el resto no se ejecuto.
      level: 'info',
      format: this.buildFormat(),
      transports: [this.buildTransport(EXECUTION_FILE_PREFIX)],
    });
  }

  /**
   * Formato comun: marca de tiempo y JSON.
   *
   * JSON y no texto plano porque las dos trazas llevan objetos anidados —el
   * contexto acumulado en una, el payload del nodo en la otra— y en texto
   * quedarian como "[object Object]".
   */
  private buildFormat(): ReturnType<typeof format.combine> {
    return format.combine(format.timestamp(), format.json());
  }

  /** Transporte rotado diario para el prefijo indicado. */
  private buildTransport(prefix: string): DailyRotateFile {
    return new DailyRotateFile({
      dirname: this.logDir,
      filename: `${prefix}-%DATE%.log`,
      datePattern: DATE_PATTERN,
      maxFiles:
        this.configService.get<string>(LOG_MAX_FILES_KEY) ?? DEFAULT_MAX_FILES,
      maxSize:
        this.configService.get<string>(LOG_MAX_SIZE_KEY) ?? DEFAULT_MAX_SIZE,
      // El directorio puede no existir en un despliegue limpio.
      createSymlink: false,
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

      return this.resolveCurrentPath(FILE_PREFIX);
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
   * Registra el desenlace de UN nodo en los dos destinos del modelo hibrido.
   *
   * NO LANZA NUNCA, igual que `logCatastrophicFailure` y por el mismo motivo: se
   * invoca desde el bucle del motor, y una excepcion aqui sustituiria el
   * resultado real del nodo por un fallo de registro. Un flujo no puede caerse
   * porque no se pudo anotar que funciono.
   *
   * Los dos destinos van en `try/catch` SEPARADOS y no en uno comun: si la base
   * de datos no responde, la traza de disco sigue siendo valiosa, y al reves
   * tambien. Media traza es mejor que ninguna, y agrupar los dos en un solo
   * manejador convertiria cualquier fallo del primero en la perdida del segundo.
   *
   * El disco va PRIMERO por la misma razon que en el volcado catastrofico: este
   * metodo cubre tambien el caso de que PostgreSQL sea justo lo que esta
   * fallando, y entonces el archivo es el unico rastro que va a quedar.
   */
  public async logNodeExecution(details: NodeExecutionDetails): Promise<void> {
    const logFilePath = this.writeNodeTrace(details);

    try {
      await this.logNodoRepo.save(
        this.logNodoRepo.create({
          executionId: details.executionId,
          nodeId: details.nodeId,
          nodeType: details.nodeType,
          status: details.status,
          severity: details.severity ?? null,
          // Se recorta al ancho de la columna: un codigo mas largo es un error
          // de quien lo declaro, pero perder la fila entera por eso seria peor.
          errorCode: details.errorCode?.slice(0, ERROR_CODE_MAX_LENGTH) ?? null,
          message: details.message ?? null,
          durationMs: details.durationMs ?? null,
          httpStatusCode: null,
          logFilePath,
        }),
      );
    } catch (error: unknown) {
      this.logger.error(
        `No se pudo persistir la traza del nodo "${details.nodeId ?? 'desconocido'}" (ejecucion "${details.executionId}"): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Escribe la linea de traza en el archivo rotado y devuelve su ruta.
   *
   * @returns Ruta del archivo, o `null` si no se pudo escribir — que es lo que
   *          acaba en `logs_nodo.ruta_archivo_log`. "Hubo ejecucion, no hay
   *          archivo" es informacion honesta; una ruta a un archivo inexistente
   *          seria una pista falsa.
   */
  private writeNodeTrace(details: NodeExecutionDetails): string | null {
    try {
      this.executionWinston.info({
        message: details.message ?? details.status,
        executionId: details.executionId,
        nodeId: details.nodeId,
        nodeType: details.nodeType,
        status: details.status,
        level_fsm: details.severity ?? null,
        errorCode: details.errorCode ?? null,
        durationMs: details.durationMs ?? null,
        stackTrace: details.stackTrace ?? null,
        payload: details.payloadSnapshot ?? null,
      });

      return this.resolveCurrentPath(EXECUTION_FILE_PREFIX);
    } catch (error: unknown) {
      this.logger.error(
        `No se pudo volcar a disco la traza del nodo "${details.nodeId ?? 'desconocido'}": ${
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
  private resolveCurrentPath(prefix: string): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');

    return `${this.logDir}/${prefix}-${year}-${month}-${day}.log`;
  }
}
