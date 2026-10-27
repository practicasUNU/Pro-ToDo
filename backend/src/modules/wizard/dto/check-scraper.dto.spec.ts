import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CheckScraperDto } from './check-scraper.dto';

import type { ValidationError, ValidatorOptions } from 'class-validator';

/**
 * Las MISMAS opciones que aplica `STRICT_VALIDATION` en el controlador.
 *
 * `forbidNonWhitelisted` es la mitad que importa: el pipe global de `main.ts` no
 * lo lleva y descartaria en silencio las claves desconocidas, que es justo lo
 * que estas pruebas comprueban que NO ocurre.
 */
const STRICT_OPTIONS: ValidatorOptions = {
  whitelist: true,
  forbidNonWhitelisted: true,
};

const VALID_URL = 'https://www.ejemplo.es/noticias/nota-de-prensa';

const validateBody = async (
  body: Record<string, unknown>,
): Promise<ValidationError[]> =>
  validate(plainToInstance(CheckScraperDto, body), STRICT_OPTIONS);

const failedProperties = (errors: ValidationError[]): string[] =>
  errors.map((error) => error.property);

describe('CheckScraperDto', () => {
  describe('1. URL de prueba', () => {
    it('1.1 deberia aceptar una URL https absoluta', async () => {
      // 1. Arrange & 2. Act
      const errors = await validateBody({ targetUrl: VALID_URL });

      // 3. Assert
      expect(errors).toHaveLength(0);
    });

    it('1.2 deberia RECHAZAR una plantilla de interpolacion', async () => {
      // 1. Arrange: es la diferencia deliberada con el DTO del nodo, donde esta
      //    misma cadena es el valor NORMAL. Aqui no hay contexto que interpolar,
      //    y dejarla pasar solo acabaria en un `new URL()` que lanza, es decir,
      //    en un 500 donde deberia haber un 400 que nombra el campo.
      const errors = await validateBody({
        targetUrl: '{{parsed_email.extracted_urls[0]}}',
      });

      // 3. Assert
      expect(failedProperties(errors)).toContain('targetUrl');
    });

    it('1.3 deberia rechazar un esquema no navegable', async () => {
      // 1. Arrange & 2. Act: sin la lista blanca de `protocols`, un `file:`
      //    seria una lectura arbitraria del disco del servidor disparada por un
      //    EDITOR autenticado.
      const errors = await validateBody({ targetUrl: 'file:///etc/passwd' });

      // 3. Assert
      expect(failedProperties(errors)).toContain('targetUrl');
    });

    it('1.4 deberia rechazar una URL relativa', async () => {
      // 1. Arrange & 2. Act
      const errors = await validateBody({ targetUrl: '/noticias/nota' });

      // 3. Assert
      expect(failedProperties(errors)).toContain('targetUrl');
    });

    it('1.5 deberia aceptar un host interno sin dominio de primer nivel', async () => {
      // 1. Arrange & 2. Act: `require_tld: false` es deliberado. Probar contra
      //    la intranet corporativa es un caso real de una implantacion cerrada.
      const errors = await validateBody({ targetUrl: 'http://intranet/nota' });

      // 3. Assert
      expect(errors).toHaveLength(0);
    });

    it('1.6 deberia exigir targetUrl', async () => {
      // 1. Arrange & 2. Act
      const errors = await validateBody({});

      // 3. Assert
      expect(failedProperties(errors)).toContain('targetUrl');
    });
  });

  describe('2. Rangos heredados del DTO del nodo', () => {
    it.each([4_999, 60_001])(
      '2.1 deberia rechazar un timeoutMs de %p',
      async (timeoutMs: number) => {
        // 1. Arrange & 2. Act
        const errors = await validateBody({ targetUrl: VALID_URL, timeoutMs });

        // 3. Assert: los topes se heredan con `PickType` para que el asistente
        //    no apruebe un valor que la estrategia rechazaria.
        expect(failedProperties(errors)).toContain('timeoutMs');
      },
    );

    it('2.2 deberia aceptar los limites exactos del rango', async () => {
      // 1. Arrange & 2. Act
      const errors = await validateBody({
        targetUrl: VALID_URL,
        timeoutMs: 5_000,
        maxRetries: 0,
        retryDelayMs: 500,
      });

      // 3. Assert
      expect(errors).toHaveLength(0);
    });

    it('2.3 deberia rechazar maxRetries por encima del techo', async () => {
      // 1. Arrange & 2. Act
      const errors = await validateBody({
        targetUrl: VALID_URL,
        maxRetries: 6,
      });

      // 3. Assert
      expect(failedProperties(errors)).toContain('maxRetries');
    });
  });

  describe('3. Claves no permitidas', () => {
    it('3.1 deberia rechazar una propiedad que el nodo no declara', async () => {
      // 1. Arrange & 2. Act: `waitForSelector` no existe en el DTO del nodo, y
      //    aceptarlo aqui haria creer al operador que el nodo lo respeta.
      const errors = await validateBody({
        targetUrl: VALID_URL,
        waitForSelector: 'article.entry-content',
      });

      // 3. Assert
      expect(failedProperties(errors)).toContain('waitForSelector');
    });
  });
});
