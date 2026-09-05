import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { RedLocalMiddleware } from '@common/middlewares/red-local.middleware';

import { AppModule } from './app.module';

const API_PREFIX = 'api';
const SWAGGER_PATH = 'api/docs';
const ASSETS_PATH = '/static/uploads';

/**
 * Rutas a cubrir con el perimetro de red (PROT-05), y el motivo de que haya que
 * montarlo A MANO sobre ellas.
 *
 * Las dos familias comparten causa: `SwaggerModule` y `ServeStaticModule` NO
 * registran sus rutas en el router de Nest, sino directamente en el adaptador
 * de Express (`useStaticAssets`). El `IpWhitelistGuard` global, que es un
 * `APP_GUARD` del router, jamas las alcanza, asi que sin este middleware
 * quedarian abiertas a cualquier origen.
 *
 * - Swagger: el documento JSON/YAML son rutas HERMANAS (`api/docs-json`), no
 *   anidadas, de modo que cubrir solo `/api/docs` dejaria expuesto el
 *   inventario de endpoints.
 * - Assets: `security-and-scope.md` §1 exige que toda ruta protegida pase por
 *   aqui, y las imagenes de los articulos no son una excepcion. Si algun dia el
 *   CMS de destino tuviera que descargarlas desde fuera del rango corporativo,
 *   este es el punto exacto donde relajarlo.
 */
const PERIMETER_PATHS = [
  `/${SWAGGER_PATH}`,
  `/${SWAGGER_PATH}-json`,
  `/${SWAGGER_PATH}-yaml`,
  ASSETS_PATH,
];

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // CORS: en desarrollo local se permite '*' si FRONTEND_URL no esta definida
  app.enableCors({ origin: process.env.FRONTEND_URL || '*' });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.setGlobalPrefix(API_PREFIX);

  // Se monta antes de SwaggerModule.setup porque Express resuelve por orden de
  // registro. Los estaticos se cubren igual: ServeStaticModule los registra en
  // `app.init()`, es decir durante el `listen()` de mas abajo, asi que este
  // `use` entra antes en la pila y se evalua primero (ver PERIMETER_PATHS).
  const redLocalMiddleware = app.get(RedLocalMiddleware);

  app.use(PERIMETER_PATHS, redLocalMiddleware.use.bind(redLocalMiddleware));

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
