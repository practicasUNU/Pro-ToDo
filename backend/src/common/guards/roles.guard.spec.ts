import { Controller, ForbiddenException, Get } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { Roles } from '@common/decorators/roles.decorator';
import { RolesGuard } from '@common/guards/roles.guard';
import { UserRole } from '@modules/users/enums/user-role.enum';

import type { ExecutionContext } from '@nestjs/common';
import type { AuthenticatedUser } from '@modules/auth/interfaces/jwt-payload.interface';

/** Controlador de prueba restringido a ADMIN, como el CRUD real de usuarios. */
@Roles(UserRole.ADMIN)
@Controller('solo-admin')
class AdminOnlyTestController {
  @Get()
  public handler(): void {}
}

/** Controlador de prueba sin metadata de roles. */
@Controller('sin-roles')
class UnrestrictedTestController {
  @Get()
  public handler(): void {}
}

/** Forma de un controlador de prueba: permite tipar el acceso a `prototype.handler`. */
interface TestControllerClass {
  new (): unknown;
  readonly prototype: { handler: () => void };
}

const buildExecutionContext = (
  user: AuthenticatedUser | undefined,
  targetClass: TestControllerClass,
): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => targetClass.prototype.handler,
    getClass: () => targetClass,
  }) as unknown as ExecutionContext;

const buildUser = (role: UserRole): AuthenticatedUser => ({
  id: '3f1c2b64-8a5e-4c2f-9d3a-7b6e5f4c1a20',
  email: 'usuario@unuware.com',
  role,
});

describe('RolesGuard (PROT-04.2)', () => {
  let guard: RolesGuard;

  beforeEach(() => {
    guard = new RolesGuard(new Reflector());
  });

  it('deberia bloquear con 403 a un usuario con rol EDITOR en una ruta reservada a ADMIN', () => {
    // 1. Arrange
    const context = buildExecutionContext(
      buildUser(UserRole.EDITOR),
      AdminOnlyTestController,
    );

    // 2. Act & 3. Assert
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    expect(() => guard.canActivate(context)).toThrow(/ADMIN/);
  });

  it('deberia permitir el paso a un usuario con rol ADMIN', () => {
    // 1. Arrange
    const context = buildExecutionContext(
      buildUser(UserRole.ADMIN),
      AdminOnlyTestController,
    );

    // 2. Act
    const result = guard.canActivate(context);

    // 3. Assert
    expect(result).toBe(true);
  });

  it('deberia bloquear con 403 cuando la peticion no trae identidad en req.user', () => {
    // 1. Arrange
    const context = buildExecutionContext(undefined, AdminOnlyTestController);

    // 2. Act & 3. Assert
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('deberia permitir el paso cuando la ruta no declara roles requeridos', () => {
    // 1. Arrange
    const context = buildExecutionContext(
      buildUser(UserRole.EDITOR),
      UnrestrictedTestController,
    );

    // 2. Act
    const result = guard.canActivate(context);

    // 3. Assert
    expect(result).toBe(true);
  });
});
