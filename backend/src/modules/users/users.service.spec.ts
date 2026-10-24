import { ConfigService } from '@nestjs/config';

import { CrudEventsCoordinator } from '@common/services/crud-events.coordinator';
import { SessionEventsCoordinator } from '@common/services/session-events.coordinator';
import { SessionRevocationCoordinator } from '@common/services/session-revocation.coordinator';

import { UserRole } from './enums/user-role.enum';
import { UsersService, resolveSessionBreakingFields } from './users.service';

import type { Repository } from 'typeorm';
import type { User } from './entities/user.entity';

const USER_ID = 'c8a1f2d3-5b6e-4790-8c1d-2e3f4a5b6c7d';
const ACTOR_ID = '3f1c2b64-8a5e-4c2f-9d3a-7b6e5f4c1a20';
const ACTOR_EMAIL = 'admin@unuware.com';

const buildUser = (overrides: Partial<User> = {}): User => ({
  id: USER_ID,
  email: 'usuario@unuware.com',
  role: UserRole.EDITOR,
  otpSecret: null,
  isActive: true,
  tokenVersion: 3,
  createdByUserId: null,
  updatedByUserId: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

/**
 * Repositorio doble.
 *
 * `findOne` responde segun lo que se le pida: la consulta del ACTOR trae su
 * correo y cualquier otra devuelve la fila del usuario editado, que es la misma
 * instancia que `update` muta en el sitio.
 */
const buildRepository = (user: User) => {
  const findOne = jest.fn((options: { where?: { id?: string } }) =>
    Promise.resolve(
      options.where?.id === ACTOR_ID ? ({ email: ACTOR_EMAIL } as User) : user,
    ),
  );
  const save = jest.fn((entity: User) => Promise.resolve(entity));

  return {
    findOne,
    save,
    repository: {
      findOne,
      save,
      create: jest.fn(),
    } as unknown as Repository<User>,
  };
};

const buildService = (user: User) => {
  const { findOne, save, repository } = buildRepository(user);
  // Coordinadores REALES: sin puertos inscritos son un no-op silencioso, que es
  // justo lo que hace falta para observar el despacho con un espia.
  const sessionEvents = new SessionEventsCoordinator();
  const sessionRevocation = new SessionRevocationCoordinator();
  const dispatch = jest.spyOn(sessionEvents, 'dispatch');
  const revoke = jest
    .spyOn(sessionRevocation, 'revokeAllForUser')
    .mockResolvedValue(undefined);

  const service = new UsersService(
    repository,
    new ConfigService({}),
    new CrudEventsCoordinator(),
    sessionRevocation,
    sessionEvents,
  );

  return { service, findOne, save, dispatch, revoke };
};

describe('resolveSessionBreakingFields', () => {
  const base = {
    role: UserRole.EDITOR,
    isActive: true,
    email: 'usuario@unuware.com',
  };

  it('0.1 deberia nombrar solo los campos que de verdad cambiaron', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const changed = resolveSessionBreakingFields(base, {
      ...base,
      role: UserRole.ADMIN,
      email: 'otro@unuware.com',
    });

    // 3. Assert 🎯
    expect(changed).toEqual(['rol', 'correo']);
  });

  it('0.2 NO deberia considerar una edicion indiferente', () => {
    // 1. Arrange 📐: el nombre o una marca de auditoria no alteran lo que el
    //    token afirma; expulsar por eso seria castigar un cambio cosmetico.
    // 2. Act ⚙️
    const changed = resolveSessionBreakingFields(base, { ...base });

    // 3. Assert 🎯
    expect(changed).toEqual([]);
  });
});

describe('UsersService (cierre forzado de sesion)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('1.1 deberia subir tokenVersion, revocar y avisar al cambiar el rol', async () => {
    // 1. Arrange 📐: el rol viaja firmado dentro del JWT, asi que un token
    //    viejo seguiria abriendo pantallas que su dueno ya no deberia ver.
    const user = buildUser();
    const { service, save, dispatch, revoke } = buildService(user);

    // 2. Act ⚙️
    await service.update(USER_ID, { role: UserRole.ADMIN }, ACTOR_ID);

    // 3. Assert 🎯
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ tokenVersion: 4 }),
    );
    expect(revoke).toHaveBeenCalledWith(USER_ID);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        actorEmail: ACTOR_EMAIL,
        updatedFields: ['rol'],
      }),
    );
  });

  it('1.2 NO deberia tocar nada en una edicion que no rompe la sesion', async () => {
    // 1. Arrange 📐
    const user = buildUser();
    const { service, save, dispatch, revoke } = buildService(user);

    // 2. Act ⚙️: se reescribe el mismo rol que ya tenia.
    await service.update(USER_ID, { role: UserRole.EDITOR }, ACTOR_ID);

    // 3. Assert 🎯
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ tokenVersion: 3 }),
    );
    expect(revoke).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('1.3 deberia revocar al desactivar por borrado logico', async () => {
    // 1. Arrange 📐: `DELETE /users/:id` no borra, desactiva. Una cuenta sin
    //    acceso que conserva su sesion viva es el caso que esto cierra.
    const user = buildUser();
    const { service, dispatch, revoke } = buildService(user);

    // 2. Act ⚙️
    await service.remove(USER_ID, ACTOR_ID);

    // 3. Assert 🎯
    expect(revoke).toHaveBeenCalledWith(USER_ID);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ updatedFields: ['estado'] }),
    );
  });

  it('1.4 NO deberia volver a avisar si la cuenta ya estaba desactivada', async () => {
    // 1. Arrange 📐: desactivar dos veces no invalida nada nuevo, y el segundo
    //    aviso solo serviria para alarmar a quien ya esta fuera.
    const user = buildUser({ isActive: false });
    const { service, dispatch, revoke } = buildService(user);

    // 2. Act ⚙️
    await service.remove(USER_ID, ACTOR_ID);

    // 3. Assert 🎯
    expect(revoke).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('1.5 deberia revocar ANTES de avisar', async () => {
    // 1. Arrange 📐: al reves, el cliente recibiria el modal mientras sus
    //    tokens siguen sirviendo, y bastaria cerrar la pestana durante la
    //    cuenta atras para conservar una sesion ya dada por muerta.
    const user = buildUser();
    const { service, dispatch, revoke } = buildService(user);
    const order: string[] = [];

    revoke.mockImplementation(() => {
      order.push('revoke');
      return Promise.resolve();
    });
    dispatch.mockImplementation(() => {
      order.push('dispatch');
    });

    // 2. Act ⚙️
    await service.remove(USER_ID, ACTOR_ID);

    // 3. Assert 🎯
    expect(order).toEqual(['revoke', 'dispatch']);
  });

  it('1.6 deberia leer el estado de autorizacion con solo dos columnas', async () => {
    // 1. Arrange 📐: esto corre en CADA peticion autenticada; traer la fila
    //    entera —con su secreto OTP y sus relaciones— multiplicaria el coste
    //    del guard sin que nadie use el resto.
    const user = buildUser();
    const { service, findOne } = buildService(user);

    // 2. Act ⚙️
    await service.findAuthState(USER_ID);

    // 3. Assert 🎯
    expect(findOne).toHaveBeenCalledWith({
      where: { id: USER_ID },
      select: { tokenVersion: true, isActive: true },
    });
  });
});
