import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { IS_PUBLIC_IP_KEY } from '@common/constants/security.constants';
import { IpAccessService } from '@common/services/ip-access.service';

import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Guard perimetral global (PROT-05): valida que toda peticion al router de Nest
 * provenga de la red corporativa / VPN autorizada.
 *
 * Se registra como `APP_GUARD`, por lo que se ejecuta antes que los guards de
 * controlador (`JwtAuthGuard`, `RolesGuard`): la IP se rechaza antes de procesar
 * credenciales, cumpliendo el requisito de rechazo temprano.
 *
 * Las rutas marcadas con `@PublicIp()` quedan exentas.
 */
@Injectable()
export class IpWhitelistGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly ipAccessService: IpAccessService,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublicIp = this.reflector.getAllAndOverride<boolean>(
      IS_PUBLIC_IP_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (isPublicIp) return true;

    await this.ipAccessService.assertRequestAllowed(
      context.switchToHttp().getRequest<Request>(),
    );

    return true;
  }
}
