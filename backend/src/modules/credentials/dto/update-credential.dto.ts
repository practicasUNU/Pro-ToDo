import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

import { TrimmedString } from '@common/decorators/trimmed-string.decorator';

import {
  ApiKeyPlacement,
  CredentialAuthType,
} from '../enums/credential-auth-type.enum';
import {
  API_KEY_NAME_PATTERN,
  MAX_CREDENTIAL_NAME_LENGTH,
  MAX_SECRET_LENGTH,
} from './credential-fields';

/**
 * Edicion de una credencial. TODO es opcional, y el secreto es de SOLO ESCRITURA.
 *
 * El panel nunca recibe el secreto guardado, asi que no puede reenviarlo: un
 * PATCH que solo cambia el nombre deja el cifrado intacto. Si llega cualquier
 * campo secreto (o un `authType` nuevo), `CredentialsService` exige el juego
 * COMPLETO del tipo resultante y vuelve a cifrar; un secreto a medias no se
 * mezcla con el anterior, porque eso exigiria descifrarlo fuera del motor.
 *
 * No es `PartialType(CreateCredentialDto)`: aquel arrastraria los `ValidateIf`
 * por tipo, que aqui deben ceder a la regla de "todo o nada" del servicio.
 */
export class UpdateCredentialDto {
  @ApiPropertyOptional()
  @IsOptional()
  @TrimmedString()
  @IsString({ message: 'name debe ser una cadena.' })
  @IsNotEmpty({ message: 'name no puede quedar vacio.' })
  @MaxLength(MAX_CREDENTIAL_NAME_LENGTH, {
    message: `name no puede superar ${MAX_CREDENTIAL_NAME_LENGTH} caracteres.`,
  })
  name?: string;

  @ApiPropertyOptional({ enum: CredentialAuthType })
  @IsOptional()
  @IsEnum(CredentialAuthType, {
    message: `authType debe ser uno de: ${Object.values(CredentialAuthType).join(', ')}.`,
  })
  authType?: CredentialAuthType;

  @ApiPropertyOptional({ writeOnly: true })
  @IsOptional()
  @IsString({ message: 'token debe ser una cadena.' })
  @IsNotEmpty({ message: 'token no puede quedar vacio.' })
  @MaxLength(MAX_SECRET_LENGTH, {
    message: `token no puede superar ${MAX_SECRET_LENGTH} caracteres.`,
  })
  token?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString({ message: 'username debe ser una cadena.' })
  @Matches(/^[^:\r\n]+$/, {
    message: 'username no puede contener ":" ni saltos de linea.',
  })
  @MaxLength(MAX_CREDENTIAL_NAME_LENGTH, {
    message: `username no puede superar ${MAX_CREDENTIAL_NAME_LENGTH} caracteres.`,
  })
  username?: string;

  @ApiPropertyOptional({ writeOnly: true })
  @IsOptional()
  @IsString({ message: 'password debe ser una cadena.' })
  @IsNotEmpty({ message: 'password no puede quedar vacio.' })
  @MaxLength(MAX_SECRET_LENGTH, {
    message: `password no puede superar ${MAX_SECRET_LENGTH} caracteres.`,
  })
  password?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString({ message: 'keyName debe ser una cadena.' })
  @Matches(API_KEY_NAME_PATTERN, {
    message: 'keyName solo admite letras, digitos, "-" y "_" (maximo 100).',
  })
  keyName?: string;

  @ApiPropertyOptional({ writeOnly: true })
  @IsOptional()
  @IsString({ message: 'apiKey debe ser una cadena.' })
  @IsNotEmpty({ message: 'apiKey no puede quedar vacio.' })
  @MaxLength(MAX_SECRET_LENGTH, {
    message: `apiKey no puede superar ${MAX_SECRET_LENGTH} caracteres.`,
  })
  apiKey?: string;

  @ApiPropertyOptional({ enum: ApiKeyPlacement })
  @IsOptional()
  @IsEnum(ApiKeyPlacement, {
    message: `placement debe ser uno de: ${Object.values(ApiKeyPlacement).join(', ')}.`,
  })
  placement?: ApiKeyPlacement;
}
