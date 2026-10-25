import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';

import {
  CREDENTIALS_ENCRYPTION_KEY_VAR,
  EncryptionService,
} from '@core/security/encryption.service';

import { CredentialsService } from './credentials.service';
import {
  ApiKeyPlacement,
  CredentialAuthType,
} from './enums/credential-auth-type.enum';

import type { ConfigService } from '@nestjs/config';
import type { DataSource, Repository } from 'typeorm';
import type { CrudEventsCoordinator } from '@common/services/crud-events.coordinator';
import type { Credential } from './entities/credential.entity';

const CREDENTIAL_ID = '0b9a2c47-5d1e-4f3a-8c6b-2e7d9f1a4b30';

/**
 * Repositorio en memoria: guarda las filas COMPLETAS (con cifrado) y simula el
 * `select: false` devolviendo sin columnas criptograficas en `findOne`.
 */
const buildHarness = (options: { key?: string; inUse?: boolean } = {}) => {
  const rows = new Map<string, Credential>();
  const stripCrypto = (row: Credential): Credential =>
    ({
      ...row,
      encryptedData: undefined,
      iv: undefined,
      authTag: undefined,
    }) as unknown as Credential;

  const repository = {
    find: jest.fn(() => Promise.resolve([...rows.values()].map(stripCrypto))),
    findOne: jest.fn(({ where }: { where: { id: string } }) => {
      const row = rows.get(where.id);
      return Promise.resolve(row === undefined ? null : stripCrypto(row));
    }),
    exists: jest.fn(({ where }: { where: { name: string } }) =>
      Promise.resolve(
        [...rows.values()].some((row) => row.name === where.name),
      ),
    ),
    insert: jest.fn((row: Credential) => {
      rows.set(row.id, {
        ...row,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return Promise.resolve();
    }),
    update: jest.fn(({ id }: { id: string }, patch: Partial<Credential>) => {
      const row = rows.get(id);
      if (row !== undefined) rows.set(id, { ...row, ...patch });
      return Promise.resolve();
    }),
    delete: jest.fn(({ id }: { id: string }) => {
      rows.delete(id);
      return Promise.resolve();
    }),
    createQueryBuilder: jest.fn(() => {
      let id = '';
      const builder = {
        addSelect: () => builder,
        where: (_: string, params: { id: string }) => {
          id = params.id;
          return builder;
        },
        getOne: () => Promise.resolve(rows.get(id) ?? null),
      };
      return builder;
    }),
  };
  const key = options.key ?? randomBytes(32).toString('base64');
  const encryption = new EncryptionService({
    get: (name: string) =>
      name === CREDENTIALS_ENCRYPTION_KEY_VAR ? key : undefined,
  } as unknown as ConfigService);
  jest.spyOn(encryption['logger'], 'warn').mockImplementation(() => undefined);
  const dataSource = {
    query: jest
      .fn()
      .mockResolvedValue(options.inUse === true ? [{ '?column?': 1 }] : []),
  };
  const crudEvents = { dispatch: jest.fn() };

  const service = new CredentialsService(
    repository as unknown as Repository<Credential>,
    encryption,
    dataSource as unknown as DataSource,
    crudEvents as unknown as CrudEventsCoordinator,
  );
  jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);

  return { service, rows, repository, dataSource, crudEvents };
};

describe('CredentialsService (boveda AES-256-GCM)', () => {
  describe('1. Alta y lectura del secreto', () => {
    it('1.1 deberia guardar SOLO el cifrado y descifrarlo para la FSM', async () => {
      // 1. Arrange 📐
      const { service, rows } = buildHarness();

      // 2. Act ⚙️
      const created = await service.create({
        name: 'API de becas',
        authType: CredentialAuthType.BEARER_TOKEN,
        token: 'tok_secreto',
      });
      const resolution = await service.resolveSecret(created.id);

      // 3. Assert 🎯
      const stored = rows.get(created.id);
      expect(JSON.stringify(stored)).not.toContain('tok_secreto');
      expect(created).not.toHaveProperty('token');
      expect(resolution).toEqual({
        secret: {
          authType: CredentialAuthType.BEARER_TOKEN,
          token: 'tok_secreto',
        },
      });
    });

    it('1.2 deberia descartar los campos que no son del tipo', async () => {
      // 1. Arrange 📐: un `password` junto a un BEARER no se cifra en silencio.
      const { service } = buildHarness();

      // 2. Act ⚙️
      const created = await service.create({
        name: 'API',
        authType: CredentialAuthType.BEARER_TOKEN,
        token: 't',
        password: 'colado',
      });
      const resolution = await service.resolveSecret(created.id);

      // 3. Assert 🎯
      expect(resolution).toEqual({
        secret: { authType: CredentialAuthType.BEARER_TOKEN, token: 't' },
      });
    });

    it('1.3 deberia responder 503 si falta la clave maestra', async () => {
      // 1. Arrange 📐
      const { service } = buildHarness({ key: '' });

      // 2. Act ⚙️ + 3. Assert 🎯
      await expect(
        service.create({
          name: 'API',
          authType: CredentialAuthType.BEARER_TOKEN,
          token: 't',
        }),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it('1.4 deberia rechazar un nombre repetido', async () => {
      // 1. Arrange 📐
      const { service } = buildHarness();
      await service.create({
        name: 'API',
        authType: CredentialAuthType.BEARER_TOKEN,
        token: 't',
      });

      // 2. Act ⚙️ + 3. Assert 🎯
      await expect(
        service.create({
          name: 'API',
          authType: CredentialAuthType.BEARER_TOKEN,
          token: 'u',
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('2. Edicion (secreto de solo escritura)', () => {
    it('2.1 deberia conservar el cifrado si solo cambia el nombre', async () => {
      // 1. Arrange 📐
      const { service, rows } = buildHarness();
      const created = await service.create({
        name: 'API',
        authType: CredentialAuthType.BEARER_TOKEN,
        token: 't',
      });
      const before = rows.get(created.id)?.encryptedData;

      // 2. Act ⚙️
      await service.update(created.id, { name: 'API renombrada' });

      // 3. Assert 🎯
      expect(rows.get(created.id)?.encryptedData).toBe(before);
      expect(rows.get(created.id)?.name).toBe('API renombrada');
    });

    it('2.2 deberia exigir el juego completo al rotar un BASIC_AUTH', async () => {
      // 1. Arrange 📐: mezclar el usuario nuevo con la contrasena vieja
      //    exigiria descifrar fuera del motor.
      const { service } = buildHarness();
      const created = await service.create({
        name: 'Portal',
        authType: CredentialAuthType.BASIC_AUTH,
        username: 'svc',
        password: 'p1',
      });

      // 2. Act ⚙️ + 3. Assert 🎯
      await expect(
        service.update(created.id, { password: 'p2' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('2.3 deberia re-cifrar al rotar el secreto completo', async () => {
      // 1. Arrange 📐
      const { service } = buildHarness();
      const created = await service.create({
        name: 'Clave',
        authType: CredentialAuthType.API_KEY,
        keyName: 'X-Api-Key',
        apiKey: 'k1',
        placement: ApiKeyPlacement.HEADER,
      });

      // 2. Act ⚙️
      await service.update(created.id, {
        keyName: 'api_key',
        apiKey: 'k2',
        placement: ApiKeyPlacement.QUERY,
      });

      // 3. Assert 🎯
      await expect(service.resolveSecret(created.id)).resolves.toEqual({
        secret: {
          authType: CredentialAuthType.API_KEY,
          keyName: 'api_key',
          apiKey: 'k2',
          placement: ApiKeyPlacement.QUERY,
        },
      });
    });

    it('2.4 no deberia cambiar el tipo de una credencial en uso', async () => {
      // 1. Arrange 📐
      const { service } = buildHarness({ inUse: true });
      const created = await service.create({
        name: 'API',
        authType: CredentialAuthType.BEARER_TOKEN,
        token: 't',
      });

      // 2. Act ⚙️ + 3. Assert 🎯
      await expect(
        service.update(created.id, {
          authType: CredentialAuthType.BASIC_AUTH,
          username: 'u',
          password: 'p',
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('3. Borrado y resolucion fallida', () => {
    it('3.1 deberia bloquear el borrado de una credencial citada por un flujo', async () => {
      // 1. Arrange 📐
      const { service, repository, dataSource } = buildHarness({ inUse: true });
      const created = await service.create({
        name: 'API',
        authType: CredentialAuthType.BEARER_TOKEN,
        token: 't',
      });

      // 2. Act ⚙️ + 3. Assert 🎯
      await expect(service.remove(created.id)).rejects.toThrow(
        ConflictException,
      );
      expect(repository.delete).not.toHaveBeenCalled();
      // El id viaja como PARAMETRO, nunca interpolado en el SQL.
      expect(dataSource.query).toHaveBeenCalledWith(expect.any(String), [
        created.id,
      ]);
    });

    it('3.2 deberia borrar y difundir DELETED si nadie la usa', async () => {
      // 1. Arrange 📐
      const { service, rows, crudEvents } = buildHarness();
      const created = await service.create({
        name: 'API',
        authType: CredentialAuthType.BEARER_TOKEN,
        token: 't',
      });

      // 2. Act ⚙️
      await service.remove(created.id);

      // 3. Assert 🎯
      expect(rows.has(created.id)).toBe(false);
      expect(crudEvents.dispatch).toHaveBeenLastCalledWith(
        expect.objectContaining({ entity: 'credentials', action: 'DELETED' }),
      );
    });

    it('3.3 deberia devolver NOT_FOUND, VAULT_UNAVAILABLE o UNREADABLE sin lanzar', async () => {
      // 1. Arrange 📐
      const { service, rows } = buildHarness();
      const created = await service.create({
        name: 'API',
        authType: CredentialAuthType.BEARER_TOKEN,
        token: 't',
      });
      const row = rows.get(created.id);
      if (row !== undefined)
        rows.set(created.id, {
          ...row,
          authTag: Buffer.alloc(16).toString('base64'),
        });

      // 2. Act ⚙️
      const missing = await service.resolveSecret(CREDENTIAL_ID);
      const tampered = await service.resolveSecret(created.id);
      const noKey = await buildHarness({ key: '' }).service.resolveSecret(
        created.id,
      );

      // 3. Assert 🎯
      expect(missing).toEqual({ reason: 'NOT_FOUND' });
      expect(tampered).toEqual({ reason: 'UNREADABLE' });
      expect(noKey).toEqual({ reason: 'VAULT_UNAVAILABLE' });
    });
  });
});
