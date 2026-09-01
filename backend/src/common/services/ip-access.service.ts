import { ForbiddenException, Injectable, Logger } from '@nestjs/common';

import { ACCESS_DENIED_MESSAGE } from '@common/constants/security.constants';
import { extractClientIp } from '@common/utils/client-ip.util';
import { AllowedIpsService } from '@modules/security/allowed-ips/allowed-ips.service';

import type { Request } from 'express';

/**
 * Politica perimetral unica (PROT-05.2 y PROT-05.3).
 *
 * Es la unica fuente de verdad sobre "que IP puede entrar": tanto el `IpWhitelistGuard`
 * (rutas del router de Nest) como el `RedLocalMiddleware` (rutas de Swagger, que viven
 * fuera del router) delegan aqui para evitar duplicar la regla. La resolucion de los
 * rangos autorizados (tabla `allowed_ips` + fallback de arranque) vive en
 * `AllowedIpsService`; este servicio solo orquesta la extraccion de IP y el rechazo.
 */
@Injectable()
export class IpAccessService {
  private readonly logger = new Logger(IpAccessService.name);

  constructor(private readonly allowedIpsService: AllowedIpsService) {}

  /**
   * Verifica que la peticion provenga de la red corporativa / VPN autorizada.
   *
   * Politica estricta fail-closed: si la IP de origen no se puede determinar o no
   * cae en ningun rango autorizado, se rechaza.
   *
   * @throws ForbiddenException (HTTP 403) si el origen no esta autorizado.
   */
  public async assertRequestAllowed(req: Request): Promise<void> {
    const clientIp = extractClientIp(req);

    if (!clientIp) {
      throw this.buildDenial(
        req,
        null,
        'No se pudo determinar la IP de origen',
      );
    }

    if (!(await this.allowedIpsService.isIpAllowed(clientIp))) {
      throw this.buildDenial(
        req,
        clientIp,
        'IP fuera de los rangos CIDR autorizados',
      );
    }
  }

  /**
   * Registra la traza del intento no autorizado (IP, metodo y URL) y construye el rechazo.
   * El motivo tecnico solo viaja al log; al cliente se le devuelve un mensaje generico.
   */
  private buildDenial(
    req: Request,
    clientIp: string | null,
    reason: string,
  ): ForbiddenException {
    this.logger.warn(
      `Acceso perimetral denegado | ip=${clientIp ?? 'desconocida'} | metodo=${req.method} | url=${req.originalUrl ?? req.url} | motivo=${reason}`,
    );

    return new ForbiddenException(ACCESS_DENIED_MESSAGE);
  }
}
