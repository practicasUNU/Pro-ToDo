import {
  MAX_EXPORT_ROWS,
  TelemetryQueryService,
} from '@modules/telemetry/telemetry-query.service';

import { LlmProvider } from '@modules/nodes/strategies/interfaces/llm-provider.interface';

import type { Repository } from 'typeorm';
import type { FsmExecution } from '@core/fsm/entities/fsm-execution.entity';
import type { TelemetriaTokensIa } from '@modules/telemetry/entities/telemetria-tokens-ia.entity';

const FLOW_ID = 'f1b2c3d4-0000-4000-8000-000000000003';

/** Eslabones encadenables de un `SelectQueryBuilder`, todos devolviendo la cadena. */
const CHAIN_METHODS = [
  'select',
  'addSelect',
  'where',
  'andWhere',
  'setParameter',
  'groupBy',
  'addGroupBy',
  'orderBy',
  'addOrderBy',
  'leftJoin',
  'take',
  'skip',
  'innerJoin',
  'distinct',
] as const;

type QueryBuilderMock = Record<(typeof CHAIN_METHODS)[number], jest.Mock> & {
  getRawOne: jest.Mock;
  getRawMany: jest.Mock;
  getMany: jest.Mock;
  getManyAndCount: jest.Mock;
};

const buildQueryBuilder = (): QueryBuilderMock => {
  const builder = {
    getRawOne: jest.fn().mockResolvedValue(undefined),
    getRawMany: jest.fn().mockResolvedValue([]),
    getMany: jest.fn().mockResolvedValue([]),
    getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
  } as Partial<QueryBuilderMock>;

  for (const method of CHAIN_METHODS) {
    builder[method] = jest.fn(() => builder);
  }

  return builder as QueryBuilderMock;
};

/** Fila de telemetria como la devuelve TypeORM, con el flujo parcial. */
const buildRow = (index: number): TelemetriaTokensIa =>
  ({
    id: `row-${index}`,
    createdAt: new Date('2026-10-22T08:30:00.000Z'),
    operationOrigin: 'EJECUCION_FLUJO',
    executionId: 'exec-1',
    flowId: FLOW_ID,
    flow: { name: 'Notiweb' },
    nodeId: 'nodo_ia',
    aiProvider: 'GEMINI',
    aiModel: 'gemini-3.6-flash',
    promptTokens: 10,
    completionTokens: 20,
    reasoningTokens: 5,
    totalTokens: 35,
    promptRateUsd: 0.075,
    completionRateUsd: 0.3,
    reasoningRateUsd: 0.3,
    estimatedCostUsd: 0.00001,
    isEstimated: false,
    status: 'FAILED',
    errorMessage: 'timeout',
    userId: 'u-1',
    user: { id: 'u-1', email: 'practicas@unuware.com' },
  }) as unknown as TelemetriaTokensIa;

const buildService = () => {
  const telemetryBuilder = buildQueryBuilder();
  const executionBuilder = buildQueryBuilder();
  const service = new TelemetryQueryService(
    {
      createQueryBuilder: jest.fn(() => telemetryBuilder),
    } as unknown as Repository<TelemetriaTokensIa>,
    {
      createQueryBuilder: jest.fn(() => executionBuilder),
    } as unknown as Repository<FsmExecution>,
  );

  return { service, telemetryBuilder, executionBuilder };
};

