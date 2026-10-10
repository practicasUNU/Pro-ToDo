import { In } from 'typeorm';

import { ExecutionState } from '@core/fsm/types/fsm.enums';

import { FsmExecutionQueryService } from './fsm-execution-query.service';

import type { FsmExecution } from '@core/fsm/entities/fsm-execution.entity';
import type { Repository } from 'typeorm';

const FLOW_ID = 'b6c1f0d2-3e4a-4b5c-8d6e-7f8091a2b3c4';
const EXECUTION_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

const buildExecution = (
  overrides: Partial<FsmExecution> = {},
): FsmExecution => ({
  executionId: EXECUTION_ID,
  flowId: FLOW_ID,
  currentState: ExecutionState.PAUSADO,
  activeCursor: 'nodo_b',
  contextPayload: { salida_a: { valorA: 1 } },
  retryState: {},
  logFilePath: 'logs/execution-2026-10-10.log',
  failureReason: null,
  createdAt: new Date('2026-10-10T08:00:00.000Z'),
  updatedAt: new Date('2026-10-10T08:05:00.000Z'),
  ...overrides,
});

interface RepositoryDouble {
  repo: Repository<FsmExecution>;
  findAndCount: jest.Mock;
  findOne: jest.Mock;
  find: jest.Mock;
}

const buildRepository = (): RepositoryDouble => {
  const findAndCount = jest.fn().mockResolvedValue([[buildExecution()], 1]);
  const findOne = jest.fn().mockResolvedValue(buildExecution());
  const find = jest.fn().mockResolvedValue([buildExecution()]);

  return {
    repo: {
      findAndCount,
      findOne,
      find,
    } as unknown as Repository<FsmExecution>,
    findAndCount,
    findOne,
    find,
  };
};

describe('FsmExecutionQueryService (lectura de ejecuciones_flujo)', () => {
  describe('1. Listado paginado', () => {
    it('1.1 NO deberia pedir el contexto acumulado', async () => {
      // 1. Arrange: `contexto_acumulado` lleva el correo entero en base64 en
      //    un flujo con adjuntos. Serializarlo cincuenta veces para una tabla
      //    que solo muestra estado y cursor es como se tumba la respuesta.
      const { repo, findAndCount } = buildRepository();

      // 2. Act
      await new FsmExecutionQueryService(repo).findPage({
        limit: 25,
        offset: 0,
      });

      // 3. Assert
      const [options] = findAndCount.mock.calls[0] as [
        { select: Record<string, boolean> },
      ];
      expect(options.select).not.toHaveProperty('contextPayload');
      expect(options.select.executionId).toBe(true);
      expect(options.select.logFilePath).toBe(true);
    });

    it('1.2 deberia aplicar la ventana y devolver el total del filtro', async () => {
      // 1. Arrange: el total es el de TODAS las filas que cumplen el filtro, no
      //    el de la pagina; es lo que el paginador necesita para saber si quedan.
      const { repo, findAndCount } = buildRepository();
      findAndCount.mockResolvedValue([[buildExecution()], 137]);

      // 2. Act
      const page = await new FsmExecutionQueryService(repo).findPage({
        limit: 10,
        offset: 40,
      });

      // 3. Assert
      expect(page.total).toBe(137);
      expect(page.items).toHaveLength(1);
      expect(findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ take: 10, skip: 40 }),
      );
    });

    it('1.3 NO deberia filtrar por claves que el cliente no envio', async () => {
      // 1. Arrange: un `where: { flowId: undefined }` en TypeORM no es "sin
      //    filtro", es una comparacion contra NULL que no devuelve nada.
      const { repo, findAndCount } = buildRepository();

      // 2. Act
      await new FsmExecutionQueryService(repo).findPage({
        limit: 25,
        offset: 0,
      });

      // 3. Assert
      const [options] = findAndCount.mock.calls[0] as [
        { where: Record<string, unknown> },
      ];
      expect(options.where).toEqual({});
    });

    it('1.4 deberia trasladar los filtros declarados', async () => {
      // 1. Arrange
      const { repo, findAndCount } = buildRepository();

      // 2. Act
      await new FsmExecutionQueryService(repo).findPage({
        flowId: FLOW_ID,
        state: ExecutionState.PAUSADO,
        limit: 25,
        offset: 0,
      });

      // 3. Assert
      expect(findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { flowId: FLOW_ID, currentState: ExecutionState.PAUSADO },
        }),
      );
    });

    it('1.5 deberia ordenar de la mas reciente a la mas antigua por fecha de INICIO', async () => {
      // 1. Arrange: por `fecha_inicio` y no por la de actualizacion, que
      //    reordenaria la lista cada vez que un checkpoint toca una fila vieja.
      const { repo, findAndCount } = buildRepository();

      // 2. Act
      await new FsmExecutionQueryService(repo).findPage({
        limit: 25,
        offset: 0,
      });

      // 3. Assert
      expect(findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ order: { createdAt: 'DESC' } }),
      );
    });
  });

  describe('2. Detalle', () => {
    it('2.1 deberia devolver la entidad completa, con el contexto', async () => {
      // 1. Arrange: aqui el contexto SI es el dato que se ha pedido, y va una
      //    fila por peticion en vez de cincuenta.
      const { repo, findOne } = buildRepository();

      // 2. Act
      const execution = await new FsmExecutionQueryService(repo).findById(
        EXECUTION_ID,
      );

      // 3. Assert
      expect(execution?.contextPayload).toEqual({ salida_a: { valorA: 1 } });
      expect(findOne).toHaveBeenCalledWith({
        where: { executionId: EXECUTION_ID },
      });
    });

    it('2.2 deberia devolver null si no existe, sin lanzar', async () => {
      // 1. Arrange: traducir la ausencia a un 404 es decision del llamante;
      //    esta capa solo lee.
      const { repo, findOne } = buildRepository();
      findOne.mockResolvedValue(null);

      // 2. Act + 3. Assert
      await expect(
        new FsmExecutionQueryService(repo).findById(EXECUTION_ID),
      ).resolves.toBeNull();
    });
  });

  describe('3. Ejecuciones vivas de un flujo', () => {
    it('3.1 deberia contemplar EN_PROCESO y PAUSADO', async () => {
      // 1. Arrange: las dos impiden que el flujo arranque otra. La primera
      //    tiene un bucle atendiendola; la segunda espera un reintento manual.
      const { repo, find } = buildRepository();

      // 2. Act
      await new FsmExecutionQueryService(repo).findLiveByFlow(FLOW_ID);

      // 3. Assert
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
    });
  });
});
