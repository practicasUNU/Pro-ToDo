import { ApiProperty } from '@nestjs/swagger';
import { Exclude, Expose, Type } from 'class-transformer';

import { AuditUserResponseDto } from '@common/dto/audit-response.dto';

import { CredentialAuthType } from '../enums/credential-auth-type.enum';

/**
 * Representacion publica de una credencial: sus METADATOS, nunca el secreto.
 *
 * `@Exclude()` de clase: solo sale lo marcado con `@Expose()`. Ni el texto
 * plano —que la entidad no tiene— ni las tres columnas criptograficas pueden
 * filtrarse por olvido, aunque alguien las cargue con `addSelect`.
 */
@Exclude()
export class CredentialResponseDto {
  @Expose()
  @ApiProperty({ format: 'uuid' })
  id: string;

  @Expose()
  @ApiProperty()
  name: string;

  @Expose()
  @ApiProperty({ enum: CredentialAuthType })
  authType: CredentialAuthType;

  @Expose()
  @ApiProperty()
  createdAt: Date;

  @Expose()
  @ApiProperty()
  updatedAt: Date;

  /** Autor del alta; `null` en las filas anteriores a la migracion 058. */
  @Expose()
  @ApiProperty({ type: AuditUserResponseDto, nullable: true })
  @Type(() => AuditUserResponseDto)
  createdBy: AuditUserResponseDto | null;

  /** Ultimo en modificar o rotar el secreto; `null` si no consta. */
  @Expose()
  @ApiProperty({ type: AuditUserResponseDto, nullable: true })
  @Type(() => AuditUserResponseDto)
  updatedBy: AuditUserResponseDto | null;
}

/**
 * Opcion del selector cerrado del nodo DESTINO_HTTP_GENERICO.
 *
 * Es lo UNICO que ve un EDITOR de la boveda: con que nombre elegir una
 * credencial y de que tipo es, para filtrar por el `authType` del nodo.
 */
@Exclude()
export class CredentialOptionDto {
  @Expose()
  @ApiProperty({ format: 'uuid' })
  id: string;

  @Expose()
  @ApiProperty()
  name: string;

  @Expose()
  @ApiProperty({ enum: CredentialAuthType })
  authType: CredentialAuthType;
}
