import { createHash } from 'node:crypto';

import { UnauthorizedException } from '@nestjs/common';

import { RefreshTokenService } from '@modules/auth/services/refresh-token.service';
import { UserRole } from '@modules/users/enums/user-role.enum';

import type { RefreshToken } from '@modules/auth/entities/refresh-token.entity';
import type { User } from '@modules/users/entities/user.entity';
import type { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';

const ACTIVE_USER: User = {
  id: '3f1c2b64-8a5e-4c2f-9d3a-7b6e5f4c1a20',
  email: 'admin@unuware.com',
  role: UserRole.ADMIN,
  isActive: true,
};

const INACTIVE_USER: User = { ...ACTIVE_USER, isActive: false };

const EXPIRATION_DAYS = 7;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/** Repositorio doble: `create` devuelve el literal tal cual y `save` lo refleja. */
type RefreshTokenRepositoryMock = jest.Mocked<
  Pick<
    Repository<RefreshToken>,
    'create' | 'save' | 'findOne' | 'update' | 'delete'
  >
>;

const buildRepository = (): RefreshTokenRepositoryMock =>
  ({
    create: jest.fn((entity: Partial<RefreshToken>) => entity as RefreshToken),
    save: jest.fn((entity: RefreshToken) => Promise.resolve(entity)),
    findOne: jest.fn(),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
  }) as unknown as RefreshTokenRepositoryMock;

const buildConfigService = (): ConfigService =>
  ({
    get: jest.fn((key: string) =>
      key === 'REFRESH_TOKEN_EXPIRES_IN_DAYS' ? EXPIRATION_DAYS : undefined,
    ),
  }) as unknown as ConfigService;

/** Replica del hash del servicio, para verificar lo que se persiste. */
const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

/** Registro almacenado valido, ajustable por caso de prueba. */
const buildStoredToken = (
  overrides: Partial<RefreshToken> = {},
): RefreshToken => ({
  id: '9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d',
  userId: ACTIVE_USER.id,
  user: ACTIVE_USER,
  tokenHash: sha256('token-en-claro'),
  expiresAt: new Date(Date.now() + MILLISECONDS_PER_DAY),
  isRevoked: false,
  createdAt: new Date(),
  ...overrides,
});

describe('RefreshTokenService (PROT-06.4)', () => {
  let repository: RefreshTokenRepositoryMock;
  let service: RefreshTokenService;

  beforeEach(() => {
    repository = buildRepository();
    service = new RefreshTokenService(
      repository as unknown as Repository<RefreshToken>,
      buildConfigService(),
    );
  });

  describe('issue', () => {
    it('deberia persistir el hash del token y NUNCA el valor en claro', async () => {
      // 2. Act
      const rawToken = await service.issue(ACTIVE_USER);

      // 3. Assert
      const persisted = repository.save.mock.calls[0]?.[0] as RefreshToken;
      expect(persisted.tokenHash).toBe(sha256(rawToken));
      expect(JSON.stringify(persisted)).not.toContain(rawToken);
    });

    it('deberia emitir tokens distintos en cada llamada', async () => {
      // 2. Act
      const [first, second] = await Promise.all([
        service.issue(ACTIVE_USER),
        service.issue(ACTIVE_USER),
      ]);

      // 3. Assert
      expect(first).not.toBe(second);
    });

    it('deberia fechar la expiracion segun REFRESH_TOKEN_EXPIRES_IN_DAYS', async () => {
      // 1. Arrange
      const before = Date.now();

      // 2. Act
      await service.issue(ACTIVE_USER);

      // 3. Assert
      const persisted = repository.save.mock.calls[0]?.[0] as RefreshToken;
      const expectedMs = EXPIRATION_DAYS * MILLISECONDS_PER_DAY;
      expect(persisted.expiresAt.getTime()).toBeGreaterThanOrEqual(
        before + expectedMs,
      );
      expect(persisted.isRevoked).toBe(false);
    });
  });

  describe('rotate', () => {
    it('deberia devolver el usuario y revocar el token canjeado', async () => {
      // 1. Arrange
      const stored = buildStoredToken();
      repository.findOne.mockResolvedValue(stored);

      // 2. Act
      const user = await service.rotate('token-en-claro');

      // 3. Assert
      expect(user).toEqual(ACTIVE_USER);
      expect(repository.update).toHaveBeenCalledWith(
        { id: stored.id },
        { isRevoked: true },
      );
    });

    it('deberia buscar por hash, nunca por el token en claro', async () => {
      // 1. Arrange
      repository.findOne.mockResolvedValue(buildStoredToken());

      // 2. Act
      await service.rotate('token-en-claro');

      // 3. Assert
      expect(repository.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tokenHash: sha256('token-en-claro') },
        }),
      );
    });

    it('deberia lanzar UnauthorizedException si el token no existe', async () => {
      // 1. Arrange
      repository.findOne.mockResolvedValue(null);

      // 2. Act & 3. Assert
      await expect(service.rotate('desconocido')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('deberia revocar TODAS las sesiones del usuario si detecta reutilizacion', async () => {
      // 1. Arrange: el token ya fue canjeado y vuelve a presentarse
      repository.findOne.mockResolvedValue(
        buildStoredToken({ isRevoked: true }),
      );

      // 2. Act & 3. Assert
      await expect(service.rotate('token-en-claro')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(repository.update).toHaveBeenCalledWith(
        { userId: ACTIVE_USER.id, isRevoked: false },
        { isRevoked: true },
      );
    });

    it('deberia rechazar un token caducado sin revocar la familia', async () => {
      // 1. Arrange
      repository.findOne.mockResolvedValue(
        buildStoredToken({ expiresAt: new Date(Date.now() - 1000) }),
      );

      // 2. Act & 3. Assert
      await expect(service.rotate('token-en-claro')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('deberia rechazar la renovacion si la cuenta fue desactivada', async () => {
      // 1. Arrange
      repository.findOne.mockResolvedValue(
        buildStoredToken({ user: INACTIVE_USER }),
      );

      // 2. Act & 3. Assert
      await expect(service.rotate('token-en-claro')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('deberia devolver el mismo mensaje para token inexistente, revocado y caducado', async () => {
      // 1. Arrange
      const collectMessage = async (
        stored: RefreshToken | null,
      ): Promise<string | undefined> => {
        repository.findOne.mockResolvedValueOnce(stored);
        return service
          .rotate('token-en-claro')
          .then(() => undefined)
          .catch((error: UnauthorizedException) => error.message);
      };

      // 2. Act
      const missing = await collectMessage(null);
      const revoked = await collectMessage(
        buildStoredToken({ isRevoked: true }),
      );
      const expired = await collectMessage(
        buildStoredToken({ expiresAt: new Date(Date.now() - 1000) }),
      );

      // 3. Assert
      expect(missing).toBeDefined();
      expect(revoked).toBe(missing);
      expect(expired).toBe(missing);
    });
  });

  describe('revoke', () => {
    it('deberia revocar por hash y no lanzar si el token ya no existe', async () => {
      // 1. Arrange
      repository.update.mockResolvedValue({
        affected: 0,
        raw: [],
        generatedMaps: [],
      });

      // 2. Act & 3. Assert
      await expect(service.revoke('token-en-claro')).resolves.toBeUndefined();
      expect(repository.update).toHaveBeenCalledWith(
        { tokenHash: sha256('token-en-claro') },
        { isRevoked: true },
      );
    });
  });
});
