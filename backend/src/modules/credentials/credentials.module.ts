import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SecurityCoreModule } from '@core/security/security-core.module';

import { CredentialsController } from './credentials.controller';
import { CredentialsService } from './credentials.service';
import { Credential } from './entities/credential.entity';

/**
 * Boveda de credenciales cifradas (migracion 055).
 *
 * Hoja del grafo: no importa ningun modulo de negocio. La consulta de "en uso"
 * lee `flujos` y `plantillas_flujo` por SQL directo para no importar
 * `WorkflowsModule`, que a traves de `NodesModule` volveria a importar este.
 *
 * Exporta `CredentialsService` para `NodesModule`: la estrategia
 * DESTINO_HTTP_GENERICO es la unica consumidora de `resolveSecret`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Credential]), SecurityCoreModule],
  controllers: [CredentialsController],
  providers: [CredentialsService],
  exports: [CredentialsService],
})
export class CredentialsModule {}
