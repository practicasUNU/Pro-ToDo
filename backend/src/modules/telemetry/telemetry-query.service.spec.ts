import {
  MAX_EXPORT_ROWS,
  TelemetryQueryService,
} from '@modules/telemetry/telemetry-query.service';

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
        },
      ]);
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
      });
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
