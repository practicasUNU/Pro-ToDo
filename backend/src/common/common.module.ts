import { Global, Module } from '@nestjs/common';

import { RedLocalMiddleware } from '@common/middlewares/red-local.middleware';
import { EmailService } from '@common/services/email.service';
import { CrudEventsCoordinator } from '@common/services/crud-events.coordinator';
import { SessionEventsCoordinator } from '@common/services/session-events.coordinator';
import { SessionRevocationCoordinator } from '@common/services/session-revocation.coordinator';
import { ExecutionEventsCoordinator } from '@common/services/execution-events.coordinator';
import { FlowPollingCoordinator } from '@common/services/flow-polling.coordinator';
import { WorkflowStatusCoordinator } from '@common/services/workflow-status.coordinator';
import { IpAccessService } from '@common/services/ip-access.service';
import { SmtpNodeMailerService } from '@common/services/smtp-node-mailer.service';
import { FsmConfig } from '@core/config/fsm.config';
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
 * Aloja tambien `FsmConfig` por ese mismo caracter global. Sus dos techos de
 * saturacion los consumen `FsmEngineService` (`@core`) y los dos disparadores
 * automaticos (`@modules/nodes`), que no comparten modulo; registrarlo en cada
 * uno crearia dos instancias de una clase que describe un unico limite.
 *
 * Aloja tambien `CrudEventsCoordinator`, que ademas rompe un ciclo real:
 * `NotificationsModule` importa `AuthModule` y este `UsersModule`, de modo que
 * inyectar el gateway en los servicios CRUD seria una dependencia circular.
 *
 * Y aloja `ExecutionEventsCoordinator` por identica razon que al anterior: lo
 * publican `FsmEngineService` (`@core`) y `ExecutionsService`
 * (`@modules/workflows`), y lo implementa `NotificationGateway`
 * (`@modules/notifications`), que no conoce a ninguno de los dos.
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
    SmtpNodeMailerService,
    FlowPollingCoordinator,
    CrudEventsCoordinator,
    ExecutionEventsCoordinator,
    SessionEventsCoordinator,
    SessionRevocationCoordinator,
    WorkflowStatusCoordinator,
    FsmConfig,
  ],
  exports: [
    IpAccessService,
    RedLocalMiddleware,
    EmailService,
    SmtpNodeMailerService,
    FlowPollingCoordinator,
    CrudEventsCoordinator,
    ExecutionEventsCoordinator,
    SessionEventsCoordinator,
    SessionRevocationCoordinator,
    WorkflowStatusCoordinator,
    FsmConfig,
  ],
})
export class CommonModule {}
