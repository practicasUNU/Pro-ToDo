import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditModule } from '@modules/audit/audit.module';
import { PrecioModeloIa } from '@modules/telemetry/entities/precio-modelo-ia.entity';

import { PricingController } from './pricing.controller';
import { PricingService } from './pricing.service';

/**
 * CRUD de tarifas de IA (ADMIN).
 *
 * Reutiliza la entidad de `TelemetryModule` en lugar de moverla: la telemetria
 * es su lectora en caliente (`resolvePricing`) y este modulo solo su escritor
 * administrativo. Registrar la misma entidad en dos `forFeature` es legitimo y
 * evita que `TelemetryModule` dependa de un modulo de administracion.
 */
@Module({
  imports: [TypeOrmModule.forFeature([PrecioModeloIa]), AuditModule],
  controllers: [PricingController],
  providers: [PricingService],
})
export class PricingModule {}
