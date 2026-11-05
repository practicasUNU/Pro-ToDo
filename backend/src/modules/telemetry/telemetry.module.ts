import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { FsmExecution } from '@core/fsm/entities/fsm-execution.entity';
import { BrowserModule } from '@modules/nodes/browser.module';
import { PrecioModeloIa } from '@modules/telemetry/entities/precio-modelo-ia.entity';
import { TelemetriaTokensIa } from '@modules/telemetry/entities/telemetria-tokens-ia.entity';
import { TelemetryPdfRenderer } from '@modules/telemetry/reports/telemetry-pdf.renderer';
import { TelemetryController } from '@modules/telemetry/telemetry.controller';
import { TelemetryQueryService } from '@modules/telemetry/telemetry-query.service';
import { TelemetryService } from '@modules/telemetry/telemetry.service';

/**
 * Telemetria de consumo de IA (migraciones 045 y 046): registro de cada
 * inferencia, agregados para el dashboard y exportaciones CSV/PDF.
 *
 * Casi una hoja del grafo de modulos: solo importa repositorios y
 * `BrowserModule`, que a su vez es hoja (el Chromium compartido del PDF). Asi
 * `NodesModule` puede importarlo sin cerrar ningun ciclo.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      TelemetriaTokensIa,
      PrecioModeloIa,
      FsmExecution,
    ]),
    BrowserModule,
  ],
  controllers: [TelemetryController],
  providers: [TelemetryService, TelemetryQueryService, TelemetryPdfRenderer],
  exports: [TelemetryService],
})
export class TelemetryModule {}
