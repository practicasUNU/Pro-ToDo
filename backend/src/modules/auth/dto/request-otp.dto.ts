import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, MaxLength } from 'class-validator';

import { TrimmedString } from '@common/decorators/trimmed-string.decorator';

/** Payload de solicitud de un codigo OTP (`POST /auth/otp/generate`). */
export class RequestOtpDto {
  @ApiProperty({
    description: 'Correo corporativo del usuario que solicita el acceso',
    example: 'usuario@unuware.com',
    maxLength: 255,
  })
  @TrimmedString()
  @IsEmail({}, { message: 'El correo no tiene un formato valido.' })
  @MaxLength(255)
  email: string;
}
