import { JwtService } from '@nestjs/jwt';

import { generateDevJwt } from '@common/utils/dev-jwt.util';
import { UserRole } from '@modules/users/enums/user-role.enum';

import type { JwtPayload } from '@modules/auth/interfaces/jwt-payload.interface';

/** Secreto de juguete: solo tiene que ser el mismo al firmar y al verificar. */
const TEST_SECRET = 'secreto-de-prueba-dev-jwt';

/**
 * `JwtService` real y no un doble.
 *
 * Firmar y verificar de verdad es lo unico que prueba que el token sirva: un
 * doble que devolviera una cadena solo comprobaria que se le llamo.
 */
const buildJwtService = (): JwtService =>
  new JwtService({ secret: TEST_SECRET, signOptions: { expiresIn: '1h' } });

describe('generateDevJwt · token de pruebas para saltarse el OTP', () => {
  it('deberia firmar el payload que la API emite de verdad', () => {
    // 1. Arrange
    const jwtService = buildJwtService();

    // 2. Act
    const token = generateDevJwt(jwtService, {
      userId: '11111111-2222-4333-8444-555555555555',
      email: 'auditor@unuware.com',
      role: UserRole.EDITOR,
    });

    // 3. Assert: se verifica con la misma clave, que es lo que hara `JwtStrategy`.
    const payload = jwtService.verify<JwtPayload>(token, {
      secret: TEST_SECRET,
    });

    expect(payload.sub).toBe('11111111-2222-4333-8444-555555555555');
    expect(payload.email).toBe('auditor@unuware.com');
    expect(payload.role).toBe(UserRole.EDITOR);
  });

  it('deberia emitir un ADMIN cuando no se indica rol', () => {
    // 1. Arrange
    const jwtService = buildJwtService();

    // 2. Act
    const token = generateDevJwt(jwtService);

    // 3. Assert: el uso tipico es probar el CRUD de usuarios, exclusivo de ADMIN.
    const payload = jwtService.verify<JwtPayload>(token, {
      secret: TEST_SECRET,
    });

    expect(payload.role).toBe(UserRole.ADMIN);
    expect(payload.sub).not.toBe('');
  });

  it('NO deberia anadir claims fuera del contrato de JwtPayload', () => {
    // 1. Arrange: `JwtStrategy.validate` solo lee `sub`, `email` y `role`, pero un
    //    claim de mas aqui seria una divergencia silenciosa con el token real.
    const jwtService = buildJwtService();

    // 2. Act
    const token = generateDevJwt(jwtService);
    const payload = jwtService.verify<Record<string, unknown>>(token, {
      secret: TEST_SECRET,
    });

    // 3. Assert: los tres del contrato, mas los dos que pone la libreria.
    expect(Object.keys(payload).sort()).toEqual([
      'email',
      'exp',
      'iat',
      'role',
      'sub',
    ]);
  });

  it('deberia respetar la vigencia configurada en el JwtService', () => {
    // 1. Arrange: la caducidad NO se decide aqui. Sale del `JwtModule` real, que
    //    es el motivo de recibir el servicio en vez de firmar por nuestra cuenta.
    const jwtService = new JwtService({
      secret: TEST_SECRET,
      signOptions: { expiresIn: '30s' },
    });

    // 2. Act
    const token = generateDevJwt(jwtService);
    const { iat, exp } = jwtService.verify<
      JwtPayload & { iat: number; exp: number }
    >(token, { secret: TEST_SECRET });

    // 3. Assert
    expect(exp - iat).toBe(30);
  });
});
