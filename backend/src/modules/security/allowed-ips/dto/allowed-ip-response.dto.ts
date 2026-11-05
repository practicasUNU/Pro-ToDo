import { ApiProperty } from '@nestjs/swagger';

import { AuditFieldsResponseDto } from '@common/dto/audit-response.dto';
import { toAuditFields } from '@common/utils/audit.util';

import type { AllowedIp } from '../entities/allowed-ip.entity';

/**
 * IP/CIDR autorizada tal como sale por la API.
 *
 * Hasta ahora el controlador devolvia la entidad en crudo. Con los autores de
 * `AuditableEntity` cargados, eso serializaria la entidad `User` completa: esta
 * proyeccion la reduce a `{ id, email }`, igual que en el resto de maestras.
 */
export class AllowedIpResponseDto extends AuditFieldsResponseDto {
  @ApiProperty({ format: 'uuid' })
  readonly id: string;

  @ApiProperty({ example: '192.168.1.0/24' })
  readonly ipOrCidr: string;

  @ApiProperty()
  readonly description: string;
}

/** Proyecta la entidad (cargada con `AUDIT_RELATIONS`) a la respuesta. */
export const toAllowedIpResponse = (
  entry: AllowedIp,
): AllowedIpResponseDto => ({
  id: entry.id,
  ipOrCidr: entry.ipOrCidr,
  description: entry.description,
  ...toAuditFields(entry),
});
