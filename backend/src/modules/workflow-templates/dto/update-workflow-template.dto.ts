import { PartialType } from '@nestjs/mapped-types';

import { CreateWorkflowTemplateDto } from './create-workflow-template.dto';

/**
 * Edicion de una plantilla de flujo.
 *
 * `PartialType` deja los cuatro campos opcionales, de modo que un solo verbo
 * cubre editar, activar e inactivar: `{ active: false }` retira la plantilla del
 * selector sin tocar su topologia. Mismo patron que `UpdateTemplateDto`.
 */
export class UpdateWorkflowTemplateDto extends PartialType(
  CreateWorkflowTemplateDto,
) {}
