import { ConflictException, NotFoundException } from '@nestjs/common';

import { AllowedIpsService } from './allowed-ips.service';

import type { AllowedIp } from './entities/allowed-ip.entity';
import type { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';

const EXISTING_ENTRY: AllowedIp = {
  id: '3f1c2b64-8a5e-4c2f-9d3a-7b6e5f4c1a20',
  ipOrCidr: '192.168.1.0/24',
  description: 'VPN Corporativa Madrid',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

type AllowedIpRepositoryMock = jest.Mocked<
  Pick<Repository<AllowedIp>, 'create' | 'save' | 'find' | 'findOne' | 'remove'>
>;

/** Repositorio doble: `create` refleja el literal, `save` lo resuelve tal cual. */
const buildRepository = (): AllowedIpRepositoryMock =>
  ({
    create: jest.fn((entity: Partial<AllowedIp>) => entity as AllowedIp),
    save: jest.fn((entity: AllowedIp) => Promise.resolve(entity)),
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    remove: jest.fn((entity: AllowedIp) => Promise.resolve(entity)),
  }) as unknown as AllowedIpRepositoryMock;

/** `ConfigService` doble: solo resuelve la variable de fallback. */
const buildConfigService = (allowedRanges: string | undefined): ConfigService =>
  ({
    get: jest.fn((key: string) =>
      key === 'ALLOWED_IP_RANGES' ? allowedRanges : undefined,
    ),
  }) as unknown as ConfigService;

describe('AllowedIpsService', () => {
  describe('CRUD', () => {
    it('deberia listar todas las IPs registradas', async () => {
      // 1. Arrange
      const repository = buildRepository();
      repository.find.mockResolvedValue([EXISTING_ENTRY]);
      const service = new AllowedIpsService(
        repository,
        buildConfigService(undefined),
      );

      // 2. Act
      const result = await service.findAll();

      // 3. Assert
      expect(result).toEqual([EXISTING_ENTRY]);
    });

    it('deberia lanzar NotFoundException si el id no existe', async () => {
      // 1. Arrange
      const repository = buildRepository();
      const service = new AllowedIpsService(
        repository,
        buildConfigService(undefined),
      );

      // 2. Act & 3. Assert
      await expect(service.findById('id-inexistente')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('deberia crear una IP nueva y normalizar espacios', async () => {
      // 1. Arrange
      const repository = buildRepository();
      const service = new AllowedIpsService(
        repository,
        buildConfigService(undefined),
      );

      // 2. Act
      const result = await service.create({
        ipOrCidr: '  10.0.0.0/8  ',
        description: '  Red interna  ',
      });

      // 3. Assert
      expect(result.ipOrCidr).toBe('10.0.0.0/8');
      expect(result.description).toBe('Red interna');
      expect(repository.save).toHaveBeenCalledTimes(1);
    });

    it('deberia lanzar ConflictException al crear una IP duplicada', async () => {
      // 1. Arrange
      const repository = buildRepository();
      repository.findOne.mockResolvedValue(EXISTING_ENTRY);
      const service = new AllowedIpsService(
        repository,
        buildConfigService(undefined),
      );

      // 2. Act & 3. Assert
      await expect(
        service.create({
          ipOrCidr: EXISTING_ENTRY.ipOrCidr,
          description: 'Otra',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('deberia permitir actualizar una IP conservando su propio registro (sin falso duplicado)', async () => {
      // 1. Arrange
      const repository = buildRepository();
      repository.findOne
        .mockResolvedValueOnce(EXISTING_ENTRY) // findById
        .mockResolvedValueOnce(EXISTING_ENTRY); // assertNotDuplicate encuentra el mismo registro
      const service = new AllowedIpsService(
        repository,
        buildConfigService(undefined),
      );

      // 2. Act
      const result = await service.update(EXISTING_ENTRY.id, {
        ipOrCidr: EXISTING_ENTRY.ipOrCidr,
        description: 'Descripcion actualizada',
      });

      // 3. Assert
      expect(result.description).toBe('Descripcion actualizada');
    });

    it('deberia eliminar fisicamente una IP existente', async () => {
      // 1. Arrange
      const repository = buildRepository();
      repository.findOne.mockResolvedValue(EXISTING_ENTRY);
      const service = new AllowedIpsService(
        repository,
        buildConfigService(undefined),
      );

      // 2. Act
      const result = await service.remove(EXISTING_ENTRY.id);

      // 3. Assert
      expect(result).toEqual(EXISTING_ENTRY);
      expect(repository.remove).toHaveBeenCalledWith(EXISTING_ENTRY);
    });
  });

  describe('isIpAllowed', () => {
    it('deberia permitir una IP dentro de un rango almacenado en la tabla', async () => {
      // 1. Arrange
      const repository = buildRepository();
      repository.find.mockResolvedValue([EXISTING_ENTRY]);
      const service = new AllowedIpsService(
        repository,
        buildConfigService(undefined),
      );

      // 2. Act
      const result = await service.isIpAllowed('192.168.1.55');

      // 3. Assert
      expect(result).toBe(true);
    });

    it('deberia rechazar una IP fuera de los rangos almacenados', async () => {
      // 1. Arrange
      const repository = buildRepository();
      repository.find.mockResolvedValue([EXISTING_ENTRY]);
      const service = new AllowedIpsService(
        repository,
        buildConfigService(undefined),
      );

      // 2. Act
      const result = await service.isIpAllowed('203.0.113.10');

      // 3. Assert
      expect(result).toBe(false);
    });

    it('deberia permitir localhost y ALLOWED_IP_RANGES cuando la tabla esta vacia', async () => {
      // 1. Arrange
      const repository = buildRepository();
      repository.find.mockResolvedValue([]);
      const service = new AllowedIpsService(
        repository,
        buildConfigService('10.0.0.0/8'),
      );

      // 2. Act
      const localhostResult = await service.isIpAllowed('127.0.0.1');
      const envRangeResult = await service.isIpAllowed('10.20.30.40');
      const outsideResult = await service.isIpAllowed('203.0.113.10');

      // 3. Assert
      expect(localhostResult).toBe(true);
      expect(envRangeResult).toBe(true);
      expect(outsideResult).toBe(false);
    });

    it('deberia permitir siempre ::1, aunque no haya fallback configurado', async () => {
      // 1. Arrange
      const repository = buildRepository();
      repository.find.mockResolvedValue([]);
      const service = new AllowedIpsService(
        repository,
        buildConfigService(undefined),
      );

      // 2. Act
      const result = await service.isIpAllowed('::1');

      // 3. Assert
      expect(result).toBe(true);
    });

    it('NUNCA deberia bloquear localhost ni ALLOWED_IP_RANGES aunque la tabla tenga registros ajenos (anti-lockout)', async () => {
      // 1. Arrange: la tabla solo tiene una IP de terceros, sin localhost ni la red del .env
      const repository = buildRepository();
      repository.find.mockResolvedValue([EXISTING_ENTRY]);
      const service = new AllowedIpsService(
        repository,
        buildConfigService('10.0.0.0/8'),
      );

      // 2. Act
      const localhostResult = await service.isIpAllowed('127.0.0.1');
      const loopbackV6Result = await service.isIpAllowed('::1');
      const envRangeResult = await service.isIpAllowed('10.20.30.40');
      const tableEntryResult = await service.isIpAllowed('192.168.1.55');
      const outsideResult = await service.isIpAllowed('203.0.113.10');

      // 3. Assert: un alta en la tabla nunca reduce el acceso, solo lo amplia
      expect(localhostResult).toBe(true);
      expect(loopbackV6Result).toBe(true);
      expect(envRangeResult).toBe(true);
      expect(tableEntryResult).toBe(true);
      expect(outsideResult).toBe(false);
    });

    it('deberia cachear los rangos y no repetir la consulta dentro del TTL', async () => {
      // 1. Arrange
      const repository = buildRepository();
      repository.find.mockResolvedValue([EXISTING_ENTRY]);
      const service = new AllowedIpsService(
        repository,
        buildConfigService(undefined),
      );

      // 2. Act
      await service.isIpAllowed('192.168.1.55');
      await service.isIpAllowed('192.168.1.55');

      // 3. Assert
      expect(repository.find).toHaveBeenCalledTimes(1);
    });

    it('deberia invalidar la cache tras una mutacion y volver a consultar la tabla', async () => {
      // 1. Arrange
      const repository = buildRepository();
      repository.find.mockResolvedValue([EXISTING_ENTRY]);
      repository.findOne.mockResolvedValue(null);
      const service = new AllowedIpsService(
        repository,
        buildConfigService(undefined),
      );
      await service.isIpAllowed('192.168.1.55');

      // 2. Act
      await service.create({
        ipOrCidr: '172.16.0.0/12',
        description: 'Nueva red',
      });
      await service.isIpAllowed('192.168.1.55');

      // 3. Assert
      expect(repository.find).toHaveBeenCalledTimes(2);
    });
  });
});
