import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ServeStaticModule } from '@nestjs/serve-static';
import { ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { join } from 'path';

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
import { NodesModule } from '@modules/nodes/nodes.module';
import { AllowedIpsModule } from '@modules/security/allowed-ips/allowed-ips.module';
import { TemplatesModule } from '@modules/templates/templates.module';
import { UsersModule } from '@modules/users/users.module';
import { WorkflowsModule } from '@modules/workflows/workflows.module';

import { AppController } from './app.controller';
import { AppService } from './app.service';

/**
 * Raiz fisica de los recursos estaticos.
 *
 * `process.cwd()` y no `__dirname`: este archivo se ejecuta desde `src/` en
 * desarrollo y desde `dist/` en produccion, asi que una ruta relativa al modulo
 * apuntaria a dos sitios distintos. El directorio de trabajo es `backend/` en
 * ambos casos, que es exactamente donde vive `static/uploads`.
 *
 * Queda FUERA de `src/` a proposito: `nest build` compila `src/` hacia `dist/` y
 * `rimraf dist` lo borra en cada build. Un binario ahi dentro se perderia, o
 * ensuciaria el arbol que ve el compilador de TypeScript.
 */
const STATIC_UPLOADS_ROOT = join(process.cwd(), 'static', 'uploads');

/**
 * Prefijo HTTP de los recursos. Debe coincidir con la cola de `ASSETS_BASE_URL`,
 * que es lo que `TemplateRendererService` interpola en `{{_assets.base_url}}`.
 */
const STATIC_UPLOADS_ROUTE = '/static/uploads';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Entrega de imagenes referenciadas por las plantillas (`{{_assets.base_url}}`).
    // El alcance del MVP es referenciar y servir: nada de recorte, compresion ni
    // edicion grafica (`security-and-scope.md` §3).
    //
    // `serveRoot` NO lleva el prefijo `/api`: el adaptador de Express registra
    // estas rutas fuera del router de Nest, asi que `setGlobalPrefix()` no las
    // alcanza. Es el mismo motivo por el que Swagger vive en `/api/docs` y no en
    // `/api/api/docs`.
    ServeStaticModule.forRoot({
      rootPath: STATIC_UPLOADS_ROOT,
      serveRoot: STATIC_UPLOADS_ROUTE,
      serveStaticOptions: {
        // Sin listado ni `index.html` implicito: una peticion al directorio debe
        // ser un 404, no un indice del contenido del servidor.
        index: false,
        redirect: false,
      },
    }),
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
    AllowedIpsModule,
    TemplatesModule,
    NodesModule,
    WorkflowsModule,
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
