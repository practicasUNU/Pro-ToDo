import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { FsmModule } from '@core/fsm/fsm.module';
import { LogsModule } from '@modules/logs/logs.module';
import { WorkflowTemplatesModule } from '@modules/workflow-templates/workflow-templates.module';

import { Workflow } from './entities/workflow.entity';
import { ExecutionsController } from './executions.controller';
import { ExecutionsService } from './executions.service';
import { WorkflowsController } from './workflows.controller';
import { WorkflowsService } from './workflows.service';

/**
 * Modulo de operacion de flujos.
 *
 * Importa `FsmModule` por sus dos servicios exportados —`PipelineValidatorService`
 * y `FsmEngineService`— en lugar de replicar validacion o bucle de ejecucion.
 *
 * Aloja tambien la superficie de EJECUCIONES (`ExecutionsController`), y no un
 * modulo propio, porque reanudar necesita la fila de `flujos` para revalidar su
 * esquema: `@core` no puede importar de `@modules`, y un modulo aparte tendria
 * que duplicar el `forFeature([Workflow])` o importar este para nada.
 *
 * NO importa `NodesModule`: las estrategias se inscriben solas en la instancia
 * compartida de `NodeStrategyFactory` cuando `AppModule` levanta `NodesModule`,
 * asi que el despachador solo necesita el motor. Acoplarlo a los nodos obligaria
 * a tocar este modulo cada vez que se anada un tipo de nodo nuevo, que es justo
 * lo que la factoria evita.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Workflow]),
    FsmModule,
    // Por `WorkflowTemplatesService`: comprueba el `templateId` al instanciar.
    // La dependencia va en un solo sentido; el catalogo no conoce este modulo.
    WorkflowTemplatesModule,
    // Por la marca de demarcacion que `ExecutionsService` escribe al reanudar:
    // `LogsModule` no es global desde que salio de `CommonModule`.
    LogsModule,
  ],
  controllers: [WorkflowsController, ExecutionsController],
  providers: [WorkflowsService, ExecutionsService],
  exports: [WorkflowsService],
})
export class WorkflowsModule {}
