import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
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
 * Alta de una credencial. Los campos secretos se exigen SEGUN el tipo.
 *
 * Plano y no anidado (`{ secret: {...} }`) a proposito: `ValidateIf` por tipo
 * expresa el discriminante sin un `@Type` polimorfico, y el formulario del
 * panel envia exactamente estos campos.
 *
 * Los secretos NO llevan `@TrimmedString`: un espacio puede ser parte legitima
 * de una contrasena, y recortarlo cambiaria la credencial sin avisar.
 */
export class CreateCredentialDto {
  @ApiProperty({ example: 'API de becas (produccion)' })
  @TrimmedString()
  @IsString({ message: 'name debe ser una cadena.' })
  @IsNotEmpty({ message: 'name es obligatorio.' })
  @MaxLength(MAX_CREDENTIAL_NAME_LENGTH, {
    message: `name no puede superar ${MAX_CREDENTIAL_NAME_LENGTH} caracteres.`,
  })
  name: string;

  @ApiProperty({ enum: CredentialAuthType })
  @IsEnum(CredentialAuthType, {
    message: `authType debe ser uno de: ${Object.values(CredentialAuthType).join(', ')}.`,
  })
  authType: CredentialAuthType;

  @ApiPropertyOptional({
    description: 'Obligatorio en BEARER_TOKEN',
    writeOnly: true,
  })
  @ValidateIf(
    (dto: CreateCredentialDto) =>
      dto.authType === CredentialAuthType.BEARER_TOKEN,
  )
  @IsString({ message: 'token debe ser una cadena.' })
  @IsNotEmpty({ message: 'token es obligatorio en BEARER_TOKEN.' })
  @MaxLength(MAX_SECRET_LENGTH, {
    message: `token no puede superar ${MAX_SECRET_LENGTH} caracteres.`,
  })
  token?: string;

  @ApiPropertyOptional({ description: 'Obligatorio en BASIC_AUTH' })
  @ValidateIf(
    (dto: CreateCredentialDto) =>
      dto.authType === CredentialAuthType.BASIC_AUTH,
  )
  @IsString({ message: 'username debe ser una cadena.' })
  @IsNotEmpty({ message: 'username es obligatorio en BASIC_AUTH.' })
  // RFC 7617: el usuario no puede contener dos puntos, que separan usuario y
  // contrasena dentro del valor codificado.
  @Matches(/^[^:\r\n]+$/, {
    message: 'username no puede contener ":" ni saltos de linea.',
  })
  @MaxLength(MAX_CREDENTIAL_NAME_LENGTH, {
    message: `username no puede superar ${MAX_CREDENTIAL_NAME_LENGTH} caracteres.`,
  })
  username?: string;

  @ApiPropertyOptional({
    description: 'Obligatorio en BASIC_AUTH',
    writeOnly: true,
  })
  @ValidateIf(
    (dto: CreateCredentialDto) =>
      dto.authType === CredentialAuthType.BASIC_AUTH,
  )
  @IsString({ message: 'password debe ser una cadena.' })
  @IsNotEmpty({ message: 'password es obligatorio en BASIC_AUTH.' })
  @MaxLength(MAX_SECRET_LENGTH, {
    message: `password no puede superar ${MAX_SECRET_LENGTH} caracteres.`,
  })
  password?: string;

  @ApiPropertyOptional({
    description: 'Obligatorio en API_KEY',
    example: 'X-Api-Key',
  })
  @ValidateIf(
    (dto: CreateCredentialDto) => dto.authType === CredentialAuthType.API_KEY,
  )
  @IsString({ message: 'keyName debe ser una cadena.' })
  @Matches(API_KEY_NAME_PATTERN, {
    message: 'keyName solo admite letras, digitos, "-" y "_" (maximo 100).',
  })
  keyName?: string;

  @ApiPropertyOptional({
    description: 'Obligatorio en API_KEY',
    writeOnly: true,
  })
  @ValidateIf(
    (dto: CreateCredentialDto) => dto.authType === CredentialAuthType.API_KEY,
  )
  @IsString({ message: 'apiKey debe ser una cadena.' })
  @IsNotEmpty({ message: 'apiKey es obligatorio en API_KEY.' })
  @MaxLength(MAX_SECRET_LENGTH, {
    message: `apiKey no puede superar ${MAX_SECRET_LENGTH} caracteres.`,
  })
  apiKey?: string;

  @ApiPropertyOptional({
    enum: ApiKeyPlacement,
    description: 'Obligatorio en API_KEY',
  })
  @ValidateIf(
    (dto: CreateCredentialDto) => dto.authType === CredentialAuthType.API_KEY,
  )
  @IsEnum(ApiKeyPlacement, {
    message: `placement debe ser uno de: ${Object.values(ApiKeyPlacement).join(', ')}.`,
  })
  placement?: ApiKeyPlacement;
}
