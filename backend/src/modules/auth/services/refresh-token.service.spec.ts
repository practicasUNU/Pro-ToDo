import { createHash } from 'node:crypto';

import { UnauthorizedException } from '@nestjs/common';

import { RefreshTokenService } from '@modules/auth/services/refresh-token.service';
import { UserRole } from '@modules/users/enums/user-role.enum';

import type { RefreshToken } from '@modules/auth/entities/refresh-token.entity';
import type { User } from '@modules/users/entities/user.entity';
import type { ConfigService } from '@nestjs/config';
import type { FindManyOptions, FindOptionsWhere, Repository } from 'typeorm';

const ACTIVE_USER: User = {
  id: '3f1c2b64-8a5e-4c2f-9d3a-7b6e5f4c1a20',
  email: 'admin@unuware.com',
  role: UserRole.ADMIN,
  isActive: true,
  otpSecret: null,
};

const INACTIVE_USER: User = { ...ACTIVE_USER, isActive: false };

/** Dispositivo que abre la sesion bajo prueba. */
const DEVICE_ID = 'b3f1c2d4-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

/** Segundo equipo del mismo usuario, para verificar el aislamiento. */
const OTHER_DEVICE_ID = 'e1d2c3b4-a5f6-4e7d-8c9b-0a1f2e3d4c5b';

const EXPIRATION_DAYS = 7;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/** Espejo de la constante homonima del servicio. */
const RETAINED_DEAD_TOKENS = 5;

/**
 * Espejo de `MAX_ACTIVE_SESSIONS`. Vale lo mismo que la anterior y mide otra
 * cosa: sesiones vivas permitidas, no tokens muertos retenidos.
 */
const MAX_ACTIVE_SESSIONS = 5;

/** Repositorio doble: `create` devuelve el literal tal cual y `save` lo refleja. */
type RefreshTokenRepositoryMock = jest.Mocked<
  Pick<
    Repository<RefreshToken>,
    'create' | 'save' | 'find' | 'findOne' | 'update' | 'delete'
  >
> & { manager: { transaction: jest.Mock } };

/**
 * El doble se devuelve a si mismo como repositorio transaccional: `issue()` opera
 * dentro de `manager.transaction`, asi que sin este puente las llamadas se
 * perderian y no habria nada que verificar. El callback se ejecuta en el acto,
 * que es justo el comportamiento de una transaccion que confirma.
 */
const buildRepository = (): RefreshTokenRepositoryMock => {
  const repository = {
    create: jest.fn((entity: Partial<RefreshToken>) => entity as RefreshToken),
    save: jest.fn((entity: RefreshToken) => Promise.resolve(entity)),
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
  } as unknown as RefreshTokenRepositoryMock;

  repository.manager = {
    transaction: jest.fn(
      (runInTransaction: (manager: { getRepository: jest.Mock }) => unknown) =>
        runInTransaction({ getRepository: jest.fn(() => repository) }),
    ),
  };

  return repository;
};

const buildConfigService = (): ConfigService =>
  ({
    get: jest.fn((key: string) =>
      key === 'REFRESH_TOKEN_EXPIRES_IN_DAYS' ? EXPIRATION_DAYS : undefined,
    ),
  }) as unknown as ConfigService;

/**
 * `issue()` lanza DOS consultas `find` en la misma transaccion y hay que poder
 * distinguirlas. Se discriminan por la forma del `where`, que es lo unico que
 * las separa: el limite de sesiones filtra con un objeto y la poda con un array
 * (el OR revocado/caducado). Indexar por orden de llamada ataria las pruebas al
 * orden interno de `issue()`, que es un detalle de implementacion.
 */
const isPruneQuery = (options?: FindManyOptions<RefreshToken>): boolean =>
  Array.isArray(options?.where);

/** Criterio con el que se pidio cada una de las dos consultas. */
const findCriteria = (
  repository: RefreshTokenRepositoryMock,
  query: 'prune' | 'sessionLimit',
): FindManyOptions<RefreshToken> => {
  const call = repository.find.mock.calls.find(
    ([options]: [FindManyOptions<RefreshToken>?]) =>
      isPruneQuery(options) === (query === 'prune'),
  );

  if (!call?.[0]) {
    throw new Error(`No se lanzo la consulta "${query}" en issue().`);
  }

  return call[0];
};

