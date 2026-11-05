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

describe('JwtStrategy · pruebas a mala leche (revocacion por tokenVersion)', () => {
  it('2.1 deberia revocar EN EL ACTO un token vivo al subir la generacion', async () => {
    // 1. Arrange 📐: MISMA instancia de la estrategia, MISMO token. Entre las
    //    dos peticiones un ADMIN cambia algo de la cuenta y `token_version`
    //    pasa de 0 a 1. Nada de cache: la segunda peticion tiene que verlo.
    const { strategy, usersService } = buildStrategy({
      tokenVersion: 0,
      isActive: true,
    });
    const liveToken = buildPayload({ tokenVersion: 0 });
    await expect(strategy.validate(liveToken)).resolves.toMatchObject({
      id: USER_ID,
    });
    usersService.findAuthState.mockResolvedValue({
      tokenVersion: 1,
      isActive: true,
    });

    // 2. Act ⚙️
    const second = strategy.validate(liveToken);

    // 3. Assert 🎯
    await expect(second).rejects.toBeInstanceOf(UnauthorizedException);
    expect(usersService.findAuthState).toHaveBeenCalledTimes(2);
  });

  it('2.2 deberia aceptar el token REEMITIDO tras la revocacion', async () => {
    // 1. Arrange 📐: revocar no es banear; el siguiente login trae la nueva
    //    generacion y debe entrar.
    const { strategy } = buildStrategy({ tokenVersion: 1, isActive: true });

    // 2. Act ⚙️
    const user = await strategy.validate(buildPayload({ tokenVersion: 1 }));

    // 3. Assert 🎯
    expect(user.id).toBe(USER_ID);
  });

  it('2.3 deberia expulsar a un ADMIN degradado aunque su token aun diga ADMIN', async () => {
    // 1. Arrange 📐: el rol viaja FIRMADO en el payload y la estrategia no lo
    //    contrasta con la BD. Lo que corta el privilegio es que degradar sube
    //    `token_version`; si eso fallara, el token seguiria siendo ADMIN.
    const { strategy } = buildStrategy({ tokenVersion: 4, isActive: true });
    const staleAdmin = buildPayload({ role: UserRole.ADMIN, tokenVersion: 3 });

    // 2. Act ⚙️ + 3. Assert 🎯
    await expect(strategy.validate(staleAdmin)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it.each([
    ['la generacion como texto', '0', 0],
    ['una generacion negativa', -1, 0],
    ['una generacion del futuro', 7, 3],
    ['un decimal', 0.5, 0],
    ['un nulo', null, 0],
  ])(
    '2.4 deberia rechazar %s (comparacion estricta, sin coercion)',
    async (_label, claimed, stored) => {
      // 1. Arrange 📐: un token manipulado no puede colarse por una igualdad
      //    laxa (`'0' == 0`) ni por un `?? 0` mal colocado.
      const { strategy } = buildStrategy({
        tokenVersion: stored,
        isActive: true,
      });
      const payload = buildPayload({
        tokenVersion: claimed as unknown as number,
      });

      // 2. Act ⚙️ + 3. Assert 🎯
      // `null` es la unica excepcion legitima a probar aparte: `?? 0` lo
      // trata como "token anterior a la 051", igual que la ausencia.
      if (claimed === null) {
        await expect(strategy.validate(payload)).resolves.toMatchObject({
          id: USER_ID,
        });
        return;
      }

      await expect(strategy.validate(payload)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    },
  );

  it.each([
    ['una inyeccion SQL', "x' OR '1'='1"],
    ['un id numerico', '42'],
    ['un UUID truncado', 'c8a1f2d3-5b6e-4790-8c1d'],
  ])(
    '2.5 deberia rechazar con 401 un `sub` que no es UUID (%s) sin consultar la BD',
    async (_label, hostileSub) => {
      // 1. Arrange 📐: hallado por la e2e `input-resilience` 4.4. El `sub` iba
      //    a una columna UUID y el driver lanzaba `invalid input syntax for
      //    type uuid`: un 500 que ademas delataba el motor de base de datos.
      const { strategy, usersService } = buildStrategy({
        tokenVersion: 0,
        isActive: true,
      });

      // 2. Act ⚙️ + 3. Assert 🎯
      await expect(
        strategy.validate(buildPayload({ sub: hostileSub })),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(usersService.findAuthState).not.toHaveBeenCalled();
    },
  );
});
