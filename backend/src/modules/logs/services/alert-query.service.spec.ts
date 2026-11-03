import { AlertQueryService } from '@modules/logs/services/alert-query.service';

import type { Repository } from 'typeorm';
import type { AlertaError } from '@modules/logs/entities/alerta-error.entity';
import type { LogNodo } from '@modules/logs/entities/log-nodo.entity';

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
});
