import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NotFoundException } from '@nestjs/common';

import { NodeLogStatus } from '@modules/logs/entities/log-nodo.entity';
import {
  ExecutionLogReaderService,
  MAX_LOG_ENTRIES,
} from '@modules/logs/services/execution-log-reader.service';

import type { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import type { FsmExecution } from '@core/fsm/entities/fsm-execution.entity';
import type { LogNodo } from '@modules/logs/entities/log-nodo.entity';

const EXECUTION_ID = '735dc678-1111-4111-8111-111111111111';
const OTHER_EXECUTION_ID = '4044dc84-2222-4222-8222-222222222222';

/** Linea JSON tal como la escribe Winston en `execution-*.log`. */
const nodeLine = (overrides: Record<string, unknown>): string =>
  JSON.stringify({
    durationMs: 10,
    errorCode: null,
    executionId: EXECUTION_ID,
    level: 'info',
    level_fsm: null,
    message: 'OK',
    nodeId: 'nodo_template',
    nodeType: 'MAPEADOR_PLANTILLA',
    payload: { compiled_text: 'Contenido del correo' },
    stackTrace: null,
    status: 'OK',
    timestamp: '2026-10-22T08:00:00.000Z',
    ...overrides,
  });

const FAILURE_LINE = nodeLine({
  errorCode: 'ERR_LLM_PROVIDER_FAILURE',
  level_fsm: 'GRAVE',
  message: 'El proveedor ANTHROPIC no completo la inferencia',
  nodeId: 'procesador_ia',
  nodeType: 'PROCESADOR_IA',
  payload: null,
  stackTrace:
    'AnthropicProviderException: 529\n    at toPayload (/var/www/html/UNUWARE/Pro-ToDo/backend/src/modules/nodes/anthropic.ts:310:13)',
  status: 'ERROR',
  timestamp: '2026-10-22T08:00:05.000Z',
});

describe('ExecutionLogReaderService', () => {
  let logDir: string;

  beforeEach(async () => {
    logDir = await mkdtemp(path.join(tmpdir(), 'protodo-logs-'));
  });

  afterEach(async () => {
    await rm(logDir, { recursive: true, force: true });
  });

  /** Servicio con repositorios doblados y `LOG_DIR` apuntando al temporal. */
  const buildService = (
    execution: Partial<FsmExecution> | null,
    nodeLogs: Partial<LogNodo>[] = [],
  ) => {
    const executionRepository = {
      findOne: jest
        .fn()
        .mockResolvedValue(
          execution === null
            ? null
            : { executionId: EXECUTION_ID, failureReason: null, ...execution },
        ),
    };
    const logNodoRepository = { find: jest.fn().mockResolvedValue(nodeLogs) };
    const config = { get: jest.fn().mockReturnValue(logDir) };

    return new ExecutionLogReaderService(
      config as unknown as ConfigService,
      executionRepository as unknown as Repository<FsmExecution>,
      logNodoRepository as unknown as Repository<LogNodo>,
    );
  };

  it('deberia devolver solo las entradas de la ejecucion, sin payload y con rutas relativas', async () => {
    // 1. Arrange 📐: fichero diario COMPARTIDO con otra ejecucion.
    await writeFile(
      path.join(logDir, 'execution-2026-10-22.log'),
      [
        nodeLine({}),
        nodeLine({ executionId: OTHER_EXECUTION_ID, message: 'ajena' }),
        FAILURE_LINE,
      ].join('\n'),
    );
    const service = buildService({
      logFilePath: 'logs/execution-2026-10-22.log',
    });

    // 2. Act ⚙️
    const log = await service.readExecutionLog(EXECUTION_ID);

    // 3. Assert 🎯
    const lines = log.rawLog.split('\n');
    expect(lines).toHaveLength(2);
    expect(log.rawLog).not.toContain(OTHER_EXECUTION_ID);
    expect(log.rawLog).not.toContain('payload');
    expect(log.rawLog).not.toContain('Contenido del correo');
    expect(log.level).toBe('GRAVE');
    expect(log.timestamp).toBe('2026-10-22T08:00:05.000Z');
    expect(log.stackTrace).toBe(
      'AnthropicProviderException: 529\n    at toPayload (src/modules/nodes/anthropic.ts:310:13)',
    );
    expect(log.truncated).toBe(false);
  });

  it('deberia unir el volcado forense y las trazas por nodo de varios dias', async () => {
    // 1. Arrange 📐: pausa el 21, reanudacion y fallo catastrofico el 22.
    await writeFile(
      path.join(logDir, 'execution-2026-10-21.log'),
      nodeLine({ timestamp: '2026-10-21T10:00:00.000Z' }),
    );
    await writeFile(
      path.join(logDir, 'fsm-2026-10-22.log'),
      JSON.stringify({
        executionId: EXECUTION_ID,
        level: 'error',
        level_fsm: 'URGENTE',
        message: 'La variable no existe',
        payload: { raw_email: {} },
        stackTrace: 'MissingContextVariableException: x',
        timestamp: '2026-10-22T09:00:00.000Z',
      }),
    );
    const service = buildService({ logFilePath: 'logs/fsm-2026-10-22.log' }, [
      {
        logFilePath: 'logs/execution-2026-10-21.log',
        status: NodeLogStatus.OK,
      },
    ]);

    // 2. Act ⚙️
    const log = await service.readExecutionLog(EXECUTION_ID);

    // 3. Assert 🎯: ordenadas por instante; el fallo principal es el ultimo.
    expect(log.rawLog.split('\n')).toHaveLength(2);
    expect(log.rawLog.indexOf('2026-10-21')).toBeLessThan(
      log.rawLog.indexOf('2026-10-22'),
    );
    expect(log.level).toBe('URGENTE');
    expect(log.stackTrace).toBe('MissingContextVariableException: x');
  });

  it('deberia usar codigo y mensaje como traza de un fallo de dominio sin stack', async () => {
    // 1. Arrange 📐: un nodo que devolvio success:false no lanza excepcion.
    await writeFile(
      path.join(logDir, 'execution-2026-10-22.log'),
      nodeLine({
        errorCode: 'ERR_PARSER_UNEXTRACTABLE_MEDIA',
        level_fsm: 'GRAVE',
        message: 'Adjunto sin texto extraible',
        status: 'ERROR',
      }),
    );
    const service = buildService({
      logFilePath: 'logs/execution-2026-10-22.log',
    });

    // 2. Act ⚙️
    const log = await service.readExecutionLog(EXECUTION_ID);

    // 3. Assert 🎯
    expect(log.stackTrace).toBe(
      'ERR_PARSER_UNEXTRACTABLE_MEDIA: Adjunto sin texto extraible',
    );
    expect(log.level).toBe('GRAVE');
  });

  it('deberia ignorar rutas manipuladas en la base de datos', async () => {
    // 1. Arrange 📐: un fichero real fuera del patron, al lado de los logs.
    await writeFile(path.join(logDir, 'secreto.txt'), EXECUTION_ID);
    const service = buildService({ logFilePath: '../secreto.txt' }, [
      {
        logFilePath: `${logDir}/secreto.txt`,
        status: NodeLogStatus.ERROR,
        createdAt: new Date('2026-10-22T08:00:00.000Z'),
      },
    ]);

    // 2. Act ⚙️
    const log = await service.readExecutionLog(EXECUTION_ID);

    // 3. Assert 🎯
    expect(log.rawLog).toBe('');
  });

  it('deberia caer a logs_nodo cuando los ficheros ya rotaron', async () => {
    // 1. Arrange 📐: la ruta existe en BD pero el fichero ya no (ENOENT).
    const service = buildService(
      {
        logFilePath: 'logs/execution-2026-09-01.log',
        failureReason: 'Motivo del operador',
      },
      [
        {
          status: NodeLogStatus.ERROR,
          severity: 'GRAVE',
          message: 'El proveedor no respondio',
          logFilePath: 'logs/execution-2026-09-01.log',
          createdAt: new Date('2026-09-01T10:00:00.000Z'),
        },
      ],
    );

    // 2. Act ⚙️
    const log = await service.readExecutionLog(EXECUTION_ID);

    // 3. Assert 🎯
    expect(log).toEqual({
      executionId: EXECUTION_ID,
      timestamp: '2026-09-01T10:00:00.000Z',
      level: 'GRAVE',
      stackTrace: 'El proveedor no respondio',
      rawLog: '',
      truncated: false,
    });
  });

  it('deberia saltar lineas corruptas sin fallar', async () => {
    // 1. Arrange 📐
    await writeFile(
      path.join(logDir, 'execution-2026-10-22.log'),
      [`{"executionId":"${EXECUTION_ID}", roto`, FAILURE_LINE].join('\n'),
    );
    const service = buildService({
      logFilePath: 'logs/execution-2026-10-22.log',
    });

    // 2. Act ⚙️
    const log = await service.readExecutionLog(EXECUTION_ID);

    // 3. Assert 🎯
    expect(log.rawLog.split('\n')).toHaveLength(1);
    expect(log.level).toBe('GRAVE');
  });

  it('deberia conservar las entradas mas recientes al superar el tope', async () => {
    // 1. Arrange 📐
    const lines = Array.from({ length: MAX_LOG_ENTRIES + 10 }, (_, index) =>
      nodeLine({
        nodeId: `nodo_${index}`,
        timestamp: new Date(Date.UTC(2026, 9, 22, 0, 0, index)).toISOString(),
      }),
    );
    await writeFile(
      path.join(logDir, 'execution-2026-10-22.log'),
      lines.join('\n'),
    );
    const service = buildService({
      logFilePath: 'logs/execution-2026-10-22.log',
    });

    // 2. Act ⚙️
    const log = await service.readExecutionLog(EXECUTION_ID);

    // 3. Assert 🎯
    expect(log.truncated).toBe(true);
    expect(log.rawLog.split('\n')).toHaveLength(MAX_LOG_ENTRIES);
    expect(log.rawLog).toContain(`nodo_${MAX_LOG_ENTRIES + 9}"`);
    expect(log.rawLog).not.toContain('"nodo_0"');
  });

  it('deberia lanzar NotFoundException si la ejecucion no existe', async () => {
    // 1. Arrange 📐
    const service = buildService(null);

    // 2. Act ⚙️ + 3. Assert 🎯
    await expect(service.readExecutionLog(EXECUTION_ID)).rejects.toThrow(
      NotFoundException,
    );
  });
});
