import { ForbiddenException } from '@nestjs/common';

import { ACCESS_DENIED_MESSAGE } from '@common/constants/security.constants';
import { RedLocalMiddleware } from '@common/middlewares/red-local.middleware';
import { IpAccessService } from '@common/services/ip-access.service';

import type { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';

const AUTHORIZED_RANGES = '127.0.0.1/32,::1/128,192.168.1.0/24,10.0.0.0/8';

const buildConfigService = (allowedRanges: string | undefined): ConfigService =>
  ({
    get: jest.fn((key: string) =>
      key === 'ALLOWED_IP_RANGES' ? allowedRanges : undefined,
    ),
  }) as unknown as ConfigService;

const buildRequest = (forwardedFor?: string): Request =>
  ({
    headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
    socket: { remoteAddress: undefined },
    method: 'GET',
    originalUrl: '/api/docs',
  }) as unknown as Request;

const buildMiddleware = (
  allowedRanges: string | undefined,
): RedLocalMiddleware =>
  new RedLocalMiddleware(
    new IpAccessService(buildConfigService(allowedRanges)),
  );

describe('RedLocalMiddleware (perimetro de Swagger, PROT-05.3)', () => {
  const response = {} as Response;

  it('deberia invocar next() una sola vez cuando la IP pertenece a la red corporativa', () => {
    // 1. Arrange
    const middleware = buildMiddleware(AUTHORIZED_RANGES);
    const next: NextFunction = jest.fn();

    // 2. Act
    middleware.use(buildRequest('192.168.1.20'), response, next);

    // 3. Assert
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('deberia bloquear con 403 y no invocar next() cuando la IP esta fuera del rango', () => {
    // 1. Arrange
    const middleware = buildMiddleware(AUTHORIZED_RANGES);
    const next: NextFunction = jest.fn();

    // 2. Act & 3. Assert
    expect(() =>
      middleware.use(buildRequest('203.0.113.10'), response, next),
    ).toThrow(new ForbiddenException(ACCESS_DENIED_MESSAGE));
    expect(next).not.toHaveBeenCalled();
  });

  it('deberia bloquear con 403 sin ALLOWED_IP_RANGES configurada (fail-closed)', () => {
    // 1. Arrange
    const middleware = buildMiddleware(undefined);
    const next: NextFunction = jest.fn();

    // 2. Act & 3. Assert
    expect(() =>
      middleware.use(buildRequest('127.0.0.1'), response, next),
    ).toThrow(ForbiddenException);
    expect(next).not.toHaveBeenCalled();
  });
});
