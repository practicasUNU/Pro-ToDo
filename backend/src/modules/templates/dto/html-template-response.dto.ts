import { ApiProperty } from '@nestjs/swagger';

import { AuditFieldsResponseDto } from '@common/dto/audit-response.dto';
import { toAuditFields } from '@common/utils/audit.util';

import type { HtmlTemplate } from '../entities/html-template.entity';

/**
 * Plantilla HTML tal como sale por la API.
 *
 * Hasta la migracion 045 el controlador devolvia la entidad en crudo, lo que
 * era inocuo mientras no tuviera relaciones. Con los autores de
 * `AuditableEntity` cargados, devolverla tal cual serializaria la entidad
 * `User` completa: esta proyeccion la reduce a `{ id, email }`.
 */
export class HtmlTemplateResponseDto extends AuditFieldsResponseDto {
  @ApiProperty({ format: 'uuid' })
  readonly id: string;

  @ApiProperty()
  readonly name: string;

  @ApiProperty({ nullable: true, type: String })
  readonly description: string | null;

  @ApiProperty()
  readonly htmlContent: string;

  @ApiProperty({ type: [String] })
  readonly requiredVariables: string[];

  @ApiProperty({ format: 'uuid', description: 'Autor original (JWT del alta)' })
  readonly createdById: string;

  @ApiProperty()
  readonly active: boolean;
}

/** Proyecta la entidad (cargada con `AUDIT_RELATIONS`) a la respuesta. */
export const toHtmlTemplateResponse = (
  template: HtmlTemplate,
): HtmlTemplateResponseDto => ({
  id: template.id,
  name: template.name,
  description: template.description,
  htmlContent: template.htmlContent,
  requiredVariables: template.requiredVariables,
  createdById: template.createdById,
  active: template.active,
  ...toAuditFields(template),
});
