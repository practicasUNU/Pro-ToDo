import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { FsmExecution } from '@core/fsm/entities/fsm-execution.entity';
import { LogNodo, NodeLogStatus } from '@modules/logs/entities/log-nodo.entity';
import {
  resolveLogFile,
  sanitizeLogEntry,
} from '@modules/logs/utils/log-file.util';

import type { ExecutionLogResponseDto } from '@modules/logs/dto/execution-log-response.dto';
import type { LogFileEntry } from '@modules/logs/utils/log-file.util';

/** Mismo origen y defecto que `HybridLoggerService`: deben leer donde aquel escribe. */
const LOG_DIR_KEY = 'LOG_DIR';
const DEFAULT_LOG_DIR = 'logs';

/**
 * Topes de la respuesta. Una ejecucion reanudada muchas veces puede acumular
 * cientos de lineas; el visor es para leer un fallo, no para volcar el disco.
 */
export const MAX_LOG_ENTRIES = 200;
export const MAX_RAW_LOG_BYTES = 512 * 1024;

/** Resultado de leer los ficheros: entradas ya saneadas y si se cortaron. */
interface CollectedEntries {
  readonly entries: LogFileEntry[];
  readonly truncated: boolean;
}

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

/**
 * Traza de un fallo de DOMINIO, que no lanzo excepcion y por tanto no tiene
 * stack: un nodo que devolvio `success: false` con su codigo y su mensaje. Es
 * lo que el operador necesita leer, asi que ocupa el lugar del stack.
 */
const describeFailure = (entry: LogFileEntry): string | null => {
  const message = asString(entry.message);
  const code = asString(entry.errorCode);

  if (message === null) return code;

  return code === null ? message : `${code}: ${message}`;
};

/** Una entrada describe un fallo si trae stack o se marco como error. */
const isFailureEntry = (entry: LogFileEntry): boolean =>
  asString(entry.stackTrace) !== null ||
  entry.status === NodeLogStatus.ERROR ||
  entry.level === 'error';

/**
 * Lee la traza de UNA ejecucion de los ficheros `.log` del servidor.
 *
 * Los ficheros son DIARIOS y COMPARTIDOS (`fsm-YYYY-MM-DD.log`,
 * `execution-YYYY-MM-DD.log`, JSON Lines): no hay un fichero por ejecucion, asi
 * que se recorren en streaming y se filtran por `executionId`. Solo se abren
 * los ficheros que la base de datos asocia a la ejecucion, nunca un listado del
 * directorio: un rango acotado y conocido, y ninguna ruta que no haya escrito
 * el propio logger (ver `resolveLogFile`).
 */
@Injectable()
export class ExecutionLogReaderService {
  private readonly logDir: string;

  constructor(
    configService: ConfigService,
    @InjectRepository(FsmExecution)
    private readonly executionRepository: Repository<FsmExecution>,
    @InjectRepository(LogNodo)
    private readonly logNodoRepository: Repository<LogNodo>,
  ) {
    this.logDir = configService.get<string>(LOG_DIR_KEY) ?? DEFAULT_LOG_DIR;
  }

