import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { RedLocalMiddleware } from '@common/middlewares/red-local.middleware';

import { AppModule } from './app.module';

const API_PREFIX = 'api';
const SWAGGER_PATH = 'api/docs';

/**
 * Rutas de Swagger a cubrir con el perimetro de red. `SwaggerModule` registra el
 * documento JSON/YAML como rutas HERMANAS (`api/docs-json`), no anidadas, por lo que
 * montar solo el prefijo `/api/docs` dejaria expuesto el inventario de endpoints.
 */
const SWAGGER_PERIMETER_PATHS = [
  `/${SWAGGER_PATH}`,
  `/${SWAGGER_PATH}-json`,
  `/${SWAGGER_PATH}-yaml`,
];

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // CORS: en desarrollo local se permite '*' si FRONTEND_URL no esta definida
  app.enableCors({ origin: process.env.FRONTEND_URL || '*' });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.setGlobalPrefix(API_PREFIX);

  // Perimetro de red para Swagger (PROT-05): sus rutas las registra el adaptador Express,
  // fuera del router de Nest, por lo que el IpWhitelistGuard global nunca las alcanza.
  // Se monta antes de SwaggerModule.setup porque Express resuelve por orden de registro.
  const redLocalMiddleware = app.get(RedLocalMiddleware);
  app.use(
    SWAGGER_PERIMETER_PATHS,
    redLocalMiddleware.use.bind(redLocalMiddleware),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Proto-Do API')
    .setDescription('Endpoints del Motor FSM y Panel de Control')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup(SWAGGER_PATH, app, swaggerDocument);

  const port = Number(process.env.PORT);
  await app.listen(port);

  const logger = new Logger('Bootstrap');
  logger.log(`API disponible en http://localhost:${port}/${API_PREFIX}`);
  logger.log(
    `Documentacion Swagger disponible en http://localhost:${port}/${SWAGGER_PATH}`,
  );
}
bootstrap();
