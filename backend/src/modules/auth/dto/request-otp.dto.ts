import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, MaxLength } from 'class-validator';

/** Payload de solicitud de un codigo OTP (`POST /auth/otp/generate`). */
export class RequestOtpDto {
  @ApiProperty({
    description: 'Correo corporativo del usuario que solicita el acceso',
    example: 'usuario@unuware.com',
    maxLength: 255,
  })
  @IsEmail({}, { message: 'El correo no tiene un formato valido.' })
  @MaxLength(255)
  email: string;
}
