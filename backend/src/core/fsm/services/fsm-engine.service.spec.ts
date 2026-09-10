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
import { NodeType } from '@core/fsm/types/pipeline-schema.types';

import type { HybridLoggerService } from '@common/services/hybrid-logger.service';
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
  let hybridLogger: { logCatastrophicFailure: jest.Mock };

  beforeEach(() => {
    hybridLogger = {
      logCatastrophicFailure: jest.fn().mockReturnValue(LOG_PATH),
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
});
