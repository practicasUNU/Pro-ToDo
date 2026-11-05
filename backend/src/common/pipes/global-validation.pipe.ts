import { ValidationPipe } from '@nestjs/common';

/**
 * El `ValidationPipe` global, en UN solo sitio.
 *
 * QUE PROBLEMA RESUELVE. `main.ts` y cada suite e2e montaban su propio pipe a
 * mano, y se desalinearon: el de produccion gano `forbidNonWhitelisted` y los
 * de prueba no, de modo que las e2e daban por buena una peticion con un campo
 * de mas que en produccion es un 400. Con una fabrica compartida, lo que se
 * prueba es exactamente lo que se despliega.
 *
 * `forbidNonWhitelisted` convierte en 400 lo que `whitelist` descartaba en
 * silencio. El cambio es de contrato y se hace a sabiendas: un campo de mas en
 * una peticion casi siempre delata un cliente desactualizado o un intento de
 * tocar algo que el DTO no expone, y enterarse con un error es mucho mejor que
 * verlo ignorado y creer que surtio efecto.
 */
export const createGlobalValidationPipe = (): ValidationPipe =>
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
