import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Payload de renovacion y de cierre de sesion (`POST /auth/refresh`, `POST /auth/logout`).
 *
 * El token es una cadena opaca en base64url de 32 bytes (~43 caracteres); el
 * limite de longitud corta de raiz cualquier intento de enviar un valor enorme
 * antes de que llegue a calcularse su hash.
 */
export class RefreshTokenDto {
  @ApiProperty({
    description: 'Token de renovacion opaco entregado al validar el OTP',
    example: 'xQ8kZ2m1Rr9pV6tL0sYbN4hJ7wC3dF5gA1eU8iO2kM0',
    maxLength: 512,
  })
  @IsString()
  @IsNotEmpty({ message: 'El token de renovacion es obligatorio.' })
  @MaxLength(512)
  refreshToken: string;
}
