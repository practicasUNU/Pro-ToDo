import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { FsmModule } from '@core/fsm/fsm.module';

import { WorkflowTemplate } from './entities/workflow-template.entity';
import { WorkflowTemplatesController } from './workflow-templates.controller';
import { WorkflowTemplatesService } from './workflow-templates.service';

/**
 * Catalogo de plantillas de flujo (blueprints maestros).
 *
 * Importa `FsmModule` por `PipelineValidatorService`: el grafo de una plantilla
 * se valida con la MISMA pieza que el de un flujo, para que ambos caminos exijan
 * exactamente lo mismo. Replicar la validacion aqui abriria la puerta a una
 * plantilla que el catalogo acepta y el motor rechaza.
 *
 * Exporta el servicio porque `WorkflowsModule` lo inyecta para comprobar el
 * `templateId` al instanciar un flujo. La dependencia va en un solo sentido:
 * este modulo NO conoce `WorkflowsModule`, y esa asimetria es lo que mantiene el
 * grafo de modulos aciclico.
 */
@Module({
  imports: [TypeOrmModule.forFeature([WorkflowTemplate]), FsmModule],
  controllers: [WorkflowTemplatesController],
  providers: [WorkflowTemplatesService],
  exports: [WorkflowTemplatesService],
})
export class WorkflowTemplatesModule {}
