import {
  Body,
  ClassSerializerInterceptor,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

import { OTP_THROTTLER_NAME } from '@common/constants/throttler.constants';
import { AuthService } from '@modules/auth/auth.service';
import { RefreshTokenDto } from '@modules/auth/dto/refresh-token.dto';
import { RequestOtpDto } from '@modules/auth/dto/request-otp.dto';
import { VerifyOtpDto } from '@modules/auth/dto/verify-otp.dto';
import { OtpConfigService } from '@modules/auth/services/otp-config.service';

import type {
  AuthTokenResponse,
  OtpRequestResponse,
} from '@modules/auth/interfaces/jwt-payload.interface';

/**
 * Respuesta neutra de la solicitud de OTP.
 *
 * Es la MISMA cadena, con el MISMO 202, tanto si el codigo se envio como si la
 * cuenta no existe o esta desactivada: homologar los tres caminos es lo que
 * impide enumerar cuentas desde fuera.
 */
const OTP_REQUESTED_MESSAGE =
  'Si la cuenta existe y esta activa, hemos enviado un codigo OTP a su correo';

/**
 * Limite propio de las rutas de sesion. El presupuesto de 3 peticiones/minuto
 * esta calibrado contra la fuerza bruta del OTP y la saturacion de buzones;
 * renovar o cerrar sesion no tiene ese riesgo y varias pestañas abiertas lo
 * agotarian sin motivo.
 */
const SESSION_THROTTLE = { [OTP_THROTTLER_NAME]: { limit: 10, ttl: 60_000 } };

/**
 * Autenticacion sin contrasena por OTP (PROT-04.1) y ciclo de sesion (PROT-06.4).
 *
 * Estas rutas NO llevan `@PublicIp()`: el inicio de sesion tambien debe ocurrir
 * dentro de la red corporativa, asi que siguen sujetas al `IpWhitelistGuard` global.
 * El `ThrottlerGuard` se aplica aqui de forma explicita, no globalmente.
 */
@ApiTags('auth')
@UseGuards(ThrottlerGuard)
@UseInterceptors(ClassSerializerInterceptor)
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly otpConfigService: OtpConfigService,
  ) {}

  @Post('otp/generate')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Envia un codigo temporal al correo corporativo' })
  @ApiResponse({
    status: HttpStatus.ACCEPTED,
    description:
      'Solicitud aceptada. Se responde igual exista o no la cuenta, y este activa o no.',
  })
  @ApiTooManyRequestsResponse({ description: 'Limite de solicitudes excedido' })
  public async generate(
    @Body() requestOtpDto: RequestOtpDto,
  ): Promise<OtpRequestResponse> {
    // `requestOtp` no lanza por cuenta inexistente ni desactivada: descarta en
    // silencio. Aqui no hay try/catch precisamente porque no hay nada que
    // capturar — si algun dia lo hubiera, envolverlo seria obligatorio para no
    // reabrir el oraculo de enumeracion.
    await this.authService.requestOtp(requestOtpDto.email);

    // Respuesta constante: no revela si el correo esta registrado ni si esta activo.
    // `expiresInSeconds` es configuracion global, igual para toda cuenta.
    return {
      message: OTP_REQUESTED_MESSAGE,
      expiresInSeconds: this.otpConfigService.getExpirationSeconds(),
    };
  }

  @Post('otp/validate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Valida el codigo temporal y abre la sesion',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Par de tokens emitido',
  })
  @ApiUnauthorizedResponse({ description: 'Codigo invalido o expirado' })
  @ApiTooManyRequestsResponse({ description: 'Limite de intentos excedido' })
  public async validate(
    @Body() verifyOtpDto: VerifyOtpDto,
  ): Promise<AuthTokenResponse> {
    return this.authService.verifyOtp(verifyOtpDto.email, verifyOtpDto.code);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle(SESSION_THROTTLE)
  @ApiOperation({
    summary: 'Renueva la sesion rotando el refresh token',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Par de tokens renovado; el anterior queda revocado',
  })
  @ApiUnauthorizedResponse({
    description: 'Token inexistente, ya canjeado o expirado',
  })
  public async refresh(
    @Body() refreshTokenDto: RefreshTokenDto,
  ): Promise<AuthTokenResponse> {
    return this.authService.refreshSession(refreshTokenDto.refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle(SESSION_THROTTLE)
  @ApiOperation({ summary: 'Revoca el refresh token de la sesion actual' })
  @ApiResponse({
    status: HttpStatus.NO_CONTENT,
    description: 'Sesion cerrada (idempotente)',
  })
  public async logout(@Body() refreshTokenDto: RefreshTokenDto): Promise<void> {
    // Idempotente: cerrar una sesion ya cerrada no es un error para el cliente.
    await this.authService.logout(refreshTokenDto.refreshToken);
  }
}
