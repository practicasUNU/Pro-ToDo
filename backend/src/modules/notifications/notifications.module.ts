import { Module } from '@nestjs/common';

import { AuthModule } from '@modules/auth/auth.module';
import { NotificationGateway } from '@modules/notifications/notification.gateway';

/**
 * Canal WebSocket de eventos de ejecucion (`architecture-patterns.md` §5).
 *
 * Importa `AuthModule` solo por `JwtService`: ese modulo reexporta `JwtModule`
 * ya configurado con `JWT_SECRET`, de modo que el gateway verifica el handshake
 * con el mismo secreto y las mismas opciones que las rutas HTTP. Registrar aqui
 * un `JwtModule` propio abriria la puerta a que ambos se configurasen distinto.
 *
 * No declara `IpAccessService` ni `ExecutionEventsCoordinator`: los provee
 * `CommonModule`, que es global.
 */
@Module({
  imports: [AuthModule],
  providers: [NotificationGateway],
})
export class NotificationsModule {}