/** Respuesta distinta para cada una de las dos consultas de `issue()`. */
const mockFindByQuery = (
  repository: RefreshTokenRepositoryMock,
  results: { dead?: RefreshToken[]; active?: RefreshToken[] },
): void => {
  repository.find.mockImplementation(
    (options?: FindManyOptions<RefreshToken>) =>
      Promise.resolve(
        isPruneQuery(options) ? (results.dead ?? []) : (results.active ?? []),
      ),
  );
};

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
  deviceId: DEVICE_ID,
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
      const rawToken = await service.issue(ACTIVE_USER, DEVICE_ID);

      // 3. Assert
      const persisted = repository.save.mock.calls[0]?.[0] as RefreshToken;
      expect(persisted.tokenHash).toBe(sha256(rawToken));
      expect(JSON.stringify(persisted)).not.toContain(rawToken);
    });

    it('deberia emitir tokens distintos en cada llamada', async () => {
      // 2. Act
      const [first, second] = await Promise.all([
        service.issue(ACTIVE_USER, DEVICE_ID),
        service.issue(ACTIVE_USER, DEVICE_ID),
      ]);

      // 3. Assert
      expect(first).not.toBe(second);
    });

    it('deberia fechar la expiracion segun REFRESH_TOKEN_EXPIRES_IN_DAYS', async () => {
      // 1. Arrange
      const before = Date.now();

      // 2. Act
      await service.issue(ACTIVE_USER, DEVICE_ID);

      // 3. Assert
      const persisted = repository.save.mock.calls[0]?.[0] as RefreshToken;
      const expectedMs = EXPIRATION_DAYS * MILLISECONDS_PER_DAY;
      expect(persisted.expiresAt.getTime()).toBeGreaterThanOrEqual(
        before + expectedMs,
      );
      expect(persisted.isRevoked).toBe(false);
    });

    it('deberia revocar, insertar, acotar y podar en la MISMA transaccion', async () => {
      // 2. Act
      await service.issue(ACTIVE_USER, DEVICE_ID);

      // 3. Assert: una sola transaccion para los cuatro pasos. Si alguno fallara,
      // el token nuevo tampoco se persistiria.
      expect(repository.manager.transaction).toHaveBeenCalledTimes(1);
      expect(repository.update).toHaveBeenCalledTimes(1);
      expect(repository.save).toHaveBeenCalledTimes(1);
      // Dos consultas: limite de sesiones y poda de muertos.
      expect(repository.find).toHaveBeenCalledTimes(2);
    });

    it('deberia revocar el token vivo anterior del MISMO dispositivo', async () => {
      // 2. Act
      await service.issue(ACTIVE_USER, DEVICE_ID);

      // 3. Assert
      expect(repository.update).toHaveBeenCalledWith(
        { userId: ACTIVE_USER.id, deviceId: DEVICE_ID, isRevoked: false },
        { isRevoked: true },
      );
    });

    it('NO deberia alcanzar las sesiones de OTROS dispositivos del usuario', async () => {
      // 2. Act
      await service.issue(ACTIVE_USER, DEVICE_ID);

      // 3. Assert: el criterio acota por dispositivo, asi que la forma user-wide
      // de `revokeAllForUser` no puede aparecer aqui. Sin el `deviceId`, emitir un
      // token en un equipo cerraria la sesion de todos los demas.
      const criteria = repository.update.mock.calls[0]?.[0] as {
        deviceId?: string;
      };
      expect(criteria.deviceId).toBe(DEVICE_ID);
      expect(repository.update).not.toHaveBeenCalledWith(
        { userId: ACTIVE_USER.id, isRevoked: false },
        { isRevoked: true },
      );
      expect(criteria.deviceId).not.toBe(OTHER_DEVICE_ID);
    });

    it('deberia revocar ANTES de insertar, para no revocar el token recien creado', async () => {
      // 2. Act
      await service.issue(ACTIVE_USER, DEVICE_ID);

      // 3. Assert: el filtro de revocacion es `isRevoked: false`, asi que invertir
      // el orden alcanzaria a la fila que se acaba de insertar y la mataria al nacer.
      const revokeOrder = repository.update.mock.invocationCallOrder[0];
      const insertOrder = repository.save.mock.invocationCallOrder[0];
      expect(revokeOrder).toBeLessThan(insertOrder);
    });

    it('deberia persistir el deviceId recibido en la fila nueva', async () => {
      // 2. Act
      await service.issue(ACTIVE_USER, DEVICE_ID);

      // 3. Assert
      const persisted = repository.save.mock.calls[0]?.[0] as RefreshToken;
      expect(persisted.deviceId).toBe(DEVICE_ID);
      expect(persisted.userId).toBe(ACTIVE_USER.id);
    });

    it('deberia podar solo tokens inservibles, saltando los mas recientes', async () => {
      // 2. Act
      await service.issue(ACTIVE_USER, DEVICE_ID);

      // 3. Assert
      const criteria = findCriteria(repository, 'prune');
      expect(criteria.skip).toBe(RETAINED_DEAD_TOKENS);
      expect(criteria.order).toEqual({ createdAt: 'DESC' });

      // El `where` es un OR de dos ramas: revocados y caducados, ambas acotadas
      // al usuario. Ninguna otra rama puede alcanzar a un token vigente.
      const branches = criteria.where as FindOptionsWhere<RefreshToken>[];
      expect(branches).toHaveLength(2);
      expect(branches).toContainEqual({
        userId: ACTIVE_USER.id,
        isRevoked: true,
      });
      expect(branches[1]?.userId).toBe(ACTIVE_USER.id);
      expect(branches[1]?.expiresAt).toBeDefined();
    });

    it('deberia purgar un token caducado aunque NO este revocado', async () => {
      // 1. Arrange: el criterio es un OR, no un AND. Si solo mirase `isRevoked`,
      // una fila caducada pero nunca canjeada se quedaria ahi para siempre.
      const expiredButLive = buildStoredToken({
        id: 'caducado-sin-revocar',
        isRevoked: false,
        expiresAt: new Date(Date.now() - MILLISECONDS_PER_DAY),
      });
      mockFindByQuery(repository, { dead: [expiredButLive] });

      // 2. Act
      await service.issue(ACTIVE_USER, DEVICE_ID);

      // 3. Assert
      expect(repository.delete).toHaveBeenCalledWith(['caducado-sin-revocar']);

      // La rama de caducidad existe y esta acotada al usuario.
      const branches = findCriteria(repository, 'prune')
        .where as FindOptionsWhere<RefreshToken>[];
      const expiryBranch = branches.find((branch) => branch.expiresAt);
      expect(expiryBranch?.userId).toBe(ACTIVE_USER.id);
      expect(expiryBranch?.isRevoked).toBeUndefined();
    });

    it('NO deberia borrar nada si no hay candidatos', async () => {
      // 1. Arrange
      repository.find.mockResolvedValue([]);

      // 2. Act
      await service.issue(ACTIVE_USER, DEVICE_ID);

      // 3. Assert
      expect(repository.delete).not.toHaveBeenCalled();
    });

    it('deberia borrar exactamente los ids devueltos por la consulta', async () => {
      // 1. Arrange
      const doomedIds = ['id-viejo-1', 'id-viejo-2'];
      mockFindByQuery(repository, {
        dead: doomedIds.map((id) => buildStoredToken({ id, isRevoked: true })),
      });

      // 2. Act
      await service.issue(ACTIVE_USER, DEVICE_ID);

      // 3. Assert: un unico borrado, el de la poda; el cupo no tiene sobrantes.
      expect(repository.delete).toHaveBeenCalledTimes(1);
      expect(repository.delete).toHaveBeenCalledWith(doomedIds);
    });

    it('deberia dejar intacta la sesion vigente de otro dispositivo', async () => {
      // 1. Arrange: el filtro solo puede devolver tokens ya inservibles, asi que
      // un vigente de otro equipo jamas llega al `delete`. Se simula el escenario
      // que rompia la regla "top 2": un revocado reciente y nada mas que borrar.
      repository.find.mockResolvedValue([]);

      // 2. Act
      await service.issue(ACTIVE_USER, DEVICE_ID);

      // 3. Assert
      const branches = findCriteria(repository, 'prune')
        .where as FindOptionsWhere<RefreshToken>[];
      expect(
        branches.every(
          (branch) => branch.isRevoked === true || branch.expiresAt,
        ),
      ).toBe(true);
      expect(repository.delete).not.toHaveBeenCalled();
    });
  });

  describe('limite de sesiones activas (MOD-01)', () => {
    /** `n` sesiones vivas, de la mas reciente a la mas antigua. */
    const buildActiveSessions = (count: number): RefreshToken[] =>
      Array.from({ length: count }, (_value, index) =>
        buildStoredToken({
          id: `sesion-${index}`,
          deviceId: `dispositivo-${index}`,
          createdAt: new Date(Date.now() - index * 1000),
        }),
      );

    it('deberia consultar solo las sesiones REALMENTE vivas', async () => {
      // 2. Act
      await service.issue(ACTIVE_USER, DEVICE_ID);

      // 3. Assert: un token revocado o caducado ya no ocupa plaza; contarlo
      // expulsaria sesiones buenas para hacer sitio a filas muertas.
      const criteria = findCriteria(repository, 'sessionLimit');
      const where = criteria.where as FindOptionsWhere<RefreshToken>;

      expect(where.userId).toBe(ACTIVE_USER.id);
      expect(where.isRevoked).toBe(false);
      expect(where.expiresAt).toBeDefined();
      expect(criteria.skip).toBe(MAX_ACTIVE_SESSIONS);
    });

    it('deberia ordenar de forma determinista para que el corte sea estable', async () => {
      // 2. Act
      await service.issue(ACTIVE_USER, DEVICE_ID);

      // 3. Assert: dos tokens emitidos en el mismo instante comparten
      // `createdAt`; sin el desempate por `id`, cual de los dos cae del lado del
      // `skip` lo decidiria el plan de ejecucion de PostgreSQL.
      expect(findCriteria(repository, 'sessionLimit').order).toEqual({
        createdAt: 'DESC',
        id: 'DESC',
      });
    });

    it('NO deberia expulsar nada por debajo del limite', async () => {
      // 1. Arrange: 5 vivas contando la recien emitida, ninguna sobrante
      mockFindByQuery(repository, { active: [] });

      // 2. Act
      await service.issue(ACTIVE_USER, DEVICE_ID);

      // 3. Assert
      expect(repository.delete).not.toHaveBeenCalled();
    });

    it('deberia expulsar la sesion mas antigua al superar el limite', async () => {
      // 1. Arrange: el `skip` ya deja fuera las 5 mas recientes, asi que la
      // consulta solo devuelve la sobrante.
      const oldest = buildStoredToken({
        id: 'sesion-mas-antigua',
        deviceId: OTHER_DEVICE_ID,
        createdAt: new Date(Date.now() - 90 * MILLISECONDS_PER_DAY),
      });
      mockFindByQuery(repository, { active: [oldest] });

      // 2. Act
      await service.issue(ACTIVE_USER, DEVICE_ID);

      // 3. Assert
      expect(repository.delete).toHaveBeenCalledTimes(1);
      expect(repository.delete).toHaveBeenCalledWith(['sesion-mas-antigua']);
    });

    it('deberia BORRAR las expulsadas y jamas revocarlas', async () => {
      // 1. Arrange: es la prueba de seguridad del limite. Una fila revocada
      // sobrevive, y cuando el dispositivo expulsado presentase su token,
      // `rotate()` lo leeria como REUTILIZACION: derribaria con
      // `revokeAllForUser()` las demas sesiones del usuario y dejaria una alerta
      // de robo falsa en el log. Borrandola, ese intento acaba en un 401 normal.
      const evicted = buildStoredToken({
        id: 'expulsada',
        deviceId: OTHER_DEVICE_ID,
      });
      mockFindByQuery(repository, { active: [evicted] });

      // 2. Act
      await service.issue(ACTIVE_USER, DEVICE_ID);

      // 3. Assert
      expect(repository.delete).toHaveBeenCalledWith(['expulsada']);

      // El unico `update` legitimo aqui es la revocacion del token previo de ESTE
      // dispositivo. Ninguno puede apuntar a la fila expulsada.
      expect(repository.update).toHaveBeenCalledTimes(1);
      expect(repository.update).not.toHaveBeenCalledWith(
        { id: 'expulsada' },
        { isRevoked: true },
      );
    });

    it('NO deberia expulsar el token recien emitido', async () => {
      // 1. Arrange
      mockFindByQuery(repository, { active: buildActiveSessions(2) });

      // 2. Act
      const rawToken = await service.issue(ACTIVE_USER, DEVICE_ID);

      // 3. Assert: la consulta va DESPUES del `save`, y como ordena por
      // `createdAt DESC` la fila nueva es la primera, no la ultima. Invertir el
      // orden la dejaria expulsandose a si misma y el login no devolveria sesion.
      const saveOrder = repository.save.mock.invocationCallOrder[0] ?? 0;
      const limitOrder = repository.find.mock.invocationCallOrder[0] ?? 0;
      expect(saveOrder).toBeLessThan(limitOrder);

      // Y el token devuelto es el que se persistio, no uno que acabe borrado.
      const persisted = repository.save.mock.calls[0]?.[0] as RefreshToken;
      expect(persisted.tokenHash).toBe(sha256(rawToken));
      expect(persisted.isRevoked).toBe(false);
    });

    it('deberia acotar por usuario y no por dispositivo', async () => {
      // 2. Act
      await service.issue(ACTIVE_USER, DEVICE_ID);

      // 3. Assert: el cupo es de sesiones del USUARIO. Filtrar tambien por
      // dispositivo daria siempre un resultado y el limite no acotaria nada.
      const where = findCriteria(repository, 'sessionLimit')
        .where as FindOptionsWhere<RefreshToken>;
      expect(where.deviceId).toBeUndefined();
    });
  });

  describe('vigencia configurable', () => {
    /** Servicio con un valor concreto de `REFRESH_TOKEN_EXPIRES_IN_DAYS`. */
    const buildServiceWith = (value: unknown): RefreshTokenService =>
      new RefreshTokenService(
        repository as unknown as Repository<RefreshToken>,
        {
          get: jest.fn(() => value),
        } as unknown as ConfigService,
      );

    /** Dias de vigencia con que se fecho el token persistido. */
    const persistedDays = (issuedAt: number): number => {
      const persisted = repository.save.mock.calls[0]?.[0] as RefreshToken;
      return Math.round(
        (persisted.expiresAt.getTime() - issuedAt) / MILLISECONDS_PER_DAY,
      );
    };

    it.each([
      ['ausente', undefined],
      ['vacia', ''],
      ['no numerica', 'abc'],
      ['negativa', '-3'],
      ['cero', '0'],
    ])('deberia caer a 7 dias con una variable %s', async (_case, value) => {
      // 1. Arrange: la coalescencia nula por si sola solo cubre el primer caso.
      // Una cadena vacia da `Number('') === 0` y el token naceria caducado: el
      // login quedaria roto sin un solo error en el log.
      const issuedAt = Date.now();

      // 2. Act
      await buildServiceWith(value).issue(ACTIVE_USER, DEVICE_ID);

      // 3. Assert
      expect(persistedDays(issuedAt)).toBe(7);
    });

    it('deberia respetar un valor valido, aunque llegue como cadena', async () => {
      // 1. Arrange: del `.env` siempre llega texto, nunca un numero.
      const issuedAt = Date.now();

      // 2. Act
      await buildServiceWith('30').issue(ACTIVE_USER, DEVICE_ID);

      // 3. Assert
      expect(persistedDays(issuedAt)).toBe(30);
    });
  });

  describe('rotate', () => {
    it('deberia devolver el usuario y revocar el token canjeado', async () => {
      // 1. Arrange
      const stored = buildStoredToken();
      repository.findOne.mockResolvedValue(stored);

      // 2. Act
      const { user } = await service.rotate('token-en-claro');

      // 3. Assert
      expect(user).toEqual(ACTIVE_USER);
      expect(repository.update).toHaveBeenCalledWith(
        { id: stored.id },
        { isRevoked: true },
      );
    });

    it('deberia devolver el deviceId del token canjeado para arrastrarlo al nuevo', async () => {
      // 1. Arrange: la sesion se abrio en OTHER_DEVICE_ID, no en el de por defecto
      repository.findOne.mockResolvedValue(
        buildStoredToken({ deviceId: OTHER_DEVICE_ID }),
      );

      // 2. Act
      const { deviceId } = await service.rotate('token-en-claro');

      // 3. Assert: el cliente no reenvia el dispositivo al renovar, lo transporta
      // la cadena de tokens; sin esto la renovacion cambiaria de dispositivo.
      expect(deviceId).toBe(OTHER_DEVICE_ID);
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
