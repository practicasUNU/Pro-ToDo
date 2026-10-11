import { ForbiddenException, Injectable, Logger } from '@nestjs/common';

import { ACCESS_DENIED_MESSAGE } from '@common/constants/security.constants';
import { extractClientIp } from '@common/utils/client-ip.util';
import { AllowedIpsService } from '@modules/security/allowed-ips/allowed-ips.service';

import type { ClientIpSource } from '@common/utils/client-ip.util';
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
   * Misma politica, para transportes que no son el router HTTP de Nest.
   *
   * La usa `NotificationGateway` sobre el handshake de Socket.io. Devuelve un
   * booleano en vez de lanzar porque ahi no hay respuesta HTTP donde colgar un
   * 403: quien rechaza es el middleware del handshake, cortando la conexion
   * antes de que llegue a establecerse.
   *
   * Comparte `extractClientIp` con la ruta HTTP y eso es lo importante. Duplicar
   * aqui la precedencia `x-forwarded-for` -> `x-real-ip` -> socket seria crear
   * una segunda definicion de "IP de origen" que se puede desviar de la primera
   * sin que ninguna prueba lo note.
   *
   * Fail-closed igual que su hermana: sin IP determinable, se deniega.
   */
  public async isOriginAllowed(source: ClientIpSource): Promise<boolean> {
    const clientIp = extractClientIp(source);

    if (!clientIp) {
      this.logger.warn(
        'Acceso perimetral denegado | ip=desconocida | transporte=no-http | motivo=No se pudo determinar la IP de origen',
      );
      return false;
    }

    if (!(await this.allowedIpsService.isIpAllowed(clientIp))) {
      this.logger.warn(
        `Acceso perimetral denegado | ip=${clientIp} | transporte=no-http | motivo=IP fuera de los rangos CIDR autorizados`,
      );
      return false;
    }

    return true;
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
