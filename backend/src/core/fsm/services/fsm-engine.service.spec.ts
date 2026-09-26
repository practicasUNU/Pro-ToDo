import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { In, QueryFailedError } from 'typeorm';

import { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import { NodeStrategyFactory } from '@core/fsm/factories/node-strategy.factory';
import {
  FsmEngineService,
  MAX_TRANSITIONS,
  TRIGGER_NAMESPACE,
} from '@core/fsm/services/fsm-engine.service';
import { ExecutionState } from '@core/fsm/types/fsm.enums';
import { NodeLogStatus } from '@modules/logs/entities/log-nodo.entity';
import {
  ERROR_CONTEXT_NAMESPACE,
  NodeType,
} from '@core/fsm/types/pipeline-schema.types';

import type { HybridLoggerService } from '@modules/logs/services/hybrid-logger.service';
import type { PipelineSchemaDto } from '@core/fsm/dto/pipeline-schema.dto';
import type { FsmExecution } from '@core/fsm/entities/fsm-execution.entity';
import type {
  INodeStrategy,
  NodeErrorSeverity,
  NodeResult,
} from '@core/fsm/types/node-strategy.types';
import type { Repository } from 'typeorm';

/** Codigo por defecto de los fallos de prueba; el que `catchErrors` menciona. */
const TEST_ERROR_CODE = 'ERR_TEST';
const OTHER_ERROR_CODE = 'ERR_OTRO';

const EXECUTION_ID = 'd4c3b2a1-9f8e-4d7c-8b6a-5e4f3d2c1b0a';
const FLOW_ID = 'b3f1c2d4-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

/** Repositorio doble; `update` acumula los checkpoints para poder aseverarlos. */
interface RepositoryDouble {
  repo: Repository<FsmExecution>;
  findOne: jest.Mock;
  update: jest.Mock;
}

/** Fila de `ejecuciones_flujo` recien creada, ajustable por prueba. */
const buildExecution = (
  overrides: Partial<FsmExecution> = {},
): FsmExecution => ({
  executionId: EXECUTION_ID,
  flowId: FLOW_ID,
  currentState: ExecutionState.INACTIVO,
  activeCursor: null,
  contextPayload: {},
  retryState: {},
  logFilePath: null,
  failureReason: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const buildRepository = (execution: FsmExecution): RepositoryDouble => {
  const findOne = jest.fn().mockResolvedValue(execution);
  const update = jest.fn().mockResolvedValue({ affected: 1 });

  return {
    repo: { findOne, update } as unknown as Repository<FsmExecution>,
    findOne,
    update,
  };
};

/** Forma del error del driver `pg` que el motor inspecciona. */
type PostgresDriverErrorDouble = Error & {
  code: string;
  constraint?: string;
};

/**
 * Error tal y como lo envuelve TypeORM cuando el driver `pg` rechaza la sentencia.
 *
 * `code` y `constraint` van dentro de `driverError` porque es de donde los lee
 * el motor. Se construye el error REAL de TypeORM, no un objeto con la forma
 * parecida: la guarda del motor arranca con un `instanceof`, y un doble suelto
 * la dejaria sin ejercitar.
 *
 * @param code SQLSTATE a simular (`23505` es `unique_violation`).
 * @param constraint Nombre de la restriccion. Omitirlo simula al driver que no
 *        lo informa, que es la rama tolerante de la guarda.
 */
const buildQueryFailedError = (
  code: string,
  constraint?: string,
): QueryFailedError => {
  const driverError: PostgresDriverErrorDouble = Object.assign(
    new Error('duplicate key value violates unique constraint'),
    { code, constraint },
  );

  return new QueryFailedError(
    'UPDATE "ejecuciones_flujo" SET "estado" = $1 WHERE "id_ejecucion" = $2',
    [],
    driverError,
  );
};

/**
 * Estrategia falsa: la factoria real la registra e indexa por `nodeType`.
 *
 * `getRequiredNamespaces` se omite por defecto para que las pruebas que no van
 * de dependencias no tengan que declarar nada: la interfaz lo tiene opcional
 * justo porque un disparador no exige contexto alguno.
 */
const buildStrategy = (
  nodeType: NodeType,
  execute: jest.Mock,
  getRequiredNamespaces?: (
    params: Record<string, unknown>,
  ) => readonly string[],
): INodeStrategy =>
  getRequiredNamespaces === undefined
    ? { nodeType, execute }
    : { nodeType, execute, getRequiredNamespaces };

/** `NodeResult` fallido con la severidad y el codigo indicados. */
const failure = (
  level: NodeErrorSeverity,
  message = 'fallo',
  code = TEST_ERROR_CODE,
): NodeResult => ({
  success: false,
  error: { level, code, message },
});

/**
 * Pipeline lineal de 3 nodos, uno por tipo, encadenados hasta el terminal.
 * Devuelve un literal nuevo en cada llamada para que cada prueba mute su copia.
 */
const buildLinearSchema = (): PipelineSchemaDto => ({
  flowId: FLOW_ID,
  name: 'Pipeline lineal de prueba',
  version: '1.0.0',
  entrypoint: 'nodo_a',
  nodes: {
    nodo_a: {
      nodeId: 'nodo_a',
      nodeType: NodeType.TRIGGER_IMAP,
      outputNamespace: 'salida_a',
      nextStep: 'nodo_b',
      onErrorStep: null,
      params: {},
    },
    nodo_b: {
      nodeId: 'nodo_b',
      nodeType: NodeType.PROCESADOR_IA,
      outputNamespace: 'salida_b',
      nextStep: 'nodo_c',
      onErrorStep: null,
      params: {},
    },
    nodo_c: {
      nodeId: 'nodo_c',
      nodeType: NodeType.DESTINO_HTTP,
      outputNamespace: 'salida_c',
      nextStep: null,
      onErrorStep: null,
      params: {},
    },
  },
});

/**
 * Ultimo checkpoint persistido, ya tipado.
 *
 * `update.mock.calls` es `any[]`, y el lint del repositorio rechaza navegarlo a
 * pelo. Se anota la tupla en un solo sitio en vez de repetir el aserto en cada
 * prueba, que es el mismo idioma que usan los `cursors` de los bloques previos.
 */
const lastPatch = (
  update: jest.Mock,
): { currentState: ExecutionState; activeCursor: string | null } => {
  const calls = update.mock.calls as [
    string,
    { currentState: ExecutionState; activeCursor: string | null },
  ][];

  const last = calls.at(-1);

  if (last === undefined) {
    throw new Error('No se persistio ningun checkpoint.');
  }

  return last[1];
};

/** Ruta que el doble del volcado forense devuelve, para aseverar sobre ella. */
const LOG_PATH = 'logs/fsm-2026-09-09.log';

describe('FsmEngineService (PROT-09)', () => {
  let factory: NodeStrategyFactory;

  /**
   * Doble del volcado hibrido.
   *
   * Se simula y no se usa el real porque el real ESCRIBE EN DISCO: una suite que
   * lo instanciara dejaria un `logs/` sembrado de archivos por cada ejecucion de
   * `npm test`. Lo que aqui importa es el contrato —que el motor lo invoque con
   * los datos correctos y persista la ruta que devuelve—, no el formato del
   * archivo, que se prueba en el spec del propio servicio.
   */
  let hybridLogger: {
    logCatastrophicFailure: jest.Mock;
    logNodeExecution: jest.Mock;
  };

  beforeEach(() => {
    hybridLogger = {
      logCatastrophicFailure: jest.fn().mockReturnValue(LOG_PATH),
      logNodeExecution: jest.fn().mockResolvedValue(undefined),
    };
    factory = new NodeStrategyFactory();
    jest.spyOn(factory['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(factory['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(factory['logger'], 'error').mockImplementation(() => undefined);
  });

  /**
   * Silencia el Logger del motor para que la salida de Jest siga legible.
   *
   * El `ConfigService` va vacio: estas pruebas ejercitan `executeWorkflow`, que
   * no consulta configuracion. El unico consumidor es `createExecution`, con su
   * propio bloque y su propia siembra de `MAX_CONCURRENT_EXECUTIONS_PER_FLOW`.
   */
  const buildEngine = (
    repo: Repository<FsmExecution>,
    configService: ConfigService = new ConfigService({}),
  ): FsmEngineService => {
    const engine = new FsmEngineService(
      repo,
      factory,
      configService,
      hybridLogger as unknown as HybridLoggerService,
    );
    jest.spyOn(engine['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(engine['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(engine['logger'], 'error').mockImplementation(() => undefined);

    return engine;
  };

  describe('1. Flujo lineal exitoso', () => {
    it('deberia recorrer los 3 nodos y terminar en EXITOSO con el cursor nulo', async () => {
      // 1. Arrange
      const execution = buildExecution();
      const { repo, update } = buildRepository(execution);
      const executeA = jest.fn().mockResolvedValue({
        success: true,
        data: { valorA: 1 },
      });
      const executeB = jest.fn().mockResolvedValue({
        success: true,
        data: { valorB: 2 },
      });
      const executeC = jest.fn().mockResolvedValue({ success: true });

      factory.registerStrategy(buildStrategy(NodeType.TRIGGER_IMAP, executeA));
      factory.registerStrategy(buildStrategy(NodeType.PROCESADOR_IA, executeB));
      factory.registerStrategy(buildStrategy(NodeType.DESTINO_HTTP, executeC));

      // 2. Act
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildLinearSchema(),
      );

      // 3. Assert
      expect(executeA).toHaveBeenCalledTimes(1);
      expect(executeB).toHaveBeenCalledTimes(1);
      expect(executeC).toHaveBeenCalledTimes(1);
      expect(result.currentState).toBe(ExecutionState.EXITOSO);
      expect(result.activeCursor).toBeNull();
      expect(result.contextPayload).toEqual({
        salida_a: { valorA: 1 },
        salida_b: { valorB: 2 },
        salida_c: {},
      });
      // Marca inicial EN_PROCESO + un checkpoint por transicion + el final
      expect(update).toHaveBeenCalledTimes(4);
    });

    it('deberia dejar constancia del cursor intermedio en cada checkpoint', async () => {
      // 1. Arrange
      const execution = buildExecution();
      const { repo, update } = buildRepository(execution);
      const execute = jest.fn().mockResolvedValue({ success: true });

      factory.registerStrategy(buildStrategy(NodeType.TRIGGER_IMAP, execute));
      factory.registerStrategy(buildStrategy(NodeType.PROCESADOR_IA, execute));
      factory.registerStrategy(buildStrategy(NodeType.DESTINO_HTTP, execute));

      // 2. Act
      await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildLinearSchema(),
      );

      // 3. Assert: la secuencia de cursores persistidos describe el recorrido
      const cursors = update.mock.calls.map(
        ([, patch]: [string, { activeCursor: string | null }]) =>
          patch.activeCursor,
      );
      expect(cursors).toEqual(['nodo_a', 'nodo_b', 'nodo_c', null]);
    });
  });

  describe('1.1 Parada ordenada pedida por un nodo (`halt`)', () => {
    it('deberia cerrar en EXITOSO sin invocar los nodos siguientes', async () => {
      // 1. Arrange: el disparador no encuentra nada que procesar y pide parar.
      const execution = buildExecution();
      const { repo, update } = buildRepository(execution);
      const executeA = jest.fn().mockResolvedValue({
        success: true,
        data: { status: 'NO_MESSAGES_FOUND' },
        halt: { reason: 'El buzon no contiene mensajes nuevos que procesar.' },
      });
      const executeB = jest.fn().mockResolvedValue({ success: true });
      const executeC = jest.fn().mockResolvedValue({ success: true });

      factory.registerStrategy(buildStrategy(NodeType.TRIGGER_IMAP, executeA));
      factory.registerStrategy(buildStrategy(NodeType.PROCESADOR_IA, executeB));
      factory.registerStrategy(buildStrategy(NodeType.DESTINO_HTTP, executeC));

      // 2. Act
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildLinearSchema(),
      );

      // 3. Assert
      expect(executeA).toHaveBeenCalledTimes(1);
      expect(executeB).not.toHaveBeenCalled();
      expect(executeC).not.toHaveBeenCalled();
      expect(result.currentState).toBe(ExecutionState.EXITOSO);
      expect(result.activeCursor).toBeNull();
      // El motivo queda en el contexto: es lo que explica en trazabilidad por
      // que la ejecucion termino en un unico paso.
      expect(result.contextPayload).toEqual({
        salida_a: { status: 'NO_MESSAGES_FOUND' },
      });
      // Marca inicial EN_PROCESO + el checkpoint final. Sin transiciones
      // intermedias: el cursor nunca llego a avanzar.
      expect(update).toHaveBeenCalledTimes(2);
      // La marca transitoria es lo UNICO que distingue esta salida de la del
      // nodo terminal: ambas dejan la fila en EXITOSO con el cursor nulo.
      expect(result.haltReason).toBe(
        'El buzon no contiene mensajes nuevos que procesar.',
      );
    });

    it('no deberia marcar haltReason cuando recorre el grafo entero', async () => {
      // 1. Arrange: la contrapartida del caso anterior. Sin esta prueba, un
      //    `haltReason` que quedase pegado haria que `stopOnFirstSuccess` no
      //    desactivase nunca, y el fallo seria invisible.
      const execution = buildExecution();
      const { repo } = buildRepository(execution);
      const execute = jest.fn().mockResolvedValue({ success: true });

      factory.registerStrategy(buildStrategy(NodeType.TRIGGER_IMAP, execute));
      factory.registerStrategy(buildStrategy(NodeType.PROCESADOR_IA, execute));
      factory.registerStrategy(buildStrategy(NodeType.DESTINO_HTTP, execute));

      // 2. Act
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildLinearSchema(),
      );

      // 3. Assert
      expect(result.currentState).toBe(ExecutionState.EXITOSO);
      expect(result.haltReason).toBeUndefined();
    });

    it('deberia ignorar `halt` en un nodo que falla y seguir su ruta de error', async () => {
      // 1. Arrange: `halt` solo se atiende con `success: true`; aqui manda el
      // fallo, que tiene sus propias rutas (`onErrorStep`).
      const execution = buildExecution();
      const { repo } = buildRepository(execution);
      const schema = buildLinearSchema();
      schema.nodes.nodo_a.onErrorStep = 'nodo_c';

      const executeA = jest.fn().mockResolvedValue({
        ...failure('LEVE'),
        halt: { reason: 'no deberia atenderse' },
      });
      const executeB = jest.fn().mockResolvedValue({ success: true });
      const executeC = jest.fn().mockResolvedValue({ success: true });

      factory.registerStrategy(buildStrategy(NodeType.TRIGGER_IMAP, executeA));
      factory.registerStrategy(buildStrategy(NodeType.PROCESADOR_IA, executeB));
      factory.registerStrategy(buildStrategy(NodeType.DESTINO_HTTP, executeC));

      // 2. Act
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        schema,
      );

      // 3. Assert
      expect(executeC).toHaveBeenCalledTimes(1);
      expect(result.currentState).toBe(ExecutionState.EXITOSO);
    });
  });

  describe('1.2 Traza por nodo (PROT-18.1)', () => {
    it('deberia registrar una traza por cada nodo recorrido', async () => {
      // 1. Arrange
      const execution = buildExecution();
      const { repo } = buildRepository(execution);
      const execute = jest.fn().mockResolvedValue({ success: true });

      factory.registerStrategy(buildStrategy(NodeType.TRIGGER_IMAP, execute));
      factory.registerStrategy(buildStrategy(NodeType.PROCESADOR_IA, execute));
      factory.registerStrategy(buildStrategy(NodeType.DESTINO_HTTP, execute));

      // 2. Act
      await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildLinearSchema(),
      );

      // 3. Assert
      expect(hybridLogger.logNodeExecution).toHaveBeenCalledTimes(3);
      expect(hybridLogger.logNodeExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          executionId: EXECUTION_ID,
          nodeId: 'nodo_a',
          nodeType: NodeType.TRIGGER_IMAP,
          status: NodeLogStatus.OK,
        }),
      );

      const [firstTrace] = hybridLogger.logNodeExecution.mock.calls[0] as [
        { durationMs: number },
      ];
      expect(typeof firstTrace.durationMs).toBe('number');
    });

    it('deberia registrar UNA traza por intento, no una por nodo', async () => {
      // 1. Arrange: con una sola fila final los reintentos fallidos
      //    desapareceran, y son el dato que explica la incidencia.
      const execution = buildExecution();
      const { repo } = buildRepository(execution);
      const schema = buildLinearSchema();
      schema.nodes.nodo_a.retryPolicy = { maxRetries: 2 };

      const executeA = jest.fn().mockResolvedValue(failure('GRAVE'));
      factory.registerStrategy(buildStrategy(NodeType.TRIGGER_IMAP, executeA));

      // 2. Act
      await buildEngine(repo).executeWorkflow(EXECUTION_ID, schema);

      // 3. Assert: intento inicial + 2 reintentos.
      expect(executeA).toHaveBeenCalledTimes(3);
      expect(hybridLogger.logNodeExecution).toHaveBeenCalledTimes(3);
    });

    it('deberia marcar ADVERTENCIA y no ERROR ante un fallo LEVE', async () => {
      // 1. Arrange: quien lea la traza tiene que distinguir "fallo y hay que
      //    mirarlo" de "no pudo y volvera a intentarlo solo".
      const execution = buildExecution();
      const { repo } = buildRepository(execution);

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue(failure('LEVE')),
        ),
      );

      // 2. Act
      await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildLinearSchema(),
      );

      // 3. Assert
      expect(hybridLogger.logNodeExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          status: NodeLogStatus.ADVERTENCIA,
          severity: 'LEVE',
          errorCode: TEST_ERROR_CODE,
        }),
      );
    });

    it('deberia usar el customMessage de la ruta que atrapa ese codigo', async () => {
      // 1. Arrange: el mensaje de la estrategia esta escrito para quien depura;
      //    el customMessage explica por que importa el fallo en ESTE flujo.
      const execution = buildExecution();
      const { repo } = buildRepository(execution);
      const schema = buildLinearSchema();
      schema.nodes.nodo_a.onErrorStep = {
        targetNode: 'nodo_c',
        catchErrors: [TEST_ERROR_CODE],
        customMessage:
          'El buzon institucional no responde; se avisa a soporte.',
      };

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue(failure('GRAVE', 'fallo tecnico crudo')),
        ),
      );
      factory.registerStrategy(
        buildStrategy(
          NodeType.DESTINO_HTTP,
          jest.fn().mockResolvedValue({ success: true }),
        ),
      );

      // 2. Act
      await buildEngine(repo).executeWorkflow(EXECUTION_ID, schema);

      // 3. Assert
      expect(hybridLogger.logNodeExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          nodeId: 'nodo_a',
          message: 'El buzon institucional no responde; se avisa a soporte.',
        }),
      );
    });

    it('NO deberia usar el customMessage de una ruta que no atrapa ese codigo', async () => {
      // 1. Arrange: sustituir el mensaje real por uno pensado para otro fallo
      //    seria peor que no tener mensaje personalizado.
      const execution = buildExecution();
      const { repo } = buildRepository(execution);
      const schema = buildLinearSchema();
      schema.nodes.nodo_a.onErrorStep = {
        targetNode: 'nodo_c',
        catchErrors: [OTHER_ERROR_CODE],
        customMessage: 'no deberia aparecer',
      };

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue(failure('GRAVE', 'fallo tecnico crudo')),
        ),
      );

      // 2. Act
      await buildEngine(repo).executeWorkflow(EXECUTION_ID, schema);

      // 3. Assert
      expect(hybridLogger.logNodeExecution).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'fallo tecnico crudo' }),
      );
    });

    it('no deberia tumbar la ejecucion si el registro falla', async () => {
      // 1. Arrange: restriccion explicita del contrato. El servicio no lanza,
      //    pero esta prueba fija que el motor tampoco depende de ello.
      const execution = buildExecution();
      const { repo } = buildRepository(execution);
      hybridLogger.logNodeExecution.mockRejectedValue(
        new Error('connection terminated'),
      );

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue({ success: true }),
        ),
      );
      factory.registerStrategy(
        buildStrategy(
          NodeType.PROCESADOR_IA,
          jest.fn().mockResolvedValue({ success: true }),
        ),
      );
      factory.registerStrategy(
        buildStrategy(
          NodeType.DESTINO_HTTP,
          jest.fn().mockResolvedValue({ success: true }),
        ),
      );

      // 2. Act
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildLinearSchema(),
      );

      // 3. Assert: el flujo recorre sus tres nodos y termina bien pese a que
      //    NINGUNA traza se pudo registrar.
      expect(result.currentState).toBe(ExecutionState.EXITOSO);
      expect(hybridLogger.logNodeExecution).toHaveBeenCalledTimes(3);
    });
  });

  describe('2 y 3. Reintento intra-nodo', () => {
    it('deberia reintentar en el mismo nodo, incrementar retry_state y acabar en exito', async () => {
      // 1. Arrange: el nodo B falla GRAVE dos veces y luego funciona
      const execution = buildExecution();
      const { repo } = buildRepository(execution);
      const schema = buildLinearSchema();
      schema.nodes.nodo_b.retryPolicy = { maxRetries: 3 };

      const executeB = jest
        .fn()
        .mockResolvedValueOnce(failure('GRAVE'))
        .mockResolvedValueOnce(failure('GRAVE'))
        .mockResolvedValue({ success: true, data: { valorB: 2 } });

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue({ success: true }),
        ),
      );
      factory.registerStrategy(buildStrategy(NodeType.PROCESADOR_IA, executeB));
      factory.registerStrategy(
        buildStrategy(
          NodeType.DESTINO_HTTP,
          jest.fn().mockResolvedValue({ success: true }),
        ),
      );

      // 2. Act
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        schema,
      );

      // 3. Assert
      expect(executeB).toHaveBeenCalledTimes(3);
      expect(result.currentState).toBe(ExecutionState.EXITOSO);
      expect(result.retryState).toEqual({ nodo_b: 2 });
      expect(result.contextPayload.salida_b).toEqual({ valorB: 2 });
    });

    it('deberia reintentar sin alterar la ruta ni consumir presupuesto de transiciones', async () => {
      // 1. Arrange: un solo nodo terminal que falla y se recupera al tercer intento
      const execution = buildExecution();
      const { repo, update } = buildRepository(execution);
      const schema = buildLinearSchema();
      schema.nodes.nodo_a.nextStep = null;
      schema.nodes.nodo_a.retryPolicy = { maxRetries: 4 };

      const executeA = jest
        .fn()
        .mockResolvedValueOnce(failure('GRAVE'))
        .mockResolvedValueOnce(failure('GRAVE'))
        .mockResolvedValue({ success: true });

      factory.registerStrategy(buildStrategy(NodeType.TRIGGER_IMAP, executeA));

      // 2. Act
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        schema,
      );

      // 3. Assert: 3 ejecuciones del nodo pero una sola transicion de grafo
      expect(executeA).toHaveBeenCalledTimes(3);
      expect(result.currentState).toBe(ExecutionState.EXITOSO);

      const cursors = update.mock.calls.map(
        ([, patch]: [string, { activeCursor: string | null }]) =>
          patch.activeCursor,
      );
      // marca inicial + 2 checkpoints de reintento (mismo cursor) + el final
      expect(cursors).toEqual(['nodo_a', 'nodo_a', 'nodo_a', null]);
    });
  });

  describe('4. Limite del DTO (capa 1 de la defensa)', () => {
    it('deberia ejecutar como mucho 6 veces un nodo con el maxRetries maximo', async () => {
      // 1. Arrange: 5 es el techo que impone @Max(MAX_RETRY_ATTEMPTS) en el DTO
      const execution = buildExecution();
      const { repo } = buildRepository(execution);
      const schema = buildLinearSchema();
      schema.nodes.nodo_a.nextStep = null;
      schema.nodes.nodo_a.retryPolicy = { maxRetries: 5 };

      const executeA = jest.fn().mockResolvedValue(failure('GRAVE'));
      factory.registerStrategy(buildStrategy(NodeType.TRIGGER_IMAP, executeA));

      // 2. Act
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        schema,
      );

      // 3. Assert: intento inicial + 5 reintentos, y despues pausa
      expect(executeA).toHaveBeenCalledTimes(6);
      expect(result.currentState).toBe(ExecutionState.PAUSADO);
      expect(result.retryState).toEqual({ nodo_a: 5 });
    });
  });

  describe('5. Fallo con onErrorStep', () => {
    it('deberia saltar al nodo de recuperacion tras agotar los reintentos', async () => {
      // 1. Arrange: nodo_a falla siempre y deriva a nodo_c
      const execution = buildExecution();
      const { repo } = buildRepository(execution);
      const schema = buildLinearSchema();
      schema.nodes.nodo_a.onErrorStep = 'nodo_c';
      schema.nodes.nodo_a.retryPolicy = { maxRetries: 1 };

      const executeA = jest.fn().mockResolvedValue(failure('GRAVE'));
      const executeC = jest
        .fn()
        .mockResolvedValue({ success: true, data: { recuperado: true } });

      factory.registerStrategy(buildStrategy(NodeType.TRIGGER_IMAP, executeA));
      factory.registerStrategy(buildStrategy(NodeType.DESTINO_HTTP, executeC));

      // 2. Act
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        schema,
      );

      // 3. Assert
      expect(executeA).toHaveBeenCalledTimes(2);
      expect(executeC).toHaveBeenCalledTimes(1);
      expect(result.currentState).toBe(ExecutionState.EXITOSO);
      expect(result.contextPayload.salida_c).toEqual({ recuperado: true });
    });
  });

  describe('5ter. Contexto del error entregado al nodo de respaldo', () => {
    /**
     * Captura el contexto tal y como lo VE el nodo de respaldo.
     *
     * Se lee dentro de su `execute` y no del checkpoint final a proposito: lo
     * que importa es que el namespace este disponible en el momento en que el
     * respaldo corre, no que acabe persistido despues.
     */
    const captureFallbackContext = (): {
      readonly executeC: jest.Mock;
      readonly seen: Record<string, unknown>[];
    } => {
      const seen: Record<string, unknown>[] = [];
      const executeC = jest
        .fn()
        .mockImplementation((context: StatePayloadContext) => {
          seen.push(context.getNamespace(ERROR_CONTEXT_NAMESPACE) ?? {});

          return Promise.resolve({ success: true });
        });

      factory.registerStrategy(
        buildStrategy(
          NodeType.PROCESADOR_IA,
          jest.fn().mockResolvedValue({ success: true }),
        ),
      );
      factory.registerStrategy(buildStrategy(NodeType.DESTINO_HTTP, executeC));

      return { executeC, seen };
    };

    it('5t.1 deberia sembrar error_context con los metadatos del fallo', async () => {
      // 1. Arrange 📐
      const execution = buildExecution();
      const { repo } = buildRepository(execution);
      const schema = buildLinearSchema();
      schema.nodes.nodo_a.onErrorStep = 'nodo_c';

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue({
            ...failure('GRAVE', 'el buzon no responde'),
            data: { parcial: true },
          }),
        ),
      );
      const { seen } = captureFallbackContext();

      // 2. Act ⚙️
      await buildEngine(repo).executeWorkflow(EXECUTION_ID, schema);

      // 3. Assert 🎯: sin esto la rama de recuperacion es ciega. El nodo de
      //    respaldo sabria que le toca correr, pero no que fallo ni donde.
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        failed_node_id: 'nodo_a',
        failed_node_type: NodeType.TRIGGER_IMAP,
        error_code: TEST_ERROR_CODE,
        error_level: 'GRAVE',
        error_message: 'el buzon no responde',
        missing_fields: [],
        attempts: 0,
        partial_data: { parcial: true },
      });
      expect(typeof seen[0]?.failed_at).toBe('string');
    });

    it('5t.2 deberia preferir el customMessage de la ruta al mensaje del fallo', async () => {
      // 1. Arrange 📐
      const execution = buildExecution();
      const { repo } = buildRepository(execution);
      const schema = buildLinearSchema();
      schema.nodes.nodo_a.onErrorStep = {
        targetNode: 'nodo_c',
        catchErrors: [TEST_ERROR_CODE],
        customMessage: 'El buzon institucional lleva caido desde ayer',
      };

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue(failure('GRAVE', 'ETIMEDOUT en host X')),
        ),
      );
      const { seen } = captureFallbackContext();

      // 2. Act ⚙️
      await buildEngine(repo).executeWorkflow(EXECUTION_ID, schema);

      // 3. Assert 🎯: mismo criterio que `logNodeOutcome`. Ese texto existe para
      //    explicar el fallo a quien lo va a leer, y el nodo de respaldo —que
      //    normalmente redacta el aviso— es el primero de esos lectores.
      expect(seen[0]?.error_message).toBe(
        'El buzon institucional lleva caido desde ayer',
      );
      // El `code` NO se sustituye: es lo que identifica el fallo.
      expect(seen[0]?.error_code).toBe(TEST_ERROR_CODE);
    });

    it('5t.3 NO deberia sembrarlo cuando la ruta no atrapa el codigo', async () => {
      // 1. Arrange 📐
      const execution = buildExecution();
      const { repo } = buildRepository(execution);
      const schema = buildLinearSchema();
      schema.nodes.nodo_a.onErrorStep = {
        targetNode: 'nodo_c',
        catchErrors: [OTHER_ERROR_CODE],
      };

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue(failure('GRAVE')),
        ),
      );
      const { executeC } = captureFallbackContext();

      // 2. Act ⚙️
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        schema,
      );

      // 3. Assert 🎯: sin desvio no hay contexto de error que sembrar, y el
      //    checkpoint de la pausa no debe arrastrar un namespace que nadie pidio.
      expect(executeC).not.toHaveBeenCalled();
      expect(result.currentState).toBe(ExecutionState.PAUSADO);
      expect(result.contextPayload[ERROR_CONTEXT_NAMESPACE]).toBeUndefined();
    });

    it('5t.4 deberia pisar por completo el contexto de un desvio anterior', async () => {
      // 1. Arrange 📐: dos desvios en la misma ejecucion. `setNamespace` fusiona
      //    por clave, asi que el segundo fallo tiene que sobrescribir TODAS las
      //    del primero: un `missing_fields` heredado acusaria al nodo de
      //    respaldo de un campo ausente que no tiene nada que ver con su error.
      const execution = buildExecution();
      const { repo } = buildRepository(execution);
      const schema = buildLinearSchema();
      schema.nodes.nodo_a.onErrorStep = 'nodo_b';
      schema.nodes.nodo_b.onErrorStep = 'nodo_c';

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue({
            success: false,
            error: {
              level: 'GRAVE',
              code: TEST_ERROR_CODE,
              message: 'primer fallo',
              missingFields: ['parsed_email.clean_body'],
            },
          }),
        ),
      );

      const seen: Record<string, unknown>[] = [];
      factory.registerStrategy(
        buildStrategy(
          NodeType.PROCESADOR_IA,
          jest
            .fn()
            .mockResolvedValue(
              failure('GRAVE', 'segundo fallo', OTHER_ERROR_CODE),
            ),
        ),
      );
      factory.registerStrategy(
        buildStrategy(
          NodeType.DESTINO_HTTP,
          jest.fn().mockImplementation((context: StatePayloadContext) => {
            seen.push(context.getNamespace(ERROR_CONTEXT_NAMESPACE) ?? {});

            return Promise.resolve({ success: true });
          }),
        ),
      );

      // 2. Act ⚙️
      await buildEngine(repo).executeWorkflow(EXECUTION_ID, schema);

      // 3. Assert 🎯
      expect(seen[0]).toMatchObject({
        failed_node_id: 'nodo_b',
        error_code: OTHER_ERROR_CODE,
        error_message: 'segundo fallo',
        missing_fields: [],
      });
    });
  });

  describe('6. Fallo sin fallback', () => {
    it('deberia pausar conservando el cursor del nodo culpable', async () => {
      // 1. Arrange
      const execution = buildExecution();
      const { repo } = buildRepository(execution);
      const executeA = jest
        .fn()
        .mockResolvedValue({ success: true, data: { valorA: 1 } });
      const executeB = jest.fn().mockResolvedValue(failure('URGENTE'));

      factory.registerStrategy(buildStrategy(NodeType.TRIGGER_IMAP, executeA));
      factory.registerStrategy(buildStrategy(NodeType.PROCESADOR_IA, executeB));

      // 2. Act
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildLinearSchema(),
      );

      // 3. Assert: el cursor queda donde fallo, listo para el reintento de CU-09
      expect(result.currentState).toBe(ExecutionState.PAUSADO);
      expect(result.activeCursor).toBe('nodo_b');
      // El trabajo del nodo previo se conserva: reanudar no lo repite
      expect(result.contextPayload.salida_a).toEqual({ valorA: 1 });
    });

    it('deberia cerrar sin reintentar ni pausar cuando la severidad es LEVE', async () => {
      // 1. Arrange: LEVE no es reintentable aunque el nodo declare politica.
      const execution = buildExecution();
      const { repo } = buildRepository(execution);
      const schema = buildLinearSchema();
      schema.nodes.nodo_a.retryPolicy = { maxRetries: 5 };

      const executeA = jest
        .fn()
        .mockResolvedValue(failure('LEVE', 'Se agoto el tiempo de espera'));
      factory.registerStrategy(buildStrategy(NodeType.TRIGGER_IMAP, executeA));

      // 2. Act
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        schema,
      );

      // 3. Assert: FALLIDO y no PAUSADO. Pausar reservaria el cursor para el
      //    reintento manual de CU-09, y una incidencia transitoria se reintenta
      //    sola en el siguiente sondeo.
      expect(executeA).toHaveBeenCalledTimes(1);
      expect(result.currentState).toBe(ExecutionState.FALLIDO);
      expect(result.activeCursor).toBeNull();
      expect(result.failureReason).toBe('Se agoto el tiempo de espera');
      expect(result.retryState).toEqual({});
    });

    it('NO deberia volcar un .log forense al cerrar por LEVE', async () => {
      // 1. Arrange: el volcado lo reserva el desenlace catastrofico. Escribir un
      //    fichero por minuto durante una caida de red enterraria los
      //    incidentes reales bajo el ruido.
      const execution = buildExecution();
      const { repo } = buildRepository(execution);

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue(failure('LEVE')),
        ),
      );

      // 2. Act
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildLinearSchema(),
      );

      // 3. Assert
      expect(hybridLogger.logCatastrophicFailure).not.toHaveBeenCalled();
      expect(result.logFilePath).toBeNull();
    });
  });

  describe('5bis. Captura selectiva de errores en onErrorStep', () => {
    /** Registra las tres estrategias del pipeline lineal con un fallo en A. */
    const registerFailingEntrypoint = (
      result: NodeResult,
    ): { executeA: jest.Mock; executeC: jest.Mock } => {
      const executeA = jest.fn().mockResolvedValue(result);
      const executeC = jest.fn().mockResolvedValue({ success: true });

      factory.registerStrategy(buildStrategy(NodeType.TRIGGER_IMAP, executeA));
      factory.registerStrategy(
        buildStrategy(
          NodeType.PROCESADOR_IA,
          jest.fn().mockResolvedValue({ success: true }),
        ),
      );
      factory.registerStrategy(buildStrategy(NodeType.DESTINO_HTTP, executeC));

      return { executeA, executeC };
    };

    it('5b.1 deberia desviar SIEMPRE con la forma heredada de cadena', async () => {
      // 1. Arrange: la compatibilidad con los esquemas ya persistidos. Una
      //    cadena no discrimina: atrapa cualquier codigo.
      const execution = buildExecution();
      const { repo } = buildRepository(execution);
      const schema = buildLinearSchema();
      schema.nodes.nodo_a.onErrorStep = 'nodo_c';
      const { executeC } = registerFailingEntrypoint(
        failure('GRAVE', 'fallo', OTHER_ERROR_CODE),
      );

      // 2. Act
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        schema,
      );

      // 3. Assert
      expect(executeC).toHaveBeenCalledTimes(1);
      expect(result.currentState).toBe(ExecutionState.EXITOSO);
    });

    it('5b.2 deberia desviar cuando catchErrors incluye el codigo', async () => {
      // 1. Arrange
      const execution = buildExecution();
      const { repo } = buildRepository(execution);
      const schema = buildLinearSchema();
      schema.nodes.nodo_a.onErrorStep = {
        targetNode: 'nodo_c',
        catchErrors: [TEST_ERROR_CODE],
      };
      const { executeC } = registerFailingEntrypoint(failure('GRAVE'));

      // 2. Act
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        schema,
      );

      // 3. Assert
      expect(executeC).toHaveBeenCalledTimes(1);
      expect(result.currentState).toBe(ExecutionState.EXITOSO);
    });

    it('5b.3 deberia PAUSAR cuando catchErrors no incluye el codigo', async () => {
      // 1. Arrange: es lo que hace util declarar una ruta selectiva. Si atrapase
      //    todo seria una cadena con pasos de mas.
      const execution = buildExecution();
      const { repo } = buildRepository(execution);
      const schema = buildLinearSchema();
      schema.nodes.nodo_a.onErrorStep = {
        targetNode: 'nodo_c',
        catchErrors: [OTHER_ERROR_CODE],
      };
      const { executeC } = registerFailingEntrypoint(failure('GRAVE'));

      // 2. Act
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        schema,
      );

      // 3. Assert
      expect(executeC).not.toHaveBeenCalled();
      expect(result.currentState).toBe(ExecutionState.PAUSADO);
      expect(result.activeCursor).toBe('nodo_a');
    });

    it('5b.4 deberia dar prioridad a la ruta declarada sobre el cierre por LEVE', async () => {
      // 1. Arrange: un `catchErrors` que menciona un codigo LEVE es una decision
      //    explicita del disenador del flujo y debe ganar al comportamiento por
      //    defecto. Al reves, el nodo de respaldo no correria jamas y el sintoma
      //    seria mudo.
      const execution = buildExecution();
      const { repo } = buildRepository(execution);
      const schema = buildLinearSchema();
      schema.nodes.nodo_a.onErrorStep = {
        targetNode: 'nodo_c',
        catchErrors: [TEST_ERROR_CODE],
      };
      const { executeC } = registerFailingEntrypoint(failure('LEVE'));

      // 2. Act
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        schema,
      );

      // 3. Assert
      expect(executeC).toHaveBeenCalledTimes(1);
      expect(result.currentState).toBe(ExecutionState.EXITOSO);
    });

    it('5b.5 deberia ignorar una ruta con catchErrors vacio', async () => {
      // 1. Arrange: no atrapar nada es una declaracion valida, no un error.
      const execution = buildExecution();
      const { repo } = buildRepository(execution);
      const schema = buildLinearSchema();
      schema.nodes.nodo_a.onErrorStep = {
        targetNode: 'nodo_c',
        catchErrors: [],
      };
      const { executeC } = registerFailingEntrypoint(failure('GRAVE'));

      // 2. Act
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        schema,
      );

      // 3. Assert
      expect(executeC).not.toHaveBeenCalled();
      expect(result.currentState).toBe(ExecutionState.PAUSADO);
    });
  });

  describe('7. Excepcion no controlada: fallo catastrofico', () => {
    it('deberia marcar FALLIDO sin propagar la excepcion', async () => {
      // 1. Arrange
      const execution = buildExecution();
      const { repo } = buildRepository(execution);
      const executeA = jest
        .fn()
        .mockRejectedValue(new Error('El socket IMAP se cerro de golpe'));

      factory.registerStrategy(buildStrategy(NodeType.TRIGGER_IMAP, executeA));

      // 2. Act: la promesa RESUELVE, no rechaza; el proceso no cae
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildLinearSchema(),
      );

      // 3. Assert: FALLIDO y NO pausado. Una estrategia que lanza se ha roto, y
      // reanudarla con CU-09 repetiria el mismo fallo; hay que corregir el
      // codigo y lanzar una ejecucion nueva. El cursor se conserva porque saber
      // donde se rompio es la mitad del diagnostico.
      expect(result.currentState).toBe(ExecutionState.FALLIDO);
      expect(result.activeCursor).toBe('nodo_a');
    });

    it('deberia volcar el stack trace a disco y persistir su ruta', async () => {
      // 1. Arrange
      const execution = buildExecution();
      const { repo } = buildRepository(execution);
      const boom = new Error('TypeError: cannot read properties of undefined');
      factory.registerStrategy(
        buildStrategy(NodeType.TRIGGER_IMAP, jest.fn().mockRejectedValue(boom)),
      );

      // 2. Act
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildLinearSchema(),
      );

      // 3. Assert
      expect(hybridLogger.logCatastrophicFailure).toHaveBeenCalledTimes(1);
      expect(hybridLogger.logCatastrophicFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          executionId: EXECUTION_ID,
          flowId: FLOW_ID,
          nodeId: 'nodo_a',
          level: 'URGENTE',
          message: boom.message,
          stackTrace: boom.stack,
        }),
      );
      // La ruta es el unico eslabon entre el volcado y la fila: sin ella la
      // traza de la base de datos sabria que hubo fallo pero no donde mirar.
      expect(result.logFilePath).toBe(LOG_PATH);
    });

    it('NO deberia reintentar una estrategia que lanza, aunque declare retryPolicy', async () => {
      // 1. Arrange
      const execution = buildExecution();
      const { repo } = buildRepository(execution);
      const schema = buildLinearSchema();
      schema.nodes.nodo_a.retryPolicy = { maxRetries: 3 };
      const executeA = jest.fn().mockRejectedValue(new Error('roto'));

      factory.registerStrategy(buildStrategy(NodeType.TRIGGER_IMAP, executeA));

      // 2. Act
      await buildEngine(repo).executeWorkflow(EXECUTION_ID, schema);

      // 3. Assert: no se sabe que dejo a medias, asi que volver a invocarla es
      // apostar sobre un estado desconocido.
      expect(executeA).toHaveBeenCalledTimes(1);
    });

    it('NO deberia seguir onErrorStep ante un fallo catastrofico', async () => {
      // 1. Arrange
      const execution = buildExecution();
      const { repo } = buildRepository(execution);
      const schema = buildLinearSchema();
      schema.nodes.nodo_a.onErrorStep = 'nodo_c';
      const executeC = jest.fn().mockResolvedValue({ success: true });

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockRejectedValue(new Error('roto')),
        ),
      );
      factory.registerStrategy(buildStrategy(NodeType.DESTINO_HTTP, executeC));

      // 2. Act
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        schema,
      );

      // 3. Assert: `onErrorStep` es una decision sobre fallos PREVISTOS; aqui se
      // rompio el propio ejecutor, y encaminar a otro nodo prolongaria el bucle
      // sobre un proceso en estado desconocido.
      expect(executeC).not.toHaveBeenCalled();
      expect(result.currentState).toBe(ExecutionState.FALLIDO);
    });

    it('deberia tratar un HttpException de la estrategia como fallo de DOMINIO', async () => {
      // 1. Arrange: un timeout o un fallo de validacion de `params` viaja asi
      const execution = buildExecution();
      const { repo } = buildRepository(execution);
      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest
            .fn()
            .mockRejectedValue(
              new BadRequestException('mailbox no puede estar vacio'),
            ),
        ),
      );

      // 2. Act
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildLinearSchema(),
      );

      // 3. Assert: PAUSADO y reanudable; el operador corrige el esquema y sigue
      expect(result.currentState).toBe(ExecutionState.PAUSADO);
      expect(hybridLogger.logCatastrophicFailure).not.toHaveBeenCalled();
    });

    it('deberia tratar un URGENTE DEVUELTO como fallo de dominio, no catastrofico', async () => {
      // 1. Arrange
      const execution = buildExecution();
      const { repo } = buildRepository(execution);
      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue(failure('URGENTE')),
        ),
      );

      // 2. Act
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildLinearSchema(),
      );

      // 3. Assert: la estrategia CONTROLABA la situacion y lo comunico. Que sea
      // grave no la convierte en catastrofica, y el flujo sigue siendo
      // reanudable con CU-09.
      expect(result.currentState).toBe(ExecutionState.PAUSADO);
      expect(hybridLogger.logCatastrophicFailure).not.toHaveBeenCalled();
    });
  });

  describe('8. Estrategia inexistente', () => {
    it('deberia aislar StrategyNotFoundException y pausar de forma controlada', async () => {
      // 1. Arrange: la factoria arranca vacia, nadie registra TRIGGER_IMAP

      const execution = buildExecution();
      const { repo } = buildRepository(execution);

      // 2. Act
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildLinearSchema(),
      );

      // 3. Assert
      expect(result.currentState).toBe(ExecutionState.PAUSADO);
      expect(result.activeCursor).toBe('nodo_a');
    });
  });

  describe('9. Circuit breaker de grafo (capa 2)', () => {
    it('deberia cortar un ciclo A -> B -> A exactamente en MAX_TRANSITIONS', async () => {
      // 1. Arrange: nodo_a falla y deriva a nodo_b, que vuelve a nodo_a
      const execution = buildExecution();
      const { repo } = buildRepository(execution);
      const schema = buildLinearSchema();
      schema.nodes.nodo_a.onErrorStep = 'nodo_b';
      schema.nodes.nodo_b.nextStep = 'nodo_a';

      const executeA = jest.fn().mockResolvedValue(failure('URGENTE'));
      const executeB = jest.fn().mockResolvedValue({ success: true });

      factory.registerStrategy(buildStrategy(NodeType.TRIGGER_IMAP, executeA));
      factory.registerStrategy(buildStrategy(NodeType.PROCESADOR_IA, executeB));

      // 2. Act
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        schema,
      );

      // 3. Assert: 100 visitas a nodo en total, ni una mas
      const visits = executeA.mock.calls.length + executeB.mock.calls.length;
      expect(visits).toBe(MAX_TRANSITIONS);
      expect(result.currentState).toBe(ExecutionState.PAUSADO);
    });
  });

  describe('10. Restauracion y reanudacion', () => {
    it('deberia arrancar desde el cursor persistido con el contexto previo intacto', async () => {
      // 1. Arrange: una ejecucion pausada en nodo_b que ya completo nodo_a
      const execution = buildExecution({
        currentState: ExecutionState.PAUSADO,
        activeCursor: 'nodo_b',
        contextPayload: { salida_a: { valorA: 1 } },
        retryState: { nodo_b: 1 },
      });
      const { repo } = buildRepository(execution);

      const executeA = jest.fn();
      const executeB = jest.fn().mockResolvedValue({ success: true });
      const executeC = jest.fn().mockResolvedValue({ success: true });

      factory.registerStrategy(buildStrategy(NodeType.TRIGGER_IMAP, executeA));
      factory.registerStrategy(buildStrategy(NodeType.PROCESADOR_IA, executeB));
      factory.registerStrategy(buildStrategy(NodeType.DESTINO_HTTP, executeC));

      // 2. Act
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildLinearSchema(),
      );

      // 3. Assert: nodo_a no se repite y su salida sigue en el contexto
      expect(executeA).not.toHaveBeenCalled();
      expect(executeB).toHaveBeenCalledTimes(1);
      expect(result.currentState).toBe(ExecutionState.EXITOSO);
      expect(result.contextPayload.salida_a).toEqual({ valorA: 1 });
      // El contador heredado se respeta: no se reinicia al reanudar
      expect(result.retryState).toEqual({ nodo_b: 1 });
    });

    it('deberia exponer el contexto restaurado a la estrategia que reanuda', async () => {
      // 1. Arrange
      const execution = buildExecution({
        currentState: ExecutionState.PAUSADO,
        activeCursor: 'nodo_b',
        contextPayload: { salida_a: { titulo: 'Noticia previa' } },
      });
      const { repo } = buildRepository(execution);

      let seen: string | undefined;
      const executeB = jest.fn((context: StatePayloadContext) => {
        seen = context.getInterpolatedValue('{{ salida_a.titulo }}');

        return Promise.resolve({ success: true });
      });

      factory.registerStrategy(buildStrategy(NodeType.PROCESADOR_IA, executeB));
      factory.registerStrategy(
        buildStrategy(
          NodeType.DESTINO_HTTP,
          jest.fn().mockResolvedValue({ success: true }),
        ),
      );

      // 2. Act
      await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildLinearSchema(),
      );

      // 3. Assert
      expect(seen).toBe('Noticia previa');
    });
  });

  describe('initialPayload y namespace trigger', () => {
    it('deberia cargar el payload inicial en el namespace trigger e interpolarlo', async () => {
      // 1. Arrange
      const execution = buildExecution();
      const { repo } = buildRepository(execution);

      let seen: string | undefined;
      const executeA = jest.fn((context: StatePayloadContext) => {
        seen = context.getInterpolatedValue('{{ trigger.remitente }}');

        return Promise.resolve({ success: true });
      });

      factory.registerStrategy(buildStrategy(NodeType.TRIGGER_IMAP, executeA));
      factory.registerStrategy(
        buildStrategy(
          NodeType.PROCESADOR_IA,
          jest.fn().mockResolvedValue({ success: true }),
        ),
      );
      factory.registerStrategy(
        buildStrategy(
          NodeType.DESTINO_HTTP,
          jest.fn().mockResolvedValue({ success: true }),
        ),
      );

      // 2. Act
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildLinearSchema(),
        { initialPayload: { remitente: 'prensa@unuware.com' } },
      );

      // 3. Assert
      expect(seen).toBe('prensa@unuware.com');
      expect(result.contextPayload[TRIGGER_NAMESPACE]).toEqual({
        remitente: 'prensa@unuware.com',
      });
    });
  });

  describe('skipNodeTypes (omision de nodos en modo prueba)', () => {
    /**
     * El nodo omitido en estas pruebas es `nodo_a` (TRIGGER_IMAP), que es
     * exactamente el caso real: el disparador abriria una conexion IMAP y
     * pisaria el contexto simulado que el despacho de pruebas acaba de sembrar.
     */
    const registerDownstreamStrategies = (): void => {
      factory.registerStrategy(
        buildStrategy(
          NodeType.PROCESADOR_IA,
          jest.fn().mockResolvedValue({ success: true }),
        ),
      );
      factory.registerStrategy(
        buildStrategy(
          NodeType.DESTINO_HTTP,
          jest.fn().mockResolvedValue({ success: true }),
        ),
      );
    };

    it('NO deberia resolver ni ejecutar la estrategia de un tipo omitido', async () => {
      // 1. Arrange
      const { repo } = buildRepository(buildExecution());
      const triggerExecute = jest.fn().mockResolvedValue({ success: true });
      factory.registerStrategy(
        buildStrategy(NodeType.TRIGGER_IMAP, triggerExecute),
      );
      registerDownstreamStrategies();

      // La factoria es la REAL: si el motor pidiera la estrategia del nodo
      // omitido, este espia lo delataria aunque la ejecucion siguiera en verde.
      const getStrategy = jest.spyOn(factory, 'getStrategy');

      // 2. Act
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildLinearSchema(),
        { skipNodeTypes: [NodeType.TRIGGER_IMAP] },
      );

      // 3. Assert
      expect(triggerExecute).not.toHaveBeenCalled();
      expect(getStrategy).not.toHaveBeenCalledWith(NodeType.TRIGGER_IMAP);
      expect(result.currentState).toBe(ExecutionState.EXITOSO);
    });

    it('deberia conservar intacto el namespace ya sembrado del nodo omitido', async () => {
      // 1. Arrange
      // El namespace del disparador llega sembrado, como lo deja
      // `createExecution` con el `mockData` del despacho de pruebas.
      const seeded = { message_id: '<test-msg-001@madridmasd.es>' };
      const { repo } = buildRepository(
        buildExecution({ contextPayload: { salida_a: seeded } }),
      );
      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue({ success: true }),
        ),
      );
      registerDownstreamStrategies();

      // 2. Act
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildLinearSchema(),
        { skipNodeTypes: [NodeType.TRIGGER_IMAP] },
      );

      // 3. Assert
      // Ni pisado con `{}` ni borrado: es el dato simulado que motiva la omision.
      expect(result.contextPayload.salida_a).toEqual(seeded);
    });

    it('deberia avanzar el cursor a nextStep y persistir el checkpoint de la transicion', async () => {
      // 1. Arrange
      const { repo, update } = buildRepository(buildExecution());
      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue({ success: true }),
        ),
      );
      registerDownstreamStrategies();

      // 2. Act
      await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildLinearSchema(),
        {
          skipNodeTypes: [NodeType.TRIGGER_IMAP],
        },
      );

      // 3. Assert
      // Un nodo omitido es un salto real del cursor, no una desaparicion: debe
      // dejar su checkpoint como cualquier otra transicion, para que un reinicio
      // reanude en `nodo_b` y no vuelva a plantarse en el disparador.
      const cursors = update.mock.calls.map(
        (call: unknown[]) =>
          (call[1] as { activeCursor: string | null }).activeCursor,
      );
      expect(cursors).toContain('nodo_b');
    });

    it('SI deberia ejecutar ese mismo nodo cuando no se declara skipNodeTypes', async () => {
      // 1. Arrange
      const { repo } = buildRepository(buildExecution());
      const triggerExecute = jest.fn().mockResolvedValue({ success: true });
      factory.registerStrategy(
        buildStrategy(NodeType.TRIGGER_IMAP, triggerExecute),
      );
      registerDownstreamStrategies();

      // 2. Act
      // Sin opciones: es como despacha `runAutomaticWorkflow`, donde el
      // disparador SI debe conectarse de verdad.
      await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildLinearSchema(),
      );

      // 3. Assert
      expect(triggerExecute).toHaveBeenCalledTimes(1);
    });
  });

  describe('backoff exponencial', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('deberia esperar backoffMs y luego backoffMs * factor entre reintentos', async () => {
      // 1. Arrange
      const execution = buildExecution();
      const { repo } = buildRepository(execution);
      const schema = buildLinearSchema();
      schema.nodes.nodo_a.nextStep = null;
      schema.nodes.nodo_a.retryPolicy = {
        maxRetries: 3,
        backoffMs: 1000,
        backoffFactor: 3,
      };

      const executeA = jest
        .fn()
        .mockResolvedValueOnce(failure('GRAVE'))
        .mockResolvedValueOnce(failure('GRAVE'))
        .mockResolvedValue({ success: true });

      factory.registerStrategy(buildStrategy(NodeType.TRIGGER_IMAP, executeA));

      // 2. Act
      const pending = buildEngine(repo).executeWorkflow(EXECUTION_ID, schema);

      // Primer reintento: 1000 * 3^0
      await jest.advanceTimersByTimeAsync(999);
      expect(executeA).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(executeA).toHaveBeenCalledTimes(2);

      // Segundo reintento: 1000 * 3^1
      await jest.advanceTimersByTimeAsync(2999);
      expect(executeA).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(1);

      const result = await pending;

      // 3. Assert
      expect(executeA).toHaveBeenCalledTimes(3);
      expect(result.currentState).toBe(ExecutionState.EXITOSO);
    });
  });

  describe('precondiciones y fallo catastrofico', () => {
    it('deberia lanzar NotFoundException si la ejecucion no existe', async () => {
      // 1. Arrange
      const repo = {
        findOne: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      } as unknown as Repository<FsmExecution>;

      // 2. Act + 3. Assert
      await expect(
        buildEngine(repo).executeWorkflow(EXECUTION_ID, buildLinearSchema()),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('deberia lanzar ConflictException si la ejecucion ya esta EN_PROCESO', async () => {
      // 1. Arrange: el mutex de la BD lo impide, pero el motor tampoco debe pisarla
      const execution = buildExecution({
        currentState: ExecutionState.EN_PROCESO,
      });
      const { repo, update } = buildRepository(execution);

      // 2. Act + 3. Assert
      await expect(
        buildEngine(repo).executeWorkflow(EXECUTION_ID, buildLinearSchema()),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(update).not.toHaveBeenCalled();
    });

    it('deberia intentar marcar FALLIDO y re-lanzar ante un fallo de base de datos', async () => {
      // 1. Arrange: el primer update (marca EN_PROCESO) pasa, el segundo revienta
      const execution = buildExecution();
      const { repo, update } = buildRepository(execution);
      update
        .mockResolvedValueOnce({ affected: 1 })
        .mockRejectedValueOnce(new Error('conexion perdida con PostgreSQL'))
        .mockResolvedValue({ affected: 1 });

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue({ success: true }),
        ),
      );

      // 2. Act + 3. Assert
      await expect(
        buildEngine(repo).executeWorkflow(EXECUTION_ID, buildLinearSchema()),
      ).rejects.toThrow('conexion perdida con PostgreSQL');
      expect(execution.currentState).toBe(ExecutionState.FALLIDO);
    });
  });
  describe('mutex de ejecucion idx_flujo_activo (RNF-09)', () => {
    /**
     * Arranca el motor con la PRIMERA escritura rechazada por el driver.
     *
     * Esa escritura —la que marca EN_PROCESO— es la unica que puede perder la
     * carrera contra el indice unico parcial, asi que basta con un
     * `mockRejectedValueOnce` para reproducir el choque completo.
     */
    const runWithFirstWriteRejected = async (
      rejection: unknown,
    ): Promise<{
      execution: FsmExecution;
      update: jest.Mock;
      caught: unknown;
    }> => {
      const execution = buildExecution();
      const { repo, update } = buildRepository(execution);
      update.mockRejectedValueOnce(rejection);

      const caught: unknown = await buildEngine(repo)
        .executeWorkflow(EXECUTION_ID, buildLinearSchema())
        .then(() => undefined)
        .catch((error: unknown) => error);

      return { execution, update, caught };
    };

    it('deberia traducir la violacion del mutex a ConflictException', async () => {
      // 1. Arrange & 2. Act
      const { caught } = await runWithFirstWriteRejected(
        buildQueryFailedError('23505', 'idx_flujo_activo'),
      );

      // 3. Assert: el mensaje nombra el flujo, que es lo que el operador busca
      expect(caught).toBeInstanceOf(ConflictException);
      expect((caught as ConflictException).message).toContain(FLOW_ID);
    });

    it('NO deberia marcar FALLIDO al perder la carrera por el mutex', async () => {
      // 1. Arrange & 2. Act
      const { execution, update } = await runWithFirstWriteRejected(
        buildQueryFailedError('23505', 'idx_flujo_activo'),
      );

      // 3. Assert: no le tocaba turno, el flujo no ha fallado. Y la entidad en
      // memoria no debe anunciar un estado que la fila nunca llego a tener.
      expect(update).toHaveBeenCalledTimes(1);
      expect(update).not.toHaveBeenCalledWith(
        EXECUTION_ID,
        expect.objectContaining({ currentState: ExecutionState.FALLIDO }),
      );
      expect(execution.currentState).toBe(ExecutionState.INACTIVO);
    });

    it('deberia aceptar el 23505 aunque el driver no informe la restriccion', async () => {
      // 1. Arrange & 2. Act: rama tolerante de la guarda
      const { caught } = await runWithFirstWriteRejected(
        buildQueryFailedError('23505'),
      );

      // 3. Assert
      expect(caught).toBeInstanceOf(ConflictException);
    });

    it('deberia propagar un 23505 de OTRA restriccion sin disfrazarlo de 409', async () => {
      // 1. Arrange & 2. Act
      const { caught } = await runWithFirstWriteRejected(
        buildQueryFailedError('23505', 'ejecuciones_flujo_pkey'),
      );

      // 3. Assert: convertirlo en 409 enmascararia un bug distinto
      expect(caught).toBeInstanceOf(QueryFailedError);
      expect(caught).not.toBeInstanceOf(ConflictException);
    });

    it('deberia propagar un fallo de BD distinto del mutex sin marcar FALLIDO', async () => {
      // 1. Arrange & 2. Act: 40001 es `serialization_failure`
      const { caught, update } = await runWithFirstWriteRejected(
        buildQueryFailedError('40001'),
      );

      // 3. Assert: esta escritura vive FUERA del try externo, asi que ningun
      // fallo suyo marca FALLIDO; eso solo ocurre con los fallos del bucle.
      expect(caught).toBeInstanceOf(QueryFailedError);
      expect(caught).not.toBeInstanceOf(ConflictException);
      expect(update).toHaveBeenCalledTimes(1);
    });

    it('deberia propagar tal cual un error ajeno a TypeORM', async () => {
      // 1. Arrange & 2. Act: cubre la guarda `instanceof` del helper
      const { caught } = await runWithFirstWriteRejected(
        new Error('conexion perdida con PostgreSQL'),
      );

      // 3. Assert
      expect(caught).not.toBeInstanceOf(ConflictException);
      expect((caught as Error).message).toBe('conexion perdida con PostgreSQL');
    });
  });

  describe('createExecution y control de concurrencia (RNF-09)', () => {
    /** Doble con `count` y `create`/`save`, que `buildRepository` no cubre. */
    const buildCreationRepository = (
      activeCount: number,
    ): {
      repo: Repository<FsmExecution>;
      count: jest.Mock;
      save: jest.Mock;
    } => {
      const count = jest.fn().mockResolvedValue(activeCount);
      const save = jest.fn((entity: FsmExecution) => Promise.resolve(entity));
      const create = jest.fn((entity: Partial<FsmExecution>) => entity);

      return {
        repo: { count, create, save } as unknown as Repository<FsmExecution>,
        count,
        save,
      };
    };

    it('deberia crear la ejecucion INACTIVO sembrando los namespaces recibidos', async () => {
      // 1. Arrange
      const { repo, count, save } = buildCreationRepository(0);
      const initialContext = {
        parsed_email: { clean_title: 'Noticia de prueba' },
      };

      // 2. Act
      const execution = await buildEngine(repo).createExecution(
        FLOW_ID,
        initialContext,
      );

      // 3. Assert
      expect(count).toHaveBeenCalledWith({
        where: { flowId: FLOW_ID, currentState: ExecutionState.EN_PROCESO },
      });
      expect(save).toHaveBeenCalledTimes(1);
      expect(execution.currentState).toBe(ExecutionState.INACTIVO);
      expect(execution.activeCursor).toBeNull();
      expect(execution.contextPayload).toEqual(initialContext);
    });

    it('deberia lanzar ConflictException si el flujo ya tiene una instancia EN_PROCESO', async () => {
      // 1. Arrange
      const { repo, save } = buildCreationRepository(1);

      // 2. Act + 3. Assert: se rechaza ANTES de insertar, no despues
      await expect(
        buildEngine(repo).createExecution(FLOW_ID),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(save).not.toHaveBeenCalled();
    });

    it('deberia respetar el cupo declarado en MAX_CONCURRENT_EXECUTIONS_PER_FLOW', async () => {
      // 1. Arrange: con cupo 2, una sola instancia activa no bloquea
      const { repo, save } = buildCreationRepository(1);
      const configService = new ConfigService({
        MAX_CONCURRENT_EXECUTIONS_PER_FLOW: '2',
      });

      // 2. Act
      await buildEngine(repo, configService).createExecution(FLOW_ID);

      // 3. Assert
      expect(save).toHaveBeenCalledTimes(1);
    });
  });

  describe('11. Aborto de las ejecuciones de un flujo desactivado', () => {
    /**
     * Repositorio con `find`, que es lo que `abortExecutionsForFlow` usa para
     * saber a que bucles vivos hay que avisar antes del UPDATE masivo.
     */
    const buildAbortRepository = (
      live: Array<Pick<FsmExecution, 'executionId' | 'currentState'>>,
      execution: FsmExecution = buildExecution(),
    ): {
      repo: Repository<FsmExecution>;
      update: jest.Mock;
      find: jest.Mock;
    } => {
      const findOne = jest.fn().mockResolvedValue(execution);
      const update = jest.fn().mockResolvedValue({ affected: live.length });
      const find = jest.fn().mockResolvedValue(live);

      return {
        repo: { findOne, update, find } as unknown as Repository<FsmExecution>,
        update,
        find,
      };
    };

    it('11.1 deberia cerrar como FALLIDO las EN_PROCESO y las PAUSADO', async () => {
      // 1. Arrange
      const { repo, update, find } = buildAbortRepository([
        { executionId: EXECUTION_ID, currentState: ExecutionState.EN_PROCESO },
        { executionId: 'otra', currentState: ExecutionState.PAUSADO },
      ]);

      // 2. Act
      const closed = await buildEngine(repo).abortExecutionsForFlow(
        FLOW_ID,
        'Flujo padre desactivado',
      );

      // 3. Assert
      expect(closed).toBe(2);
      expect(find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            flowId: FLOW_ID,
            currentState: In([
              ExecutionState.EN_PROCESO,
              ExecutionState.PAUSADO,
            ]),
          },
        }),
      );
      expect(update).toHaveBeenCalledWith(
        {
          flowId: FLOW_ID,
          currentState: In([ExecutionState.EN_PROCESO, ExecutionState.PAUSADO]),
        },
        {
          currentState: ExecutionState.FALLIDO,
          failureReason: 'Flujo padre desactivado',
        },
      );
    });

    it('11.2 no deberia escribir nada si el flujo no tiene ejecuciones vivas', async () => {
      // 1. Arrange: el caso normal al desactivar un flujo que estaba quieto.
      const { repo, update } = buildAbortRepository([]);

      // 2. Act
      const closed = await buildEngine(repo).abortExecutionsForFlow(
        FLOW_ID,
        'Flujo padre desactivado',
      );

      // 3. Assert
      expect(closed).toBe(0);
      expect(update).not.toHaveBeenCalled();
    });

    it('11.3 deberia recortar el motivo al ancho de la columna', async () => {
      // 1. Arrange: el motivo puede interpolar el nombre del flujo, que lo
      //    escribe un usuario; sin recorte seria un `value too long`.
      const { repo, update } = buildAbortRepository([
        { executionId: EXECUTION_ID, currentState: ExecutionState.PAUSADO },
      ]);

      // 2. Act
      await buildEngine(repo).abortExecutionsForFlow(FLOW_ID, 'x'.repeat(400));

      // 3. Assert
      const [, patch] = update.mock.calls[0] as [
        unknown,
        { failureReason: string },
      ];
      expect(patch.failureReason).toHaveLength(255);
    });

    it('11.4 deberia detener el bucle vivo sin escribir ningun checkpoint mas', async () => {
      // 1. Arrange: el nodo A aborta el flujo como efecto lateral, simulando la
      //    desactivacion que ocurre mientras la ejecucion esta en curso.
      // La fila arranca INACTIVO: `executeWorkflow` rechaza con 409 una que ya
      // venga EN_PROCESO, porque eso significaria un segundo bucle.
      const execution = buildExecution();
      const { repo, update } = buildAbortRepository(
        [
          {
            executionId: EXECUTION_ID,
            currentState: ExecutionState.EN_PROCESO,
          },
        ],
        execution,
      );
      const engine = buildEngine(repo);

      const executeA = jest.fn().mockImplementation(async () => {
        await engine.abortExecutionsForFlow(FLOW_ID, 'Flujo padre desactivado');
        return { success: true, data: { valorA: 1 } };
      });
      const executeB = jest.fn().mockResolvedValue({ success: true });
      const executeC = jest.fn().mockResolvedValue({ success: true });

      factory.registerStrategy(buildStrategy(NodeType.TRIGGER_IMAP, executeA));
      factory.registerStrategy(buildStrategy(NodeType.PROCESADOR_IA, executeB));
      factory.registerStrategy(buildStrategy(NodeType.DESTINO_HTTP, executeC));

      // 2. Act
      await engine.executeWorkflow(EXECUTION_ID, buildLinearSchema());

      // 3. Assert: el bucle abandona en el nodo A, sin llegar a B ni a C.
      expect(executeB).not.toHaveBeenCalled();
      expect(executeC).not.toHaveBeenCalled();

      // Y sobre todo, sin resucitar la fila: ningun checkpoint posterior al
      // UPDATE masivo. Si lo hubiera, la ejecucion volveria a EN_PROCESO y
      // seguiria reservando el mutex `idx_flujo_activo`.
      const statesWritten = update.mock.calls
        .map(
          ([, patch]) =>
            (patch as { currentState?: ExecutionState }).currentState,
        )
        .filter((state) => state !== undefined);
      expect(statesWritten).not.toContain(ExecutionState.EXITOSO);
      expect(statesWritten.at(-1)).toBe(ExecutionState.FALLIDO);
    });

    it('11.5 deberia devolver la entidad ya marcada FALLIDO al abortar', async () => {
      // 1. Arrange: `update()` masivo no refresca la instancia cargada, asi que
      //    sin el ajuste en memoria el llamante recibiria un EN_PROCESO falso.
      const execution = buildExecution();
      const { repo } = buildAbortRepository(
        [
          {
            executionId: EXECUTION_ID,
            currentState: ExecutionState.EN_PROCESO,
          },
        ],
        execution,
      );
      const engine = buildEngine(repo);

      const executeA = jest.fn().mockImplementation(async () => {
        await engine.abortExecutionsForFlow(FLOW_ID, 'Flujo padre desactivado');
        return { success: true };
      });
      factory.registerStrategy(buildStrategy(NodeType.TRIGGER_IMAP, executeA));
      factory.registerStrategy(
        buildStrategy(NodeType.PROCESADOR_IA, jest.fn()),
      );
      factory.registerStrategy(buildStrategy(NodeType.DESTINO_HTTP, jest.fn()));

      // 2. Act
      const result = await engine.executeWorkflow(
        EXECUTION_ID,
        buildLinearSchema(),
      );

      // 3. Assert
      expect(result.currentState).toBe(ExecutionState.FALLIDO);
      expect(result.failureReason).toBe('Flujo padre desactivado');
    });

    it('11.6 no deberia abortar un reintento posterior de la misma ejecucion', async () => {
      // 1. Arrange: una marca superviviente envenenaria el reintento manual de
      //    CU-09, que reutiliza el mismo `executionId`.
      const execution = buildExecution({
        currentState: ExecutionState.PAUSADO,
      });
      const { repo } = buildAbortRepository(
        [
          {
            executionId: EXECUTION_ID,
            currentState: ExecutionState.EN_PROCESO,
          },
        ],
        execution,
      );
      const engine = buildEngine(repo);
      await engine.abortExecutionsForFlow(FLOW_ID, 'Flujo padre desactivado');

      const executeA = jest.fn().mockResolvedValue({ success: true });
      const executeB = jest.fn().mockResolvedValue({ success: true });
      const executeC = jest.fn().mockResolvedValue({ success: true });
      factory.registerStrategy(buildStrategy(NodeType.TRIGGER_IMAP, executeA));
      factory.registerStrategy(buildStrategy(NodeType.PROCESADOR_IA, executeB));
      factory.registerStrategy(buildStrategy(NodeType.DESTINO_HTTP, executeC));

      // 2. Act: el flujo se reactiva y se relanza la ejecucion.
      const result = await engine.executeWorkflow(
        EXECUTION_ID,
        buildLinearSchema(),
      );

      // 3. Assert
      expect(executeC).toHaveBeenCalledTimes(1);
      expect(result.currentState).toBe(ExecutionState.EXITOSO);
    });
  });

  describe('12. Liberacion de binarios de adjuntos', () => {
    const BASE64 = 'Y29udGVuaWRvLWJpbmFyaW8tZGUtcHJ1ZWJh';

    /** Adjunto tal como lo escribe el nodo IMAP, con su binario todavia vivo. */
    const buildAttachment = (): Record<string, unknown> => ({
      filename: 'escaneo.pdf',
      contentType: 'application/pdf',
      size: 1024,
      contentBase64: BASE64,
    });

    /**
     * Pipeline de 2 nodos cuyo primer paso escribe en `raw_email`.
     *
     * El namespace importa: la purga es estructural y se aplica sobre ese nombre
     * concreto, no sobre el nodo que lo produjo.
     */
    const buildEmailSchema = (): PipelineSchemaDto => ({
      flowId: FLOW_ID,
      name: 'Pipeline de correo',
      version: '1.0.0',
      entrypoint: 'nodo_a',
      nodes: {
        nodo_a: {
          nodeId: 'nodo_a',
          nodeType: NodeType.TRIGGER_IMAP,
          outputNamespace: 'raw_email',
          nextStep: 'nodo_b',
          onErrorStep: null,
          params: {},
        },
        nodo_b: {
          nodeId: 'nodo_b',
          nodeType: NodeType.PROCESADOR_IA,
          outputNamespace: 'parsed_email',
          nextStep: null,
          onErrorStep: null,
          params: {},
        },
      },
    });

    /** Todos los `contextPayload` persistidos, en orden. */
    const checkpointsOf = (update: jest.Mock): unknown[] =>
      update.mock.calls.map(
        ([, patch]) => (patch as Record<string, unknown>).contextPayload,
      );

    const attachmentsIn = (payload: unknown): Record<string, unknown>[] => {
      const namespaces = payload as Record<string, Record<string, unknown>>;

      return (namespaces.raw_email?.attachments ?? []) as Record<
        string,
        unknown
      >[];
    };

    it('12.1 deberia liberar el base64 en cuanto el propio nodo IMAP trae texto', async () => {
      // 1. Arrange: el correo trae cuerpo textual, asi que su adjunto deja de
      //    ser la unica fuente de datos en el MISMO paso que lo ingirio.
      const execution = buildExecution();
      const { repo, update } = buildRepository(execution);

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue({
            success: true,
            data: {
              subject: 'Factura',
              text: 'Cuerpo con contenido textual mas que suficiente para el modelo.',
              attachments: [buildAttachment()],
            },
          }),
        ),
      );
      factory.registerStrategy(
        buildStrategy(
          NodeType.PROCESADOR_IA,
          jest.fn().mockResolvedValue({ success: true, data: {} }),
        ),
      );

      // 2. Act
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildEmailSchema(),
      );

      // 3. Assert: binario liberado y metadatos intactos.
      expect(attachmentsIn(result.contextPayload)).toEqual([
        {
          filename: 'escaneo.pdf',
          contentType: 'application/pdf',
          size: 1024,
          contentBase64: null,
        },
      ]);
      // Y, sobre todo: NINGUN checkpoint llego a escribir el base64 en jsonb.
      for (const payload of checkpointsOf(update)) {
        expect(JSON.stringify(payload)).not.toContain(BASE64);
      }
    });

    it('12.2 deberia conservar el binario hasta que algun nodo extraiga texto', async () => {
      // 1. Arrange: correo sin cuerpo textual (PDF escaneado). El texto solo
      //    aparece en el segundo nodo.
      const execution = buildExecution();
      const { repo, update } = buildRepository(execution);

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue({
            success: true,
            data: { text: '', attachments: [buildAttachment()] },
          }),
        ),
      );
      factory.registerStrategy(
        buildStrategy(
          NodeType.PROCESADOR_IA,
          jest.fn().mockResolvedValue({
            success: true,
            data: {
              clean_body:
                'Texto extraido por el modelo multimodal a partir del PDF escaneado.',
            },
          }),
        ),
      );

      // 2. Act
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildEmailSchema(),
      );

      // 3. Assert: el primer checkpoint SI lleva el binario —era la unica fuente
      //    de datos y el nodo multimodal lo necesitaba— y al final ya no esta.
      const payloads = checkpointsOf(update);
      expect(
        payloads.some((payload) => JSON.stringify(payload).includes(BASE64)),
      ).toBe(true);
      expect(attachmentsIn(result.contextPayload)[0].contentBase64).toBeNull();
    });

    it('12.3 deberia reconocer extracted_text como senal de texto util', async () => {
      // 1. Arrange
      const execution = buildExecution();
      const { repo } = buildRepository(execution);

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue({
            success: true,
            data: {
              extracted_text:
                'Texto reconocido por el OCR sobre la pagina escaneada del documento.',
              attachments: [buildAttachment()],
            },
          }),
        ),
      );
      factory.registerStrategy(
        buildStrategy(
          NodeType.PROCESADOR_IA,
          jest.fn().mockResolvedValue({ success: true, data: {} }),
        ),
      );

      // 2. Act
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildEmailSchema(),
      );

      // 3. Assert
      expect(attachmentsIn(result.contextPayload)[0].contentBase64).toBeNull();
    });

    it('12.3.1 deberia reconocer extracted_documents_text como texto util', async () => {
      // 1. Arrange: el caso que mas pesa del corpus, el correo de cuerpo vacio
      //    cuyo contenido entero viaja en un PDF adjunto. `PARSER_PRE_IA` saca
      //    su texto NATIVO, sin OCR, y lo publica bajo esta clave. Sin ella en
      //    `EXTRACTED_TEXT_KEYS`, `clean_body` quedaba vacio, `hasUsefulText`
      //    daba `false` y los megabytes se quedaban en `contexto_acumulado`
      //    para siempre, aun habiendose extraido ya todo su texto.
      const execution = buildExecution();
      const { repo } = buildRepository(execution);

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue({
            success: true,
            data: {
              clean_body: '',
              extracted_documents_text:
                '--- Documento: nota.pdf ---\n\nLa compania abre una nueva sede en Madrid.',
              attachments: [buildAttachment()],
            },
          }),
        ),
      );
      factory.registerStrategy(
        buildStrategy(
          NodeType.PROCESADOR_IA,
          jest.fn().mockResolvedValue({ success: true, data: {} }),
        ),
      );

      // 2. Act
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildEmailSchema(),
      );

      // 3. Assert
      expect(attachmentsIn(result.contextPayload)[0].contentBase64).toBeNull();
    });

    it('12.4 NO deberia liberar nada si ningun nodo produce texto', async () => {
      // 1. Arrange
      const execution = buildExecution();
      const { repo } = buildRepository(execution);

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue({
            success: true,
            data: { text: '', attachments: [buildAttachment()] },
          }),
        ),
      );
      factory.registerStrategy(
        buildStrategy(
          NodeType.PROCESADOR_IA,
          jest.fn().mockResolvedValue({ success: true, data: { ok: true } }),
        ),
      );

      // 2. Act
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildEmailSchema(),
      );

      // 3. Assert: sigue siendo la unica fuente de datos del correo.
      expect(attachmentsIn(result.contextPayload)[0].contentBase64).toBe(
        BASE64,
      );
    });

    it('12.5 NO deberia tomar una cadena en blanco por texto util', async () => {
      // 1. Arrange: espacios y saltos son ausencia de texto con otra forma.
      const execution = buildExecution();
      const { repo } = buildRepository(execution);

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue({
            success: true,
            data: { text: '   \n  ', attachments: [buildAttachment()] },
          }),
        ),
      );
      factory.registerStrategy(
        buildStrategy(
          NodeType.PROCESADOR_IA,
          jest.fn().mockResolvedValue({ success: true, data: {} }),
        ),
      );

      // 2. Act
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildEmailSchema(),
      );

      // 3. Assert
      expect(attachmentsIn(result.contextPayload)[0].contentBase64).toBe(
        BASE64,
      );
    });

    it('12.6 deberia ser inocuo en un flujo sin correo ni adjuntos', async () => {
      // 1. Arrange: pipeline normal, sin namespace `raw_email`.
      const execution = buildExecution();
      const { repo } = buildRepository(execution);

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue({
            success: true,
            data: { text: 'Texto sin adjuntos.' },
          }),
        ),
      );
      factory.registerStrategy(
        buildStrategy(
          NodeType.PROCESADOR_IA,
          jest.fn().mockResolvedValue({ success: true, data: {} }),
        ),
      );

      // 2. Act
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildEmailSchema(),
      );

      // 3. Assert: nunca se inventa una clave `attachments` que nadie escribio.
      expect(result.currentState).toBe(ExecutionState.EXITOSO);
      const namespaces = result.contextPayload;
      expect(namespaces.raw_email).not.toHaveProperty('attachments');
    });

    it('12.7 NO deberia liberar el binario cuando el nodo falla', async () => {
      // 1. Arrange: purgar antes de un fallo dejaria al reintento calculando
      //    sobre un adjunto ya vaciado.
      const execution = buildExecution();
      const { repo } = buildRepository(execution);

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue({
            success: true,
            data: { text: '', attachments: [buildAttachment()] },
          }),
        ),
      );
      factory.registerStrategy(
        buildStrategy(
          NodeType.PROCESADOR_IA,
          jest.fn().mockResolvedValue({
            ...failure('GRAVE'),
            data: { clean_body: 'texto que nunca se publica' },
          }),
        ),
      );

      // 2. Act
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildEmailSchema(),
      );

      // 3. Assert
      expect(result.currentState).toBe(ExecutionState.PAUSADO);
      expect(attachmentsIn(result.contextPayload)[0].contentBase64).toBe(
        BASE64,
      );
    });

    it('12.8 deberia redactar el base64 en la traza de disco del nodo', async () => {
      // 1. Arrange: `payloadSnapshot` va al archivo `execution-*.log`, que rota
      //    por tamano. Una linea de 6,8 MB se llevaria por delante el resto.
      const execution = buildExecution();
      const { repo } = buildRepository(execution);

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue({
            success: true,
            data: { text: 'Cuerpo real.', attachments: [buildAttachment()] },
          }),
        ),
      );
      factory.registerStrategy(
        buildStrategy(
          NodeType.PROCESADOR_IA,
          jest.fn().mockResolvedValue({ success: true, data: {} }),
        ),
      );

      // 2. Act
      await buildEngine(repo).executeWorkflow(EXECUTION_ID, buildEmailSchema());

      // 3. Assert
      const [firstTrace] = hybridLogger.logNodeExecution.mock.calls[0] as [
        Record<string, unknown>,
      ];
      const snapshot = JSON.stringify(firstTrace.payloadSnapshot);
      expect(snapshot).not.toContain(BASE64);
      expect(snapshot).toContain('[base64 omitido]');
      // Los metadatos siguen ahi: un log que borra el adjunto entero no permite
      // saber que venia en el correo.
      expect(snapshot).toContain('escaneo.pdf');
    });

    it('12.9 NO deberia liberar el binario si el nodo declara el respaldo multimodal', async () => {
      // 1. Arrange: el correo trae texto de sobra, pero el nodo declara que el
      //    binario sigue haciendo falta. El veto gana sobre el texto: liberar de
      //    mas destruye la UNICA copia del dato y el checkpoint ya esta escrito.
      const execution = buildExecution();
      const { repo } = buildRepository(execution);

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue({
            success: true,
            data: { text: '', attachments: [buildAttachment()] },
          }),
        ),
      );
      factory.registerStrategy(
        buildStrategy(
          NodeType.PROCESADOR_IA,
          jest.fn().mockResolvedValue({
            success: true,
            data: {
              clean_body:
                'Texto suficiente para superar el listado del motor sin problema.',
              requires_multimodal_fallback: true,
            },
          }),
        ),
      );

      // 2. Act
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildEmailSchema(),
      );

      // 3. Assert
      expect(attachmentsIn(result.contextPayload)[0].contentBase64).toBe(
        BASE64,
      );
    });

    it('12.10 deberia liberar el binario cuando la bandera llega en false', async () => {
      // 1. Arrange: el veto es POSITIVO-ONLY. Una bandera apagada no puede
      //    bloquear la politica de memoria de la plataforma.
      const execution = buildExecution();
      const { repo } = buildRepository(execution);

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue({
            success: true,
            data: { text: '', attachments: [buildAttachment()] },
          }),
        ),
      );
      factory.registerStrategy(
        buildStrategy(
          NodeType.PROCESADOR_IA,
          jest.fn().mockResolvedValue({
            success: true,
            data: {
              clean_body:
                'Texto suficiente para superar el listado del motor sin problema.',
              requires_multimodal_fallback: false,
            },
          }),
        ),
      );

      // 2. Act
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildEmailSchema(),
      );

      // 3. Assert
      expect(attachmentsIn(result.contextPayload)[0].contentBase64).toBeNull();
    });

    it('12.11 NO deberia tomar por veto un valor que no sea el booleano true', async () => {
      // 1. Arrange: el `data` se rehidrata desde jsonb, donde la cadena "false"
      //    tambien es truthy. Sin la comparacion estricta, un veto accidental
      //    desactivaria la purga y nadie lo notaria hasta ver crecer la tabla.
      const execution = buildExecution();
      const { repo } = buildRepository(execution);

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue({
            success: true,
            data: { text: '', attachments: [buildAttachment()] },
          }),
        ),
      );
      factory.registerStrategy(
        buildStrategy(
          NodeType.PROCESADOR_IA,
          jest.fn().mockResolvedValue({
            success: true,
            data: {
              clean_body:
                'Texto suficiente para superar el listado del motor sin problema.',
              requires_multimodal_fallback: 'true',
            },
          }),
        ),
      );

      // 2. Act
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildEmailSchema(),
      );

      // 3. Assert: la cadena NO veta, asi que el binario se libera.
      expect(attachmentsIn(result.contextPayload)[0].contentBase64).toBeNull();
    });

    it('12.12 NO deberia liberar el binario con un texto por debajo del listado', async () => {
      // 1. Arrange: ES EL CASO QUE MOTIVA EL LISTADO. El nodo IMAP emite `text`
      //    y corre ANTES del parser, asi que un "Ver adjunto." de doce
      //    caracteres purgaba los bytes del PDF escaneado antes de que nadie
      //    pudiera vetarlo, y el veto del parser llegaba sobre un adjunto vacio.
      const execution = buildExecution();
      const { repo } = buildRepository(execution);

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue({
            success: true,
            data: { text: 'Ver adjunto.', attachments: [buildAttachment()] },
          }),
        ),
      );
      factory.registerStrategy(
        buildStrategy(
          NodeType.PROCESADOR_IA,
          jest.fn().mockResolvedValue({ success: true, data: {} }),
        ),
      );

      // 2. Act
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildEmailSchema(),
      );

      // 3. Assert: el binario llega intacto al nodo que puede interpretarlo.
      expect(attachmentsIn(result.contextPayload)[0].contentBase64).toBe(
        BASE64,
      );
    });

    it('12.13 deberia respetar el listado configurado en FSM_MIN_USEFUL_TEXT_LENGTH', async () => {
      // 1. Arrange: el MISMO texto corto del caso anterior, pero con el listado
      //    bajado por entorno. Fija que la variable se lee de verdad.
      const execution = buildExecution();
      const { repo } = buildRepository(execution);

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue({
            success: true,
            data: { text: 'Ver adjunto.', attachments: [buildAttachment()] },
          }),
        ),
      );
      factory.registerStrategy(
        buildStrategy(
          NodeType.PROCESADOR_IA,
          jest.fn().mockResolvedValue({ success: true, data: {} }),
        ),
      );

      // 2. Act
      const result = await buildEngine(
        repo,
        new ConfigService({ FSM_MIN_USEFUL_TEXT_LENGTH: '5' }),
      ).executeWorkflow(EXECUTION_ID, buildEmailSchema());

      // 3. Assert
      expect(attachmentsIn(result.contextPayload)[0].contentBase64).toBeNull();
    });
  });

  describe('31. Namespaces requeridos aguas arriba', () => {
    it('31.1 deberia ejecutar el nodo cuando su namespace requerido esta presente', async () => {
      // 1. Arrange: `nodo_a` escribe `salida_a` y `nodo_b` la exige.
      const execA = jest
        .fn()
        .mockResolvedValue({ success: true, data: { ok: 1 } });
      const execB = jest
        .fn()
        .mockResolvedValue({ success: true, data: { ok: 2 } });
      const execC = jest.fn().mockResolvedValue({ success: true });
      factory.registerStrategy(buildStrategy(NodeType.TRIGGER_IMAP, execA));
      factory.registerStrategy(
        buildStrategy(NodeType.PROCESADOR_IA, execB, () => ['salida_a']),
      );
      factory.registerStrategy(buildStrategy(NodeType.DESTINO_HTTP, execC));
      const execution = buildExecution();
      const { repo, update } = buildRepository(execution);

      // 2. Act
      await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildLinearSchema(),
      );

      // 3. Assert
      expect(execB).toHaveBeenCalledTimes(1);
      expect(lastPatch(update).currentState).toBe(ExecutionState.EXITOSO);
    });

    it('31.2 no deberia invocar la estrategia si falta un namespace requerido', async () => {
      // 1. Arrange: `nodo_b` exige algo que ningun nodo anterior escribe.
      const execA = jest
        .fn()
        .mockResolvedValue({ success: true, data: { ok: 1 } });
      const execB = jest.fn().mockResolvedValue({ success: true });
      factory.registerStrategy(buildStrategy(NodeType.TRIGGER_IMAP, execA));
      factory.registerStrategy(
        buildStrategy(NodeType.PROCESADOR_IA, execB, () => ['llm_response']),
      );
      factory.registerStrategy(buildStrategy(NodeType.DESTINO_HTTP, jest.fn()));
      const execution = buildExecution();
      const { repo, update } = buildRepository(execution);

      // 2. Act
      await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildLinearSchema(),
      );

      // 3. Assert: la guarda corta ANTES de invocar, que es todo el objetivo:
      //    un nodo sin su contexto no debe llegar a intentarlo.
      expect(execB).not.toHaveBeenCalled();

      const last = lastPatch(update);

      expect(last.currentState).toBe(ExecutionState.PAUSADO);
      // El cursor se conserva en el nodo culpable para que CU-09 pueda reanudar
      // ahi mismo tras corregir la topologia.
      expect(last.activeCursor).toBe('nodo_b');
    });

    it('31.3 deberia registrar el fallo como GRAVE con los namespaces que faltan', async () => {
      // 1. Arrange
      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue({ success: true }),
        ),
      );
      factory.registerStrategy(
        buildStrategy(NodeType.PROCESADOR_IA, jest.fn(), () => [
          'llm_response',
          'scraped_web',
        ]),
      );
      factory.registerStrategy(buildStrategy(NodeType.DESTINO_HTTP, jest.fn()));
      const { repo } = buildRepository(buildExecution());

      // 2. Act
      await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildLinearSchema(),
      );

      // 3. Assert: GRAVE y no URGENTE para que `canRetry` lo contemple y el
      //    operador pueda reanudar; el codigo es lo que un `catchErrors` enruta.
      const nodeLog = hybridLogger.logNodeExecution.mock.calls
        .map(
          ([details]: [
            { nodeId: string; errorCode?: string; severity?: string },
          ]) => details,
        )
        .find((details) => details.nodeId === 'nodo_b');

      expect(nodeLog?.errorCode).toBe('ERR_MISSING_UPSTREAM_CONTEXT');
      expect(nodeLog?.severity).toBe('GRAVE');
      expect(nodeLog?.message).toContain('scraped_web');
    });

    it('31.4 deberia dar por satisfecho un namespace escrito vacio', async () => {
      // 1. Arrange: `nodo_a` termina bien SIN devolver `data`, asi que el motor
      //    escribe `{}` en su namespace.
      const execB = jest.fn().mockResolvedValue({ success: true });
      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue({ success: true }),
        ),
      );
      factory.registerStrategy(
        buildStrategy(NodeType.PROCESADOR_IA, execB, () => ['salida_a']),
      );
      factory.registerStrategy(
        buildStrategy(
          NodeType.DESTINO_HTTP,
          jest.fn().mockResolvedValue({ success: true }),
        ),
      );
      const { repo } = buildRepository(buildExecution());

      // 2. Act
      await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildLinearSchema(),
      );

      // 3. Assert: la guarda pregunta "corrio el nodo que produce esto", no
      //    "trae los campos que espero". Lo segundo solo lo sabe la estrategia
      //    consumidora, y juzgarlo aqui bloquearia nodos que devuelven vacio de
      //    forma legitima.
      expect(execB).toHaveBeenCalledTimes(1);
    });

    it('31.5 deberia respetar el onErrorStep declarado para el codigo', async () => {
      // 1. Arrange
      const execC = jest.fn().mockResolvedValue({ success: true });
      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue({ success: true }),
        ),
      );
      factory.registerStrategy(
        buildStrategy(NodeType.PROCESADOR_IA, jest.fn(), () => [
          'llm_response',
        ]),
      );
      factory.registerStrategy(buildStrategy(NodeType.DESTINO_HTTP, execC));

      const schema = buildLinearSchema();
      schema.nodes.nodo_b.onErrorStep = {
        targetNode: 'nodo_c',
        catchErrors: ['ERR_MISSING_UPSTREAM_CONTEXT'],
      };
      const { repo, update } = buildRepository(buildExecution());

      // 2. Act
      await buildEngine(repo).executeWorkflow(EXECUTION_ID, schema);

      // 3. Assert: el fallo entra por el mismo camino que cualquier otro del
      //    dominio, que es la razon de poner la guarda dentro de `runNode`.
      expect(execC).toHaveBeenCalledTimes(1);
      expect(lastPatch(update).currentState).toBe(ExecutionState.EXITOSO);
    });

    it('31.6 deberia ejecutar sin exigir nada una estrategia que no declara el metodo', async () => {
      // 1. Arrange: es el caso de los disparadores, primeros del grafo.
      const execA = jest.fn().mockResolvedValue({ success: true });
      factory.registerStrategy(buildStrategy(NodeType.TRIGGER_IMAP, execA));
      factory.registerStrategy(
        buildStrategy(
          NodeType.PROCESADOR_IA,
          jest.fn().mockResolvedValue({ success: true }),
        ),
      );
      factory.registerStrategy(
        buildStrategy(
          NodeType.DESTINO_HTTP,
          jest.fn().mockResolvedValue({ success: true }),
        ),
      );
      const { repo } = buildRepository(buildExecution());

      // 2. Act
      await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildLinearSchema(),
      );

      // 3. Assert
      expect(execA).toHaveBeenCalledTimes(1);
    });
  });
});
