import { Injectable } from '@nestjs/common';

import { IpAccessService } from '@common/services/ip-access.service';

import type { NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * Perimetro de red para las rutas que NO pasan por el router de Nest (PROT-05).
 *
 * `SwaggerModule.setup()` registra sus rutas directamente contra el adaptador Express,
 * sin `ExecutionContext`, por lo que ningun `CanActivate` llega a ejecutarse sobre
 * `/api/docs`. Este middleware cubre ese hueco reutilizando exactamente la misma
 * politica que `IpWhitelistGuard`.
 */
@Injectable()
export class RedLocalMiddleware implements NestMiddleware {
  constructor(private readonly ipAccessService: IpAccessService) {}

  public async use(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> {
    await this.ipAccessService.assertRequestAllowed(req);

    next();
  }
}
