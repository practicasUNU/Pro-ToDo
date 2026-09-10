import { Global, Module } from '@nestjs/common';

import { RedLocalMiddleware } from '@common/middlewares/red-local.middleware';
import { EmailService } from '@common/services/email.service';
import { HybridLoggerService } from '@common/services/hybrid-logger.service';
import { IpAccessService } from '@common/services/ip-access.service';
import { AllowedIpsModule } from '@modules/security/allowed-ips/allowed-ips.module';

/**
 * Infraestructura transversal de seguridad perimetral (PROT-05).
 *
 * Aloja tambien `HybridLoggerService`, el volcado forense del motor FSM: es
 * transversal por naturaleza —cualquier capa puede necesitar dejar constancia de
 * un fallo catastrofico— y no pertenece al dominio de ningun modulo concreto.
 *
 * Es global para que cualquier modulo pueda inyectar `IpAccessService` sin reimportarlo,
 * y expone `RedLocalMiddleware` como provider para poder resolverlo desde `main.ts`
 * y montarlo sobre las rutas de Swagger. Importa `AllowedIpsModule` porque
 * `IpAccessService` delega en `AllowedIpsService` la resolucion de rangos autorizados.
 */
@Global()
@Module({
  imports: [AllowedIpsModule],
  providers: [
    IpAccessService,
    RedLocalMiddleware,
    EmailService,
    HybridLoggerService,
  ],
  exports: [
    IpAccessService,
    RedLocalMiddleware,
    EmailService,
    HybridLoggerService,
  ],
})
export class CommonModule {}
