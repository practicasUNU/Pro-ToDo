import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthController } from '@modules/auth/auth.controller';
import { AuthService } from '@modules/auth/auth.service';
import { RefreshToken } from '@modules/auth/entities/refresh-token.entity';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { OtpConfigService } from '@modules/auth/services/otp-config.service';
import { RefreshTokenService } from '@modules/auth/services/refresh-token.service';
import { JwtStrategy } from '@modules/auth/strategies/jwt.strategy';
import { UsersModule } from '@modules/users/users.module';

import type { JwtModuleOptions } from '@nestjs/jwt';

/** Tipo del campo `expiresIn` que espera `jsonwebtoken` (formato de la libreria `ms`). */
type ExpiresIn = NonNullable<JwtModuleOptions['signOptions']>['expiresIn'];

/** Vigencia por defecto del token si `JWT_EXPIRES_IN` no esta definida. */
const DEFAULT_JWT_EXPIRATION = '8h';

/**
 * Autenticacion corporativa: verificacion del JWT (PROT-04.2) y emision del token
 * tras validar el OTP enviado por correo (PROT-04.1).
 *
 * `EmailService` no se declara aqui: lo provee `CommonModule`, que es global.
 */
@Module({
  imports: [
    UsersModule,
    TypeOrmModule.forFeature([RefreshToken]),
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
  controllers: [AuthController],
  providers: [
    AuthService,
    OtpConfigService,
    RefreshTokenService,
    JwtStrategy,
    JwtAuthGuard,
  ],
  exports: [JwtAuthGuard, JwtModule, PassportModule],
})
export class AuthModule {}
