import { Module } from '@nestjs/common';

import { NodeStrategyFactory } from '@core/fsm/factories/node-strategy.factory';
import { FsmModule } from '@core/fsm/fsm.module';
import { TemplatesModule } from '@modules/templates/templates.module';

import { TemplateMapperStrategy } from './strategies/template-mapper.strategy';

import type { OnModuleInit } from '@nestjs/common';

/**
 * Modulo de nodos: agrupa las estrategias reales de la FSM y las inscribe en la
 * factoria (PROT-10/PROT-11.2).
 *
 * El registro se hace aqui, en `onModuleInit`, y no dentro de
 * `NodeStrategyFactory`: la factoria es deliberadamente agnostica de estrategias
 * concretas (registro explicito, sin descubrimiento automatico), y `FsmModule`
 * exporta la instancia justo para que los modulos de nodos escriban sobre la
 * MISMA que consume `FsmEngineService`.
 *
 * A diferencia de las estrategias de andamiaje de `strategies/dummies/`, estas
 * si se instancian por inyeccion: necesitan servicios del contenedor.
 */
@Module({
  imports: [FsmModule, TemplatesModule],
  providers: [TemplateMapperStrategy],
  exports: [TemplateMapperStrategy],
})
export class NodesModule implements OnModuleInit {
  constructor(
    private readonly strategyFactory: NodeStrategyFactory,
    private readonly templateMapperStrategy: TemplateMapperStrategy,
  ) {}

  public onModuleInit(): void {
    this.strategyFactory.registerStrategy(this.templateMapperStrategy);
  }
}
