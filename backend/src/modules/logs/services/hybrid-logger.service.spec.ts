import { ConfigService } from '@nestjs/config';

import { HybridLoggerService } from './hybrid-logger.service';

import { AlertaError } from '@modules/logs/entities/alerta-error.entity';
import { LogNodo, NodeLogStatus } from '@modules/logs/entities/log-nodo.entity';

import type {
  CatastrophicFailureDetails,
  NodeExecutionDetails,
} from './hybrid-logger.service';
import type { Repository } from 'typeorm';

/**
 * El transporte de disco se simula ENTERO.
 *
 * Un spec que instanciara `DailyRotateFile` de verdad crearia un directorio
 * `logs/` y escribiria en el en cada pasada de `npm test`, dejando basura en el
 * repositorio y haciendo la prueba dependiente del sistema de archivos. Lo que
 * hay que fijar aqui es el CONTRATO —que se escriba una entrada con el volcado
 * completo y que la ruta devuelta case con el archivo—, no la mecanica de
 * winston, que es codigo de terceros ya probado.
 */
const rotateTransportSpy = jest.fn();

jest.mock('winston-daily-rotate-file', () =>
  jest.fn().mockImplementation((options: unknown) => {
    rotateTransportSpy(options);
    // Winston exige que un transporte sea un Stream con `log`; con esto basta
    // para que `createLogger` lo acepte sin tocar el disco.
    return { log: jest.fn(), on: jest.fn(), once: jest.fn(), emit: jest.fn() };
  }),
);

const errorSpy = jest.fn();
const infoSpy = jest.fn();

jest.mock('winston', () => ({
  // Cada `createLogger` devuelve el MISMO doble: el servicio crea dos loggers
  // —incidencias y traza por nodo— y distinguirlos por instancia no aportaria
  // nada, porque lo que se asevera es con que se escribe, no en cual.
  createLogger: jest.fn(() => ({ error: errorSpy, info: infoSpy })),
  format: {
    combine: jest.fn(),
    timestamp: jest.fn(),
    json: jest.fn(),
  },
  transports: {},
}));

const DETAILS: CatastrophicFailureDetails = {
  executionId: 'd4c3b2a1-9f8e-4d7c-8b6a-5e4f3d2c1b0a',
  flowId: 'b3f1c2d4-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
  nodeId: 'nodo_a',
  level: 'URGENTE',
  message: 'El socket IMAP se cerro de golpe',
  stackTrace: 'Error: El socket IMAP se cerro de golpe\n    at Socket.onEnd',
  payload: { trigger: { subject: 'Avance cientifico' } },
};

/** Identificador que devuelve el `save` de `logs_nodo` en el caso feliz. */
const SAVED_LOG_ID = '0f1e2d3c-4b5a-4968-8778-6f5e4d3c2b1a';

/** Repositorio doble: `create` devuelve lo que recibe para aseverar el mapeo. */
interface RepositoryDouble<T> {
  repo: Repository<T>;
  create: jest.Mock<Partial<T>, [Partial<T>]>;
  save: jest.Mock;
}

/**
 * @param savedId Identificador que simula la clave generada por PostgreSQL. Se
 *                devuelve desde `save` porque es lo que el servicio necesita
 *                para vincular la alerta con su traza.
 */
const buildRepository = <T>(savedId?: string): RepositoryDouble<T> => {
  const create: jest.Mock<Partial<T>, [Partial<T>]> = jest.fn(
    (entity: Partial<T>) => entity,
  );
  const save = jest.fn((entity: Partial<T>) =>
    Promise.resolve(
      savedId === undefined ? entity : { ...entity, id: savedId },
    ),
  );

  return {
    repo: { create, save } as unknown as Repository<T>,
    create,
    save,
  };
};

/** Silencia el Logger de Nest para que la salida de Jest siga legible. */
const buildService = (
  env: Record<string, string> = {},
  repository: RepositoryDouble<LogNodo> = buildRepository<LogNodo>(
    SAVED_LOG_ID,
  ),
  alerts: RepositoryDouble<AlertaError> = buildRepository<AlertaError>(),
): {
  service: HybridLoggerService;
  repository: RepositoryDouble<LogNodo>;
  alerts: RepositoryDouble<AlertaError>;
} => {
  const service = new HybridLoggerService(
    new ConfigService(env),
    repository.repo,
    alerts.repo,
  );
  jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);

  return { service, repository, alerts };
};

