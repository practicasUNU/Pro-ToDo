import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';

import { UserRole } from '@modules/users/enums/user-role.enum';

import { JwtStrategy } from './jwt.strategy';

import type { UsersService } from '@modules/users/users.service';
import type { JwtPayload } from '@modules/auth/interfaces/jwt-payload.interface';

const USER_ID = 'c8a1f2d3-5b6e-4790-8c1d-2e3f4a5b6c7d';

const buildPayload = (overrides: Partial<JwtPayload> = {}): JwtPayload => ({
  sub: USER_ID,
  email: 'usuario@unuware.com',
  role: UserRole.EDITOR,
  tokenVersion: 3,
  ...overrides,
});

const buildStrategy = (
  authState: { tokenVersion: number; isActive: boolean } | null,
) => {
  const usersService = {
    findAuthState: jest.fn().mockResolvedValue(authState),
  };

  const strategy = new JwtStrategy(
    new ConfigService({ JWT_SECRET: 'secreto-de-prueba' }),
    usersService as unknown as UsersService,
  );

  return { strategy, usersService };
};

describe('JwtStrategy', () => {
  it('1.1 deberia aceptar un token de la generacion vigente', async () => {
    // 1. Arrange 📐
    const { strategy } = buildStrategy({ tokenVersion: 3, isActive: true });

    // 2. Act ⚙️
    const user = await strategy.validate(buildPayload());

    // 3. Assert 🎯
    expect(user).toEqual({
      id: USER_ID,
      email: 'usuario@unuware.com',
      role: UserRole.EDITOR,
    });
  });

  it('1.2 deberia rechazar un token de una generacion anterior', async () => {
    // 1. Arrange 📐: ES LA GUARDA QUE JUSTIFICA TODO EL CAMBIO. Sin ella, un
    //    ADMIN degradado conservaba sus privilegios hasta que el JWT caducaba
    //    solo, porque la identidad viajaba firmada y nadie la contrastaba.
    const { strategy } = buildStrategy({ tokenVersion: 4, isActive: true });

    // 2. Act + 3. Assert 🎯
    await expect(
      strategy.validate(buildPayload({ tokenVersion: 3 })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('1.3 deberia rechazar a una cuenta desactivada', async () => {
    // 1. Arrange 📐
    const { strategy } = buildStrategy({ tokenVersion: 3, isActive: false });

    // 2. Act + 3. Assert 🎯
    await expect(strategy.validate(buildPayload())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('1.4 deberia rechazar a una cuenta que ya no existe', async () => {
    // 1. Arrange 📐
    const { strategy } = buildStrategy(null);

    // 2. Act + 3. Assert 🎯
    await expect(strategy.validate(buildPayload())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('1.5 deberia admitir un token anterior a la migracion, sin el claim', async () => {
    // 1. Arrange 📐: los tokens emitidos antes de la 051 no traen
    //    `tokenVersion`. Se interpretan como la generacion 0 para que el
    //    despliegue no expulse de golpe a todas las sesiones vivas.
    const { strategy } = buildStrategy({ tokenVersion: 0, isActive: true });
    const payload = buildPayload();
    delete payload.tokenVersion;

    // 2. Act ⚙️
    const user = await strategy.validate(payload);

    // 3. Assert 🎯
    expect(user.id).toBe(USER_ID);
  });

  it('1.6 NO deberia consultar la BD si el payload ya es invalido', async () => {
    // 1. Arrange 📐: un token sin identidad no merece un viaje a PostgreSQL.
    const { strategy, usersService } = buildStrategy({
      tokenVersion: 0,
      isActive: true,
    });

    // 2. Act + 3. Assert 🎯
    await expect(
      strategy.validate(buildPayload({ role: 'INVENTADO' as UserRole })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(usersService.findAuthState).not.toHaveBeenCalled();
  });

  it('1.7 deberia dar el MISMO mensaje a los tres rechazos de sesion', async () => {
    // 1. Arrange 📐: a quien presenta un token caduco no se le confirma si la
    //    cuenta existe, si sigue activa o si solo le cambiaron el rol.
    const cases = [
      buildStrategy(null),
      buildStrategy({ tokenVersion: 3, isActive: false }),
      buildStrategy({ tokenVersion: 9, isActive: true }),
    ];

    // 2. Act ⚙️
    const messages = await Promise.all(
      cases.map(({ strategy }) =>
        strategy
          .validate(buildPayload())
          .catch((error: Error) => error.message),
      ),
    );

    // 3. Assert 🎯
    expect(new Set(messages).size).toBe(1);
  });
});
