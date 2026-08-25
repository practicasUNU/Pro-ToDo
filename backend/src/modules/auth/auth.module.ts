import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { JwtStrategy } from '@modules/auth/strategies/jwt.strategy';

import type { JwtModuleOptions } from '@nestjs/jwt';

/** Tipo del campo `expiresIn` que espera `jsonwebtoken` (formato de la libreria `ms`). */
type ExpiresIn = NonNullable<JwtModuleOptions['signOptions']>['expiresIn'];

/** Vigencia por defecto del token si `JWT_EXPIRES_IN` no esta definida. */
const DEFAULT_JWT_EXPIRATION = '8h';

/**
 * Capa de verificacion de identidad (PROT-04.2).
 *
 * Intencionadamente sin controlador: la emision de tokens (solicitud y validacion
 * del OTP corporativo) pertenece a PROT-04.1 y se añadira aqui mismo.
 */
@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService): JwtModuleOptions => ({
        secret: configService.get<string>('JWT_SECRET'),
        // `expiresIn` acepta el formato de `ms` ('8h', '30m'): se afirma el tipo porque
        // el valor llega como string plano desde el entorno.
        signOptions: {
          expiresIn: (configService.get<string>('JWT_EXPIRES_IN') ??
            DEFAULT_JWT_EXPIRATION) as ExpiresIn,
        },
      }),
    }),
  ],
  providers: [JwtStrategy, JwtAuthGuard],
  exports: [JwtAuthGuard, JwtModule, PassportModule],
})
export class AuthModule {}
