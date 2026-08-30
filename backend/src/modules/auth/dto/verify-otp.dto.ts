import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

/** Payload de validacion del codigo OTP (`POST /auth/otp/validate`). */
export class VerifyOtpDto {
  @ApiProperty({
    description: 'Correo corporativo al que se envio el codigo',
    example: 'usuario@unuware.com',
    maxLength: 255,
  })
  @IsEmail({}, { message: 'El correo no tiene un formato valido.' })
  @MaxLength(255)
  email: string;

  @ApiProperty({
    description: 'Codigo temporal de un solo uso recibido por correo',
    example: '123456',
    minLength: 6,
    maxLength: 6,
  })
  @IsString()
  @Length(6, 6, { message: 'El codigo debe tener exactamente 6 digitos.' })
  @Matches(/^\d{6}$/, { message: 'El codigo solo puede contener digitos.' })
  code: string;

  @ApiProperty({
    description:
      'Identificador del dispositivo que inicia la sesion, generado y persistido por el cliente',
    example: 'b3f1c2d4-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
    format: 'uuid',
  })
  // Sin fijar version: el contrato no debe acoplarse a la que genere el cliente.
  @IsUUID(undefined, {
    message: 'El identificador de dispositivo debe ser un UUID valido.',
  })
  deviceId: string;
}
