import { ANY_MODEL } from '@modules/telemetry/entities/precio-modelo-ia.entity';
import { TelemetryService } from '@modules/telemetry/telemetry.service';

import type { Repository } from 'typeorm';
import type { RecordTelemetryDto } from '@modules/telemetry/dto/record-telemetry.dto';
import type { PrecioModeloIa } from '@modules/telemetry/entities/precio-modelo-ia.entity';
import type { TelemetriaTokensIa } from '@modules/telemetry/entities/telemetria-tokens-ia.entity';

const EXECUTION_ID = 'exec-11111111-1111-4111-8111-111111111111';

const buildDto = (
  overrides: Partial<RecordTelemetryDto> = {},
): RecordTelemetryDto => ({
  executionId: EXECUTION_ID,
  nodeId: 'nodo_ia',
  aiProvider: 'GEMINI',
  aiModel: 'gemini-3.6-flash',
  promptTokens: 1_000_000,
  completionTokens: 500_000,
  reasoningTokens: 100_000,
  usageReported: true,
  ...overrides,
});

const buildPrice = (overrides: Partial<PrecioModeloIa> = {}): PrecioModeloIa =>
  ({
    aiProvider: 'GEMINI',
    aiModel: 'gemini-3.6-flash',
    promptRateUsdPerMTok: 0.5,
    completionRateUsdPerMTok: 3,
    reasoningRateUsdPerMTok: 3,
    validFrom: new Date('2026-01-01T00:00:00.000Z'),
    active: true,
    ...overrides,
  }) as PrecioModeloIa;

/** Cadena del `QueryBuilder` de insercion, doblada eslabon a eslabon. */
const buildInsertChain = () => {
  const chain = {
    insert: jest.fn(),
    into: jest.fn(),
    values: jest.fn<unknown, [Record<string, unknown>]>(),
    setParameter: jest.fn(),
    execute: jest.fn().mockResolvedValue({}),
  };
  chain.insert.mockReturnValue(chain);
  chain.into.mockReturnValue(chain);
  chain.values.mockReturnValue(chain);
  chain.setParameter.mockReturnValue(chain);

  return chain;
};

const buildService = (prices: PrecioModeloIa[] = [buildPrice()]) => {
  const chain = buildInsertChain();
  const telemetryRepository = {
    createQueryBuilder: jest.fn().mockReturnValue(chain),
  };
  const pricingRepository = { find: jest.fn().mockResolvedValue(prices) };
  const service = new TelemetryService(
    telemetryRepository as unknown as Repository<TelemetriaTokensIa>,
    pricingRepository as unknown as Repository<PrecioModeloIa>,
  );

  return { service, chain, pricingRepository };
};

describe('TelemetryService', () => {
  describe('computeUsage', () => {
    it('deberia calcular el coste con la tarifa exacta del modelo', async () => {
      // 1. Arrange 📐
      const { service } = buildService();

      // 2. Act ⚙️
      const metrics = await service.computeUsage(buildDto());

      // 3. Assert 🎯: 1M x 0.5 + 0.5M x 3 + 0.1M x 3 = 2.3 USD.
      expect(metrics).toEqual({
        promptTokens: 1_000_000,
        completionTokens: 500_000,
        reasoningTokens: 100_000,
        totalTokens: 1_600_000,
        promptRateUsd: 0.5,
        completionRateUsd: 3,
        reasoningRateUsd: 3,
        estimatedCostUsd: 2.3,
        isEstimated: false,
      });
    });

    it('deberia preferir la tarifa exacta aunque la generica sea mas reciente', async () => {
      // 1. Arrange 📐: `find` ordena por vigencia descendente.
      const { service } = buildService([
        buildPrice({
          aiModel: ANY_MODEL,
          promptRateUsdPerMTok: 99,
          validFrom: new Date('2026-06-01T00:00:00.000Z'),
        }),
        buildPrice(),
      ]);

      // 2. Act ⚙️
      const metrics = await service.computeUsage(buildDto());

      // 3. Assert 🎯
      expect(metrics.promptRateUsd).toBe(0.5);
      expect(metrics.isEstimated).toBe(false);
    });

    it('deberia aplicar la tarifa generica del proveedor y marcarla como estimada', async () => {
      // 1. Arrange 📐
      const { service } = buildService([buildPrice({ aiModel: ANY_MODEL })]);

      // 2. Act ⚙️
      const metrics = await service.computeUsage(
        buildDto({ aiModel: 'gemini-modelo-nuevo' }),
      );

      // 3. Assert 🎯
      expect(metrics.estimatedCostUsd).toBe(2.3);
      expect(metrics.isEstimated).toBe(true);
    });

    it('deberia devolver coste 0 estimado si no hay ninguna tarifa', async () => {
      // 1. Arrange 📐: un modelo sin precio no debe pausar el flujo.
      const { service } = buildService([]);

      // 2. Act ⚙️
      const metrics = await service.computeUsage(buildDto());

      // 3. Assert 🎯
      expect(metrics.estimatedCostUsd).toBe(0);
      expect(metrics.isEstimated).toBe(true);
    });

    it('deberia marcar como estimado el uso que el proveedor no informo', async () => {
      // 1. Arrange 📐
      const { service } = buildService();

      // 2. Act ⚙️
      const metrics = await service.computeUsage(
        buildDto({ usageReported: false }),
      );

      // 3. Assert 🎯
      expect(metrics.isEstimated).toBe(true);
    });

    it('deberia redondear el coste a seis decimales', async () => {
      // 1. Arrange 📐: 7 x 0.5 / 1M = 0.0000035 USD.
      const { service } = buildService();

      // 2. Act ⚙️
      const metrics = await service.computeUsage(
        buildDto({ promptTokens: 7, completionTokens: 0, reasoningTokens: 0 }),
      );

      // 3. Assert 🎯
      expect(metrics.estimatedCostUsd).toBe(0.000004);
    });
  });

  describe('recordTokenUsage', () => {
    it('deberia insertar la fila con la fotografia de tarifas y el flujo resuelto en SQL', async () => {
      // 1. Arrange 📐
      const { service, chain } = buildService();

      // 2. Act ⚙️
      const metrics = await service.recordTokenUsage(buildDto());

      // 3. Assert 🎯
      const values = chain.values.mock.calls[0]?.[0] ?? {};
      expect(values).toMatchObject({
        executionId: EXECUTION_ID,
        nodeId: 'nodo_ia',
        aiProvider: 'GEMINI',
        aiModel: 'gemini-3.6-flash',
        totalTokens: 1_600_000,
        promptRateUsd: 0.5,
        completionRateUsd: 3,
        reasoningRateUsd: 3,
        estimatedCostUsd: 2.3,
        isEstimated: false,
      });
      expect((values.flowId as () => string)()).toContain(
        'FROM ejecuciones_flujo WHERE id_ejecucion = :executionId',
      );
      expect(chain.setParameter).toHaveBeenCalledWith(
        'executionId',
        EXECUTION_ID,
      );
      expect(metrics.estimatedCostUsd).toBe(2.3);
    });

    it('deberia propagar el fallo del INSERT para que el nodo decida', async () => {
      // 1. Arrange 📐
      const { service, chain } = buildService();
      chain.execute.mockRejectedValue(
        new Error('violates not-null constraint'),
      );

      // 2. Act ⚙️ + 3. Assert 🎯
      await expect(service.recordTokenUsage(buildDto())).rejects.toThrow(
        'violates not-null constraint',
      );
    });
  });
});
