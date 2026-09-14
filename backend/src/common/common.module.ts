import { Global, Module } from '@nestjs/common';

import { RedLocalMiddleware } from '@common/middlewares/red-local.middleware';
import { EmailService } from '@common/services/email.service';
import { FlowPollingCoordinator } from '@common/services/flow-polling.coordinator';
import { IpAccessService } from '@common/services/ip-access.service';
import { AllowedIpsModule } from '@modules/security/allowed-ips/allowed-ips.module';

/**
 * Infraestructura transversal de seguridad perimetral (PROT-05).
 *
 * `HybridLoggerService` vivia aqui y se mudo a `LogsModule` al ganar un
 * repositorio propio: una entidad de dominio en la capa comun obligaria a este
 * modulo a declarar el `forFeature` de una tabla que solo usa aquel servicio.
 *
 * Aloja en cambio `FlowPollingCoordinator`, el puerto que permite
 * a `WorkflowsService` cortar el sondeo IMAP de un flujo sin inyectar
 * `ImapPollingService`: `NodesModule` ya importa `WorkflowsModule`, asi que la
 * dependencia directa cerraria un ciclo de modulos. Que este modulo sea global
 * es justo lo que evita ese acoplamiento.
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
    FlowPollingCoordinator,
  ],
  exports: [
    IpAccessService,
    RedLocalMiddleware,
    EmailService,
    FlowPollingCoordinator,
  ],
})
export class CommonModule {}
