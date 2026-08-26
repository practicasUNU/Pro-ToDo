import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';

import { AuthService } from '@modules/auth/auth.service';
import { RequestOtpDto } from '@modules/auth/dto/request-otp.dto';
import { VerifyOtpDto } from '@modules/auth/dto/verify-otp.dto';

import type { AuthTokenResponse } from '@modules/auth/interfaces/jwt-payload.interface';

/** Respuesta neutra de la solicitud de OTP: identica exista o no la cuenta. */
const OTP_REQUESTED_MESSAGE = 'Si el correo existe, recibira un codigo OTP.';

/**
 * Autenticacion sin contrasena por OTP (PROT-04.1).
 *
 * Estas rutas NO llevan `@PublicIp()`: el inicio de sesion tambien debe ocurrir
 * dentro de la red corporativa, asi que siguen sujetas al `IpWhitelistGuard` global.
 * El `ThrottlerGuard` se aplica aqui de forma explicita, no globalmente.
 */
@ApiTags('auth')
@UseGuards(ThrottlerGuard)
@Controller('auth/otp')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('generate')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Envia un codigo temporal al correo corporativo' })
  @ApiResponse({
    status: HttpStatus.ACCEPTED,
    description: 'Solicitud aceptada',
  })
  @ApiTooManyRequestsResponse({ description: 'Limite de solicitudes excedido' })
  public async generate(
    @Body() requestOtpDto: RequestOtpDto,
  ): Promise<{ message: string }> {
    await this.authService.requestOtp(requestOtpDto.email);

    // Respuesta constante: no revela si el correo esta registrado ni si esta activo.
    return { message: OTP_REQUESTED_MESSAGE };
  }

  @Post('validate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Valida el codigo temporal y emite el JWT de sesion',
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Token emitido' })
  @ApiTooManyRequestsResponse({ description: 'Limite de intentos excedido' })
  public async validate(
    @Body() verifyOtpDto: VerifyOtpDto,
  ): Promise<AuthTokenResponse> {
    return this.authService.verifyOtp(verifyOtpDto.email, verifyOtpDto.code);
  }
}
