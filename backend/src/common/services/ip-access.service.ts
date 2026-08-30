import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import ipRangeCheck from 'ip-range-check';

import {
  ACCESS_DENIED_MESSAGE,
  ALLOWED_IP_RANGES_ENV,
} from '@common/constants/security.constants';
import { extractClientIp } from '@common/utils/client-ip.util';

import type { Request } from 'express';

/**
 * Politica perimetral unica (PROT-05.2 y PROT-05.3).
 *
 * Es la unica fuente de verdad sobre "que IP puede entrar": tanto el `IpWhitelistGuard`
 * (rutas del router de Nest) como el `RedLocalMiddleware` (rutas de Swagger, que viven
 * fuera del router) delegan aqui para evitar duplicar la regla.
 */
@Injectable()
export class IpAccessService {
  private readonly logger = new Logger(IpAccessService.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Rangos CIDR autorizados, parseados desde `ALLOWED_IP_RANGES`.
   * Se lee en cada peticion (no se cachea) para que un cambio de configuracion
   * en caliente no requiera reiniciar el proceso.
   */
  private getAllowedRanges(): string[] {
    return (this.configService.get<string>(ALLOWED_IP_RANGES_ENV) ?? '')
      .split(',')
      .map((range) => range.trim())
      .filter(Boolean);
  }

  /**
   * Verifica que la peticion provenga de la red corporativa / VPN autorizada.
   *
   * Politica estricta fail-closed: si la lista de rangos no esta definida, esta vacia
   * o la IP de origen no se puede determinar, se rechaza. Nunca se abre el perimetro
   * por ausencia de configuracion.
   *
   * @throws ForbiddenException (HTTP 403) si el origen no esta autorizado.
   */
  public assertRequestAllowed(req: Request): void {
    const allowedRanges = this.getAllowedRanges();

    if (allowedRanges.length === 0) {
      throw this.buildDenial(
        req,
        null,
        'ALLOWED_IP_RANGES no esta configurada (politica fail-closed)',
      );
    }

    const clientIp = extractClientIp(req);

    if (!clientIp) {
      throw this.buildDenial(
        req,
        null,
        'No se pudo determinar la IP de origen',
      );
    }

    if (!ipRangeCheck(clientIp, allowedRanges)) {
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
