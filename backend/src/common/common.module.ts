import { Global, Module } from '@nestjs/common';

import { RedLocalMiddleware } from '@common/middlewares/red-local.middleware';
import { IpAccessService } from '@common/services/ip-access.service';

/**
 * Infraestructura transversal de seguridad perimetral (PROT-05).
 *
 * Es global para que cualquier modulo pueda inyectar `IpAccessService` sin reimportarlo,
 * y expone `RedLocalMiddleware` como provider para poder resolverlo desde `main.ts`
 * y montarlo sobre las rutas de Swagger.
 */
@Global()
@Module({
  providers: [IpAccessService, RedLocalMiddleware],
  exports: [IpAccessService, RedLocalMiddleware],
})
export class CommonModule {}
