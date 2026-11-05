import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  CheckParserDto,
  MAX_CHECK_PARSER_ATTACHMENTS,
  MAX_CHECK_PARSER_BODY_CHARS,
  MAX_CHECK_PARSER_SUBJECT_CHARS,
} from './check-parser.dto';

import type { ValidationError } from 'class-validator';
import type { ValidatorOptions } from 'class-validator';

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

const validateBody = async (
  body: Record<string, unknown>,
): Promise<ValidationError[]> =>
  validate(plainToInstance(CheckParserDto, body), STRICT_OPTIONS);

/** Propiedades rechazadas, aplanadas incluidos los errores anidados. */
const failedProperties = (errors: ValidationError[]): string[] =>
  errors.flatMap((error) => [
    error.property,
    ...(error.children ?? []).flatMap((child) =>
      (child.children ?? []).map((grandchild) => grandchild.property),
    ),
  ]);

describe('CheckParserDto', () => {
  describe('0. Cuerpo minimo', () => {
    it('0.1 deberia admitir un cuerpo vacio', async () => {
      // 1. Arrange: todos los campos son opcionales; el nodo aplica sus defectos.
      // 2. Act
      const errors = await validateBody({});

      // 3. Assert
      expect(errors).toHaveLength(0);
    });

    it('0.2 deberia admitir un correo de prueba completo', async () => {
      // 1. Arrange / 2. Act
      const errors = await validateBody({
        subject: 'RV: Nota de prensa',
        text: 'Cuerpo en texto plano.',
        html: '<p>Cuerpo en marcado.</p>',
        minBodyLength: 120,
        attachments: [
          { filename: 'nota.pdf', contentType: 'application/pdf', size: 2048 },
        ],
      });

      // 3. Assert
      expect(errors).toHaveLength(0);
    });
  });

  describe('1. Umbral heredado de ParserEmailConfigDto', () => {
    it('1.1 deberia rechazar el cero por @IsPositive', async () => {
      // 1. Arrange: el DTO del nodo queda INTACTO, y el asistente valida con sus
      //    mismos decoradores. Un umbral que aqui pasase y alli fallase haria
      //    inutil el paso de comprobacion.
      // 2. Act
      const errors = await validateBody({ minBodyLength: 0 });

      // 3. Assert
      expect(failedProperties(errors)).toContain('minBodyLength');
    });

    it('1.2 deberia admitir el uno, que es el minimo real', async () => {
      // 1. Arrange / 2. Act
      const errors = await validateBody({ minBodyLength: 1 });

      // 3. Assert
      expect(errors).toHaveLength(0);
    });

    it('1.3 deberia rechazar un decimal por @IsInt', async () => {
      // 1. Arrange / 2. Act
      const errors = await validateBody({ minBodyLength: 1.5 });

      // 3. Assert
      expect(failedProperties(errors)).toContain('minBodyLength');
    });

    it('1.4 deberia rechazar un valor negativo', async () => {
      // 1. Arrange / 2. Act
      const errors = await validateBody({ minBodyLength: -10 });

      // 3. Assert
      expect(failedProperties(errors)).toContain('minBodyLength');
    });
  });

  describe('2. Topes de longitud (barrera de CPU)', () => {
    it('2.1 deberia admitir un HTML justo en el tope', async () => {
      // 1. Arrange / 2. Act
      const errors = await validateBody({
        html: 'x'.repeat(MAX_CHECK_PARSER_BODY_CHARS),
      });

      // 3. Assert
      expect(errors).toHaveLength(0);
    });

    it('2.2 deberia rechazar un HTML por encima del tope, en castellano', async () => {
      // 1. Arrange: sin este tope, `sanitizeEmailHtml` montaria un DOM sincrono
      //    sobre megabytes y bloquearia el bucle de eventos del backend entero.
      // 2. Act
      const errors = await validateBody({
        html: 'x'.repeat(MAX_CHECK_PARSER_BODY_CHARS + 1),
      });

      // 3. Assert
      expect(failedProperties(errors)).toContain('html');
      expect(Object.values(errors[0].constraints ?? {}).join(' ')).toContain(
        'no puede superar',
      );
    });

    it('2.3 deberia rechazar un texto plano por encima del tope', async () => {
      // 1. Arrange / 2. Act
      const errors = await validateBody({
        text: 'x'.repeat(MAX_CHECK_PARSER_BODY_CHARS + 1),
      });

      // 3. Assert
      expect(failedProperties(errors)).toContain('text');
    });

    it('2.4 deberia rechazar un asunto por encima del limite de la RFC 5322', async () => {
      // 1. Arrange / 2. Act
      const errors = await validateBody({
        subject: 'x'.repeat(MAX_CHECK_PARSER_SUBJECT_CHARS + 1),
      });

      // 3. Assert
      expect(failedProperties(errors)).toContain('subject');
    });

    it('2.5 deberia acotar el numero de adjuntos simulados', async () => {
      // 1. Arrange / 2. Act
      const errors = await validateBody({
        attachments: Array.from(
          { length: MAX_CHECK_PARSER_ATTACHMENTS + 1 },
          () => ({
            filename: 'a.pdf',
            contentType: 'application/pdf',
            size: 1,
          }),
        ),
      });

      // 3. Assert
      expect(failedProperties(errors)).toContain('attachments');
    });
  });

  describe('3. Claves que el endpoint NO acepta', () => {
    it('3.1 deberia rechazar sourceNamespace', async () => {
      // 1. Arrange: el correo viaja en el propio cuerpo y no hay contexto del
      //    que leer, asi que el campo no haria nada. Un 400 honesto es mejor que
      //    ignorarlo en silencio.
      // 2. Act
      const errors = await validateBody({ sourceNamespace: 'raw_email' });

      // 3. Assert
      expect(failedProperties(errors)).toContain('sourceNamespace');
    });

    it('3.2 deberia rechazar contentBase64 dentro de un adjunto', async () => {
      // 1. Arrange: es la barrera que impide que esta ruta del asistente acepte
      //    megabytes de binario. La decision multimodal solo mira contentType.
      // 2. Act
      const errors = await validateBody({
        attachments: [
          {
            filename: 'nota.pdf',
            contentType: 'application/pdf',
            size: 2048,
            contentBase64: 'Y29udGVuaWRv',
          },
        ],
      });

      // 3. Assert
      expect(failedProperties(errors)).toContain('contentBase64');
    });

    it('3.3 deberia rechazar cualquier clave inventada', async () => {
      // 1. Arrange / 2. Act
      const errors = await validateBody({ stripSignatures: false });

      // 3. Assert
      expect(failedProperties(errors)).toContain('stripSignatures');
    });
  });
});
