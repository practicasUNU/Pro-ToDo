import { Module } from '@nestjs/common';

import { NodesModule } from '@modules/nodes/nodes.module';
import { PromptsController } from '@modules/prompts/prompts.controller';
import { PromptOptimizerService } from '@modules/prompts/prompt-optimizer.service';
import { TelemetryModule } from '@modules/telemetry/telemetry.module';

/**
 * Asistente de optimizacion de prompts.
 *
 * Reutiliza los clientes de LLM de `NodesModule` (factoria, catalogo y
 * defaults del entorno) en vez de construir otros: un segundo camino hacia los
 * proveedores tendria su propio mapeo de errores y su propia telemetria, que
 * es justo lo que hay que evitar.
 */
@Module({
  imports: [NodesModule, TelemetryModule],
  controllers: [PromptsController],
  providers: [PromptOptimizerService],
})
export class PromptsModule {}
