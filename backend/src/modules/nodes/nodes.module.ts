import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { NodeStrategyFactory } from '@core/fsm/factories/node-strategy.factory';
import { FsmModule } from '@core/fsm/fsm.module';
import { TemplatesModule } from '@modules/templates/templates.module';
import { Workflow } from '@modules/workflows/entities/workflow.entity';
import { WorkflowsModule } from '@modules/workflows/workflows.module';

import { ImapPollingService } from './services/imap-polling.service';
import { ImapTriggerStrategy } from './strategies/imap-trigger.strategy';
import { TemplateMapperStrategy } from './strategies/template-mapper.strategy';

import type { OnModuleInit } from '@nestjs/common';

/**
 * Modulo de nodos: agrupa las estrategias reales de la FSM y las inscribe en la
 * factoria (PROT-10/PROT-11.2/PROT-12).
 *
 * El registro se hace aqui, en `onModuleInit`, y no dentro de
 * `NodeStrategyFactory`: la factoria es deliberadamente agnostica de estrategias
 * concretas (registro explicito, sin descubrimiento automatico), y `FsmModule`
 * exporta la instancia justo para que los modulos de nodos escriban sobre la
 * MISMA que consume `FsmEngineService`.
 *
 * A diferencia de las estrategias de andamiaje de `strategies/dummies/`, estas
 * si se instancian por inyeccion: necesitan servicios del contenedor.
 *
 * Importa `WorkflowsModule` por `WorkflowsService`, que es quien despacha el
 * flujo cuando el sondeo IMAP detecta correo nuevo. La dependencia va en un solo
 * sentido: `WorkflowsModule` NO importa este modulo a proposito (las estrategias
 * se inscriben solas en la factoria compartida), y esa asimetria es justo lo que
 * mantiene el grafo de modulos aciclico.
 */
@Module({
  imports: [
    FsmModule,
    TemplatesModule,
    WorkflowsModule,
    // El sondeo lee `flujos` para descubrir que buzones vigilar.
    TypeOrmModule.forFeature([Workflow]),
  ],
  providers: [TemplateMapperStrategy, ImapTriggerStrategy, ImapPollingService],
  exports: [TemplateMapperStrategy, ImapTriggerStrategy, ImapPollingService],
})
export class NodesModule implements OnModuleInit {
  constructor(
    private readonly strategyFactory: NodeStrategyFactory,
    private readonly templateMapperStrategy: TemplateMapperStrategy,
    private readonly imapTriggerStrategy: ImapTriggerStrategy,
  ) {}

  public onModuleInit(): void {
    this.strategyFactory.registerStrategy(this.templateMapperStrategy);
    this.strategyFactory.registerStrategy(this.imapTriggerStrategy);
  }
}
