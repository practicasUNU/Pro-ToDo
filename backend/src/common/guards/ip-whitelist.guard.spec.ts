import { Controller, ForbiddenException, Get } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ACCESS_DENIED_MESSAGE } from '@common/constants/security.constants';
import { PublicIp } from '@common/decorators/public-ip.decorator';
import { IpWhitelistGuard } from '@common/guards/ip-whitelist.guard';
import { IpAccessService } from '@common/services/ip-access.service';

import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

const AUTHORIZED_RANGES = '127.0.0.1/32,::1/128,192.168.1.0/24,10.0.0.0/8';

/** Controlador de prueba protegido por el perimetro (sin decorador de exencion). */
@Controller('protegido')
class ProtectedTestController {
  @Get()
  public handler(): void {}
}

/** Controlador de prueba exento del perimetro mediante `@PublicIp()`. */
@PublicIp()
@Controller('publico')
class PublicIpTestController {
  @Get()
  public handler(): void {}
}

/** `ConfigService` doble: solo resuelve la variable de rangos autorizados. */
const buildConfigService = (allowedRanges: string | undefined): ConfigService =>
  ({
    get: jest.fn((key: string) =>
      key === 'ALLOWED_IP_RANGES' ? allowedRanges : undefined,
    ),
  }) as unknown as ConfigService;

/** Forma de un controlador de prueba: permite tipar el acceso a `prototype.handler`. */
interface TestControllerClass {
  new (): unknown;
  readonly prototype: { handler: () => void };
}

/** `ExecutionContext` real sobre una clase y un handler concretos, con `Reflector` real. */
const buildExecutionContext = (
  req: Partial<Request>,
  targetClass: TestControllerClass,
): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => targetClass.prototype.handler,
    getClass: () => targetClass,
  }) as unknown as ExecutionContext;

/** Peticion minima con la IP declarada en `x-forwarded-for`. */
const buildRequest = (forwardedFor?: string): Partial<Request> =>
  ({
    headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
    socket: { remoteAddress: undefined },
    method: 'GET',
    originalUrl: '/api/protegido',
  }) as unknown as Partial<Request>;

describe('IpWhitelistGuard (PROT-05.2 y PROT-05.3)', () => {
  const buildGuard = (allowedRanges: string | undefined): IpWhitelistGuard =>
    new IpWhitelistGuard(
      new Reflector(),
      new IpAccessService(buildConfigService(allowedRanges)),
    );

  it('deberia permitir el paso a una ruta marcada con @PublicIp aunque la IP no este autorizada', () => {
    // 1. Arrange
    const ipAccessService = new IpAccessService(
      buildConfigService(AUTHORIZED_RANGES),
    );
    const assertSpy = jest.spyOn(ipAccessService, 'assertRequestAllowed');
    const guard = new IpWhitelistGuard(new Reflector(), ipAccessService);
    const context = buildExecutionContext(
      buildRequest('203.0.113.10'),
      PublicIpTestController,
    );

    // 2. Act
    const result = guard.canActivate(context);

    // 3. Assert
    expect(result).toBe(true);
    expect(assertSpy).not.toHaveBeenCalled();
  });

  it('deberia bloquear con 403 una IP fuera de los rangos CIDR autorizados', () => {
    // 1. Arrange
    const guard = buildGuard(AUTHORIZED_RANGES);
    const context = buildExecutionContext(
      buildRequest('203.0.113.10'),
      ProtectedTestController,
    );

    // 2. Act & 3. Assert
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    expect(() => guard.canActivate(context)).toThrow(ACCESS_DENIED_MESSAGE);
  });

  it('deberia permitir el paso a una IP dentro de la subred corporativa', () => {
    // 1. Arrange
    const guard = buildGuard(AUTHORIZED_RANGES);
    const context = buildExecutionContext(
      buildRequest('192.168.1.55'),
      ProtectedTestController,
    );

    // 2. Act
    const result = guard.canActivate(context);

    // 3. Assert
    expect(result).toBe(true);
  });

  it('deberia permitir el paso a una IP dentro del rango de VPN 10.0.0.0/8', () => {
    // 1. Arrange
    const guard = buildGuard(AUTHORIZED_RANGES);
    const context = buildExecutionContext(
      buildRequest('10.20.30.40'),
      ProtectedTestController,
    );

    // 2. Act
    const result = guard.canActivate(context);

    // 3. Assert
    expect(result).toBe(true);
  });

  it('deberia permitir el loopback IPv6 (::1) y las IPv4 mapeadas en IPv6', () => {
    // 1. Arrange
    const guard = buildGuard(AUTHORIZED_RANGES);
    const loopbackV6 = buildExecutionContext(
      buildRequest('::1'),
      ProtectedTestController,
    );
    const mappedV4 = buildExecutionContext(
      buildRequest('::ffff:127.0.0.1'),
      ProtectedTestController,
    );

    // 2. Act
    const loopbackResult = guard.canActivate(loopbackV6);
    const mappedResult = guard.canActivate(mappedV4);

    // 3. Assert
    expect(loopbackResult).toBe(true);
    expect(mappedResult).toBe(true);
  });

  it('deberia bloquear con 403 cuando ALLOWED_IP_RANGES no esta definida (fail-closed)', () => {
    // 1. Arrange
    const guard = buildGuard(undefined);
    const context = buildExecutionContext(
      buildRequest('127.0.0.1'),
      ProtectedTestController,
    );

    // 2. Act & 3. Assert
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('deberia bloquear con 403 cuando ALLOWED_IP_RANGES esta vacia o solo contiene separadores', () => {
    // 1. Arrange
    const emptyGuard = buildGuard('');
    const separatorsGuard = buildGuard(' , , ');
    const context = buildExecutionContext(
      buildRequest('127.0.0.1'),
      ProtectedTestController,
    );

    // 2. Act & 3. Assert
    expect(() => emptyGuard.canActivate(context)).toThrow(
      ACCESS_DENIED_MESSAGE,
    );
    expect(() => separatorsGuard.canActivate(context)).toThrow(
      ACCESS_DENIED_MESSAGE,
    );
  });

  it('deberia bloquear con 403 cuando la IP de origen no se puede determinar', () => {
    // 1. Arrange
    const guard = buildGuard(AUTHORIZED_RANGES);
    const context = buildExecutionContext(
      buildRequest(),
      ProtectedTestController,
    );

    // 2. Act & 3. Assert
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });
});
