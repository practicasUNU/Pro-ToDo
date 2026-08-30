import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CommonModule } from '@common/common.module';
import {
  DEFAULT_OTP_THROTTLE_LIMIT,
  DEFAULT_OTP_THROTTLE_TTL_MS,
  OTP_THROTTLER_NAME,
} from '@common/constants/throttler.constants';
import { IpWhitelistGuard } from '@common/guards/ip-whitelist.guard';
import { FsmModule } from '@core/fsm/fsm.module';
import { AuthModule } from '@modules/auth/auth.module';
import { HealthModule } from '@modules/health/health.module';
import { UsersModule } from '@modules/users/users.module';

import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get<string>('DB_HOST'),
        port: configService.get<number>('DB_PORT'),
        username: configService.get<string>('DB_USER'),
        password: configService.get<string>('DB_PASSWORD'),
        database: configService.get<string>('DB_NAME'),
        autoLoadEntities: true,
        synchronize: false,
      }),
    }),
    // Limite de tasa (PROT-04.1): protege la generacion y validacion de OTP frente a
    // fuerza bruta y saturacion de buzones. El ThrottlerGuard NO se registra como guard
    // global: se aplica explicitamente en AuthController para no penalizar al resto de la API.
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        throttlers: [
          {
            name: OTP_THROTTLER_NAME,
            ttl:
              configService.get<number>('OTP_THROTTLE_TTL_MS') ??
              DEFAULT_OTP_THROTTLE_TTL_MS,
            limit:
              configService.get<number>('OTP_THROTTLE_LIMIT') ??
              DEFAULT_OTP_THROTTLE_LIMIT,
          },
        ],
      }),
    }),
    CommonModule,
    FsmModule,
    AuthModule,
    HealthModule,
    UsersModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Perimetro de red (PROT-05): guard global, se evalua antes que los guards de
    // controlador, de modo que una IP no autorizada se rechaza sin procesar credenciales.
    { provide: APP_GUARD, useClass: IpWhitelistGuard },
  ],
})
export class AppModule {}
