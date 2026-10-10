import { Injectable, Logger } from '@nestjs/common';
// Import de VALOR y no `import type`: `ConfigService` se inyecta por constructor,
// y con `emitDecoratorMetadata` un `import type` se borra al transpilar, dejando
// `design:paramtypes` en `Object`. Nest no podria resolver la dependencia.
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createLogger, format } from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

import { AlertaError } from '@modules/logs/entities/alerta-error.entity';
import { LogNodo, NodeLogStatus } from '@modules/logs/entities/log-nodo.entity';

import type { AlertLevel } from '@modules/logs/entities/alerta-error.entity';

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
 * Texto de la alerta cuando el fallo no traia mensaje.
 *
 * Una alerta sin descripcion seria una fila que el operador no puede ni empezar
 * a interpretar. El vinculo con `logs_nodo` le dara el nodo y el codigo; esto
 * solo evita una celda vacia.
 */
const DEFAULT_ALERT_MESSAGE = 'Error operativo no tipado';

/**
 * Severidades que escalan a `alertas_error`.
 *
 * `LEVE` NO esta, y no es un olvido: es el fallo que cierra sin pausar porque se
 * reintenta solo en el siguiente sondeo. Alertar de cada uno llenaria la bandeja
 * de avisos que nadie tiene que atender —el timeout IMAP por si solo son decenas
 * al dia— y el ruido acabaria enterrando lo que si importa.
 */
const ALERT_LEVELS: readonly NodeErrorSeverity[] = ['GRAVE', 'URGENTE'];

/**
 * Guarda de tipo sobre `ALERT_LEVELS`.
 *
 * Existe porque `Array.includes` comprueba en tiempo de ejecucion pero no
 * estrecha el tipo: sin esto habria que asegurar el valor con `as AlertLevel`,
 * y ese aserto sobreviviria a cualquier cambio futuro de la lista sin avisar.
 */
const isAlertLevel = (
  severity: NodeErrorSeverity | undefined,
): severity is AlertLevel =>
  severity !== undefined && ALERT_LEVELS.includes(severity);

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
 * Acuse de la traza de un nodo: donde quedo, en disco y en la tabla.
 *
 * Se devuelve un OBJETO y no la ruta pelada porque los dos destinos del modelo
 * hibrido tienen identificadores distintos y el llamante necesita los dos:
 * `logFilePath` es lo que el motor persiste en `ejecuciones_flujo` para que la
 * interfaz pueda senalar el archivo forense de una ejecucion pausada, y
 * `logNodeId` es el unico eslabon hacia `alertas_error`, que enlaza por
 * `id_log_nodo` y no guarda ruta propia.
 *
 * Los dos campos son independientes: cada destino tiene su propio `try/catch`,
 * asi que una traza puede quedar en disco y no en la tabla, o al reves.
 */
export interface NodeTraceReceipt {
  /** Ruta del `execution-*.log`, o `null` si no se pudo escribir. */
  readonly logFilePath: string | null;
  /** Clave de la fila de `logs_nodo`, o `null` si no se pudo persistir. */
  readonly logNodeId: string | null;
}

/**
 * Averia de un proceso que corre FUERA de una ejecucion FSM.
 *
 * El caso que la motiva es el worker de sondeo IMAP: si la conexion no responde,
 * el flujo no llega a despacharse y por tanto no hay `executionId` ni nodo al
 * que colgar el fallo. Es la averia mas grave que puede tener un disparador y la
 * unica que nadie ve, porque su sintoma es que no pasa nada.
 */
