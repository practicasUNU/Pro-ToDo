import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { FsmModule } from '@core/fsm/fsm.module';

import { Workflow } from './entities/workflow.entity';
import { WorkflowsController } from './workflows.controller';
import { WorkflowsService } from './workflows.service';

/**
 * Modulo de operacion de flujos.
 *
 * Importa `FsmModule` por sus dos servicios exportados —`PipelineValidatorService`
 * y `FsmEngineService`— en lugar de replicar validacion o bucle de ejecucion.
 *
 * NO importa `NodesModule`: las estrategias se inscriben solas en la instancia
 * compartida de `NodeStrategyFactory` cuando `AppModule` levanta `NodesModule`,
 * asi que el despachador solo necesita el motor. Acoplarlo a los nodos obligaria
 * a tocar este modulo cada vez que se anada un tipo de nodo nuevo, que es justo
 * lo que la factoria evita.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Workflow]), FsmModule],
  controllers: [WorkflowsController],
  providers: [WorkflowsService],
  exports: [WorkflowsService],
})
export class WorkflowsModule {}
