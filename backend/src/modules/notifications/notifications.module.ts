import { Module } from '@nestjs/common';

import { AuthModule } from '@modules/auth/auth.module';
import { NotificationGateway } from '@modules/notifications/notification.gateway';
import { WorkflowsModule } from '@modules/workflows/workflows.module';

/**
 * Canal WebSocket de eventos de ejecucion (`architecture-patterns.md` §5).
 *
 * Importa `AuthModule` solo por `JwtService`: ese modulo reexporta `JwtModule`
 * ya configurado con `JWT_SECRET`, de modo que el gateway verifica el handshake
 * con el mismo secreto y las mismas opciones que las rutas HTTP. Registrar aqui
 * un `JwtModule` propio abriria la puerta a que ambos se configurasen distinto.
 *
 * Importa `WorkflowsModule` por `WorkflowsService`: `flow:subscribe` comprueba
 * que el flujo exista antes de inscribir al socket en su sala. La dependencia
 * va en un solo sentido —el modulo de flujos no conoce el gateway, que recibe
 * los eventos por `ExecutionEventsCoordinator`—, de modo que no hay ciclo.
 *
 * No declara `IpAccessService` ni `ExecutionEventsCoordinator`: los provee
 * `CommonModule`, que es global.
 */
@Module({
  imports: [AuthModule, WorkflowsModule],
  providers: [NotificationGateway],
})
export class NotificationsModule {}
