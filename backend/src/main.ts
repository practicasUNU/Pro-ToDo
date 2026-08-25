import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

const API_PREFIX = 'api';
const SWAGGER_PATH = 'api/docs';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // CORS: en desarrollo local se permite '*' si FRONTEND_URL no esta definida
  app.enableCors({ origin: process.env.FRONTEND_URL || '*' });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.setGlobalPrefix(API_PREFIX);

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Proto-Do API')
    .setDescription('Endpoints del Motor FSM y Panel de Control')
    .setVersion('1.0')
    .build();
  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup(SWAGGER_PATH, app, swaggerDocument);

  const port = Number(process.env.PORT);
  await app.listen(port);

  const logger = new Logger('Bootstrap');
  logger.log(`API disponible en http://localhost:${port}/${API_PREFIX}`);
  logger.log(`Documentacion Swagger disponible en http://localhost:${port}/${SWAGGER_PATH}`);
}
bootstrap();
