import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PrecioModeloIa } from '@modules/telemetry/entities/precio-modelo-ia.entity';
import { TelemetriaTokensIa } from '@modules/telemetry/entities/telemetria-tokens-ia.entity';
import { TelemetryService } from '@modules/telemetry/telemetry.service';

/**
 * Telemetria de consumo de IA (migracion 045).
 *
 * Hoja del grafo de modulos: no importa ningun modulo de dominio, solo sus
 * repositorios. Asi `NodesModule` puede importarlo sin cerrar ningun ciclo.
 */
@Module({
  imports: [TypeOrmModule.forFeature([TelemetriaTokensIa, PrecioModeloIa])],
  providers: [TelemetryService],
  exports: [TelemetryService],
})
export class TelemetryModule {}
