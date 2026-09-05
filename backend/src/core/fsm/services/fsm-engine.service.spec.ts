import { ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import { NodeStrategyFactory } from '@core/fsm/factories/node-strategy.factory';
import {
  FsmEngineService,
  MAX_TRANSITIONS,
  TRIGGER_NAMESPACE,
} from '@core/fsm/services/fsm-engine.service';
import { ExecutionState } from '@core/fsm/types/fsm.enums';
import { NodeType } from '@core/fsm/types/pipeline-schema.types';

import type { PipelineSchemaDto } from '@core/fsm/dto/pipeline-schema.dto';
import type { FsmExecution } from '@core/fsm/entities/fsm-execution.entity';
import type {
  INodeStrategy,
  NodeErrorSeverity,
  NodeResult,
} from '@core/fsm/types/node-strategy.types';
import type { Repository } from 'typeorm';

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

/** Estrategia falsa: la factoria real la registra e indexa por `nodeType`. */
const buildStrategy = (
  nodeType: NodeType,
  execute: jest.Mock,
): INodeStrategy => ({ nodeType, execute });

/** `NodeResult` fallido con la severidad indicada. */
const failure = (level: NodeErrorSeverity, message = 'fallo'): NodeResult => ({
  success: false,
  error: { level, message },
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

describe('FsmEngineService (PROT-09)', () => {
  let factory: NodeStrategyFactory;

  beforeEach(() => {
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
    const engine = new FsmEngineService(repo, factory, configService);
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

    it('deberia pausar sin reintentar cuando la severidad es LEVE', async () => {
      // 1. Arrange: LEVE no es reintentable aunque el nodo declare politica
      const execution = buildExecution();
      const { repo } = buildRepository(execution);
      const schema = buildLinearSchema();
      schema.nodes.nodo_a.retryPolicy = { maxRetries: 5 };

      const executeA = jest.fn().mockResolvedValue(failure('LEVE'));
      factory.registerStrategy(buildStrategy(NodeType.TRIGGER_IMAP, executeA));

      // 2. Act
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        schema,
      );

      // 3. Assert
      expect(executeA).toHaveBeenCalledTimes(1);
      expect(result.currentState).toBe(ExecutionState.PAUSADO);
      expect(result.retryState).toEqual({});
    });
  });

  describe('7. Aislamiento de excepcion no controlada', () => {
    it('deberia normalizar la excepcion y pausar sin propagarla', async () => {
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

      // 3. Assert
      expect(result.currentState).toBe(ExecutionState.PAUSADO);
      expect(result.activeCursor).toBe('nodo_a');
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
        { remitente: 'prensa@unuware.com' },
      );

      // 3. Assert
      expect(seen).toBe('prensa@unuware.com');
      expect(result.contextPayload[TRIGGER_NAMESPACE]).toEqual({
        remitente: 'prensa@unuware.com',
      });
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
});