describe('HybridLoggerService · volcado forense del motor FSM', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('1. Configuracion del transporte', () => {
    it('1.1 deberia usar los valores por defecto sin variables de entorno', () => {
      // 1. Arrange & 2. Act
      buildService();

      // 3. Assert
      expect(rotateTransportSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          dirname: 'logs',
          maxFiles: '14d',
          maxSize: '20m',
        }),
      );
    });

    it('1.2 deberia respetar LOG_DIR, LOG_MAX_FILES y LOG_MAX_SIZE', () => {
      // 1. Arrange & 2. Act
      buildService({
        LOG_DIR: '/var/log/protodo',
        LOG_MAX_FILES: '30d',
        LOG_MAX_SIZE: '5m',
      });

      // 3. Assert
      expect(rotateTransportSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          dirname: '/var/log/protodo',
          maxFiles: '30d',
          maxSize: '5m',
        }),
      );
    });
  });

  describe('2. Volcado del fallo', () => {
    it('2.1 deberia escribir el stack trace y el payload completos', () => {
      // 1. Arrange
      const { service } = buildService();

      // 2. Act
      service.logCatastrophicFailure(DETAILS);

      // 3. Assert: el contexto va ENTERO, no solo el namespace del nodo
      // culpable; reproducir el fallo exige saber con que entraba.
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          executionId: DETAILS.executionId,
          flowId: DETAILS.flowId,
          nodeId: 'nodo_a',
          level_fsm: 'URGENTE',
          message: DETAILS.message,
          stackTrace: DETAILS.stackTrace,
          payload: DETAILS.payload,
        }),
      );
    });

    it('2.2 deberia normalizar a null un stack trace ausente', () => {
      // 1. Arrange: un `throw "texto"` no lleva stack
      const { service } = buildService();
      const withoutStack: CatastrophicFailureDetails = {
        ...DETAILS,
        stackTrace: undefined,
      };

      // 2. Act
      service.logCatastrophicFailure(withoutStack);

      // 3. Assert
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ stackTrace: null }),
      );
    });

    it('2.3 deberia devolver una ruta dentro de LOG_DIR con la fecha del dia', () => {
      // 1. Arrange
      const { service } = buildService({ LOG_DIR: 'volcados' });

      // 2. Act
      const path = service.logCatastrophicFailure(DETAILS);

      // 3. Assert: la fecha se compone en local, igual que hace el transporte
      const now = new Date();
      const expected = `volcados/fsm-${now.getFullYear()}-${String(
        now.getMonth() + 1,
      ).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}.log`;

      expect(path).toBe(expected);
    });
  });

  describe('3. El volcado NUNCA derriba al llamante', () => {
    // Se invoca desde el manejador de errores del motor: una excepcion aqui
    // sustituiria el fallo real por uno de registro y dejaria la ejecucion sin
    // marcar, perdiendo el diagnostico original.
    it('3.1 deberia devolver null si la escritura falla, sin lanzar', () => {
      // 1. Arrange
      const { service } = buildService();
      errorSpy.mockImplementation(() => {
        throw new Error('ENOSPC: no space left on device');
      });

      // 2. Act
      const path = service.logCatastrophicFailure(DETAILS);

      // 3. Assert
      expect(path).toBeNull();
    });
  });

  describe('4. Traza por nodo (persistencia dual)', () => {
    const NODE_DETAILS: NodeExecutionDetails = {
      executionId: 'd4c3b2a1-9f8e-4d7c-8b6a-5e4f3d2c1b0a',
      nodeId: 'trigger_imap',
      nodeType: 'TRIGGER_IMAP',
      status: NodeLogStatus.OK,
      durationMs: 42,
      payloadSnapshot: { subject: 'Avance cientifico' },
    };

    it('4.1 deberia escribir en disco Y persistir la fila', async () => {
      // 1. Arrange
      const { service, repository } = buildService();

      // 2. Act
      await service.logNodeExecution(NODE_DETAILS);

      // 3. Assert: las DOS mitades del registro hibrido. Con una sola, la traza
      //    seria consultable pero sin detalle, o detallada pero inencontrable.
      expect(infoSpy).toHaveBeenCalledTimes(1);
      expect(repository.save).toHaveBeenCalledTimes(1);
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          executionId: NODE_DETAILS.executionId,
          nodeId: 'trigger_imap',
          nodeType: 'TRIGGER_IMAP',
          status: NodeLogStatus.OK,
          severity: null,
          durationMs: 42,
        }),
      );
    });

    it('4.2 deberia enlazar la fila con el archivo mediante ruta_archivo_log', async () => {
      // 1. Arrange: es el unico eslabon entre los dos destinos.
      const { service, repository } = buildService({ LOG_DIR: 'volcados' });

      // 2. Act
      await service.logNodeExecution(NODE_DETAILS);

      // 3. Assert
      const saved = repository.create.mock.calls[0][0];
      expect(saved.logFilePath).toContain('volcados/execution-');
    });

    it.each([
      ['LEVE', NodeLogStatus.ADVERTENCIA],
      ['GRAVE', NodeLogStatus.ERROR],
    ])(
      '4.3 deberia persistir la severidad %s junto a su estado',
      async (severity, status) => {
        // 1. Arrange
        const { service, repository } = buildService();

        // 2. Act: el mapeo lo decide el motor; aqui se comprueba que viaja.
        await service.logNodeExecution({
          ...NODE_DETAILS,
          status,
          severity: severity as NodeExecutionDetails['severity'],
          errorCode: 'ERR_IMAP_TIMEOUT',
          message: 'Se agoto el tiempo de espera',
        });

        // 3. Assert
        expect(repository.create).toHaveBeenCalledWith(
          expect.objectContaining({
            status,
            severity,
            errorCode: 'ERR_IMAP_TIMEOUT',
            message: 'Se agoto el tiempo de espera',
          }),
        );
      },
    );

    it('4.4 deberia persistir la fila aunque falle la escritura en disco', async () => {
      // 1. Arrange: los dos destinos van en try/catch SEPARADOS. Media traza es
      //    mejor que ninguna.
      const { service, repository } = buildService();
      infoSpy.mockImplementation(() => {
        throw new Error('ENOSPC: no space left on device');
      });

      // 2. Act
      await service.logNodeExecution(NODE_DETAILS);

      // 3. Assert: la fila se guarda, y con `null` en la ruta porque el archivo
      //    no existe. Apuntar a un archivo inexistente seria una pista falsa.
      expect(repository.save).toHaveBeenCalledTimes(1);
      const saved = repository.create.mock.calls[0][0];
      expect(saved.logFilePath).toBeNull();
    });

    it('4.5 deberia escribir en disco aunque falle la base de datos', async () => {
      // 1. Arrange: el caso simetrico del anterior.
      const repository = buildRepository<LogNodo>();
      repository.save.mockRejectedValue(new Error('connection terminated'));
      const { service } = buildService({}, repository);

      // 2. Act & 3. Assert: no lanza, y el archivo conserva la traza. Un flujo
      //    no puede caerse porque no se pudo anotar que funciono.
      await expect(
        service.logNodeExecution(NODE_DETAILS),
      ).resolves.toBeUndefined();
      expect(infoSpy).toHaveBeenCalledTimes(1);
    });

    it('4.6 no deberia lanzar aunque fallen los dos destinos', async () => {
      // 1. Arrange
      const repository = buildRepository<LogNodo>();
      repository.save.mockRejectedValue(new Error('connection terminated'));
      const { service } = buildService({}, repository);
      infoSpy.mockImplementation(() => {
        throw new Error('ENOSPC');
      });

      // 2. Act & 3. Assert
      await expect(
        service.logNodeExecution(NODE_DETAILS),
      ).resolves.toBeUndefined();
    });

    it('4.7 deberia recortar un codigo de error mas largo que su columna', async () => {
      // 1. Arrange: perder la fila entera por un codigo mal declarado seria
      //    peor que recortarlo.
      const { service, repository } = buildService();

      // 2. Act
      await service.logNodeExecution({
        ...NODE_DETAILS,
        errorCode: `ERR_${'X'.repeat(200)}`,
      });

      // 3. Assert
      const saved = repository.create.mock.calls[0][0];
      expect(saved.errorCode).toHaveLength(100);
    });
  });

  describe('5. Escalado a alertas_error', () => {
    const FAILING_NODE: NodeExecutionDetails = {
      executionId: 'd4c3b2a1-9f8e-4d7c-8b6a-5e4f3d2c1b0a',
      nodeId: 'mapeador_plantilla',
      nodeType: 'MAPEADOR_PLANTILLA',
      status: NodeLogStatus.ERROR,
      severity: 'GRAVE',
      errorCode: 'ERR_TEMPLATE_MISSING_FIELDS',
      message: 'Falta la clave raw_email.titulo',
      durationMs: 12,
    };

    it.each([['GRAVE'], ['URGENTE']])(
      '5.1 deberia registrar la alerta de un fallo %s vinculada a su traza',
      async (severity) => {
        // 1. Arrange
        const { service, alerts } = buildService();

        // 2. Act
        await service.logNodeExecution({
          ...FAILING_NODE,
          severity: severity as NodeExecutionDetails['severity'],
        });

        // 3. Assert: la clave ajena es lo que convierte una alerta en
        //    accionable; sin ella el operador sabe que fallo pero no cual.
        expect(alerts.save).toHaveBeenCalledTimes(1);
        expect(alerts.create).toHaveBeenCalledWith({
          executionId: FAILING_NODE.executionId,
          // Nulo: esta alerta nacio DENTRO de una ejecucion y ya se atribuye por
          // ella. `flowId` es para lo que ocurre fuera del motor.
          flowId: null,
          logNodeId: SAVED_LOG_ID,
          level: severity,
          errorMessage: 'Falta la clave raw_email.titulo',
          resolved: false,
        });
      },
    );

    it.each([
      ['un exito', NodeLogStatus.OK, undefined],
      ['un fallo LEVE', NodeLogStatus.ADVERTENCIA, 'LEVE'],
    ])(
      '5.2 no deberia registrar alerta ante %s',
      async (_caso, status, severity) => {
        // 1. Arrange: el LEVE cierra sin pausar porque se reintenta solo. Una
        //    alerta por cada timeout IMAP enterraria lo que si hay que atender.
        const { service, alerts } = buildService();

        // 2. Act
        await service.logNodeExecution({
          ...FAILING_NODE,
          status,
          severity: severity as NodeExecutionDetails['severity'],
        });

        // 3. Assert
        expect(alerts.save).not.toHaveBeenCalled();
      },
    );

    it('5.3 deberia registrar la alerta huerfana si falla el guardado de la traza', async () => {
      // 1. Arrange: si la base de datos esta fallando es cuando menos se puede
      //    permitir perder el aviso. El vinculo es lo prescindible.
      const repository = buildRepository<LogNodo>();
      repository.save.mockRejectedValue(new Error('connection terminated'));
      const { service, alerts } = buildService({}, repository);

      // 2. Act
      await service.logNodeExecution(FAILING_NODE);

      // 3. Assert
      expect(alerts.save).toHaveBeenCalledTimes(1);
      const saved = alerts.create.mock.calls[0][0];
      expect(saved.logNodeId).toBeNull();
    });

    it('5.4 no deberia lanzar si falla el registro de la alerta', async () => {
      // 1. Arrange: tercer try/catch, mismo criterio que los otros dos. Un fallo
      //    al anotar la alerta no puede tumbar la ejecucion que la provoco.
      const alerts = buildRepository<AlertaError>();
      alerts.save.mockRejectedValue(new Error('connection terminated'));
      const { service, repository } = buildService(
        {},
        buildRepository<LogNodo>(SAVED_LOG_ID),
        alerts,
      );

      // 2. Act & 3. Assert: la traza sobrevive intacta en los dos destinos.
      await expect(
        service.logNodeExecution(FAILING_NODE),
      ).resolves.toBeUndefined();
      expect(infoSpy).toHaveBeenCalledTimes(1);
      expect(repository.save).toHaveBeenCalledTimes(1);
    });

    it('5.5 deberia usar un mensaje por defecto cuando el fallo no traia texto', async () => {
      // 1. Arrange: una celda vacia no le dice nada a quien abre la bandeja.
      const { service, alerts } = buildService();

      // 2. Act
      await service.logNodeExecution({ ...FAILING_NODE, message: undefined });

      // 3. Assert
      const saved = alerts.create.mock.calls[0][0];
      expect(saved.errorMessage).toBe('Error operativo no tipado');
    });

    it('5.7 deberia registrar la averia de un worker atribuida al flujo', async () => {
      // 1. Arrange: el fallo ocurre fuera de la FSM, asi que no hay ejecucion ni
      //    traza de nodo a la que colgarlo.
      const { service, alerts, repository } = buildService();

      // 2. Act
      await service.logWorkerFailure({
        flowId: 'a1b2c3d4-5e6f-4788-9a0b-1c2d3e4f5a6b',
        source: 'ImapPollingService',
        level: 'GRAVE',
        message: 'Falla critica de conexion IMAP: ECONNREFUSED',
      });

      // 3. Assert: alerta si, `logs_nodo` no — esa tabla cuelga de
      //    `ejecuciones_flujo` y aqui el sentido es que no hay ejecucion.
      expect(repository.save).not.toHaveBeenCalled();
      expect(alerts.create).toHaveBeenCalledWith({
        executionId: null,
        flowId: 'a1b2c3d4-5e6f-4788-9a0b-1c2d3e4f5a6b',
        logNodeId: null,
        level: 'GRAVE',
        errorMessage: 'Falla critica de conexion IMAP: ECONNREFUSED',
        resolved: false,
      });
    });

    it('5.8 deberia volcar la averia del worker al archivo de incidencias', async () => {
      // 1. Arrange: al de INCIDENCIAS y no al de ejecucion. Esto no es un
      //    eslabon del caudal de nodos sino una autopsia.
      const { service } = buildService();

      // 2. Act
      await service.logWorkerFailure({
        flowId: 'a1b2c3d4-5e6f-4788-9a0b-1c2d3e4f5a6b',
        source: 'ImapPollingService',
        level: 'GRAVE',
        message: 'Falla critica de conexion IMAP: ECONNREFUSED',
      });

      // 3. Assert
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(infoSpy).not.toHaveBeenCalled();
    });

    it('5.9 no deberia lanzar si falla el registro de la averia del worker', async () => {
      // 1. Arrange: se invoca desde el `catch` de un `setInterval`.
      const alerts = buildRepository<AlertaError>();
      alerts.save.mockRejectedValue(new Error('connection terminated'));
      const { service } = buildService(
        {},
        buildRepository<LogNodo>(SAVED_LOG_ID),
        alerts,
      );

      // 2. Act & 3. Assert
      await expect(
        service.logWorkerFailure({
          flowId: 'a1b2c3d4-5e6f-4788-9a0b-1c2d3e4f5a6b',
          source: 'ImapPollingService',
          level: 'GRAVE',
          message: 'Falla critica de conexion IMAP: ECONNREFUSED',
        }),
      ).resolves.toBeUndefined();
    });

    it('5.6 deberia registrar una alerta por intento', async () => {
      // 1. Arrange: el motor reintenta los GRAVE, y colapsar los intentos en una
      //    sola alerta ocultaria cuantas veces se intento antes de rendirse.
      const { service, alerts } = buildService();

      // 2. Act
      await service.logNodeExecution(FAILING_NODE);
      await service.logNodeExecution(FAILING_NODE);
      await service.logNodeExecution(FAILING_NODE);

      // 3. Assert
      expect(alerts.save).toHaveBeenCalledTimes(3);
    });
  });
});
