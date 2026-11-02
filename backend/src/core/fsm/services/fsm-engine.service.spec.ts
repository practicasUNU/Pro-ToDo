import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ExecutionEventsCoordinator } from '@common/services/execution-events.coordinator';
import { WorkflowStatusCoordinator } from '@common/services/workflow-status.coordinator';
import { FsmConfig } from '@core/config/fsm.config';
import { SystemCapacityExceededException } from '@core/fsm/exceptions/system-capacity-exceeded.exception';
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

import type {
  NodeCompletedEvent,
  NodeStartedEvent,
} from '@common/types/execution-events.types';
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
      nodeType: NodeType.DESTINO_DRUPAL,
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

/**
 * Ruta de la traza POR NODO, distinta del volcado forense de arriba.
 *
 * Son dos archivos con dos prefijos: `fsm-*` lo escribe el fallo catastrofico y
 * `execution-*` la traza de cada invocacion de estrategia. La pausa persiste
 * esta segunda, asi que confundirlas en las aserciones dejaria pasar que el
 * motor guardase el archivo equivocado.
 */
const NODE_LOG_PATH = 'logs/execution-2026-09-09.log';

/** Acuse que devuelve el logger hibrido cuando ambos destinos funcionan. */
const NODE_TRACE = {
  logFilePath: NODE_LOG_PATH,
  logNodeId: 'b1d4c6e8-0a2f-4c3b-9d5e-6f7a8b9c0d1e',
};

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
      // Devuelve el ACUSE, no `undefined`: desde que la traza alimenta
      // `ejecuciones_flujo.ruta_archivo_log`, un doble que resolviera a nada
      // mentiria sobre el contrato y el motor no tendria ruta que persistir.
      logNodeExecution: jest.fn().mockResolvedValue(NODE_TRACE),
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
    // Se admite un coordinador de fuera para que las pruebas del canal puedan
    // espiar lo que el motor publica; sin pasarlo, sigue siendo el no-op de
    // siempre y ninguna prueba anterior cambia.
    events: ExecutionEventsCoordinator = new ExecutionEventsCoordinator(),
    // Mismo criterio y mismo motivo que el coordinador de eventos: real, vacio
    // y por tanto no-op, salvo cuando una prueba quiera espiar la pausa del
    // flujo padre.
    workflowStatus: WorkflowStatusCoordinator = new WorkflowStatusCoordinator(),
  ): FsmEngineService => {
    const engine = new FsmEngineService(
      repo,
      factory,
      configService,
      hybridLogger as unknown as HybridLoggerService,
      // `FsmConfig` REAL y no un doble: es una clase pura sobre el mismo
      // `ConfigService` que ya recibe el motor, asi que sembrar
      // `MAX_GLOBAL_CONCURRENT_EXECUTIONS` en el entorno de la prueba basta
      // para gobernar tambien el techo global. Un doble obligaria a declararlo
      // dos veces y permitiria que ambos se contradijeran.
      new FsmConfig(configService),
      // Coordinador REAL y sin puertos inscritos: por diseno eso lo convierte
      // en un no-op silencioso, asi que no hace falta un doble con tres
      // `jest.fn()` que ninguna asercion mira. Mismo criterio que el
      // `FsmConfig` de arriba.
      events,
      workflowStatus,
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
      factory.registerStrategy(
        buildStrategy(NodeType.DESTINO_DRUPAL, executeC),
      );

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
      factory.registerStrategy(buildStrategy(NodeType.DESTINO_DRUPAL, execute));

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

  describe('1.0 Imputacion al remitente del disparo (migracion 060)', () => {
    /** Doble del `UPDATE` condicional de `assignInitiator`. */
    const withUpdateBuilder = (
      repo: Repository<FsmExecution>,
      affected: number,
    ): { andWhere: jest.Mock; set: jest.Mock } => {
      const builder = {
        update: jest.fn(),
        set: jest.fn(),
        where: jest.fn(),
        andWhere: jest.fn(),
        execute: jest.fn().mockResolvedValue({ affected }),
      };
      builder.update.mockReturnValue(builder);
      builder.set.mockReturnValue(builder);
      builder.where.mockReturnValue(builder);
      builder.andWhere.mockReturnValue(builder);
      Object.assign(repo, { createQueryBuilder: jest.fn(() => builder) });

      return builder;
    };

    it('deberia imputar la ejecucion al usuario que devuelve el disparador', async () => {
      // 1. Arrange: el IMAP identifica al remitente como usuario registrado.
      const execution = buildExecution();
      const { repo } = buildRepository(execution);
      const builder = withUpdateBuilder(repo, 1);
      const userId = '6f1c2b3a-4d5e-4f60-8a71-b2c3d4e5f601';
      const contexts: StatePayloadContext[] = [];
      const executeA = jest
        .fn()
        .mockResolvedValue({ success: true, initiatorUserId: userId });
      const executeB = jest.fn((context: StatePayloadContext) => {
        contexts.push(context);
        return Promise.resolve({ success: true });
      });

      factory.registerStrategy(buildStrategy(NodeType.TRIGGER_IMAP, executeA));
      factory.registerStrategy(buildStrategy(NodeType.PROCESADOR_IA, executeB));
      factory.registerStrategy(
        buildStrategy(
          NodeType.DESTINO_DRUPAL,
          jest.fn().mockResolvedValue({ success: true }),
        ),
      );

      // 2. Act
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildLinearSchema(),
      );

      // 3. Assert: solo sustituye un iniciador vacio o de respaldo, y el nodo
      //    de IA siguiente ya ve al usuario en su contexto.
      expect(builder.set).toHaveBeenCalledWith({ initiatedByUserId: userId });
      expect(builder.andWhere).toHaveBeenCalledWith(
        '(usuario_id IS NULL OR usuario_id = fn_usuario_respaldo())',
      );
      expect(result.initiatedByUserId).toBe(userId);
      expect(contexts[0]?.getInitiatorUserId()).toBe(userId);
    });

    it('no deberia pisar al usuario que lanzo el flujo a mano', async () => {
      // 1. Arrange: el UPDATE condicional no afecta a ninguna fila.
      const execution = buildExecution();
      const manualUser = '3a8f0c1d-2b4e-4f6a-9c7d-1e2f3a4b5c6d';
      Object.assign(execution, { initiatedByUserId: manualUser });
      const { repo } = buildRepository(execution);
      withUpdateBuilder(repo, 0);
      const contexts: StatePayloadContext[] = [];

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue({
            success: true,
            initiatorUserId: '6f1c2b3a-4d5e-4f60-8a71-b2c3d4e5f601',
          }),
        ),
      );
      factory.registerStrategy(
        buildStrategy(
          NodeType.PROCESADOR_IA,
          jest.fn((context: StatePayloadContext) => {
            contexts.push(context);
            return Promise.resolve({ success: true });
          }),
        ),
      );
      factory.registerStrategy(
        buildStrategy(
          NodeType.DESTINO_DRUPAL,
          jest.fn().mockResolvedValue({ success: true }),
        ),
      );

      // 2. Act
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildLinearSchema(),
      );

      // 3. Assert
      expect(result.initiatedByUserId).toBe(manualUser);
      expect(contexts[0]?.getInitiatorUserId()).toBe(manualUser);
    });
  });

  describe('1.1 Parada ordenada pedida por un nodo (`halt`)', () => {
    it('deberia cerrar en OMITIDO sin invocar los nodos siguientes', async () => {
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
      factory.registerStrategy(
        buildStrategy(NodeType.DESTINO_DRUPAL, executeC),
      );

      // 2. Act
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildLinearSchema(),
      );

      // 3. Assert
      expect(executeA).toHaveBeenCalledTimes(1);
      expect(executeB).not.toHaveBeenCalled();
      expect(executeC).not.toHaveBeenCalled();
      // OMITIDO y no EXITOSO: no fallo nada, pero tampoco se hizo ningun
      // trabajo. Con un sondeo por minuto, contar esto como exito hacia que
      // cualquier recuento midiese sobre todo buzones vacios.
      expect(result.currentState).toBe(ExecutionState.OMITIDO);
      expect(result.activeCursor).toBeNull();
      // El motivo queda en el contexto: es lo que explica en trazabilidad por
      // que la ejecucion termino en un unico paso.
      expect(result.contextPayload).toEqual({
        salida_a: { status: 'NO_MESSAGES_FOUND' },
      });
      // Marca inicial EN_PROCESO + el checkpoint final. Sin transiciones
      // intermedias: el cursor nunca llego a avanzar.
      expect(update).toHaveBeenCalledTimes(2);
      // La marca transitoria se conserva pese a que el estado ya distinga las
      // dos salidas: la lee quien despacha, dentro del mismo proceso, para
      // explicar POR QUE se omitio sin volver a la base de datos.
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
      factory.registerStrategy(buildStrategy(NodeType.DESTINO_DRUPAL, execute));

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
      factory.registerStrategy(
        buildStrategy(NodeType.DESTINO_DRUPAL, executeC),
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
  });

  describe('1.2 Traza por nodo (PROT-18.1)', () => {
    it('deberia registrar una traza por cada nodo recorrido', async () => {
      // 1. Arrange
      const execution = buildExecution();
      const { repo } = buildRepository(execution);
      const execute = jest.fn().mockResolvedValue({ success: true });

      factory.registerStrategy(buildStrategy(NodeType.TRIGGER_IMAP, execute));
      factory.registerStrategy(buildStrategy(NodeType.PROCESADOR_IA, execute));
      factory.registerStrategy(buildStrategy(NodeType.DESTINO_DRUPAL, execute));

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
          NodeType.DESTINO_DRUPAL,
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
          NodeType.DESTINO_DRUPAL,
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
          NodeType.DESTINO_DRUPAL,
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
      factory.registerStrategy(
        buildStrategy(NodeType.DESTINO_DRUPAL, executeC),
      );

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
      factory.registerStrategy(
        buildStrategy(NodeType.DESTINO_DRUPAL, executeC),
      );

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
          NodeType.DESTINO_DRUPAL,
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

    it('deberia persistir la ruta del log del nodo que la detuvo', async () => {
      // 1. Arrange: sin esto, una fila PAUSADO no tiene nada que ensenar sobre
      // el fallo. La ruta sale del acuse de la traza, no del volcado forense:
      // son dos archivos distintos y aqui no hubo fallo catastrofico.
      const execution = buildExecution();
      const { repo } = buildRepository(execution);

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue({ success: true, data: {} }),
        ),
      );
      factory.registerStrategy(
        buildStrategy(
          NodeType.PROCESADOR_IA,
          jest.fn().mockResolvedValue(failure('URGENTE')),
        ),
      );

      // 2. Act
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildLinearSchema(),
      );

      // 3. Assert
      expect(result.currentState).toBe(ExecutionState.PAUSADO);
      expect(result.logFilePath).toBe(NODE_LOG_PATH);
      // Y NO el del volcado forense: confundirlos mandaria al operador a un
      // archivo que no contiene esta incidencia.
      expect(result.logFilePath).not.toBe(LOG_PATH);
    });

    it('NO deberia escribir ruta de log en una pausa anterior a ejecutar el nodo', async () => {
      // 1. Arrange: el cursor apunta a un nodo que no existe en el mapa, de
      // modo que el bucle pausa ANTES de invocar ninguna estrategia. No hay
      // traza de este paso, y escribir la del paso anterior seria una pista
      // falsa: ese archivo no explica por que se paro aqui.
      const execution = buildExecution({
        activeCursor: 'nodo_fantasma',
        logFilePath: null,
      });
      const { repo, update } = buildRepository(execution);

      // 2. Act
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildLinearSchema(),
      );

      // 3. Assert
      expect(result.currentState).toBe(ExecutionState.PAUSADO);
      expect(result.activeCursor).toBe('nodo_fantasma');
      // La clave ni siquiera viaja en el patch: `update` de TypeORM solo
      // escribe lo que recibe, asi que omitirla conserva lo que hubiera.
      const updateCalls = update.mock.calls as Array<
        [string, Record<string, unknown>]
      >;
      const pausePatch = updateCalls[updateCalls.length - 1]?.[1];
      expect(pausePatch).not.toHaveProperty('logFilePath');
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
      factory.registerStrategy(
        buildStrategy(NodeType.DESTINO_DRUPAL, executeC),
      );

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
      factory.registerStrategy(
        buildStrategy(NodeType.DESTINO_DRUPAL, executeC),
      );

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
      factory.registerStrategy(
        buildStrategy(NodeType.DESTINO_DRUPAL, executeC),
      );

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
          NodeType.DESTINO_DRUPAL,
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
          NodeType.DESTINO_DRUPAL,
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
          NodeType.DESTINO_DRUPAL,
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
    /**
     * Doble con `count` y `create`/`save`, que `buildRepository` no cubre.
     *
     * `createExecution` consulta DOS veces: primero las vivas de este flujo
     * (RNF-09) y despues las de todo el motor. `globalCount` cae por defecto en
     * `activeCount` porque en la mayoria de escenarios la unica ejecucion viva
     * del sistema es la de este flujo; los casos que separan ambos techos lo
     * declaran explicitamente.
     */
    const buildCreationRepository = (
      activeCount: number,
      globalCount: number = activeCount,
    ): {
      repo: Repository<FsmExecution>;
      count: jest.Mock;
      save: jest.Mock;
    } => {
      const count = jest
        .fn()
        .mockResolvedValueOnce(activeCount)
        .mockResolvedValue(globalCount);
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

    it('deberia guardar el usuario que lanza la ejecucion (migracion 060)', async () => {
      // 1. Arrange
      const { repo, save } = buildCreationRepository(0);
      const userId = '3a8f0c1d-2b4e-4f6a-9c7d-1e2f3a4b5c6d';

      // 2. Act
      await buildEngine(repo).createExecution(FLOW_ID, {}, userId);

      // 3. Assert
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({ initiatedByUserId: userId }),
      );
    });

    it('deberia omitir el usuario sin iniciador para que el DEFAULT ponga el respaldo', async () => {
      // 1. Arrange: Cron e IMAP de partida no traen JWT.
      const { repo, save } = buildCreationRepository(0);

      // 2. Act
      await buildEngine(repo).createExecution(FLOW_ID, {});

      // 3. Assert: la propiedad no existe, ni siquiera a `null` (TypeORM
      //    escribiria NULL y anularia el DEFAULT de la columna).
      const [entity] = save.mock.calls[0] as [FsmExecution];
      expect(entity).not.toHaveProperty('initiatedByUserId');
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

    it('deberia rechazar la creacion con SystemCapacityExceededException si las ejecuciones activas alcanzan el limite global', async () => {
      // 1. Arrange: este flujo no tiene ninguna viva —el cupo por flujo pasa
      // limpio— pero el motor en conjunto ya esta en su techo.
      const { repo, save } = buildCreationRepository(0, 5);
      const configService = new ConfigService({
        MAX_GLOBAL_CONCURRENT_EXECUTIONS: '5',
      });

      // 2. Act + 3. Assert: se rechaza ANTES de insertar, no despues
      await expect(
        buildEngine(repo, configService).createExecution(FLOW_ID),
      ).rejects.toBeInstanceOf(SystemCapacityExceededException);
      expect(save).not.toHaveBeenCalled();
    });

    it('deberia rechazar con 429 y no con 409, para distinguir saturacion de solapamiento', async () => {
      // 1. Arrange
      const { repo } = buildCreationRepository(0, 5);
      const configService = new ConfigService({
        MAX_GLOBAL_CONCURRENT_EXECUTIONS: '5',
      });

      // 2. Act
      const rejection: unknown = await buildEngine(repo, configService)
        .createExecution(FLOW_ID)
        .catch((error: unknown) => error);

      // 3. Assert: el codigo es el contrato que leen los disparadores y el
      // despacho manual. Un 409 aqui afirmaria "este flujo esta ocupado", que
      // es justo lo que NO ha pasado: el flujo esta libre y lleno el motor.
      expect(rejection).toBeInstanceOf(SystemCapacityExceededException);

      const capacityError = rejection as SystemCapacityExceededException;

      expect(capacityError.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect(capacityError.activeCount).toBe(5);
      expect(capacityError.maxAllowed).toBe(5);
    });

    it('deberia contar las EN_PROCESO de TODO el motor, no solo las del flujo', async () => {
      // 1. Arrange
      const { repo, count } = buildCreationRepository(0, 5);
      const configService = new ConfigService({
        MAX_GLOBAL_CONCURRENT_EXECUTIONS: '5',
      });

      // 2. Act
      await buildEngine(repo, configService)
        .createExecution(FLOW_ID)
        .catch(() => undefined);

      // 3. Assert: la segunda consulta NO lleva `flowId`. Filtrarla por flujo
      // la convertiria en una copia de la guarda RNF-09, y el techo global no
      // se alcanzaria jamas con flujos distintos, que es el caso que motiva
      // toda esta barrera.
      expect(count).toHaveBeenNthCalledWith(2, {
        where: { currentState: ExecutionState.EN_PROCESO },
      });
    });

    it('deberia admitir la creacion mientras quede cupo global', async () => {
      // 1. Arrange: cuatro vivas en el motor contra un techo de cinco
      const { repo, save } = buildCreationRepository(0, 4);
      const configService = new ConfigService({
        MAX_GLOBAL_CONCURRENT_EXECUTIONS: '5',
      });

      // 2. Act
      await buildEngine(repo, configService).createExecution(FLOW_ID);

      // 3. Assert
      expect(save).toHaveBeenCalledTimes(1);
    });

    it('deberia aplicar el techo global por defecto cuando la variable no esta declarada', async () => {
      // 1. Arrange: sin `MAX_GLOBAL_CONCURRENT_EXECUTIONS` manda el defecto de
      // `FsmConfig`, que son cinco. Con cinco vivas, la sexta no entra.
      const { repo, save } = buildCreationRepository(0, 5);

      // 2. Act + 3. Assert
      await expect(
        buildEngine(repo).createExecution(FLOW_ID),
      ).rejects.toBeInstanceOf(SystemCapacityExceededException);
      expect(save).not.toHaveBeenCalled();
    });
  });

  describe('13. prepareResume: preparacion del reintento manual (CU-09)', () => {
    /** Fila pausada tipica: cursor conservado, contexto a medias y contador al tope. */
    const buildPausedExecution = (): FsmExecution =>
      buildExecution({
        currentState: ExecutionState.PAUSADO,
        activeCursor: 'nodo_b',
        contextPayload: {
          salida_a: { valorA: 1, titulo: 'Original' },
          otro_namespace: { intacto: true },
        },
        retryState: { nodo_a: 2, nodo_b: 5 },
        logFilePath: NODE_LOG_PATH,
        failureReason: 'El nodo "nodo_b" fallo (GRAVE).',
      });

    it('deberia limpiar el contador del cursor y conservar el de los demas nodos', async () => {
      // 1. Arrange: sin esto, reanudar concederia UN intento en vez de la
      // politica declarada, y desde la interfaz "volvio a pausarse al
      // instante" es indistinguible de "el boton no hace nada".
      const execution = buildPausedExecution();
      const { repo } = buildRepository(execution);

      // 2. Act
      const prepared = await buildEngine(repo).prepareResume(EXECUTION_ID);

      // 3. Assert: el contador de `nodo_a` describe lo que costo llegar hasta
      // aqui y no se toca; borrarlo falsearia la traza.
      expect(prepared.retryState).toEqual({ nodo_a: 2 });
    });

    it('deberia conservar el contador cuando resetRetries es false', async () => {
      // 1. Arrange
      const execution = buildPausedExecution();
      const { repo } = buildRepository(execution);

      // 2. Act
      const prepared = await buildEngine(repo).prepareResume(
        EXECUTION_ID,
        undefined,
        false,
      );

      // 3. Assert
      expect(prepared.retryState).toEqual({ nodo_a: 2, nodo_b: 5 });
    });

    it('deberia preservar los namespaces ya publicados', async () => {
      // 1. Arrange: reanudar no puede repetir el trabajo de los nodos que si
      // completaron; ese es el motivo de conservar el checkpoint.
      const execution = buildPausedExecution();
      const { repo } = buildRepository(execution);

      // 2. Act
      const prepared = await buildEngine(repo).prepareResume(EXECUTION_ID);

      // 3. Assert
      expect(prepared.contextPayload).toEqual({
        salida_a: { valorA: 1, titulo: 'Original' },
        otro_namespace: { intacto: true },
      });
    });

    it('deberia fusionar el contextPatch sin borrar los campos previos del namespace', async () => {
      // 1. Arrange: el caso tipico de CU-09 es "faltaba un campo". Reemplazar
      // el namespace entero borraria los otros que el nodo si publico, y el
      // reintento fallaria por un dato que estaba.
      const execution = buildPausedExecution();
      const { repo } = buildRepository(execution);

      // 2. Act
      const prepared = await buildEngine(repo).prepareResume(EXECUTION_ID, {
        salida_a: { titulo: 'Corregido a mano' },
      });

      // 3. Assert: `valorA` sobrevive junto al campo parcheado
      expect(prepared.contextPayload.salida_a).toEqual({
        valorA: 1,
        titulo: 'Corregido a mano',
      });
      expect(prepared.contextPayload.otro_namespace).toEqual({ intacto: true });
    });

    it('deberia PURGAR `error_context` al reanudar', async () => {
      // 1. Arrange 📐: el namespace lo siembra el motor justo antes de desviar
      //    por `onErrorStep` y describe UN fallo concreto, no el historial.
      const execution = buildExecution({
        currentState: ExecutionState.PAUSADO,
        activeCursor: 'nodo_b',
        contextPayload: {
          salida_a: { valorA: 1 },
          error_context: {
            failed_node_id: 'nodo_b',
            error_code: 'ERR_LLM_TIMEOUT',
            error_level: 'GRAVE',
          },
        },
        retryState: {},
      });
      const { repo } = buildRepository(execution);

      // 2. Act ⚙️
      const prepared = await buildEngine(repo).prepareResume(EXECUTION_ID);

      // 3. Assert 🎯: conservarlo hacia que el canvas leyera la pausa como
      // TECNICA para siempre, de modo que una suspension limpia posterior en
      // un `PAUSA_FLOW` se repintaba como si el flujo siguiera roto y
      // senalando ademas el nodo equivocado.
      expect(prepared.contextPayload.error_context).toBeUndefined();
      // Lo demas sigue intacto: se purga un namespace, no el contexto.
      expect(prepared.contextPayload.salida_a).toEqual({ valorA: 1 });
    });

    it('NO deberia mutar el contexto original al purgarlo', async () => {
      // 1. Arrange 📐: el checkpoint es inmutable por contrato
      //    (`architecture-patterns.md` §3); un `delete` sobre el jsonb cargado
      //    tocaria el objeto que la entidad todavia expone.
      const execution = buildExecution({
        currentState: ExecutionState.PAUSADO,
        activeCursor: 'nodo_b',
        contextPayload: { error_context: { error_code: 'ERR_X' } },
        retryState: {},
      });
      const original = execution.contextPayload;
      const { repo } = buildRepository(execution);

      // 2. Act ⚙️
      await buildEngine(repo).prepareResume(EXECUTION_ID);

      // 3. Assert 🎯: el objeto de partida conserva su clave.
      expect(original.error_context).toEqual({ error_code: 'ERR_X' });
    });

    it('deberia dejar que el parche REPONGA `error_context` si alguien lo pide', async () => {
      // 1. Arrange 📐: la purga va antes de la fusion justamente para que el
      //    parche —que es abierto— siga mandando sobre el motor.
      const execution = buildExecution({
        currentState: ExecutionState.PAUSADO,
        activeCursor: 'nodo_b',
        contextPayload: { error_context: { error_code: 'ERR_VIEJO' } },
        retryState: {},
      });
      const { repo } = buildRepository(execution);

      // 2. Act ⚙️
      const prepared = await buildEngine(repo).prepareResume(EXECUTION_ID, {
        error_context: { error_code: 'ERR_REPUESTO' },
      });

      // 3. Assert 🎯
      expect(prepared.contextPayload.error_context).toEqual({
        error_code: 'ERR_REPUESTO',
      });
    });

    it('deberia admitir un namespace nuevo en el parche', async () => {
      // 1. Arrange
      const execution = buildPausedExecution();
      const { repo } = buildRepository(execution);

      // 2. Act
      const prepared = await buildEngine(repo).prepareResume(EXECUTION_ID, {
        namespace_nuevo: { aportado: 'a mano' },
      });

      // 3. Assert
      expect(prepared.contextPayload.namespace_nuevo).toEqual({
        aportado: 'a mano',
      });
    });

    it('deberia limpiar el motivo de fallo y CONSERVAR la ruta del log', async () => {
      // 1. Arrange
      const execution = buildPausedExecution();
      const { repo } = buildRepository(execution);

      // 2. Act
      const prepared = await buildEngine(repo).prepareResume(EXECUTION_ID);

      // 3. Assert: el motivo describe un cierre que ya no es el estado de esta
      // fila. La ruta, en cambio, es el rastro de por que hubo que reanudar:
      // borrarla dejaria sin nada que mirar si el reintento se rompe igual.
      expect(prepared.failureReason).toBeNull();
      expect(prepared.logFilePath).toBe(NODE_LOG_PATH);
    });

    it('NO deberia cambiar el estado ni el cursor', async () => {
      // 1. Arrange: el paso a EN_PROCESO lo da `executeWorkflow`, porque esa
      // transicion es la que reserva el mutex `idx_flujo_activo`. Adelantarla
      // dejaria el turno cogido sin ningun bucle atendiendolo.
      const execution = buildPausedExecution();
      const { repo } = buildRepository(execution);

      // 2. Act
      const prepared = await buildEngine(repo).prepareResume(EXECUTION_ID);

      // 3. Assert
      expect(prepared.currentState).toBe(ExecutionState.PAUSADO);
      expect(prepared.activeCursor).toBe('nodo_b');
    });

    it('deberia lanzar NotFoundException si la ejecucion no existe', async () => {
      // 1. Arrange
      const { repo, findOne, update } = buildRepository(buildExecution());
      findOne.mockResolvedValue(null);

      // 2. Act + 3. Assert
      await expect(
        buildEngine(repo).prepareResume(EXECUTION_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(update).not.toHaveBeenCalled();
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
      factory.registerStrategy(
        buildStrategy(NodeType.DESTINO_DRUPAL, executeC),
      );

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
      factory.registerStrategy(
        buildStrategy(NodeType.DESTINO_DRUPAL, jest.fn()),
      );

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
      factory.registerStrategy(
        buildStrategy(NodeType.DESTINO_DRUPAL, executeC),
      );

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

    it('12.1 NO deberia liberar el base64 porque el correo traiga cuerpo', async () => {
      // 1. Arrange: el correo trae cuerpo textual, pero NADIE ha abierto su
      //    adjunto. Que el cuerpo venga redactado no dice nada sobre lo que
      //    cuelga de el, y hasta el recalibrado esto purgaba un PDF del que no
      //    se habia leido un solo byte.
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

      // 3. Assert: el adjunto llega entero al final, metadatos incluidos.
      expect(attachmentsIn(result.contextPayload)).toEqual([
        {
          filename: 'escaneo.pdf',
          contentType: 'application/pdf',
          size: 1024,
          contentBase64: BASE64,
        },
      ]);
      // Y el binario sigue en el checkpoint: es la UNICA copia que queda.
      expect(
        checkpointsOf(update).some((payload) =>
          JSON.stringify(payload).includes(BASE64),
        ),
      ).toBe(true);
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
              extracted_documents_text:
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
            data: {
              extracted_documents_text: '   \n  ',
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
            data: { extracted_documents_text: 'Texto sin adjuntos.' },
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
              extracted_documents_text:
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
              extracted_documents_text:
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
              extracted_documents_text:
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
            data: {
              extracted_documents_text: 'Ver adjunto.',
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
            data: {
              extracted_documents_text: 'Ver adjunto.',
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
      const result = await buildEngine(
        repo,
        new ConfigService({ FSM_MIN_USEFUL_TEXT_LENGTH: '5' }),
      ).executeWorkflow(EXECUTION_ID, buildEmailSchema());

      // 3. Assert
      expect(attachmentsIn(result.contextPayload)[0].contentBase64).toBeNull();
    });

    /**
     * Los dos casos que fijan el incidente de la ejecucion E2E.
     *
     * `PARSER_PRE_IA` publica en el MISMO payload el cuerpo del correo y el
     * texto de los adjuntos. Son dos afirmaciones distintas y solo la segunda
     * autoriza a tirar los binarios; mientras ambas estuvieron en
     * `EXTRACTED_TEXT_KEYS` eran indistinguibles para el motor.
     */
    it('12.14 NO deberia liberar el binario si extracted_documents_text llega vacio', async () => {
      // 1. Arrange: la forma exacta que deja `skipDocumentExtraction` encendido
      //    —cuerpo largo, extraccion documental en blanco— sobre un adjunto que
      //    nadie ha abierto.
      const execution = buildExecution();
      const { repo } = buildRepository(execution);

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue({
            success: true,
            data: { attachments: [buildAttachment()] },
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
                'Cuerpo del correo con texto de sobra para cualquier modelo de lenguaje.',
              extracted_documents_text: '',
            },
          }),
        ),
      );

      // 2. Act
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildEmailSchema(),
      );

      // 3. Assert: el pliego sigue entero. Era la unica copia.
      expect(attachmentsIn(result.contextPayload)[0].contentBase64).toBe(
        BASE64,
      );
    });

    it('12.15 deberia liberar el binario cuando extracted_documents_text trae texto', async () => {
      // 1. Arrange: el MISMO cuerpo del caso anterior; lo unico que cambia es
      //    que esta vez el adjunto SI se leyo.
      const execution = buildExecution();
      const { repo } = buildRepository(execution);

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue({
            success: true,
            data: { attachments: [buildAttachment()] },
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
                'Cuerpo del correo con texto de sobra para cualquier modelo de lenguaje.',
              extracted_documents_text:
                'Pliego de clausulas administrativas particulares del expediente.',
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
      factory.registerStrategy(buildStrategy(NodeType.DESTINO_DRUPAL, execC));
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
      factory.registerStrategy(
        buildStrategy(NodeType.DESTINO_DRUPAL, jest.fn()),
      );
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
      factory.registerStrategy(
        buildStrategy(NodeType.DESTINO_DRUPAL, jest.fn()),
      );
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
          NodeType.DESTINO_DRUPAL,
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
      factory.registerStrategy(buildStrategy(NodeType.DESTINO_DRUPAL, execC));

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
          NodeType.DESTINO_DRUPAL,
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

  describe('32. Desenlace de una ejecucion desviada por onErrorStep', () => {
    /**
     * Grafo con una alerta TERMINAL colgando de la ruta de error de `nodo_b`.
     *
     * `nodo_alerta` es `DESTINO_SMTP` con `nextStep: null`: es el satelite que
     * el editor de plantillas provisiona, alcanzable SOLO por la ruta de error.
     */
    const buildSchemaWithAlert = (): PipelineSchemaDto => {
      const schema = buildLinearSchema();

      schema.nodes.nodo_b.onErrorStep = 'nodo_alerta';
      schema.nodes.nodo_alerta = {
        nodeId: 'nodo_alerta',
        nodeType: NodeType.DESTINO_SMTP,
        outputNamespace: 'smtp_result',
        nextStep: null,
        onErrorStep: null,
        params: {},
      };

      return schema;
    };

    /** Registra las tres estrategias del grafo con alerta. */
    const registerAlertStrategies = (
      executeB: jest.Mock,
      executeAlert: jest.Mock,
    ): void => {
      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue({ success: true, data: { ok: true } }),
        ),
      );
      factory.registerStrategy(buildStrategy(NodeType.PROCESADOR_IA, executeB));
      factory.registerStrategy(
        buildStrategy(NodeType.DESTINO_SMTP, executeAlert),
      );
    };

    it('32.1 deberia PAUSAR en el nodo que fallo si el error era GRAVE', async () => {
      // 1. Arrange 📐: es el caso que antes cerraba EXITOSO. La rama muere en
      //    una alerta: nadie recupero nada, solo se aviso, asi que la ejecucion
      //    fallo. GRAVE es el unico nivel que merece un reintento (mismo
      //    criterio que `canRetry`), y PAUSADO es el estado que lo conserva.
      const execution = buildExecution();
      const { repo, update } = buildRepository(execution);
      const executeAlert = jest
        .fn()
        .mockResolvedValue({ success: true, data: { enviado: true } });

      registerAlertStrategies(
        jest.fn().mockResolvedValue(failure('GRAVE')),
        executeAlert,
      );

      // 2. Act ⚙️
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildSchemaWithAlert(),
      );

      // 3. Assert 🎯: el cursor queda en `nodo_b` y NO en la alerta. El
      //    reintento manual de CU-09 tiene que repetir el paso que se rompio,
      //    no volver a mandar el correo que ya se mando.
      expect(executeAlert).toHaveBeenCalledTimes(1);
      expect(result.currentState).toBe(ExecutionState.PAUSADO);
      expect(lastPatch(update).activeCursor).toBe('nodo_b');
    });

    it('32.2 deberia FALLAR sin cursor si el error era URGENTE', async () => {
      // 1. Arrange 📐: irrecuperable. Ofrecer un reintento sobre el seria
      //    prometer algo que no puede salir bien.
      const execution = buildExecution();
      const { repo, update } = buildRepository(execution);

      registerAlertStrategies(
        jest.fn().mockResolvedValue(failure('URGENTE')),
        jest.fn().mockResolvedValue({ success: true, data: {} }),
      );

      // 2. Act ⚙️
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildSchemaWithAlert(),
      );

      // 3. Assert 🎯
      expect(result.currentState).toBe(ExecutionState.FALLIDO);
      expect(lastPatch(update).activeCursor).toBeNull();
    });

    it('32.3 deberia FALLAR sin cursor si el error era LEVE', async () => {
      // 1. Arrange 📐: un LEVE no justifica insistir. La ruta declarada gana
      //    sobre el cierre por severidad (se recorre la alerta), pero el
      //    desenlace sigue siendo un fallo sin reintento que ofrecer.
      const execution = buildExecution();
      const { repo, update } = buildRepository(execution);

      registerAlertStrategies(
        jest.fn().mockResolvedValue(failure('LEVE')),
        jest.fn().mockResolvedValue({ success: true, data: {} }),
      );

      // 2. Act ⚙️
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildSchemaWithAlert(),
      );

      // 3. Assert 🎯
      expect(result.currentState).toBe(ExecutionState.FALLIDO);
      expect(lastPatch(update).activeCursor).toBeNull();
    });

    it('32.4 deberia cerrar EXITOSO una recuperacion FUNCIONAL', async () => {
      // 1. Arrange 📐: la rama NO muere en una alerta —reincorpora el flujo y
      //    llega al terminal—, que es el caso del fallback de vision. El trabajo
      //    se hizo, asi que marcarlo fallido pediria intervencion humana sobre
      //    un flujo que publico correctamente.
      const execution = buildExecution();
      const { repo, update } = buildRepository(execution);
      const schema = buildLinearSchema();

      schema.nodes.nodo_a.onErrorStep = 'nodo_b';

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue(failure('GRAVE')),
        ),
      );
      factory.registerStrategy(
        buildStrategy(
          NodeType.PROCESADOR_IA,
          jest.fn().mockResolvedValue({ success: true, data: { via: 'ia' } }),
        ),
      );
      factory.registerStrategy(
        buildStrategy(
          NodeType.DESTINO_DRUPAL,
          jest.fn().mockResolvedValue({ success: true, data: { pub: true } }),
        ),
      );

      // 2. Act ⚙️
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        schema,
      );

      // 3. Assert 🎯
      expect(result.currentState).toBe(ExecutionState.EXITOSO);
      expect(lastPatch(update).activeCursor).toBeNull();
    });

    it('32.5 deberia decidir por la severidad del ULTIMO desvio', async () => {
      // 1. Arrange 📐: dos desvios encadenados. `nodo_a` falla URGENTE y deriva
      //    a `nodo_b`; `nodo_b` falla GRAVE y deriva a la alerta. Manda el
      //    GRAVE: es el fallo que dejo la ejecucion parada y el que corresponde
      //    al cursor que se preserva. Un URGENTE del que el flujo ya se
      //    recupero no debe condenar la ejecucion a FALLIDO.
      const execution = buildExecution();
      const { repo, update } = buildRepository(execution);
      const schema = buildSchemaWithAlert();

      schema.nodes.nodo_a.onErrorStep = 'nodo_b';

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue(failure('URGENTE')),
        ),
      );
      factory.registerStrategy(
        buildStrategy(
          NodeType.PROCESADOR_IA,
          jest.fn().mockResolvedValue(failure('GRAVE')),
        ),
      );
      factory.registerStrategy(
        buildStrategy(
          NodeType.DESTINO_SMTP,
          jest.fn().mockResolvedValue({ success: true, data: {} }),
        ),
      );

      // 2. Act ⚙️
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        schema,
      );

      // 3. Assert 🎯
      expect(result.currentState).toBe(ExecutionState.PAUSADO);
      expect(lastPatch(update).activeCursor).toBe('nodo_b');
    });

    it('32.6 deberia conservar los namespaces previos al pausar', async () => {
      // 1. Arrange 📐: la inmutabilidad del `StatePayloadContext` es lo que hace
      //    util el reintento. Si pausar perdiera lo que los pasos anteriores ya
      //    produjeron, CU-09 reanudaria sobre un contexto mutilado.
      const execution = buildExecution();
      const { repo } = buildRepository(execution);

      registerAlertStrategies(
        jest.fn().mockResolvedValue(failure('GRAVE')),
        jest.fn().mockResolvedValue({ success: true, data: { enviado: true } }),
      );

      // 2. Act ⚙️
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildSchemaWithAlert(),
      );

      // 3. Assert 🎯: el paso previo y la alerta conviven con el contexto del
      //    fallo, sin que ninguno haya pisado a otro.
      expect(result.currentState).toBe(ExecutionState.PAUSADO);
      expect(result.contextPayload.salida_a).toEqual({ ok: true });
      expect(result.contextPayload.smtp_result).toEqual({ enviado: true });
      expect(result.contextPayload.error_context).toBeDefined();
    });

    it('32.7 deberia marcar la contingencia para el despachador', async () => {
      // 1. Arrange 📐: marca TRANSITORIA que lee `applyStopOnFirstSuccess`. Sin
      //    ella, una recuperacion funcional cierra EXITOSO y apagaria el flujo,
      //    enterrando el fallo junto con el.
      const execution = buildExecution();
      const { repo } = buildRepository(execution);
      const schema = buildLinearSchema();

      schema.nodes.nodo_a.onErrorStep = 'nodo_b';

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue(failure('GRAVE')),
        ),
      );
      factory.registerStrategy(
        buildStrategy(
          NodeType.PROCESADOR_IA,
          jest.fn().mockResolvedValue({ success: true, data: {} }),
        ),
      );
      factory.registerStrategy(
        buildStrategy(
          NodeType.DESTINO_DRUPAL,
          jest.fn().mockResolvedValue({ success: true, data: {} }),
        ),
      );

      // 2. Act ⚙️
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        schema,
      );

      // 3. Assert 🎯
      expect(result.currentState).toBe(ExecutionState.EXITOSO);
      expect(result.tookContingency).toBe(true);
    });

    it('32.8 NO deberia marcarla en un recorrido nominal', async () => {
      // 1. Arrange 📐: la guarda del despachador solo debe morder cuando de
      //    verdad hubo desvio; si no, ningun flujo con la politica se apagaria.
      const execution = buildExecution();
      const { repo } = buildRepository(execution);

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue({ success: true, data: {} }),
        ),
      );
      factory.registerStrategy(
        buildStrategy(
          NodeType.PROCESADOR_IA,
          jest.fn().mockResolvedValue({ success: true, data: {} }),
        ),
      );
      factory.registerStrategy(
        buildStrategy(
          NodeType.DESTINO_DRUPAL,
          jest.fn().mockResolvedValue({ success: true, data: {} }),
        ),
      );

      // 2. Act ⚙️
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildLinearSchema(),
      );

      // 3. Assert 🎯
      expect(result.currentState).toBe(ExecutionState.EXITOSO);
      expect(result.tookContingency).toBeUndefined();
    });
  });

  describe('33. Telemetria del namespace trigger', () => {
    it('33.1 deberia sembrar flow_name para las plantillas institucionales', async () => {
      // 1. Arrange 📐: el asunto por defecto de la alerta interpola
      //    `{{trigger.flow_name}}`. Sin esto se compilaba contra un namespace
      //    que nadie escribia y el correo salia con un hueco donde va el flujo.
      const execution = buildExecution();
      const { repo } = buildRepository(execution);

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue({ success: true, data: {} }),
        ),
      );
      factory.registerStrategy(
        buildStrategy(
          NodeType.PROCESADOR_IA,
          jest.fn().mockResolvedValue({ success: true, data: {} }),
        ),
      );
      factory.registerStrategy(
        buildStrategy(
          NodeType.DESTINO_DRUPAL,
          jest.fn().mockResolvedValue({ success: true, data: {} }),
        ),
      );

      // 2. Act ⚙️
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildLinearSchema(),
        { flowName: 'Notiweb - correo a CMS' },
      );

      // 3. Assert 🎯
      expect(result.contextPayload.trigger).toEqual({
        flow_name: 'Notiweb - correo a CMS',
      });
    });

    it('33.2 deberia FUSIONARLO con el payload del disparador, no pisarlo', async () => {
      // 1. Arrange 📐: `setNamespace` fusiona, y de eso depende que el nombre
      //    del flujo no borre lo que el disparador dejo en `trigger`.
      const execution = buildExecution();
      const { repo } = buildRepository(execution);

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue({ success: true, data: {} }),
        ),
      );
      factory.registerStrategy(
        buildStrategy(
          NodeType.PROCESADOR_IA,
          jest.fn().mockResolvedValue({ success: true, data: {} }),
        ),
      );
      factory.registerStrategy(
        buildStrategy(
          NodeType.DESTINO_DRUPAL,
          jest.fn().mockResolvedValue({ success: true, data: {} }),
        ),
      );

      // 2. Act ⚙️
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildLinearSchema(),
        { initialPayload: { asunto: 'Prueba' }, flowName: 'Notiweb' },
      );

      // 3. Assert 🎯
      expect(result.contextPayload.trigger).toEqual({
        asunto: 'Prueba',
        flow_name: 'Notiweb',
      });
    });
  });

  describe('34. Publicacion del namespace desacoplada del exito', () => {
    /**
     * Payload neutro con la forma que emite `PARSER_PRE_IA` al fallar.
     *
     * Se reducen las trece claves reales a las tres que importan aqui: la
     * coleccion vacia que impide que el extractor web reviente, el texto en
     * blanco y la bandera que explica por que el nodo se rindio.
     */
    const NEUTRAL_PAYLOAD = {
      clean_body: '',
      extracted_urls: [],
      requires_multimodal_fallback: true,
    };

    /** `NodeResult` fallido que SI trae payload, como el del parser. */
    const failureWithData = (): NodeResult => ({
      ...failure('GRAVE'),
      data: { ...NEUTRAL_PAYLOAD },
    });

    /** Registra el disparador y el terminal; `nodo_b` lo pone cada prueba. */
    const registerEdges = (terminal: jest.Mock): void => {
      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue({ success: true, data: {} }),
        ),
      );
      factory.registerStrategy(
        buildStrategy(NodeType.DESTINO_DRUPAL, terminal),
      );
    };

    /** Grafo lineal con `nodo_b` desviando hacia el terminal. */
    const buildDivertedSchema = (): PipelineSchemaDto => {
      const schema = buildLinearSchema();
      schema.nodes.nodo_b.onErrorStep = {
        targetNode: 'nodo_c',
        catchErrors: [TEST_ERROR_CODE],
      };

      return schema;
    };

    it('34.1 deberia publicar el payload de un nodo que falla y se desvia', async () => {
      // 1. Arrange 📐: es el caso del parser ante un correo sin texto. El
      //    satelite lo rescata y devuelve el flujo a su curso, asi que el
      //    namespace que el esquema prometio tiene que existir igualmente.
      const { repo } = buildRepository(buildExecution());
      registerEdges(jest.fn().mockResolvedValue({ success: true, data: {} }));
      factory.registerStrategy(
        buildStrategy(
          NodeType.PROCESADOR_IA,
          jest.fn().mockResolvedValue(failureWithData()),
        ),
      );

      // 2. Act ⚙️
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildDivertedSchema(),
      );

      // 3. Assert 🎯
      expect(result.contextPayload.salida_b).toEqual(NEUTRAL_PAYLOAD);
    });

    it('34.2 deberia publicarlo ANTES de entrar al nodo de respaldo', async () => {
      // 1. Arrange 📐: el aserto se hace DENTRO de la llamada al respaldo, no
      //    sobre el contexto final. Publicar despues del desvio dejaria pasar
      //    la prueba anterior y seguiria rompiendo al nodo que se interpola.
      const { repo } = buildRepository(buildExecution());
      let seenOnEntry: Record<string, unknown> | undefined;

      registerEdges(
        jest.fn().mockImplementation((context: StatePayloadContext) => {
          seenOnEntry = context.getNamespace('salida_b');

          return Promise.resolve({ success: true, data: {} });
        }),
      );
      factory.registerStrategy(
        buildStrategy(
          NodeType.PROCESADOR_IA,
          jest.fn().mockResolvedValue(failureWithData()),
        ),
      );

      // 2. Act ⚙️
      await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildDivertedSchema(),
      );

      // 3. Assert 🎯
      expect(seenOnEntry).toEqual(NEUTRAL_PAYLOAD);
    });

    it('34.3 deberia publicarlo tambien cuando el fallo PAUSA sin ruta', async () => {
      // 1. Arrange 📐: sin `onErrorStep` el motor pausa, y el checkpoint de la
      //    pausa es lo que leera el reintento manual de CU-09. Dejar fuera lo
      //    que el nodo alcanzo a producir obligaria a recalcularlo.
      const { repo, update } = buildRepository(buildExecution());
      registerEdges(jest.fn());
      factory.registerStrategy(
        buildStrategy(
          NodeType.PROCESADOR_IA,
          jest.fn().mockResolvedValue(failureWithData()),
        ),
      );

      // 2. Act ⚙️
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildLinearSchema(),
      );

      // 3. Assert 🎯
      expect(lastPatch(update).currentState).toBe(ExecutionState.PAUSADO);
      expect(result.contextPayload.salida_b).toEqual(NEUTRAL_PAYLOAD);
    });

    it('34.4 NO deberia crear el namespace de un nodo que falla sin payload', async () => {
      // 1. Arrange 📐: es la mayoria de los fallos. Escribir un `{}` fingiria
      //    que el nodo corrio y desactivaria la guarda de namespaces para quien
      //    lo declare aguas abajo.
      const { repo } = buildRepository(buildExecution());
      registerEdges(jest.fn());
      factory.registerStrategy(
        buildStrategy(
          NodeType.PROCESADOR_IA,
          jest.fn().mockResolvedValue(failure('GRAVE')),
        ),
      );

      // 2. Act ⚙️
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildLinearSchema(),
      );

      // 3. Assert 🎯
      expect(result.contextPayload.salida_b).toBeUndefined();
    });

    it('34.5 deberia seguir creando el namespace vacio de un nodo que acierta sin payload', async () => {
      // 1. Arrange 📐: no-regresion. `findMissingNamespaces` cuenta la clave
      //    vacia como presente; perderla bloquearia al nodo siguiente con un
      //    ERR_MISSING_UPSTREAM_CONTEXT sobre un nodo que fue bien.
      const { repo } = buildRepository(buildExecution());
      registerEdges(jest.fn().mockResolvedValue({ success: true, data: {} }));
      factory.registerStrategy(
        buildStrategy(
          NodeType.PROCESADOR_IA,
          jest.fn().mockResolvedValue({ success: true }),
        ),
      );

      // 2. Act ⚙️
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildLinearSchema(),
      );

      // 3. Assert 🎯
      expect(result.contextPayload.salida_b).toEqual({});
    });

    it('34.6 deberia seguir copiando el payload en error_context.partial_data', async () => {
      // 1. Arrange 📐: no-regresion. Las dos vias coexisten: el namespace es el
      //    estado vivo —reescribible por un nodo posterior— y `partial_data` es
      //    la instantanea del fallo que cita la carta de la alerta SMTP.
      const { repo } = buildRepository(buildExecution());
      registerEdges(jest.fn().mockResolvedValue({ success: true, data: {} }));
      factory.registerStrategy(
        buildStrategy(
          NodeType.PROCESADOR_IA,
          jest.fn().mockResolvedValue(failureWithData()),
        ),
      );

      // 2. Act ⚙️
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        buildDivertedSchema(),
      );

      // 3. Assert 🎯
      expect(result.contextPayload[ERROR_CONTEXT_NAMESPACE]).toMatchObject({
        partial_data: NEUTRAL_PAYLOAD,
      });
    });
  });

  describe('35. Descarte manual de una ejecucion detenida (CU-09)', () => {
    it('35.1 deberia cerrarla en DESCARTADO, sin cursor y devolviendo el paso previo', async () => {
      // 1. Arrange 📐
      const execution = buildExecution({
        currentState: ExecutionState.PAUSADO,
        activeCursor: 'nodo_b',
        contextPayload: { salida_a: { valorA: 1 } },
      });
      const { repo, update } = buildRepository(execution);

      // 2. Act ⚙️
      const { execution: closed, lastCursor } = await buildEngine(
        repo,
      ).discardExecution(EXECUTION_ID, 'usuario-1');

      // 3. Assert 🎯
      expect(closed.currentState).toBe(ExecutionState.DESCARTADO);
      expect(closed.activeCursor).toBeNull();
      // El paso donde se detuvo viaja aparte PORQUE la fila acaba de perderlo.
      expect(lastCursor).toBe('nodo_b');
      // El contexto se conserva: es la traza de hasta donde llego.
      expect(closed.contextPayload.salida_a).toEqual({ valorA: 1 });
      expect(update).toHaveBeenCalledWith(
        EXECUTION_ID,
        expect.objectContaining({
          currentState: ExecutionState.DESCARTADO,
          activeCursor: null,
        }),
      );
    });

    it('35.2 deberia rechazar con 409 una ejecucion que no esta PAUSADO', async () => {
      // 1. Arrange 📐: descartar una viva abortaria trabajo en curso sin que el
      //    bucle se entere, y una ya cerrada no tiene nada que descartar.
      const { repo } = buildRepository(
        buildExecution({ currentState: ExecutionState.EN_PROCESO }),
      );

      // 2. Act ⚙️ & 3. Assert 🎯
      await expect(
        buildEngine(repo).discardExecution(EXECUTION_ID, 'usuario-1'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('35.3 deberia rechazar con 404 una ejecucion inexistente', async () => {
      // 1. Arrange 📐
      const { repo, findOne } = buildRepository(buildExecution());
      findOne.mockResolvedValue(null);

      // 2. Act ⚙️ & 3. Assert 🎯
      await expect(
        buildEngine(repo).discardExecution(EXECUTION_ID, 'usuario-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('36. Anuncio del desenlace por el canal', () => {
    /** Motor con un coordinador espiado, que es lo que estas pruebas miran. */
    const buildListeningEngine = (
      repo: Repository<FsmExecution>,
    ): { engine: FsmEngineService; events: ExecutionEventsCoordinator } => {
      const events = new ExecutionEventsCoordinator();

      return {
        engine: buildEngine(repo, new ConfigService({}), events),
        events,
      };
    };

    it('36.1 deberia anunciar EXITOSO al agotar el grafo sin incidencias', async () => {
      // 1. Arrange 📐
      const { repo } = buildRepository(buildExecution());
      const { engine, events } = buildListeningEngine(repo);
      const emitFlowCompleted = jest.spyOn(events, 'emitFlowCompleted');

      for (const nodeType of [
        NodeType.TRIGGER_IMAP,
        NodeType.PROCESADOR_IA,
        NodeType.DESTINO_DRUPAL,
      ]) {
        factory.registerStrategy(
          buildStrategy(
            nodeType,
            jest.fn().mockResolvedValue({ success: true, data: {} }),
          ),
        );
      }

      // 2. Act ⚙️
      await engine.executeWorkflow(EXECUTION_ID, buildLinearSchema(), {
        flowName: 'NOTIWEB Licitaciones',
      });

      // 3. Assert 🎯: el nombre viaja porque un aviso que solo diga el UUID
      //    obliga al operador a buscar de que flujo le estan hablando.
      expect(emitFlowCompleted).toHaveBeenCalledWith(
        expect.objectContaining({
          executionId: EXECUTION_ID,
          finalState: ExecutionState.EXITOSO,
          flowName: 'NOTIWEB Licitaciones',
        }),
      );
    });

    it('36.1b deberia adjuntar la pagina publicada cuando cierra un destino Drupal', async () => {
      // 1. Arrange 📐: el destino deja su enlace en SU namespace (`salida_c`
      //    en este esquema), no necesariamente en `http_result`.
      const { repo } = buildRepository(buildExecution());
      const { engine, events } = buildListeningEngine(repo);
      const emitFlowCompleted = jest.spyOn(events, 'emitFlowCompleted');

      for (const nodeType of [NodeType.TRIGGER_IMAP, NodeType.PROCESADOR_IA]) {
        factory.registerStrategy(
          buildStrategy(
            nodeType,
            jest.fn().mockResolvedValue({ success: true, data: {} }),
          ),
        );
      }
      factory.registerStrategy(
        buildStrategy(
          NodeType.DESTINO_DRUPAL,
          jest.fn().mockResolvedValue({
            success: true,
            data: {
              published_url: 'https://portal.example/noticias/innovacion',
              exit_page: '/noticias/innovacion',
            },
          }),
        ),
      );

      // 2. Act ⚙️
      await engine.executeWorkflow(EXECUTION_ID, buildLinearSchema());

      // 3. Assert 🎯
      expect(emitFlowCompleted).toHaveBeenCalledWith(
        expect.objectContaining({
          finalState: ExecutionState.EXITOSO,
          publishedUrl: 'https://portal.example/noticias/innovacion',
          exitPage: '/noticias/innovacion',
        }),
      );
    });

    it('36.1c NO deberia adjuntar enlace si el destino no devolvio URL', async () => {
      // 1. Arrange 📐: la interfaz decide por la presencia del campo.
      const { repo } = buildRepository(buildExecution());
      const { engine, events } = buildListeningEngine(repo);
      const emitFlowCompleted = jest.spyOn(events, 'emitFlowCompleted');

      for (const nodeType of [
        NodeType.TRIGGER_IMAP,
        NodeType.PROCESADOR_IA,
        NodeType.DESTINO_DRUPAL,
      ]) {
        factory.registerStrategy(
          buildStrategy(
            nodeType,
            jest.fn().mockResolvedValue({ success: true, data: {} }),
          ),
        );
      }

      // 2. Act ⚙️
      await engine.executeWorkflow(EXECUTION_ID, buildLinearSchema());

      // 3. Assert 🎯
      const [event] = emitFlowCompleted.mock.calls[0] ?? [];
      expect(event).toBeDefined();
      expect(event).not.toHaveProperty('publishedUrl');
    });

    it('36.2 deberia anunciar OMITIDO cuando un nodo pide parada ordenada', async () => {
      // 1. Arrange 📐: un buzon vacio no es un exito, y anunciarlo como tal
      //    haria creer que se publico algo.
      const { repo } = buildRepository(buildExecution());
      const { engine, events } = buildListeningEngine(repo);
      const emitFlowCompleted = jest.spyOn(events, 'emitFlowCompleted');

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue({
            success: true,
            data: {},
            halt: { reason: 'NO_MESSAGES_FOUND' },
          }),
        ),
      );

      // 2. Act ⚙️
      await engine.executeWorkflow(EXECUTION_ID, buildLinearSchema());

      // 3. Assert 🎯
      expect(emitFlowCompleted).toHaveBeenCalledWith(
        expect.objectContaining({ finalState: ExecutionState.OMITIDO }),
      );
    });

    it('36.3 NO deberia anunciar cierre al pausarse: eso ya lo dice flow:paused', async () => {
      // 1. Arrange 📐: una PAUSADO es reanudable, de modo que contarla como
      //    terminal dejaria la interfaz sin ofrecer el reintento.
      const { repo } = buildRepository(buildExecution());
      const { engine, events } = buildListeningEngine(repo);
      const emitFlowCompleted = jest.spyOn(events, 'emitFlowCompleted');
      const emitFlowPaused = jest.spyOn(events, 'emitFlowPaused');

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue(failure('URGENTE')),
        ),
      );

      // 2. Act ⚙️
      await engine.executeWorkflow(EXECUTION_ID, buildLinearSchema());

      // 3. Assert 🎯
      expect(emitFlowPaused).toHaveBeenCalledTimes(1);
      expect(emitFlowCompleted).not.toHaveBeenCalled();
    });
  });

  describe('37. Detalle que acompana a flow:paused', () => {
    it('37.1 deberia nombrar el flujo, el tipo del nodo y el codigo del fallo', async () => {
      // 1. Arrange 📐. Sin estos tres datos el aviso dice que algo fallo pero
      //    no a que pantalla ir: el nodeId no revela el tipo, y el mensaje de
      //    la estrategia cambia entre versiones mientras el codigo no.
      const { repo } = buildRepository(buildExecution());
      const events = new ExecutionEventsCoordinator();
      const emitFlowPaused = jest.spyOn(events, 'emitFlowPaused');
      const engine = buildEngine(repo, new ConfigService({}), events);

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue({ success: true, data: {} }),
        ),
      );
      factory.registerStrategy(
        buildStrategy(
          NodeType.PROCESADOR_IA,
          jest
            .fn()
            .mockResolvedValue(failure('GRAVE', 'El proveedor devolvio 503')),
        ),
      );

      // 2. Act ⚙️
      await engine.executeWorkflow(EXECUTION_ID, buildLinearSchema(), {
        flowName: 'NOTIWEB Licitaciones',
      });

      // 3. Assert 🎯
      expect(emitFlowPaused).toHaveBeenCalledWith(
        expect.objectContaining({
          activeCursor: 'nodo_b',
          severity: 'GRAVE',
          errorCode: TEST_ERROR_CODE,
          errorMessage: 'El proveedor devolvio 503',
          nodeType: NodeType.PROCESADOR_IA,
          flowName: 'NOTIWEB Licitaciones',
        }),
      );
    });

    it('37.2 NO deberia inventar tipo ni codigo en una pausa previa a ejecutar nodo', async () => {
      // 1. Arrange 📐: el cursor apunta a un nodo que ya no esta en el mapa, de
      //    modo que el bucle para ANTES de invocar estrategia alguna. Rellenar
      //    ahi un tipo o un codigo senalaria a un nodo que no intervino.
      const { repo } = buildRepository(
        buildExecution({ activeCursor: 'nodo_fantasma' }),
      );
      const events = new ExecutionEventsCoordinator();
      const emitFlowPaused = jest.spyOn(events, 'emitFlowPaused');
      const engine = buildEngine(repo, new ConfigService({}), events);

      // 2. Act ⚙️
      await engine.executeWorkflow(EXECUTION_ID, buildLinearSchema(), {
        flowName: 'NOTIWEB Licitaciones',
      });

      // 3. Assert 🎯
      const event = emitFlowPaused.mock.calls[0]?.[0];
      expect(event?.activeCursor).toBe('nodo_fantasma');
      expect(event?.nodeType).toBeUndefined();
      expect(event?.errorCode).toBeUndefined();
      // El nombre SI viaja: no depende de haber ejecutado nada.
      expect(event?.flowName).toBe('NOTIWEB Licitaciones');
    });
  });

  describe('38. Presupuesto de reintentos declarado agotado', () => {
    /** Fallo GRAVE que declara haber consumido ya su propio presupuesto. */
    const exhaustedFailure = (): NodeResult => ({
      success: false,
      error: {
        level: 'GRAVE',
        code: TEST_ERROR_CODE,
        message: 'Inferencia fallida tras agotar 3 reintentos',
        description: 'Causa raiz: el proveedor devolvio 503.',
        metadata: {
          attempts: 3,
          maxRetries: 3,
          exhausted: true,
          lastError: '503',
        },
      },
    });

    /** Pipeline cuyo primer nodo tiene presupuesto de reintentos del motor. */
    const schemaWithRetries = (maxRetries: number): PipelineSchemaDto => {
      const schema = buildLinearSchema();
      // El tipo del nodo se deriva del propio esquema en vez de importarse:
      // asi no hay una segunda referencia que mantener si el DTO cambia.
      const nodes: PipelineSchemaDto['nodes'] = { ...schema.nodes };
      const entry = nodes.nodo_a;

      if (entry === undefined) {
        throw new Error('El pipeline de prueba perdio su nodo de entrada.');
      }

      nodes.nodo_a = { ...entry, retryPolicy: { maxRetries } };

      return { ...schema, nodes };
    };

    it('38.1 NO deberia reintentar un GRAVE que ya se declara agotado', async () => {
      // 1. Arrange 📐. Es la guarda que evita la multiplicacion: bajo la
      //    estrategia ya corrio su propio bucle, asi que sumar los del nodo
      //    repetiria la cadena entera y emitiria un `node:error` por vuelta.
      const { repo } = buildRepository(buildExecution());
      const execute = jest.fn().mockResolvedValue(exhaustedFailure());
      factory.registerStrategy(buildStrategy(NodeType.TRIGGER_IMAP, execute));

      // 2. Act ⚙️
      const result = await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        schemaWithRetries(3),
      );

      // 3. Assert 🎯: UNA sola invocacion pese a los tres reintentos del nodo.
      expect(execute).toHaveBeenCalledTimes(1);
      expect(result.currentState).toBe(ExecutionState.PAUSADO);
    });

    it('38.2 SI deberia reintentar un GRAVE que no lleva la marca', async () => {
      // 1. Arrange 📐: la contrapartida. Sin ella, una guarda que cortara
      //    siempre pasaria la prueba anterior y dejaria el motor sin reintentos.
      const { repo } = buildRepository(buildExecution());
      const execute = jest.fn().mockResolvedValue(failure('GRAVE'));
      factory.registerStrategy(buildStrategy(NodeType.TRIGGER_IMAP, execute));

      // 2. Act ⚙️
      await buildEngine(repo).executeWorkflow(
        EXECUTION_ID,
        schemaWithRetries(2),
      );

      // 3. Assert 🎯: el intento inicial mas los dos reintentos.
      expect(execute).toHaveBeenCalledTimes(3);
    });

    it('38.3 deberia anunciar en la pausa los intentos que declara la estrategia', async () => {
      // 1. Arrange 📐: el contador del MOTOR vale cero en este caso —no llego a
      //    reintentar—, y publicarlo diria "fallo al primer intento" sobre una
      //    incidencia que consumio tres. Es justo el dato con el que el
      //    operador decide si reanudar ahora mismo sirve de algo.
      const { repo } = buildRepository(buildExecution());
      const events = new ExecutionEventsCoordinator();
      const emitFlowPaused = jest.spyOn(events, 'emitFlowPaused');
      const engine = buildEngine(repo, new ConfigService({}), events);

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue(exhaustedFailure()),
        ),
      );

      // 2. Act ⚙️
      await engine.executeWorkflow(EXECUTION_ID, schemaWithRetries(3));

      // 3. Assert 🎯
      expect(emitFlowPaused).toHaveBeenCalledWith(
        expect.objectContaining({
          attempts: 3,
          errorDetail: 'Causa raiz: el proveedor devolvio 503.',
        }),
      );
    });
  });

  describe('38. Ciclo de vida del nodo por el canal', () => {
    /** Motor con el coordinador real espiado, igual que en el bloque 36. */
    const buildListeningEngine = (
      repo: Repository<FsmExecution>,
    ): { engine: FsmEngineService; events: ExecutionEventsCoordinator } => {
      const events = new ExecutionEventsCoordinator();

      return {
        engine: buildEngine(repo, new ConfigService({}), events),
        events,
      };
    };

    /** Registra los tres tipos del pipeline lineal resolviendo con exito. */
    const registerHappyStrategies = (): void => {
      for (const nodeType of [
        NodeType.TRIGGER_IMAP,
        NodeType.PROCESADOR_IA,
        NodeType.DESTINO_DRUPAL,
      ]) {
        factory.registerStrategy(
          buildStrategy(
            nodeType,
            jest.fn().mockResolvedValue({ success: true, data: {} }),
          ),
        );
      }
    };

    /** Payloads emitidos, en orden, ya tipados para poder navegarlos. */
    const payloadsOf = <T>(spy: jest.SpyInstance): T[] =>
      (spy.mock.calls as [T][]).map(([event]) => event);

    it('38.1 deberia anunciar inicio y fin de cada nodo en orden topologico', async () => {
      // 1. Arrange 📐
      const { repo } = buildRepository(buildExecution());
      const { engine, events } = buildListeningEngine(repo);
      const emitNodeStarted = jest.spyOn(events, 'emitNodeStarted');
      const emitNodeCompleted = jest.spyOn(events, 'emitNodeCompleted');
      registerHappyStrategies();

      // 2. Act ⚙️
      await engine.executeWorkflow(EXECUTION_ID, buildLinearSchema());

      // 3. Assert 🎯: `stepIndex` es la posicion en la topologia que el canvas
      //    ya tiene pintada, y `totalSteps` permite el "paso 3 de 3".
      expect(payloadsOf<NodeStartedEvent>(emitNodeStarted)).toEqual([
        expect.objectContaining({ nodeId: 'nodo_a', stepIndex: 0 }),
        expect.objectContaining({ nodeId: 'nodo_b', stepIndex: 1 }),
        expect.objectContaining({ nodeId: 'nodo_c', stepIndex: 2 }),
      ]);
      expect(payloadsOf<NodeCompletedEvent>(emitNodeCompleted)).toEqual([
        expect.objectContaining({ nodeId: 'nodo_a', totalSteps: 3 }),
        expect.objectContaining({ nodeId: 'nodo_b', totalSteps: 3 }),
        expect.objectContaining({ nodeId: 'nodo_c', totalSteps: 3 }),
      ]);
    });

    it('38.2 deberia anunciar el inicio POR INTENTO y el fin una sola vez', async () => {
      // 1. Arrange 📐: con un solo anuncio inicial, la caja se quedaria pintada
      //    como fallida durante el reintento, que es cuando hace falta ver que
      //    el nodo sigue vivo.
      const { repo } = buildRepository(buildExecution());
      const { engine, events } = buildListeningEngine(repo);
      const emitNodeStarted = jest.spyOn(events, 'emitNodeStarted');
      const emitNodeCompleted = jest.spyOn(events, 'emitNodeCompleted');

      const schema = buildLinearSchema();
      schema.nodes.nodo_a.retryPolicy = { maxRetries: 2 };
      schema.nodes.nodo_a.nextStep = null;

      const executeA = jest
        .fn()
        .mockResolvedValueOnce(failure('GRAVE'))
        .mockResolvedValueOnce(failure('GRAVE'))
        .mockResolvedValue({ success: true, data: {} });
      factory.registerStrategy(buildStrategy(NodeType.TRIGGER_IMAP, executeA));

      // 2. Act ⚙️
      await engine.executeWorkflow(EXECUTION_ID, schema);

      // 3. Assert 🎯
      expect(
        payloadsOf<NodeStartedEvent>(emitNodeStarted).map((e) => e.attempt),
      ).toEqual([1, 2, 3]);
      expect(emitNodeCompleted).toHaveBeenCalledTimes(1);
      expect(emitNodeCompleted).toHaveBeenCalledWith(
        expect.objectContaining({ nodeId: 'nodo_a', attempts: 3 }),
      );
    });

    it('38.3 NO deberia anunciar fin cuando el nodo agota sus intentos', async () => {
      // 1. Arrange 📐: ese hueco ya lo cubre `node:error`, y un `node:completed`
      //    en el camino del fallo obligaria a discriminar dentro del manejador
      //    del camino feliz.
      const { repo } = buildRepository(buildExecution());
      const { engine, events } = buildListeningEngine(repo);
      const emitNodeStarted = jest.spyOn(events, 'emitNodeStarted');
      const emitNodeCompleted = jest.spyOn(events, 'emitNodeCompleted');
      const emitFlowPaused = jest.spyOn(events, 'emitFlowPaused');

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue(failure('URGENTE')),
        ),
      );

      // 2. Act ⚙️
      await engine.executeWorkflow(EXECUTION_ID, buildLinearSchema());

      // 3. Assert 🎯
      expect(emitNodeStarted).toHaveBeenCalledTimes(1);
      expect(emitNodeCompleted).not.toHaveBeenCalled();
      expect(emitFlowPaused).toHaveBeenCalledTimes(1);
    });

    it('38.4 deberia anunciar el nodo de contingencia con stepIndex nulo', async () => {
      // 1. Arrange 📐: `buildOrderedTopology` solo sigue `nextStep`, asi que un
      //    nodo colgado unicamente de un `onErrorStep` NO esta en la topologia.
      //    El nulo le dice al canvas "pintalo como rama lateral"; un -1 se
      //    pintaria como caja valida en el primer `array[index]` descuidado.
      const { repo } = buildRepository(buildExecution());
      const { engine, events } = buildListeningEngine(repo);
      const emitNodeStarted = jest.spyOn(events, 'emitNodeStarted');

      const schema = buildLinearSchema();
      schema.nodes.nodo_a.onErrorStep = 'nodo_alerta';
      schema.nodes.nodo_alerta = {
        nodeId: 'nodo_alerta',
        nodeType: NodeType.DESTINO_SMTP,
        outputNamespace: 'smtp_result',
        nextStep: null,
        onErrorStep: null,
        params: {},
      };

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue(failure('GRAVE')),
        ),
      );
      factory.registerStrategy(
        buildStrategy(
          NodeType.DESTINO_SMTP,
          jest.fn().mockResolvedValue({ success: true, data: {} }),
        ),
      );

      // 2. Act ⚙️
      await engine.executeWorkflow(EXECUTION_ID, schema);

      // 3. Assert 🎯
      expect(emitNodeStarted).toHaveBeenCalledWith(
        expect.objectContaining({ nodeId: 'nodo_alerta', stepIndex: null }),
      );
      // La topologia nominal no cambia por tener una rama de contingencia.
      expect(emitNodeStarted).toHaveBeenCalledWith(
        expect.objectContaining({ nodeId: 'nodo_alerta', totalSteps: 3 }),
      );
    });

    it('38.5 deberia conservar el stepIndex al reanudar desde un cursor intermedio', async () => {
      // 1. Arrange 📐: es la prueba que falla si alguien cambia la fuente del
      //    indice al contador del bucle, que arranca en cero sea cual sea el
      //    cursor de partida y anunciaria "paso 1" sobre la caja equivocada.
      const { repo } = buildRepository(
        buildExecution({ activeCursor: 'nodo_c' }),
      );
      const { engine, events } = buildListeningEngine(repo);
      const emitNodeStarted = jest.spyOn(events, 'emitNodeStarted');
      registerHappyStrategies();

      // 2. Act ⚙️
      await engine.executeWorkflow(EXECUTION_ID, buildLinearSchema());

      // 3. Assert 🎯: tercera caja de la topologia, primera vuelta del bucle.
      expect(emitNodeStarted).toHaveBeenCalledTimes(1);
      expect(emitNodeStarted).toHaveBeenCalledWith(
        expect.objectContaining({
          nodeId: 'nodo_c',
          stepIndex: 2,
          transition: 1,
        }),
      );
    });

    it('38.6 NO deberia anunciar un nodo omitido en modo prueba', async () => {
      // 1. Arrange 📐: un nodo saltado no se ejecuta en absoluto, de modo que
      //    anunciarlo lo pintaria corriendo sin que nadie lo invoque.
      const { repo } = buildRepository(buildExecution());
      const { engine, events } = buildListeningEngine(repo);
      const emitNodeStarted = jest.spyOn(events, 'emitNodeStarted');
      registerHappyStrategies();

      // 2. Act ⚙️
      await engine.executeWorkflow(EXECUTION_ID, buildLinearSchema(), {
        skipNodeTypes: [NodeType.TRIGGER_IMAP],
      });

      // 3. Assert 🎯
      expect(
        payloadsOf<NodeStartedEvent>(emitNodeStarted).map((e) => e.nodeId),
      ).toEqual(['nodo_b', 'nodo_c']);
    });

    it('38.7 deberia marcar halted y medir la duracion en la parada ordenada', async () => {
      // 1. Arrange 📐: confirma que el punto de emision domina tambien la salida
      //    por `halt`, que no pasa por `nextStep`.
      const { repo } = buildRepository(buildExecution());
      const { engine, events } = buildListeningEngine(repo);
      const emitNodeCompleted = jest.spyOn(events, 'emitNodeCompleted');

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue({
            success: true,
            data: {},
            halt: { reason: 'NO_MESSAGES_FOUND' },
          }),
        ),
      );

      // 2. Act ⚙️
      await engine.executeWorkflow(EXECUTION_ID, buildLinearSchema());

      // 3. Assert 🎯: el valor del reloj es real, asi que solo se afirma el
      //    tipo —mismo criterio que la traza del bloque de duraciones.
      const [completed] = payloadsOf<NodeCompletedEvent>(emitNodeCompleted);
      expect(completed?.halted).toBe(true);
      expect(completed?.attempts).toBe(1);
      expect(typeof completed?.durationMs).toBe('number');
    });
  });

  describe('39. Pausa del flujo padre al detener una ejecucion', () => {
    /** Motor con el coordinador de estado espiado. */
    const buildPausingEngine = (
      repo: Repository<FsmExecution>,
    ): {
      engine: FsmEngineService;
      workflowStatus: WorkflowStatusCoordinator;
      events: ExecutionEventsCoordinator;
    } => {
      const events = new ExecutionEventsCoordinator();
      const workflowStatus = new WorkflowStatusCoordinator();

      return {
        engine: buildEngine(
          repo,
          new ConfigService({}),
          events,
          workflowStatus,
        ),
        workflowStatus,
        events,
      };
    };

    it('39.1 deberia pedir la pausa del flujo al detenerse sin ruta', async () => {
      // 1. Arrange 📐
      const { repo } = buildRepository(buildExecution());
      const { engine, workflowStatus } = buildPausingEngine(repo);
      const pauseFlow = jest.spyOn(workflowStatus, 'pauseFlow');

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue(failure('URGENTE')),
        ),
      );

      // 2. Act ⚙️
      await engine.executeWorkflow(EXECUTION_ID, buildLinearSchema());

      // 3. Assert 🎯: se identifica el flujo, no la ejecucion: lo que se apaga
      //    es el sondeo del flujo padre.
      expect(pauseFlow).toHaveBeenCalledWith(FLOW_ID, TEST_ERROR_CODE);
    });

    it('39.1b deberia hacer coincidir pausedStepId con el cursor en un fallo', async () => {
      // 1. Arrange 📐: el nodo que se rompio ES el que se reintentara, asi que
      //    la clave cae al cursor y el cliente puede leer siempre la misma sin
      //    ramificar por tipo de pausa.
      const { repo } = buildRepository(buildExecution());
      const { engine, events } = buildPausingEngine(repo);
      const emitFlowPaused = jest.spyOn(events, 'emitFlowPaused');

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue(failure('URGENTE')),
        ),
      );

      // 2. Act ⚙️
      await engine.executeWorkflow(EXECUTION_ID, buildLinearSchema());

      // 3. Assert 🎯
      const payload = emitFlowPaused.mock.calls[0]?.[0];

      expect(payload?.pausedStepId).toBe(payload?.activeCursor);
    });

    it('39.2 deberia pausar el flujo DESPUES del checkpoint y ANTES del evento', async () => {
      // 1. Arrange 📐: el orden es observable. Despues del checkpoint porque la
      //    ejecucion es el hecho y el estado del flujo su consecuencia; antes
      //    del evento porque el cliente repinta la fila leyendo lo que el evento
      //    anuncia, y al reves pintaria "Activo" sobre una ejecucion detenida.
      const { repo, update } = buildRepository(buildExecution());
      const { engine, workflowStatus, events } = buildPausingEngine(repo);
      const pauseFlow = jest.spyOn(workflowStatus, 'pauseFlow');
      const emitFlowPaused = jest.spyOn(events, 'emitFlowPaused');

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue(failure('URGENTE')),
        ),
      );

      // 2. Act ⚙️
      await engine.executeWorkflow(EXECUTION_ID, buildLinearSchema());

      // 3. Assert 🎯
      const checkpointOrder = update.mock.invocationCallOrder.at(-1) ?? 0;
      const pauseOrder = pauseFlow.mock.invocationCallOrder[0] ?? 0;
      const eventOrder = emitFlowPaused.mock.invocationCallOrder[0] ?? 0;

      expect(checkpointOrder).toBeLessThan(pauseOrder);
      expect(pauseOrder).toBeLessThan(eventOrder);
    });

    it('39.3 NO deberia pausar el flujo en el banco de pruebas', async () => {
      // 1. Arrange 📐: un ensayo fallido contra un flujo en produccion lo
      //    dejaria PAUSADO y apagaria su sondeo, convirtiendo la prueba en una
      //    interrupcion del servicio.
      const { repo } = buildRepository(buildExecution());
      const { engine, workflowStatus, events } = buildPausingEngine(repo);
      const pauseFlow = jest.spyOn(workflowStatus, 'pauseFlow');
      const emitFlowPaused = jest.spyOn(events, 'emitFlowPaused');

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue(failure('URGENTE')),
        ),
      );

      // 2. Act ⚙️
      await engine.executeWorkflow(EXECUTION_ID, buildLinearSchema(), {
        suppressFlowPause: true,
      });

      // 3. Assert 🎯: la EJECUCION si queda PAUSADO —es reanudable—, pero el
      //    flujo padre no se entera.
      expect(pauseFlow).not.toHaveBeenCalled();
      expect(emitFlowPaused).toHaveBeenCalledTimes(1);
    });

    it('39.4 deberia pausar el flujo tambien cuando salta el circuit breaker', async () => {
      // 1. Arrange 📐: un ciclo en el grafo no tiene nodo culpable, pero deja la
      //    ejecucion igual de atascada y el sondeo igual de inutil.
      const execution = buildExecution();
      const { repo } = buildRepository(execution);
      const { engine, workflowStatus } = buildPausingEngine(repo);
      const pauseFlow = jest.spyOn(workflowStatus, 'pauseFlow');

      const schema = buildLinearSchema();
      schema.nodes.nodo_a.nextStep = 'nodo_b';
      schema.nodes.nodo_b.nextStep = 'nodo_a';

      for (const nodeType of [NodeType.TRIGGER_IMAP, NodeType.PROCESADOR_IA]) {
        factory.registerStrategy(
          buildStrategy(
            nodeType,
            jest.fn().mockResolvedValue({ success: true, data: {} }),
          ),
        );
      }

      // 2. Act ⚙️
      await engine.executeWorkflow(EXECUTION_ID, schema);

      // 3. Assert 🎯
      expect(pauseFlow).toHaveBeenCalledTimes(1);
    });

    it('39.5 NO deberia romper la pausa si el coordinador falla', async () => {
      // 1. Arrange 📐: una notificacion rota no puede convertir una pausa
      //    reanudable en una excepcion sin checkpoint.
      const { repo, update } = buildRepository(buildExecution());
      const { engine, workflowStatus, events } = buildPausingEngine(repo);
      jest
        .spyOn(workflowStatus, 'pauseFlow')
        .mockRejectedValue(new Error('PostgreSQL caido'));
      const emitFlowPaused = jest.spyOn(events, 'emitFlowPaused');

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue(failure('URGENTE')),
        ),
      );

      // 2. Act ⚙️ & 3. Assert 🎯
      await expect(
        engine.executeWorkflow(EXECUTION_ID, buildLinearSchema()),
      ).resolves.toBeDefined();
      expect(lastPatch(update).currentState).toBe(ExecutionState.PAUSADO);
      expect(emitFlowPaused).toHaveBeenCalledTimes(1);
    });
  });

  describe('40. Suspension deliberada pedida por un nodo (`pause`)', () => {
    /** Motor con el coordinador de estado y el canal espiados. */
    const buildPausingEngine = (
      repo: Repository<FsmExecution>,
    ): {
      engine: FsmEngineService;
      workflowStatus: WorkflowStatusCoordinator;
      events: ExecutionEventsCoordinator;
    } => {
      const events = new ExecutionEventsCoordinator();
      const workflowStatus = new WorkflowStatusCoordinator();

      return {
        engine: buildEngine(
          repo,
          new ConfigService({}),
          events,
          workflowStatus,
        ),
        workflowStatus,
        events,
      };
    };

    /** `NodeResult` de un nodo de pausa: exito, sin error, con senal. */
    const pausing = (): Record<string, unknown> => ({
      success: true,
      data: { shouldPause: true, pauseReason: 'PROGRAMMED_AUTO_PAUSE' },
      pause: { reason: 'PROGRAMMED_AUTO_PAUSE' },
    });

    it('40.1 deberia dejar la ejecucion PAUSADO con el cursor en el paso SIGUIENTE', async () => {
      // 1. Arrange 📐: el cursor NO se queda en el nodo de pausa. Reanudar
      //    volviendo a entrar en el pausaria otra vez, y CU-09 no podria sacar
      //    la ejecucion de ese bucle.
      const { repo, update } = buildRepository(buildExecution());
      const { engine } = buildPausingEngine(repo);
      const executeB = jest.fn().mockResolvedValue(pausing());
      const executeC = jest.fn().mockResolvedValue({ success: true });

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue({ success: true }),
        ),
      );
      factory.registerStrategy(buildStrategy(NodeType.PROCESADOR_IA, executeB));
      factory.registerStrategy(
        buildStrategy(NodeType.DESTINO_DRUPAL, executeC),
      );

      // 2. Act ⚙️
      const result = await engine.executeWorkflow(
        EXECUTION_ID,
        buildLinearSchema(),
      );

      // 3. Assert 🎯
      expect(result.currentState).toBe(ExecutionState.PAUSADO);
      expect(lastPatch(update).activeCursor).toBe('nodo_c');
      // El paso siguiente NO se ejecuta: de eso trata la pausa.
      expect(executeC).not.toHaveBeenCalled();
    });

    it('40.2 deberia pausar tambien el flujo padre, marcando que es deliberada', async () => {
      // 1. Arrange 📐: sin la marca, el cliente presenta una suspension pedida
      //    por el flujo con el mismo lenguaje de alarma que una caida.
      const { repo } = buildRepository(buildExecution());
      const { engine, workflowStatus, events } = buildPausingEngine(repo);
      const pauseFlow = jest.spyOn(workflowStatus, 'pauseFlow');
      const emitFlowPaused = jest.spyOn(events, 'emitFlowPaused');

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue(pausing()),
        ),
      );

      // 2. Act ⚙️
      await engine.executeWorkflow(EXECUTION_ID, buildLinearSchema());

      // 3. Assert 🎯
      expect(pauseFlow).toHaveBeenCalledWith(FLOW_ID, 'PROGRAMMED_AUTO_PAUSE');
      expect(emitFlowPaused).toHaveBeenCalledWith(
        expect.objectContaining({
          isProgrammedPause: true,
          pauseReason: 'PROGRAMMED_AUTO_PAUSE',
          activeCursor: 'nodo_b',
        }),
      );
    });

    it('40.2b deberia senalar el NODO DE PAUSA, no el cursor', async () => {
      // 1. Arrange 📐: es el defecto que esto corrige. El cursor queda en el
      //    paso SIGUIENTE —reanudar entrando otra vez en la pausa seria un
      //    bucle—, asi que sin `pausedStepId` la interfaz marcaba como detenido
      //    un nodo que nunca llego a arrancar, mientras el que si se ejecuto
      //    aparecia completado.
      const { repo } = buildRepository(buildExecution());
      const { engine, events } = buildPausingEngine(repo);
      const emitFlowPaused = jest.spyOn(events, 'emitFlowPaused');

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue(pausing()),
        ),
      );

      // 2. Act ⚙️
      await engine.executeWorkflow(EXECUTION_ID, buildLinearSchema());

      // 3. Assert 🎯
      expect(emitFlowPaused).toHaveBeenCalledWith(
        expect.objectContaining({
          pausedStepId: 'nodo_a',
          activeCursor: 'nodo_b',
        }),
      );
    });

    it('40.2c deberia escribir la topologia de la pausa en el namespace', async () => {
      // 1. Arrange 📐: la estrategia recibe `context` y `params`, asi que no
      //    sabe cual es su propio `nodeId` ni su `nextStep`. Solo el motor
      //    puede ponerlos, y son los que permiten reconstruir la pausa al
      //    recargar la pagina, cuando ya no hay evento que escuchar.
      const { repo } = buildRepository(buildExecution());
      const { engine } = buildPausingEngine(repo);

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue(pausing()),
        ),
      );

      // 2. Act ⚙️
      const result = await engine.executeWorkflow(
        EXECUTION_ID,
        buildLinearSchema(),
      );

      // 3. Assert 🎯: fusionado sobre lo que publico la estrategia, no en su
      //    lugar.
      expect(result.contextPayload?.salida_a).toMatchObject({
        shouldPause: true,
        pausedAtStepId: 'nodo_a',
        resumeStepId: 'nodo_b',
        reason: 'PROGRAMMED_AUTO_PAUSE',
      });
    });

    it('40.3 NO deberia escribir severidad ni codigo de error', async () => {
      // 1. Arrange 📐: una pausa deliberada no es una incidencia; que el aviso
      //    llevase severidad mandaria al operador a buscar un fallo inexistente.
      const { repo } = buildRepository(buildExecution());
      const { engine, events } = buildPausingEngine(repo);
      const emitFlowPaused = jest.spyOn(events, 'emitFlowPaused');

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue(pausing()),
        ),
      );

      // 2. Act ⚙️
      await engine.executeWorkflow(EXECUTION_ID, buildLinearSchema());

      // 3. Assert 🎯
      const payload = emitFlowPaused.mock.calls[0]?.[0];

      expect(payload?.severity).toBeUndefined();
      expect(payload?.errorCode).toBeUndefined();
    });

    it('40.4 deberia CERRAR con normalidad si el nodo de pausa no tiene paso siguiente', async () => {
      // 1. Arrange 📐: sin `nextStep` no queda nada que reanudar, asi que
      //    congelar la ejecucion solo dejaria una fila detenida para siempre
      //    esperando un trabajo que no existe.
      const { repo } = buildRepository(buildExecution());
      const { engine, workflowStatus } = buildPausingEngine(repo);
      const pauseFlow = jest.spyOn(workflowStatus, 'pauseFlow');
      const schema = buildLinearSchema();

      schema.nodes.nodo_a.nextStep = null;
      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue(pausing()),
        ),
      );

      // 2. Act ⚙️
      const result = await engine.executeWorkflow(EXECUTION_ID, schema);

      // 3. Assert 🎯
      expect(result.currentState).toBe(ExecutionState.EXITOSO);
      expect(result.activeCursor).toBeNull();
      expect(pauseFlow).not.toHaveBeenCalled();
    });

    it('40.5 NO deberia pausar el flujo padre en el banco de pruebas', async () => {
      // 1. Arrange 📐: mismo criterio que una pausa por fallo. Una prueba
      //    manual no puede dejar PAUSADO un flujo de produccion.
      const { repo } = buildRepository(buildExecution());
      const { engine, workflowStatus } = buildPausingEngine(repo);
      const pauseFlow = jest.spyOn(workflowStatus, 'pauseFlow');

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue(pausing()),
        ),
      );

      // 2. Act ⚙️
      const result = await engine.executeWorkflow(
        EXECUTION_ID,
        buildLinearSchema(),
        { suppressFlowPause: true },
      );

      // 3. Assert 🎯: la EJECUCION si queda pausada; lo que se silencia es la
      //    propagacion al flujo.
      expect(result.currentState).toBe(ExecutionState.PAUSADO);
      expect(pauseFlow).not.toHaveBeenCalled();
    });

    it('40.6 deberia IGNORAR la senal en un nodo que falla', async () => {
      // 1. Arrange 📐: `pause` solo se atiende con `success: true`, igual que
      //    `halt`. Si no, un nodo roto podria secuestrar la transicion y saltarse
      //    el protocolo de resiliencia.
      const { repo } = buildRepository(buildExecution());
      const { engine, workflowStatus } = buildPausingEngine(repo);
      const pauseFlow = jest.spyOn(workflowStatus, 'pauseFlow');

      factory.registerStrategy(
        buildStrategy(
          NodeType.TRIGGER_IMAP,
          jest.fn().mockResolvedValue({
            ...failure('URGENTE'),
            pause: { reason: 'PROGRAMMED_AUTO_PAUSE' },
          }),
        ),
      );

      // 2. Act ⚙️
      await engine.executeWorkflow(EXECUTION_ID, buildLinearSchema());

      // 3. Assert 🎯: pausa SI, pero por el protocolo de fallo y con su codigo.
      expect(pauseFlow).toHaveBeenCalledWith(FLOW_ID, TEST_ERROR_CODE);
    });
  });

  describe('41. Purga selectiva de namespaces al reanudar (invalidacion de cache)', () => {
    /**
     * Grafo realista de ingesta: disparador -> parser -> OCR -> IA -> plantilla,
     * con un satelite de alerta colgado del nodo de IA por `onErrorStep`.
     *
     * Se declara aqui y no se reutiliza `buildLinearSchema` porque la regla que
     * se prueba depende de los TIPOS de nodo (`PARSER_PRE_IA`, `PROCESADOR_OCR`)
     * y de que exista una rama de contingencia, que aquel no tiene.
     */
    const buildIngestSchema = (): PipelineSchemaDto => ({
      flowId: FLOW_ID,
      name: 'Pipeline de ingesta',
      version: '1.0.0',
      entrypoint: 'trigger',
      nodes: {
        trigger: {
          nodeId: 'trigger',
          nodeType: NodeType.TRIGGER_IMAP,
          outputNamespace: 'raw_email',
          nextStep: 'parser',
          onErrorStep: null,
          params: {},
        },
        parser: {
          nodeId: 'parser',
          nodeType: NodeType.PARSER_PRE_IA,
          outputNamespace: 'parsed_email',
          nextStep: 'ocr',
          onErrorStep: null,
          params: {},
        },
        ocr: {
          nodeId: 'ocr',
          nodeType: NodeType.PROCESADOR_OCR,
          outputNamespace: 'ocr_result',
          nextStep: 'ia',
          onErrorStep: null,
          params: {},
        },
        ia: {
          nodeId: 'ia',
          nodeType: NodeType.PROCESADOR_IA,
          outputNamespace: 'llm_response',
          nextStep: 'plantilla',
          onErrorStep: 'alerta',
          params: {},
        },
        plantilla: {
          nodeId: 'plantilla',
          nodeType: NodeType.MAPEADOR_PLANTILLA,
          outputNamespace: 'rendered_html',
          nextStep: null,
          onErrorStep: null,
          params: {},
        },
        alerta: {
          nodeId: 'alerta',
          nodeType: NodeType.DESTINO_SMTP,
          outputNamespace: 'smtp_result',
          nextStep: null,
          onErrorStep: null,
          params: {},
        },
      },
    });

    /** Ejecucion detenida en `ia` con TODO el pipeline ya publicado. */
    const buildFullContextExecution = (
      overrides: Partial<FsmExecution> = {},
    ): FsmExecution =>
      buildExecution({
        currentState: ExecutionState.PAUSADO,
        activeCursor: 'ia',
        contextPayload: {
          raw_email: { asunto: 'Nota de prensa' },
          parsed_email: { clean_title: 'Innovacion en Madrid' },
          ocr_result: { extracted_text: 'Texto del PDF escaneado' },
          llm_response: { title: 'Titulo de la corrida anterior' },
          rendered_html: { html: '<p>viejo</p>' },
          smtp_result: { sent: true },
          error_context: { failed_node_id: 'ia' },
        },
        ...overrides,
      });

    it('41.1 deberia purgar la salida del nodo y la de sus sucesores, reteniendo parsed_email y ocr_result', async () => {
      // 1. Arrange 📐: es el caso del encargo. Reanudar en `ia` tiene que
      //    rehacer la inferencia y el renderizado, pero no volver a pagar el
      //    MIME ni la pasada multimodal, cuyo insumo —el correo— no cambia.
      const execution = buildFullContextExecution();
      const { repo } = buildRepository(execution);

      // 2. Act ⚙️
      const prepared = await buildEngine(repo).prepareResume(
        EXECUTION_ID,
        undefined,
        true,
        'ia',
        buildIngestSchema(),
      );

      // 3. Assert 🎯
      expect(prepared.contextPayload).toEqual({
        raw_email: { asunto: 'Nota de prensa' },
        parsed_email: { clean_title: 'Innovacion en Madrid' },
        ocr_result: { extracted_text: 'Texto del PDF escaneado' },
      });
      // La salida del propio nodo se va: describe la corrida que se repite.
      expect(prepared.contextPayload.llm_response).toBeUndefined();
      expect(prepared.contextPayload.rendered_html).toBeUndefined();
    });

    it('41.2 deberia purgar tambien la rama declarada en onErrorStep', async () => {
      // 1. Arrange 📐: `smtp_result` solo es alcanzable por la contingencia de
      //    `ia`. Conservarlo dejaria en pie la salida del fallo que se intenta
      //    superar, y `buildOrderedTopology` ni siquiera lo veria.
      const execution = buildFullContextExecution();
      const { repo } = buildRepository(execution);

      // 2. Act ⚙️
      const prepared = await buildEngine(repo).prepareResume(
        EXECUTION_ID,
        undefined,
        true,
        'ia',
        buildIngestSchema(),
      );

      // 3. Assert 🎯
      expect(prepared.contextPayload.smtp_result).toBeUndefined();
    });

    it('41.3 deberia vaciar el contexto entero al reanudar desde el entrypoint', async () => {
      // 1. Arrange 📐: no hay ningun paso anterior cuyo resultado merezca
      //    sobrevivir, y el disparador volvera a sembrar el suyo.
      const execution = buildFullContextExecution();
      const { repo } = buildRepository(execution);

      // 2. Act ⚙️
      const prepared = await buildEngine(repo).prepareResume(
        EXECUTION_ID,
        undefined,
        true,
        'trigger',
        buildIngestSchema(),
      );

      // 3. Assert 🎯: ni siquiera la extraccion cara se salva, porque el correo
      //    que la origino se va a volver a leer.
      expect(prepared.contextPayload).toEqual({});
    });

    it('41.4 deberia conservar la extraccion cara al reanudar DESDE el propio OCR', async () => {
      // 1. Arrange 📐: la excepcion de cacheo pesado. Sin ella, volver al OCR
      //    repetiria la pasada multimodal para obtener lo mismo.
      const execution = buildFullContextExecution({ activeCursor: 'ocr' });
      const { repo } = buildRepository(execution);

      // 2. Act ⚙️
      const prepared = await buildEngine(repo).prepareResume(
        EXECUTION_ID,
        undefined,
        true,
        'ocr',
        buildIngestSchema(),
      );

      // 3. Assert 🎯
      expect(prepared.contextPayload.ocr_result).toEqual({
        extracted_text: 'Texto del PDF escaneado',
      });
      expect(prepared.contextPayload.parsed_email).toEqual({
        clean_title: 'Innovacion en Madrid',
      });
      // Lo de aguas abajo sigue purgandose SIN excepcion.
      expect(prepared.contextPayload.llm_response).toBeUndefined();
      expect(prepared.contextPayload.rendered_html).toBeUndefined();
      expect(prepared.contextPayload.smtp_result).toBeUndefined();
    });

    it('41.5 NO deberia conservar el namespace de un nodo cacheado que quedo vacio', async () => {
      // 1. Arrange 📐: la excepcion mira el contenido y no solo el tipo. Un OCR
      //    que no llego a publicar nada no tiene cache que preservar, y dejar
      //    el objeto vacio confundiria despues a `findMissingNamespaces`.
      const execution = buildFullContextExecution({
        activeCursor: 'ocr',
        contextPayload: {
          raw_email: { asunto: 'Nota de prensa' },
          parsed_email: { clean_title: 'Innovacion en Madrid' },
          ocr_result: {},
        },
      });
      const { repo } = buildRepository(execution);

      // 2. Act ⚙️
      const prepared = await buildEngine(repo).prepareResume(
        EXECUTION_ID,
        undefined,
        true,
        'ocr',
        buildIngestSchema(),
      );

      // 3. Assert 🎯
      expect(prepared.contextPayload.ocr_result).toBeUndefined();
      expect(prepared.contextPayload.parsed_email).toBeDefined();
    });

    it('41.6 deberia dejar que el contextPatch reponga un namespace recien purgado', async () => {
      // 1. Arrange 📐: el orden importa. Si la purga corriera DESPUES de la
      //    fusion, el campo que el operador siembra a mano se perderia y el
      //    reintento repetiria el mismo fallo.
      const execution = buildFullContextExecution();
      const { repo } = buildRepository(execution);

      // 2. Act ⚙️
      const prepared = await buildEngine(repo).prepareResume(
        EXECUTION_ID,
        { llm_response: { title: 'Corregido a mano' } },
        true,
        'ia',
        buildIngestSchema(),
      );

      // 3. Assert 🎯: el parche sobrevive, y lo hace limpio —sin arrastrar el
      //    resto del namespace viejo, que la purga ya se habia llevado.
      expect(prepared.contextPayload.llm_response).toEqual({
        title: 'Corregido a mano',
      });
    });

    it('41.7 deberia conservar el contexto entero cuando no se le pasa el esquema', async () => {
      // 1. Arrange 📐: sin el grafo el motor no sabe que viene despues del
      //    cursor, y adivinarlo por los nombres de los namespaces seria el
      //    acoplamiento que la purga por topologia evita. Es el comportamiento
      //    historico, y los llamantes internos que no tienen el esquema a mano
      //    siguen dependiendo de el.
      const execution = buildFullContextExecution();
      const { repo } = buildRepository(execution);

      // 2. Act ⚙️
      const prepared = await buildEngine(repo).prepareResume(EXECUTION_ID);

      // 3. Assert 🎯: solo se va `error_context`, que ya se purgaba antes.
      expect(prepared.contextPayload.llm_response).toEqual({
        title: 'Titulo de la corrida anterior',
      });
      expect(prepared.contextPayload.rendered_html).toEqual({
        html: '<p>viejo</p>',
      });
      expect(prepared.contextPayload.error_context).toBeUndefined();
    });
  });
});