export interface WorkerFailureDetails {
  readonly flowId: string;
  /** Proceso que fallo (`ImapPollingService`...). Va al archivo, no a la fila. */
  readonly source: string;
  readonly level: AlertLevel;
  readonly message: string;
  readonly stackTrace?: string | undefined;
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
 *
 * Sobre esos dos destinos hay un TERCERO, condicional: los fallos GRAVE y
 * URGENTE escalan ademas a `alertas_error`. No es una copia de la traza sino su
 * contrario — `logs_nodo` es el caudal (una fila por nodo, tambien los que van
 * bien) y `alertas_error` es la senal, con la marca de atendida que el caudal no
 * puede tener. Sin esa separacion un fallo grave queda como una fila mas entre
 * cientos, y nadie revisa un caudal continuo buscando la aguja.
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
    @InjectRepository(AlertaError)
    private readonly alertaRepo: Repository<AlertaError>,
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
   *
   * Devolver el acuse no compromete el contrato de no lanzar: las tres
   * sentencias del cuerpo ya estan protegidas por su propio manejador, y el
   * `return` no introduce ninguna ruta de excepcion nueva.
   *
   * @returns Donde quedo la traza. Ambos campos pueden ser `null` de forma
   *          independiente: "hubo ejecucion, no hay archivo" es informacion
   *          honesta, igual que en `logCatastrophicFailure`.
   */
  public async logNodeExecution(
    details: NodeExecutionDetails,
  ): Promise<NodeTraceReceipt> {
    const logFilePath = this.writeNodeTrace(details);

    // Declarado FUERA del `try` para seguir siendo visible despues del `catch`:
    // la alerta se intenta aunque la traza no se haya podido guardar.
    let savedLog: LogNodo | null = null;

    try {
      savedLog = await this.logNodoRepo.save(
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

    await this.raiseOperationalAlert(details, savedLog);

    return { logFilePath, logNodeId: savedLog?.id ?? null };
  }

  /**
   * Registra la averia de un worker: al archivo de incidencias y a la bandeja.
   *
   * Es el hermano de `logNodeExecution` para lo que ocurre fuera del motor. No
   * escribe en `logs_nodo` y no podria: esa tabla cuelga de `ejecuciones_flujo`
   * por clave ajena, y el sentido de este metodo es justamente que no hay
   * ejecucion. La alerta se atribuye al flujo.
   *
   * Va al archivo de INCIDENCIAS (`fsm-%DATE%.log`) y no al de ejecucion: este
   * no es un eslabon del caudal de nodos sino una autopsia, que es para lo que
   * existe aquel.
   *
   * NO LANZA NUNCA, como el resto del servicio. Se invoca desde el `catch` de un
   * callback de `setInterval`, donde una excepcion que escapara terminaria el
   * proceso de Node entero.
   *
   * QUIEN DECIDE SI LLAMAR ES EL LLAMANTE, no este metodo: el worker sabe si la
   * averia es nueva o es el mismo fallo repitiendose cada minuto, y ese dato no
   * viaja hasta aqui.
   */
  public async logWorkerFailure(details: WorkerFailureDetails): Promise<void> {
    try {
      this.winston.error({
        message: details.message,
        level_fsm: details.level,
        flowId: details.flowId,
        source: details.source,
        stackTrace: details.stackTrace ?? null,
      });
    } catch (error: unknown) {
      this.logger.error(
        `No se pudo volcar a disco la averia del worker "${details.source}" (flujo "${details.flowId}"): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    try {
      await this.alertaRepo.save(
        this.alertaRepo.create({
          executionId: null,
          flowId: details.flowId,
          logNodeId: null,
          level: details.level,
          errorMessage: details.message,
          resolved: false,
        }),
      );
    } catch (error: unknown) {
      this.logger.error(
        `No se pudo registrar la alerta ${details.level} del worker "${details.source}" (flujo "${details.flowId}"): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Escala el fallo a `alertas_error` si su severidad lo exige.
   *
   * SE DECIDE POR LA SEVERIDAD Y NO POR EL ESTADO: el motor ya mapea `LEVE` a
   * `ADVERTENCIA` y `GRAVE`/`URGENTE` a `ERROR`, asi que comprobar tambien el
   * estado seria redundante y crearia dos fuentes de verdad para la misma
   * decision, que es como se desincronizan.
   *
   * UNA ALERTA POR INTENTO, igual que la traza. Colapsarlas en una sola ocultaria
   * que el motor reintento cinco veces antes de rendirse, que es justo el dato
   * que distingue un fallo transitorio de uno permanente.
   *
   * SE INTENTA AUNQUE LA TRAZA NO SE HAYA GUARDADO, con `logNodeId` nulo. Si la
   * base de datos esta fallando es cuando menos se puede permitir perder el
   * aviso; el vinculo es lo prescindible, no la alerta.
   *
   * NO LANZA NUNCA, con el mismo criterio que el resto del servicio: se invoca
   * desde el bucle del motor, y un fallo al registrar la alerta no puede tumbar
   * la ejecucion que la provoco.
   */
  private async raiseOperationalAlert(
    details: NodeExecutionDetails,
    savedLog: LogNodo | null,
  ): Promise<void> {
    const { severity } = details;

    if (!isAlertLevel(severity)) {
      return;
    }

    try {
      await this.alertaRepo.save(
        this.alertaRepo.create({
          executionId: details.executionId,
          // Nulo: esta alerta nacio DENTRO de una ejecucion, asi que ya se
          // atribuye por ella. `flowId` es para lo que ocurre fuera del motor.
          flowId: null,
          logNodeId: savedLog?.id ?? null,
          level: severity,
          // El motor ya resolvio aqui el `customMessage` de la ruta de error
          // cuando el nodo lo declara para este codigo, asi que lo que llega es
          // el texto que el operador debe leer.
          errorMessage: details.message ?? DEFAULT_ALERT_MESSAGE,
          resolved: false,
        }),
      );
    } catch (error: unknown) {
      this.logger.error(
        `No se pudo registrar la alerta ${severity} del nodo "${details.nodeId ?? 'desconocido'}" (ejecucion "${details.executionId}"): ${
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
