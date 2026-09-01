import { ForbiddenException } from '@nestjs/common';

import { ACCESS_DENIED_MESSAGE } from '@common/constants/security.constants';
import { IpAccessService } from '@common/services/ip-access.service';

import type { AllowedIpsService } from '@modules/security/allowed-ips/allowed-ips.service';
import type { Request } from 'express';

type AllowedIpsServiceMock = jest.Mocked<
  Pick<AllowedIpsService, 'isIpAllowed'>
>;

/** `AllowedIpsService` doble: solo se necesita `isIpAllowed`. */
const buildAllowedIpsService = (isAllowed: boolean): AllowedIpsServiceMock => ({
  isIpAllowed: jest.fn().mockResolvedValue(isAllowed),
});

const buildRequest = (forwardedFor?: string): Request =>
  ({
    headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
    socket: { remoteAddress: undefined },
    method: 'GET',
    originalUrl: '/api/protegido',
  }) as unknown as Request;

describe('IpAccessService (PROT-05.1)', () => {
  it('deberia resolver sin error cuando la IP esta autorizada', async () => {
    // 1. Arrange
    const allowedIpsService = buildAllowedIpsService(true);
    const service = new IpAccessService(
      allowedIpsService as unknown as AllowedIpsService,
    );

    // 2. Act & 3. Assert
    await expect(
      service.assertRequestAllowed(buildRequest('192.168.1.55')),
    ).resolves.toBeUndefined();
    expect(allowedIpsService.isIpAllowed).toHaveBeenCalledWith('192.168.1.55');
  });

  it('deberia lanzar 403 cuando la IP no esta autorizada', async () => {
    // 1. Arrange
    const allowedIpsService = buildAllowedIpsService(false);
    const service = new IpAccessService(
      allowedIpsService as unknown as AllowedIpsService,
    );

    // 2. Act & 3. Assert
    await expect(
      service.assertRequestAllowed(buildRequest('203.0.113.10')),
    ).rejects.toThrow(new ForbiddenException(ACCESS_DENIED_MESSAGE));
  });

  it('deberia lanzar 403 sin consultar el servicio cuando la IP de origen no se puede determinar', async () => {
    // 1. Arrange
    const allowedIpsService = buildAllowedIpsService(true);
    const service = new IpAccessService(
      allowedIpsService as unknown as AllowedIpsService,
    );

    // 2. Act & 3. Assert
    await expect(service.assertRequestAllowed(buildRequest())).rejects.toThrow(
      ForbiddenException,
    );
    expect(allowedIpsService.isIpAllowed).not.toHaveBeenCalled();
  });
});
