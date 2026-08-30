import { Global, Module } from '@nestjs/common';

import { RedLocalMiddleware } from '@common/middlewares/red-local.middleware';
import { EmailService } from '@common/services/email.service';
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
  providers: [IpAccessService, RedLocalMiddleware, EmailService],
  exports: [IpAccessService, RedLocalMiddleware, EmailService],
})
export class CommonModule {}
