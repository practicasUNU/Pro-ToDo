import { ApiProperty } from '@nestjs/swagger';
import { Exclude, Expose, Type } from 'class-transformer';

/**
 * Autor de un cambio tal como sale por la API: identificador y correo, nada
 * mas.
 *
 * Lista blanca (`@Exclude()` de clase) porque lo que llega aqui es la entidad
 * `User` cargada por la relacion de `AuditableEntity`: sin esta proyeccion, su
 * rol, su estado y sus propias columnas de auditoria viajarian al cliente.
 */
@Exclude()
export class AuditUserResponseDto {
  @Expose()
  @ApiProperty({ format: 'uuid' })
  readonly id: string;

  @Expose()
  @ApiProperty({ example: 'usuario@unuware.com' })
  readonly email: string;
}

/**
 * Campos de auditoria comunes a las tablas maestras (migracion 045).
 *
 * `createdBy` / `updatedBy` son `null` en las filas anteriores a la 045 y en
 * las que solo ha tocado el sistema (por ejemplo, el motor al pausar un flujo).
 */
export class AuditFieldsResponseDto {
  @ApiProperty({ description: 'Alta del registro' })
  readonly createdAt: Date;

  @ApiProperty({ description: 'Ultima modificacion del registro' })
  readonly updatedAt: Date;

  @ApiProperty({ type: AuditUserResponseDto, nullable: true })
  @Type(() => AuditUserResponseDto)
  readonly createdBy: AuditUserResponseDto | null;

  @ApiProperty({ type: AuditUserResponseDto, nullable: true })
  @Type(() => AuditUserResponseDto)
  readonly updatedBy: AuditUserResponseDto | null;
}
