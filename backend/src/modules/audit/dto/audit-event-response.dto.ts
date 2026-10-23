import { ApiProperty } from '@nestjs/swagger';

import { AuditActionType } from '@modules/audit/enums/audit-action.enum';

/** Evento de auditoria tal como sale por la API. */
export class AuditEventResponseDto {
  @ApiProperty({ format: 'uuid' })
  readonly id: string;

  @ApiProperty({ description: 'Instante del evento (ISO 8601, UTC)' })
  readonly createdAt: string;

  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  readonly userId: string | null;

  @ApiProperty({ nullable: true, type: String, example: 'admin@unuware.com' })
  readonly userEmail: string | null;

  @ApiProperty({ enum: AuditActionType })
  readonly action: AuditActionType;

  @ApiProperty({ example: 'usuarios' })
  readonly affectedTable: string;

  @ApiProperty({ nullable: true, type: String })
  readonly recordId: string | null;

  @ApiProperty({ nullable: true, type: Object })
  readonly previousData: Record<string, unknown> | null;

  @ApiProperty({ nullable: true, type: Object })
  readonly newData: Record<string, unknown> | null;

  @ApiProperty({ nullable: true, type: String, example: '192.168.1.20' })
  readonly sourceIp: string | null;
}

/** Pagina del historial, mismo formato que `ExecutionPageResponseDto`. */
export class AuditEventPageResponseDto {
  @ApiProperty({ type: [AuditEventResponseDto] })
  readonly items: AuditEventResponseDto[];

  @ApiProperty()
  readonly total: number;

  @ApiProperty()
  readonly limit: number;

  @ApiProperty()
  readonly offset: number;
}