  /**
   * Traza de la ejecucion: el ultimo fallo destacado y todas sus entradas.
   *
   * @throws NotFoundException Si la ejecucion no existe.
   */
  public async readExecutionLog(
    executionId: string,
  ): Promise<ExecutionLogResponseDto> {
    const execution = await this.executionRepository.findOne({
      where: { executionId },
      select: { executionId: true, logFilePath: true, failureReason: true },
    });

    if (execution === null) {
      throw new NotFoundException(`No existe la ejecucion "${executionId}".`);
    }

    // Mas reciente primero: la primera con error es el ultimo fallo.
    const nodeLogs = await this.logNodoRepository.find({
      where: { executionId },
      select: {
        status: true,
        severity: true,
        message: true,
        logFilePath: true,
        createdAt: true,
      },
      order: { createdAt: 'DESC' },
    });

    const files = this.resolveCandidateFiles([
      execution.logFilePath,
      ...nodeLogs.map((log) => log.logFilePath),
    ]);

    const { entries, truncated } = await this.collectEntries(
      files,
      executionId,
    );

    const lastFailure = [...entries].reverse().find(isFailureEntry) ?? null;
    const lastFailedNode =
      nodeLogs.find((log) => log.status === NodeLogStatus.ERROR) ?? null;

    return {
      executionId,
      timestamp:
        asString(lastFailure?.timestamp) ??
        lastFailedNode?.createdAt.toISOString() ??
        null,
      // `level_fsm` es la severidad real; el `level` de Winston de las trazas
      // por nodo vale `info` incluso en un fallo.
      level:
        asString(lastFailure?.level_fsm) ?? lastFailedNode?.severity ?? null,
      stackTrace:
        asString(lastFailure?.stackTrace) ??
        (lastFailure === null ? null : describeFailure(lastFailure)) ??
        // Sin traza en disco (ficheros ya rotados), lo mas parecido es el
        // mensaje del fallo que quedo en la base de datos.
        lastFailedNode?.message ??
        execution.failureReason,
      rawLog: entries.map((entry) => JSON.stringify(entry)).join('\n'),
      truncated,
    };
  }

  /** Rutas distintas y seguras, en el orden en que se vieron. */
  private resolveCandidateFiles(
    storedPaths: ReadonlyArray<string | null>,
  ): string[] {
    const resolved = storedPaths
      .map((storedPath) => resolveLogFile(this.logDir, storedPath))
      .filter((file): file is string => file !== null);

    return [...new Set(resolved)];
  }

  /** Entradas de la ejecucion en todos los ficheros, ordenadas por instante. */
  private async collectEntries(
    files: readonly string[],
    executionId: string,
  ): Promise<CollectedEntries> {
    const entries: LogFileEntry[] = [];

    for (const file of files) {
      entries.push(...(await this.readMatchingLines(file, executionId)));
    }

    entries.sort((left, right) =>
      (asString(left.timestamp) ?? '').localeCompare(
        asString(right.timestamp) ?? '',
      ),
    );

    // Se conservan las MAS RECIENTES: el fallo que se viene a mirar es el
    // ultimo, y cortar por el principio lo dejaria fuera.
    const kept: LogFileEntry[] = [];
    let bytes = 0;

    for (const entry of [...entries].reverse()) {
      const size = Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1;

      if (kept.length >= MAX_LOG_ENTRIES || bytes + size > MAX_RAW_LOG_BYTES) {
        return { entries: kept.reverse(), truncated: true };
      }

      kept.push(entry);
      bytes += size;
    }

    return { entries: kept.reverse(), truncated: false };
  }

  /**
   * Lineas de un fichero que pertenecen a la ejecucion, ya saneadas.
   *
   * Streaming con `readline`: un fichero diario puede pesar decenas de MB y
   * cargarlo entero por una consulta del panel no tiene sentido. El filtro
   * barato (`includes`) va antes del `JSON.parse`, que solo se paga en las
   * lineas candidatas. Una linea corrupta o un fichero que ya roto no rompen la
   * lectura: se saltan.
   */
  private async readMatchingLines(
    file: string,
    executionId: string,
  ): Promise<LogFileEntry[]> {
    const matches: LogFileEntry[] = [];
    const stream = createReadStream(file, { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });

    try {
      for await (const line of lines) {
        if (!line.includes(executionId)) continue;

        const entry = this.parseLine(line);

        if (entry?.executionId === executionId) {
          matches.push(sanitizeLogEntry(entry));
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    } finally {
      lines.close();
      stream.destroy();
    }

    return matches;
  }

  private parseLine(line: string): LogFileEntry | null {
    try {
      const parsed: unknown = JSON.parse(line);

      return typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed)
        ? (parsed as LogFileEntry)
        : null;
    } catch {
      return null;
    }
  }
}
