import { LogNodo, NodeLogStatus } from '@modules/logs/entities/log-nodo.entity';
import { AlertQueryService } from '@modules/logs/services/alert-query.service';

import type { Repository } from 'typeorm';
import type { AlertaError } from '@modules/logs/entities/alerta-error.entity';

const buildService = (rows: Array<{ executionId: string }> = []) => {
  const builder = {
    select: jest.fn(),
    where: jest.fn(),
    getRawMany: jest.fn().mockResolvedValue(rows),
  };
  builder.select.mockReturnValue(builder);
  builder.where.mockReturnValue(builder);

  const repository = { createQueryBuilder: jest.fn(() => builder) };
  const nodeLogRepository = { findOne: jest.fn().mockResolvedValue(null) };
  const service = new AlertQueryService(
    repository as unknown as Repository<AlertaError>,
    nodeLogRepository as unknown as Repository<LogNodo>,
  );

  return { service, repository, builder, nodeLogRepository };
};

describe('AlertQueryService', () => {
  it('deberia devolver el conjunto de ejecuciones con alertas en una consulta', async () => {
    // 1. Arrange 📐
    const { service, repository } = buildService([{ executionId: 'e1' }]);

    // 2. Act ⚙️
    const result = await service.findExecutionIdsWithAlerts(['e1', 'e2']);

    // 3. Assert 🎯
    expect(result).toEqual(new Set(['e1']));
    expect(repository.createQueryBuilder).toHaveBeenCalledTimes(1);
  });

  it('no deberia consultar con una lista vacia', async () => {
    // 1. Arrange 📐: `IN ()` es SQL invalido en PostgreSQL.
    const { service, repository } = buildService();

    // 2. Act ⚙️
    const result = await service.findExecutionIdsWithAlerts([]);

    // 3. Assert 🎯
    expect(result.size).toBe(0);
    expect(repository.createQueryBuilder).not.toHaveBeenCalled();
  });

  describe('findLastNodeErrorCode', () => {
    it('deberia devolver el codigo si el ultimo desenlace del nodo fue un ERROR', async () => {
      // 1. Arrange 📐
      const { service, nodeLogRepository } = buildService();
      nodeLogRepository.findOne.mockResolvedValue({
        status: NodeLogStatus.ERROR,
        errorCode: 'ERR_POST_IA_DOM_MUTATED',
      });

      // 2. Act ⚙️
      const code = await service.findLastNodeErrorCode('e1', 'escudo');

      // 3. Assert 🎯: un solo desenlace, el mas reciente, sin las marcas
      //    ADVERTENCIA que deja cada reanudacion.
      expect(code).toBe('ERR_POST_IA_DOM_MUTATED');
      expect(nodeLogRepository.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            executionId: 'e1',
            nodeId: 'escudo',
          }) as unknown,
          order: { createdAt: 'DESC' },
        }),
      );
    });

    it('deberia devolver null si el ultimo desenlace fue OK', async () => {
      // 1. Arrange 📐: el escudo fallo antes, pero despues paso.
      const { service, nodeLogRepository } = buildService();
      nodeLogRepository.findOne.mockResolvedValue({
        status: NodeLogStatus.OK,
        errorCode: null,
      });

      // 2. Act ⚙️ + 3. Assert 🎯
      await expect(
        service.findLastNodeErrorCode('e1', 'escudo'),
      ).resolves.toBeNull();
    });

    it('deberia devolver null si el nodo nunca termino', async () => {
      // 1. Arrange 📐
      const { service } = buildService();

      // 2. Act ⚙️ + 3. Assert 🎯
      await expect(
        service.findLastNodeErrorCode('e1', 'escudo'),
      ).resolves.toBeNull();
    });
  });
});