describe('TelemetryQueryService', () => {
  describe('getSummary', () => {
    it('deberia convertir los agregados de texto a numero y calcular la tasa', async () => {
      // 1. Arrange 📐: PostgreSQL devuelve SUM/COUNT como texto.
      const { service, telemetryBuilder, executionBuilder } = buildService();
      telemetryBuilder.getRawOne.mockResolvedValue({
        totalTokens: '1600',
        totalCostUsd: '2.300000',
        aiInvocations: '3',
        estimatedInvocations: '1',
      });
      executionBuilder.getRawOne.mockResolvedValue({
        executionsTotal: '4',
        executionsSucceeded: '3',
      });

      // 2. Act ⚙️
      const summary = await service.getSummary({
        from: '2026-10-01',
        to: '2026-10-22',
      });

      // 3. Assert 🎯
      expect(summary).toEqual({
        range: {
          from: '2026-10-01T00:00:00.000Z',
          to: '2026-10-23T00:00:00.000Z',
        },
        totalTokens: 1_600,
        totalCostUsd: 2.3,
        aiInvocations: 3,
        estimatedInvocations: 1,
        executionsTotal: 4,
        executionsSucceeded: 3,
        successRate: 0.75,
      });
    });

    it('deberia devolver tasa null y ceros cuando no hay datos', async () => {
      // 1. Arrange 📐: un rango sin filas no es una tasa del 0 %.
      const { service } = buildService();

      // 2. Act ⚙️
      const summary = await service.getSummary({});

      // 3. Assert 🎯
      expect(summary.totalTokens).toBe(0);
      expect(summary.executionsTotal).toBe(0);
      expect(summary.successRate).toBeNull();
    });

    it('deberia aplicar el filtro de flujo a la telemetria y a las ejecuciones', async () => {
      // 1. Arrange 📐
      const { service, telemetryBuilder, executionBuilder } = buildService();

      // 2. Act ⚙️
      await service.getSummary({ flowId: FLOW_ID });

      // 3. Assert 🎯
      expect(telemetryBuilder.andWhere).toHaveBeenCalledWith(
        't.flujo_id = :flowId',
        { flowId: FLOW_ID },
      );
      expect(executionBuilder.andWhere).toHaveBeenCalledWith(
        'e.id_flujo = :flowId',
        { flowId: FLOW_ID },
      );
    });
  });

  describe('getSummary · tasa de exito de flujos con IA', () => {
    it('should calculate flow success rate filtering exclusively executions associated with IA telemetry', async () => {
      // 1. Arrange 📐: 2 de 5 ejecuciones con IA terminaron bien.
      const { service, executionBuilder } = buildService();
      executionBuilder.getRawOne.mockResolvedValue({
        executionsTotal: '5',
        executionsSucceeded: '2',
      });

      // 2. Act ⚙️
      const summary = await service.getSummary({});

      // 3. Assert 🎯: el EXISTS contra `telemetria_tokens_ia` excluye las
      //    ejecuciones que no invocaron ningun modelo.
      expect(executionBuilder.andWhere).toHaveBeenCalledWith(
        'EXISTS (SELECT 1 FROM telemetria_tokens_ia ti WHERE ti.ejecucion_id = e.id_ejecucion)',
        expect.any(Object),
      );
      expect(summary.executionsTotal).toBe(5);
      expect(summary.executionsSucceeded).toBe(2);
      expect(summary.successRate).toBe(0.4);
    });

    it('deberia aplicar proveedor, modelo y nodo dentro del EXISTS', async () => {
      // 1. Arrange 📐
      const { service, executionBuilder } = buildService();

      // 2. Act ⚙️
      await service.getSummary({
        aiProvider: LlmProvider.GEMINI,
        aiModel: 'gemini-3.6-flash',
        nodeId: 'nodo_ia',
      });

      // 3. Assert 🎯
      expect(executionBuilder.andWhere).toHaveBeenCalledWith(
        'EXISTS (SELECT 1 FROM telemetria_tokens_ia ti WHERE ti.ejecucion_id = e.id_ejecucion AND ti.proveedor_ia = :aiProvider AND ti.modelo_ia = :aiModel AND ti.nodo_id = :nodeId)',
        {
          aiProvider: LlmProvider.GEMINI,
          aiModel: 'gemini-3.6-flash',
          nodeId: 'nodo_ia',
        },
      );
    });
  });

  describe('getBreakdownByModel', () => {
    it('deberia agrupar por proveedor y modelo y devolver numeros', async () => {
      // 1. Arrange 📐
      const { service, telemetryBuilder } = buildService();
      telemetryBuilder.getRawMany.mockResolvedValue([
        {
          aiProvider: 'ANTHROPIC',
          aiModel: 'claude-sonnet-5-5',
          invocations: '2',
          promptTokens: '2000',
          completionTokens: '1000',
          reasoningTokens: '0',
          totalTokens: '3000',
          costUsd: '0.014000',
          succeeded: '2',
          failed: '0',
        },
      ]);

      // 2. Act ⚙️
      const rows = await service.getBreakdownByModel({});

      // 3. Assert 🎯
      expect(telemetryBuilder.groupBy).toHaveBeenCalledWith('t.proveedor_ia');
      expect(telemetryBuilder.addGroupBy).toHaveBeenCalledWith('t.modelo_ia');
      expect(rows).toEqual([
        {
          aiProvider: 'ANTHROPIC',
          aiModel: 'claude-sonnet-5-5',
          invocations: 2,
          promptTokens: 2_000,
          completionTokens: 1_000,
          reasoningTokens: 0,
          totalTokens: 3_000,
          costUsd: 0.014,
          succeeded: 2,
          failed: 0,
          successRate: 1,
        },
      ]);
    });

    it('should calculate success rate percentage grouped by model_ia for SUCCESS and FAILED status', async () => {
      // 1. Arrange 📐: Sonnet con 3 de 4 llamadas buenas, Flash sin ninguna.
      const { service, telemetryBuilder } = buildService();
      telemetryBuilder.getRawMany.mockResolvedValue([
        {
          aiProvider: 'ANTHROPIC',
          aiModel: 'claude-sonnet-5-5',
          invocations: '4',
          succeeded: '3',
          failed: '1',
        },
        {
          aiProvider: 'GEMINI',
          aiModel: 'gemini-3.6-flash',
          invocations: '2',
          succeeded: '0',
          failed: '2',
        },
      ]);

      // 2. Act ⚙️
      const rows = await service.getBreakdownByModel({});

      // 3. Assert 🎯: la tasa sale del `estado` de cada llamada, agrupada por modelo.
      expect(telemetryBuilder.addSelect).toHaveBeenCalledWith(
        'COUNT(*) FILTER (WHERE t.estado = :success)',
        'succeeded',
      );
      expect(telemetryBuilder.addSelect).toHaveBeenCalledWith(
        'COUNT(*) FILTER (WHERE t.estado = :failed)',
        'failed',
      );
      expect(telemetryBuilder.setParameter).toHaveBeenCalledWith(
        'success',
        'SUCCESS',
      );
      expect(telemetryBuilder.setParameter).toHaveBeenCalledWith(
        'failed',
        'FAILED',
      );
      expect(telemetryBuilder.addGroupBy).toHaveBeenCalledWith('t.modelo_ia');
      expect(
        rows.map(({ aiModel, succeeded, failed, successRate }) => ({
          aiModel,
          succeeded,
          failed,
          successRate,
        })),
      ).toEqual([
        {
          aiModel: 'claude-sonnet-5-5',
          succeeded: 3,
          failed: 1,
          successRate: 0.75,
        },
        {
          aiModel: 'gemini-3.6-flash',
          succeeded: 0,
          failed: 2,
          successRate: 0,
        },
      ]);
    });

    it('deberia ordenar el desglose por la columna de la lista blanca', async () => {
      // 1. Arrange 📐
      const { service, telemetryBuilder } = buildService();

      // 2. Act ⚙️
      await service.getBreakdownByModel({
        breakdownSortBy: 'invocations',
        breakdownSortOrder: 'ASC',
      });

      // 3. Assert 🎯
      expect(telemetryBuilder.orderBy).toHaveBeenCalledWith(
        '"invocations"',
        'ASC',
      );
    });

    it('deberia ordenar por coste descendente si no se pide orden', async () => {
      // 1. Arrange 📐
      const { service, telemetryBuilder } = buildService();

      // 2. Act ⚙️
      await service.getBreakdownByModel({});

      // 3. Assert 🎯
      expect(telemetryBuilder.orderBy).toHaveBeenCalledWith(
        '"costUsd"',
        'DESC',
      );
    });

    it('deberia filtrar por modelo y por nodo', async () => {
      // 1. Arrange 📐
      const { service, telemetryBuilder } = buildService();

      // 2. Act ⚙️
      await service.getBreakdownByModel({
        aiModel: 'gemini-3.6-flash',
        nodeId: 'nodo_ia',
      });

      // 3. Assert 🎯
      expect(telemetryBuilder.andWhere).toHaveBeenCalledWith(
        't.modelo_ia = :aiModel',
        { aiModel: 'gemini-3.6-flash' },
      );
      expect(telemetryBuilder.andWhere).toHaveBeenCalledWith(
        't.nodo_id = :nodeId',
        { nodeId: 'nodo_ia' },
      );
    });
  });

  describe('getFilterOptions', () => {
    it('deberia devolver proveedores unicos, modelos, flujos y nodos del rango', async () => {
      // 1. Arrange 📐: las tres consultas comparten el doble; se encadenan.
      const { service, telemetryBuilder } = buildService();
      telemetryBuilder.getRawMany
        .mockResolvedValueOnce([
          { aiProvider: 'ANTHROPIC', aiModel: 'claude-haiku-5-5' },
          { aiProvider: 'ANTHROPIC', aiModel: 'claude-sonnet-5-5' },
          { aiProvider: 'GEMINI', aiModel: 'gemini-3.6-flash' },
        ])
        .mockResolvedValueOnce([{ id: FLOW_ID, name: 'Notiweb' }])
        .mockResolvedValueOnce([{ flowId: FLOW_ID, nodeId: 'nodo_ia' }]);

      // 2. Act ⚙️
      const options = await service.getFilterOptions({});

      // 3. Assert 🎯
      expect(options.providers).toEqual(['ANTHROPIC', 'GEMINI']);
      expect(options.models).toHaveLength(3);
      expect(options.flows).toEqual([{ id: FLOW_ID, name: 'Notiweb' }]);
      expect(options.nodes).toEqual([{ flowId: FLOW_ID, nodeId: 'nodo_ia' }]);
      expect(telemetryBuilder.distinct).toHaveBeenCalledWith(true);
    });
  });

  describe('getHistory', () => {
    it('deberia paginar con los valores por defecto y resolver el nombre del flujo', async () => {
      // 1. Arrange 📐
      const { service, telemetryBuilder } = buildService();
      telemetryBuilder.getManyAndCount.mockResolvedValue([[buildRow(1)], 40]);

      // 2. Act ⚙️
      const page = await service.getHistory({});

      // 3. Assert 🎯
      expect(telemetryBuilder.take).toHaveBeenCalledWith(25);
      expect(telemetryBuilder.skip).toHaveBeenCalledWith(0);
      expect(page.total).toBe(40);
      expect(page.items[0]).toMatchObject({
        id: 'row-1',
        createdAt: '2026-10-22T08:30:00.000Z',
        operationOrigin: 'EJECUCION_FLUJO',
        flowName: 'Notiweb',
        status: 'FAILED',
        errorMessage: 'timeout',
        userId: 'u-1',
        userEmail: 'practicas@unuware.com',
      });
      // Del usuario solo se proyectan id y correo: nunca su `secreto_otp`.
      expect(telemetryBuilder.leftJoin).toHaveBeenCalledWith('t.user', 'u');
      expect(telemetryBuilder.addSelect).toHaveBeenCalledWith([
        'u.id',
        'u.email',
      ]);
      expect(telemetryBuilder.orderBy).toHaveBeenLastCalledWith(
        't.createdAt',
        'DESC',
        'NULLS LAST',
      );
    });

    it('deberia ordenar en el servidor por la columna de la lista blanca', async () => {
      // 1. Arrange 📐: `flow` es el nombre del flujo unido, no un campo de la fila.
      const { service, telemetryBuilder } = buildService();

      // 2. Act ⚙️
      await service.getHistory({ sortBy: 'flow', sortOrder: 'ASC' });

      // 3. Assert 🎯
      expect(telemetryBuilder.orderBy).toHaveBeenLastCalledWith(
        'f.name',
        'ASC',
        'NULLS LAST',
      );
      expect(telemetryBuilder.addOrderBy).toHaveBeenLastCalledWith(
        't.id',
        'ASC',
      );
    });
  });

  describe('getExportRows · orden', () => {
    it('deberia exportar en el mismo orden que el historial en pantalla', async () => {
      // 1. Arrange 📐
      const { service, telemetryBuilder } = buildService();

      // 2. Act ⚙️
      await service.getExportRows({ sortBy: 'totalTokens', sortOrder: 'ASC' });

      // 3. Assert 🎯
      expect(telemetryBuilder.orderBy).toHaveBeenLastCalledWith(
        't.totalTokens',
        'ASC',
        'NULLS LAST',
      );
    });
  });

  describe('getExportRows', () => {
    it('deberia cortar en MAX_EXPORT_ROWS y avisar del corte', async () => {
      // 1. Arrange 📐: la consulta pide una fila de mas para detectar el corte.
      const { service, telemetryBuilder } = buildService();
      telemetryBuilder.getMany.mockResolvedValue(
        Array.from({ length: MAX_EXPORT_ROWS + 1 }, (_, index) =>
          buildRow(index),
        ),
      );

      // 2. Act ⚙️
      const result = await service.getExportRows({});

      // 3. Assert 🎯
      expect(telemetryBuilder.take).toHaveBeenCalledWith(MAX_EXPORT_ROWS + 1);
      expect(result.items).toHaveLength(MAX_EXPORT_ROWS);
      expect(result.truncated).toBe(true);
    });

    it('no deberia marcar corte cuando caben todas las filas', async () => {
      // 1. Arrange 📐
      const { service, telemetryBuilder } = buildService();
      telemetryBuilder.getMany.mockResolvedValue([buildRow(1)]);

      // 2. Act ⚙️
      const result = await service.getExportRows({});

      // 3. Assert 🎯
      expect(result.truncated).toBe(false);
      expect(result.items).toHaveLength(1);
    });
  });
});
