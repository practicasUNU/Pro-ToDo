import { ConflictException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';

import { PricingEventsCoordinator } from '@common/services/pricing-events.coordinator';
import { AuditTable } from '@modules/audit/audit-tables';
import { AuditActionType } from '@modules/audit/enums/audit-action.enum';
import { LlmProvider } from '@modules/nodes/strategies/interfaces/llm-provider.interface';
import { PricingService } from '@modules/pricing/pricing.service';

import type { CreatePricingDto } from '@modules/pricing/dto/create-pricing.dto';
import type { AuditLoggerService } from '@modules/audit/services/audit-logger.service';
import type { PrecioModeloIa } from '@modules/telemetry/entities/precio-modelo-ia.entity';
import type { DataSource, Repository } from 'typeorm';

const ACTOR_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const CURRENT_ID = '0b7d3f5e-1111-4222-8333-944455556666';
const NEW_ID = '1c8e4a6f-2222-4333-8444-a55566667777';
const SOURCE_IP = '192.168.1.20';

const DTO: CreatePricingDto = {
  aiProvider: LlmProvider.GEMINI,
  aiModel: 'gemini-1.5-pro',
  promptRateUsdPerMTok: 1.5,
  completionRateUsdPerMTok: 6,
  reasoningRateUsdPerMTok: 6,
};

const buildRow = (overrides: Partial<PrecioModeloIa> = {}): PrecioModeloIa => ({
  id: CURRENT_ID,
  aiProvider: 'GEMINI',
  aiModel: 'gemini-1.5-pro',
  promptRateUsdPerMTok: 1.25,
  completionRateUsdPerMTok: 5,
  reasoningRateUsdPerMTok: 5,
  validFrom: new Date('2026-10-01T00:00:00.000Z'),
  active: true,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  updatedAt: new Date('2026-10-01T00:00:00.000Z'),
  createdBy: null,
  updatedBy: null,
  createdByUserId: null,
  updatedByUserId: null,
  ...overrides,
});

/** Eslabones encadenables del `SelectQueryBuilder` del listado. */
const CHAIN_METHODS = [
  'leftJoinAndSelect',
  'andWhere',
  'orderBy',
  'addOrderBy',
  'take',
  'skip',
] as const;

type QueryBuilderMock = Record<(typeof CHAIN_METHODS)[number], jest.Mock> & {
  getManyAndCount: jest.Mock;
};

/**
 * Banco de pruebas con una transaccion SIMULADA que registra el orden de cada
 * paso (`steps`) y que, si el callback lanza, propaga el error sin "confirmar"
 * nada —igual que el `ROLLBACK` real de TypeORM—.
 */
const buildHarness = (current: PrecioModeloIa | null = buildRow()) => {
  const steps: string[] = [];
  const committed: { value: boolean } = { value: false };

  const txRepository = {
    findOne: jest.fn(() => {
      steps.push('lock');
      return Promise.resolve(current);
    }),
    update: jest.fn(() => {
      steps.push('deactivate');
      return Promise.resolve();
    }),
    create: jest.fn((data: Partial<PrecioModeloIa>) => ({ ...data })),
    save: jest.fn((entity: Partial<PrecioModeloIa>) => {
      steps.push('insert');
      return Promise.resolve({ ...entity, id: NEW_ID });
    }),
  };

  const dataSource = {
    transaction: jest.fn(
      async (run: (manager: unknown) => Promise<unknown>) => {
        steps.push('begin');
        const result = await run({ getRepository: () => txRepository });
        steps.push('commit');
        committed.value = true;
        return result;
      },
    ),
  };

  const builder = {
    getManyAndCount: jest.fn().mockResolvedValue([[buildRow()], 1]),
  } as Partial<QueryBuilderMock>;

  for (const method of CHAIN_METHODS) {
    builder[method] = jest.fn(() => builder);
  }

  const repository = {
    createQueryBuilder: jest.fn(() => builder),
    findOneOrFail: jest.fn(() =>
      Promise.resolve(
        buildRow({
          id: NEW_ID,
          promptRateUsdPerMTok: 1.5,
          validFrom: new Date(),
        }),
      ),
    ),
  };

  const auditLogger = { record: jest.fn().mockResolvedValue(undefined) };
  const pricingEvents = new PricingEventsCoordinator();
  const dispatch = jest.spyOn(pricingEvents, 'dispatch');

  const service = new PricingService(
    repository as unknown as Repository<PrecioModeloIa>,
    dataSource as unknown as DataSource,
    auditLogger as unknown as AuditLoggerService,
    pricingEvents,
  );

  return {
    service,
    steps,
    committed,
    txRepository,
    dataSource,
    repository,
    builder: builder as QueryBuilderMock,
    auditLogger,
    dispatch,
  };
};

describe('PricingService', () => {
  describe('1. Relevo atomico de tarifas', () => {
    it('1.1 deberia bloquear, pasar a historico e insertar DENTRO de una transaccion', async () => {
      // 1. Arrange 📐
      const { service, steps, txRepository } = buildHarness();

      // 2. Act ⚙️
      await service.create(DTO, ACTOR_ID, SOURCE_IP);

      // 3. Assert 🎯: el orden es el contrato; al reves habria un instante con
      //    dos tarifas activas para el mismo par.
      expect(steps).toEqual([
        'begin',
        'lock',
        'deactivate',
        'insert',
        'commit',
      ]);
      expect(txRepository.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            aiProvider: 'GEMINI',
            aiModel: 'gemini-1.5-pro',
            active: true,
          },
          lock: { mode: 'pessimistic_write' },
        }),
      );
      expect(txRepository.update).toHaveBeenCalledWith(
        { id: CURRENT_ID },
        { active: false, updatedByUserId: ACTOR_ID },
      );
      expect(txRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          active: true,
          createdByUserId: ACTOR_ID,
          promptRateUsdPerMTok: 1.5,
        }),
      );
    });

    it('1.2 deberia fijar la vigencia en el servidor, nunca en el futuro', async () => {
      // 1. Arrange 📐
      const { service, txRepository } = buildHarness();
      const before = Date.now();

      // 2. Act ⚙️
      await service.create(DTO, ACTOR_ID, SOURCE_IP);

      // 3. Assert 🎯
      const [saved] = txRepository.save.mock.calls[0] as [PrecioModeloIa];
      expect(saved.validFrom.getTime()).toBeGreaterThanOrEqual(before);
      expect(saved.validFrom.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('1.3 deberia auditar el paso a historico como DESACTIVAR y avisar tras el COMMIT', async () => {
      // 1. Arrange 📐
      const { service, auditLogger, dispatch, committed } = buildHarness();
      dispatch.mockImplementation(() => {
        // 3. Assert 🎯 (en linea): el aviso jamas sale antes de confirmar.
        expect(committed.value).toBe(true);
      });

      // 2. Act ⚙️
      const response = await service.create(DTO, ACTOR_ID, SOURCE_IP);

      // 3. Assert 🎯
      expect(auditLogger.record).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: ACTOR_ID,
          action: AuditActionType.DEACTIVATE,
          affectedTable: AuditTable.PRECIOS_MODELOS_IA,
          recordId: CURRENT_ID,
          sourceIp: SOURCE_IP,
        }),
      );
      const [audited] = auditLogger.record.mock.calls[0] as [
        { previousData: { active: boolean }; newData: { active: boolean } },
      ];
      expect(audited.previousData.active).toBe(true);
      expect(audited.newData.active).toBe(false);
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          id: NEW_ID,
          aiProvider: 'GEMINI',
          aiModel: 'gemini-1.5-pro',
          supersededId: CURRENT_ID,
        }),
      );
      expect(response).toMatchObject({ id: NEW_ID, active: true });
    });

    it('1.4 deberia dar de alta un par sin tarifa previa sin desactivar nada', async () => {
      // 1. Arrange 📐
      const { service, steps, txRepository, auditLogger, dispatch } =
        buildHarness(null);

      // 2. Act ⚙️
      await service.create(DTO, ACTOR_ID, SOURCE_IP);

      // 3. Assert 🎯
      expect(steps).toEqual(['begin', 'lock', 'insert', 'commit']);
      expect(txRepository.update).not.toHaveBeenCalled();
      expect(auditLogger.record).not.toHaveBeenCalled();
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ supersededId: null }),
      );
    });
  });

  describe('2. Listado', () => {
    it('2.1 deberia ordenar por vigencia descendente sin criterio', async () => {
      // 1. Arrange 📐
      const { service, builder } = buildHarness();

      // 2. Act ⚙️
      const page = await service.findPage({});

      // 3. Assert 🎯
      expect(builder.orderBy).toHaveBeenCalledWith('p.validFrom', 'DESC');
      expect(builder.addOrderBy).toHaveBeenCalledWith('p.id', 'DESC');
      expect(builder.take).toHaveBeenCalledWith(25);
      expect(page.total).toBe(1);
      expect(page.items[0]).toMatchObject({
        id: CURRENT_ID,
        validFrom: '2026-10-01T00:00:00.000Z',
      });
    });

    it('2.2 deberia traducir `sortBy` por la lista blanca', async () => {
      // 1. Arrange 📐
      const { service, builder } = buildHarness();

      // 2. Act ⚙️
      await service.findPage({ sortBy: 'aiModel', sortOrder: 'ASC' });

      // 3. Assert 🎯
      expect(builder.orderBy).toHaveBeenCalledWith('p.aiModel', 'ASC');
    });

    it('2.3 deberia buscar con parametros enlazados y comodines escapados', async () => {
      // 1. Arrange 📐: `%` sin escapar devolveria la tabla entera.
      const { service, builder } = buildHarness();

      // 2. Act ⚙️
      await service.findPage({ search: '50%_off\\' });

      // 3. Assert 🎯
      expect(builder.andWhere).toHaveBeenCalledWith(
        '(p.proveedor_ia ILIKE :search OR p.modelo_ia ILIKE :search)',
        { search: '%50\\%\\_off\\\\%' },
      );
    });

    it('2.4 deberia filtrar por rango de vigencia y por vigentes', async () => {
      // 1. Arrange 📐
      const { service, builder } = buildHarness();

      // 2. Act ⚙️
      await service.findPage({
        from: '2026-10-01',
        to: '2026-10-22',
        activeOnly: true,
      });

      // 3. Assert 🎯: `to` sin hora incluye el dia completo.
      expect(builder.andWhere).toHaveBeenCalledWith(
        'p.vigente_desde >= CAST(:from AS timestamptz)',
        { from: '2026-10-01T00:00:00.000Z' },
      );
      expect(builder.andWhere).toHaveBeenCalledWith(
        'p.vigente_desde < CAST(:to AS timestamptz)',
        { to: '2026-10-23T00:00:00.000Z' },
      );
      expect(builder.andWhere).toHaveBeenCalledWith('p.activo = true');
    });

    it('2.5 NO deberia filtrar fechas si no llega ningun extremo', async () => {
      // 1. Arrange 📐
      const { service, builder } = buildHarness();

      // 2. Act ⚙️
      await service.findPage({});

      // 3. Assert 🎯
      expect(builder.andWhere).not.toHaveBeenCalled();
    });
  });

  describe('3. Errores', () => {
    it('3.1 deberia rechazar con 409 una tarifa identica a la vigente', async () => {
      // 1. Arrange 📐
      const { service, txRepository } = buildHarness(
        buildRow({
          promptRateUsdPerMTok: DTO.promptRateUsdPerMTok,
          completionRateUsdPerMTok: DTO.completionRateUsdPerMTok,
          reasoningRateUsdPerMTok: DTO.reasoningRateUsdPerMTok,
        }),
      );

      // 2. Act ⚙️ + 3. Assert 🎯
      await expect(
        service.create(DTO, ACTOR_ID, SOURCE_IP),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(txRepository.update).not.toHaveBeenCalled();
      expect(txRepository.save).not.toHaveBeenCalled();
    });

    it('3.2 deberia traducir el choque del indice parcial a un 409', async () => {
      // 1. Arrange 📐: dos ADMIN dan de alta el mismo par sin vigente previa.
      const { service, txRepository } = buildHarness(null);
      txRepository.save.mockRejectedValue(
        new QueryFailedError('INSERT', [], {
          code: '23505',
          constraint: 'uq_precios_modelos_ia_activa',
        } as unknown as Error),
      );

      // 2. Act ⚙️ + 3. Assert 🎯
      await expect(
        service.create(DTO, ACTOR_ID, SOURCE_IP),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });
});
