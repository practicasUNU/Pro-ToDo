import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { FsmModule } from '@core/fsm/fsm.module';
import { LogsModule } from '@modules/logs/logs.module';
import { NodeCatalogEntry } from '@modules/nodes/entities/node-catalog.entity';
import { UsersModule } from '@modules/users/users.module';
import { WorkflowTemplatesModule } from '@modules/workflow-templates/workflow-templates.module';

import { Workflow } from './entities/workflow.entity';
import { ExecutionsController } from './executions.controller';
import { ExecutionsService } from './executions.service';
import { InboundEmailResumeService } from './inbound-email-resume.service';
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
    // `NodeCatalogEntry` y no `NodesModule`: `InboundEmailResumeService` solo
    // necesita leer el par `codigo`/`nombre` de la tabla `nodos` para entender
    // "DESDE Disparador IMAP". Registrar la entidad cuesta una linea; importar
    // el modulo de nodos ataria este al grafo de estrategias, que es justo lo
    // que la nota de arriba explica que no se hace.
    TypeOrmModule.forFeature([Workflow, NodeCatalogEntry]),
    FsmModule,
    // Por `WorkflowTemplatesService`: comprueba el `templateId` al instanciar.
    // La dependencia va en un solo sentido; el catalogo no conoce este modulo.
    WorkflowTemplatesModule,
    // Por la marca de demarcacion que `ExecutionsService` escribe al reanudar:
    // `LogsModule` no es global desde que salio de `CommonModule`.
    LogsModule,
    // Por `InboundEmailResumeService`: comprueba contra `usuarios` quien firma
    // la orden que llega por correo.
    UsersModule,
  ],
  controllers: [WorkflowsController, ExecutionsController],
  providers: [WorkflowsService, ExecutionsService, InboundEmailResumeService],
  // `InboundEmailResumeService` se exporta para `ImapTriggerStrategy`
  // (`NodesModule`), que se topa con las ordenes de reanudacion en el buzon que
  // sondea el propio flujo —el operador responde al correo de alerta— y tiene
  // que despacharlas por la misma puerta que el barrido del buzon de ordenes.
  // El grafo sigue siendo aciclico: `NodesModule` importa este, no al reves.
  exports: [WorkflowsService, InboundEmailResumeService],
})
export class WorkflowsModule {}
