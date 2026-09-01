import { ForbiddenException } from '@nestjs/common';
import ipRangeCheck from 'ip-range-check';

import { ACCESS_DENIED_MESSAGE } from '@common/constants/security.constants';
import { RedLocalMiddleware } from '@common/middlewares/red-local.middleware';
import { IpAccessService } from '@common/services/ip-access.service';

import type { AllowedIpsService } from '@modules/security/allowed-ips/allowed-ips.service';
import type { NextFunction, Request, Response } from 'express';

const AUTHORIZED_RANGES = [
  '127.0.0.1/32',
  '::1/128',
  '192.168.1.0/24',
  '10.0.0.0/8',
];

const buildAllowedIpsService = (
  ranges: string[] | undefined,
): AllowedIpsService =>
  ({
    isIpAllowed: jest
      .fn()
      .mockImplementation((clientIp: string) =>
        Promise.resolve(
          !!ranges && ranges.length > 0 && ipRangeCheck(clientIp, ranges),
        ),
      ),
  }) as unknown as AllowedIpsService;

const buildRequest = (forwardedFor?: string): Request =>
  ({
    headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
    socket: { remoteAddress: undefined },
    method: 'GET',
    originalUrl: '/api/docs',
  }) as unknown as Request;

const buildMiddleware = (ranges: string[] | undefined): RedLocalMiddleware =>
  new RedLocalMiddleware(new IpAccessService(buildAllowedIpsService(ranges)));

describe('RedLocalMiddleware (perimetro de Swagger, PROT-05.3)', () => {
  const response = {} as Response;

  it('deberia invocar next() una sola vez cuando la IP pertenece a la red corporativa', async () => {
    // 1. Arrange
    const middleware = buildMiddleware(AUTHORIZED_RANGES);
    const next: NextFunction = jest.fn();

    // 2. Act
    await middleware.use(buildRequest('192.168.1.20'), response, next);

    // 3. Assert
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('deberia bloquear con 403 y no invocar next() cuando la IP esta fuera del rango', async () => {
    // 1. Arrange
    const middleware = buildMiddleware(AUTHORIZED_RANGES);
    const next: NextFunction = jest.fn();

    // 2. Act & 3. Assert
    await expect(
      middleware.use(buildRequest('203.0.113.10'), response, next),
    ).rejects.toThrow(new ForbiddenException(ACCESS_DENIED_MESSAGE));
    expect(next).not.toHaveBeenCalled();
  });

  it('deberia bloquear con 403 cuando no hay ningun rango autorizado (fail-closed)', async () => {
    // 1. Arrange
    const middleware = buildMiddleware(undefined);
    const next: NextFunction = jest.fn();

    // 2. Act & 3. Assert
    await expect(
      middleware.use(buildRequest('127.0.0.1'), response, next),
    ).rejects.toThrow(ForbiddenException);
    expect(next).not.toHaveBeenCalled();
  });
});
