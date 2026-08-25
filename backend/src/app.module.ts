import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CommonModule } from '@common/common.module';
import { IpWhitelistGuard } from '@common/guards/ip-whitelist.guard';
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
    CommonModule,
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
