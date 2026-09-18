import { resolveParserEmailConfig } from '@modules/nodes/dto/parser-email-config.dto';

import {
  buildParsedEmail,
  extractEmailBody,
} from './parsed-email-payload.util';

import type { ResolvedParserEmailConfig } from '@modules/nodes/dto/parser-email-config.dto';

/** Configuracion con los defectos del DTO ya aplicados. */
const buildConfig = (
  overrides: Partial<ResolvedParserEmailConfig> = {},
): ResolvedParserEmailConfig => ({
  ...resolveParserEmailConfig({}),
  ...overrides,
});

/** Cuerpo que supera con holgura el umbral por defecto (50). */
const LONG_BODY = 'Texto suficiente para un modelo de lenguaje. '.repeat(10);

/** Adjunto que solo un modelo con vision puede interpretar. */
const PDF_ATTACHMENT = {
  filename: 'escaneo.pdf',
  contentType: 'application/pdf',
  size: 1024,
};

/** Correo crudo tal como lo deja `ImapTriggerStrategy` en `raw_email`. */
const buildSource = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  subject: 'Innovacion en Madrid',
  text: LONG_BODY,
  html: '',
  attachments: [],
  ...overrides,
});

describe('parsed-email-payload.util', () => {
  describe('0. Contrato del payload', () => {
    it('0.1 deberia exponer las doce claves en su orden exacto', () => {
      // 1. Arrange: el orden es contrato PUBLICO desde que la interfaz se
      //    exporta; lo replican el frontend y el DTO de Swagger.
      const config = buildConfig();

      // 2. Act
      const payload = buildParsedEmail(buildSource(), config);

      // 3. Assert
      expect(Object.keys(payload)).toEqual([
        'subject',
        'clean_title',
        'clean_body',
        'body_source',
        'character_count',
        'original_character_count',
        'reduction_percentage',
        'extracted_urls',
        'attachment_count',
        'attachments',
        'requires_multimodal_fallback',
        'multimodal_reason',
      ]);
    });

    it('0.2 deberia limpiar los prefijos de respuesta del asunto', () => {
      // 1. Arrange
      const source = buildSource({ subject: 'Fwd: Re: Noticia' });

      // 2. Act
      const payload = buildParsedEmail(source, buildConfig());

      // 3. Assert: el crudo se conserva ADEMAS del limpio.
      expect(payload.subject).toBe('Fwd: Re: Noticia');
      expect(payload.clean_title).toBe('Noticia');
    });
  });

  describe('1. Cascada de origen del cuerpo', () => {
    it('1.1 deberia preferir el texto plano cuando existe', () => {
      // 1. Arrange: saltarse el DOM ahorra la operacion mas cara del nodo.
      const source = buildSource({ html: '<p>Marcado que sobra</p>' });

      // 2. Act
      const payload = buildParsedEmail(source, buildConfig());

      // 3. Assert
      expect(payload.body_source).toBe('text');
      expect(payload.clean_body).toBe(LONG_BODY.trim());
      expect(payload.extracted_urls).toEqual([]);
    });

    it('1.2 deberia caer al marcado cuando no hay parte de texto plano', () => {
      // 1. Arrange: el multipart/alternative sin text/plain de un boletin.
      const source = buildSource({
        text: '',
        html: '<h1>Nueva sede</h1><p>Mas en <a href="https://unuware.com/n">la nota</a>.</p>',
      });

      // 2. Act
      const payload = buildParsedEmail(source, buildConfig());

      // 3. Assert
      expect(payload.body_source).toBe('html');
      expect(payload.clean_body).toContain('Nueva sede');
      expect(payload.clean_body).not.toContain('<');
      expect(payload.extracted_urls).toEqual(['https://unuware.com/n']);
    });

    it('1.3 deberia declarar "none" en un correo sin ningun cuerpo', () => {
      // 1. Arrange
      const source = buildSource({ text: '', html: '' });

      // 2. Act
      const payload = buildParsedEmail(source, buildConfig());

      // 3. Assert
      expect(payload.body_source).toBe('none');
      expect(payload.clean_body).toBe('');
    });
  });

  describe('2. Metricas de reduccion (RNF-01)', () => {
    it('2.1 deberia medir el original contra la fuente CONSUMIDA', () => {
      // 1. Arrange: medir siempre contra `html` daria division por cero en un
      //    correo text/plain puro.
      const source = buildSource();

      // 2. Act
      const payload = buildParsedEmail(source, buildConfig());

      // 3. Assert
      expect(payload.original_character_count).toBe(LONG_BODY.length);
      expect(payload.character_count).toBe(payload.clean_body.length);
    });

    it('2.2 deberia devolver 0 y no NaN cuando no hubo fuente', () => {
      // 1. Arrange: `NaN` se serializa a `null` en el jsonb y romperia la regla
      //    de "toda clave presente CON SU TIPO".
      const source = buildSource({ text: '', html: '' });

      // 2. Act
      const payload = buildParsedEmail(source, buildConfig());

      // 3. Assert
      expect(payload.reduction_percentage).toBe(0);
      expect(Number.isNaN(payload.reduction_percentage)).toBe(false);
    });

    it('2.3 deberia reducir un correo HTML realista por encima del 50%', () => {
      // 1. Arrange
      const html =
        '<style>.a{color:red}</style>' +
        '<table><tr><td><h1>Nueva sede</h1></td></tr></table>' +
        '<p>La compania abre una sede en Madrid con doscientos empleos.</p>' +
        '<div class="gmail_signature">Juan Perez, Gabinete de Prensa</div>' +
        '<p>AVISO LEGAL: este mensaje es confidencial.</p>';
      const source = buildSource({ text: '', html });

      // 2. Act
      const payload = buildParsedEmail(source, buildConfig());

      // 3. Assert
      expect(payload.reduction_percentage).toBeGreaterThan(50);
      expect(payload.clean_body).not.toContain('AVISO LEGAL');
      expect(payload.clean_body).not.toContain('Gabinete de Prensa');
    });
  });

  describe('3. Regla multimodal (el AND)', () => {
    it('3.1 deberia levantarla con cuerpo corto Y un adjunto de vision', () => {
      // 1. Arrange: el caso que la motiva, el PDF escaneado.
      const source = buildSource({
        text: 'Ver adjunto.',
        attachments: [PDF_ATTACHMENT],
      });

      // 2. Act
      const payload = buildParsedEmail(source, buildConfig());

      // 3. Assert
      expect(payload.requires_multimodal_fallback).toBe(true);
      expect(payload.multimodal_reason).toContain('imagen o PDF');
    });

    it('3.2 NO deberia levantarla con cuerpo largo aunque haya un PDF', () => {
      // 1. Arrange: gastar vision en un boletin con logo seria la llamada mas
      //    cara del pipeline sin motivo.
      const source = buildSource({ attachments: [PDF_ATTACHMENT] });

      // 2. Act
      const payload = buildParsedEmail(source, buildConfig());

      // 3. Assert
      expect(payload.requires_multimodal_fallback).toBe(false);
      expect(payload.multimodal_reason).toBe('');
    });

    it('3.3 NO deberia levantarla sin adjuntos aunque no haya cuerpo', () => {
      // 1. Arrange: sin binario que mirar, la vision no aporta nada.
      const source = buildSource({ text: '', html: '' });

      // 2. Act
      const payload = buildParsedEmail(source, buildConfig());

      // 3. Assert
      expect(payload.requires_multimodal_fallback).toBe(false);
    });

    it('3.4 NO deberia levantarla con un adjunto que no exige vision', () => {
      // 1. Arrange: un CSV lo decodifica otro nodo sin gastar un multimodal.
      const source = buildSource({
        text: 'Ver adjunto.',
        attachments: [
          { filename: 'datos.csv', contentType: 'text/csv', size: 512 },
        ],
      });

      // 2. Act
      const payload = buildParsedEmail(source, buildConfig());

      // 3. Assert
      expect(payload.requires_multimodal_fallback).toBe(false);
    });

    it('3.5 deberia respetar el umbral configurado', () => {
      // 1. Arrange
      const source = buildSource({ attachments: [PDF_ATTACHMENT] });

      // 2. Act
      const payload = buildParsedEmail(
        source,
        buildConfig({ minBodyLength: 100_000 }),
      );

      // 3. Assert
      expect(payload.requires_multimodal_fallback).toBe(true);
      expect(payload.multimodal_reason).toContain('100000');
    });
  });

  describe('4. Inventario de adjuntos', () => {
    it('4.1 deberia proyectar los metadatos SIN reintroducir el base64', () => {
      // 1. Arrange: repetir los bytes en un segundo namespace los duplicaria en
      //    la misma fila y los devolveria tras la purga del motor.
      const source = buildSource({
        attachments: [{ ...PDF_ATTACHMENT, contentBase64: 'Y29udGVuaWRv' }],
      });

      // 2. Act
      const payload = buildParsedEmail(source, buildConfig());

      // 3. Assert
      expect(payload.attachment_count).toBe(1);
      expect(payload.attachments).toEqual([PDF_ATTACHMENT]);
      expect(JSON.stringify(payload)).not.toContain('Y29udGVuaWRv');
    });

    it('4.2 deberia tolerar un inventario rehidratado con otra forma', () => {
      // 1. Arrange: el namespace viene de una columna jsonb y nada garantiza su
      //    forma mas alla de lo que escribio el nodo anterior.
      const source = buildSource({ attachments: [null, 'basura', {}] });

      // 2. Act
      const payload = buildParsedEmail(source, buildConfig());

      // 3. Assert
      expect(payload.attachment_count).toBe(3);
      expect(payload.attachments[0]).toEqual({
        filename: '',
        contentType: 'application/octet-stream',
        size: 0,
      });
    });

    it('4.3 deberia devolver un inventario vacio si la clave no es un arreglo', () => {
      // 1. Arrange / 2. Act
      const payload = buildParsedEmail(
        buildSource({ attachments: undefined }),
        buildConfig(),
      );

      // 3. Assert
      expect(payload.attachments).toEqual([]);
      expect(payload.attachment_count).toBe(0);
    });
  });

  describe('5. Canales de aviso (hooks)', () => {
    it('5.1 deberia invocar onMultimodalFallback solo cuando la bandera sube', () => {
      // 1. Arrange
      const onMultimodalFallback = jest.fn();
      const source = buildSource({
        text: 'Ver adjunto.',
        attachments: [PDF_ATTACHMENT],
      });

      // 2. Act
      const payload = buildParsedEmail(source, buildConfig(), {
        onMultimodalFallback,
      });

      // 3. Assert: el hook recibe el MISMO texto que viaja en el payload, para
      //    que el log y el checkpoint no cuenten dos historias distintas.
      expect(onMultimodalFallback).toHaveBeenCalledTimes(1);
      expect(onMultimodalFallback).toHaveBeenCalledWith(
        payload.multimodal_reason,
      );
    });

    it('5.2 NO deberia invocar onMultimodalFallback con la bandera baja', () => {
      // 1. Arrange
      const onMultimodalFallback = jest.fn();

      // 2. Act
      buildParsedEmail(buildSource(), buildConfig(), { onMultimodalFallback });

      // 3. Assert
      expect(onMultimodalFallback).not.toHaveBeenCalled();
    });

    it('5.3 deberia degradar a "none" y avisar si el saneado lanza', () => {
      // 1. Arrange: el motor normaliza toda excepcion a URGENTE, que nunca se
      //    reintenta. Un correo mal formado no puede tumbar la ejecucion.
      const onSanitizeFailure = jest.fn();
      const sanitizer = jest
        .spyOn(
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          require('./email-sanitizer.util') as {
            sanitizeEmailHtml: (html: string) => unknown;
          },
          'sanitizeEmailHtml',
        )
        .mockImplementation(() => {
          throw new Error('marcado patologico');
        });

      // 2. Act
      const payload = buildParsedEmail(
        buildSource({ text: '', html: '<p>algo</p>' }),
        buildConfig(),
        { onSanitizeFailure },
      );

      // 3. Assert: el payload SIGUE llegando, con el inventario intacto.
      expect(onSanitizeFailure).toHaveBeenCalledWith('marcado patologico');
      expect(payload.body_source).toBe('none');
      expect(payload.clean_body).toBe('');

      sanitizer.mockRestore();
    });

    it('5.4 NO deberia exigir hooks: son opcionales', () => {
      // 1. Arrange / 2. Act / 3. Assert
      expect(() =>
        buildParsedEmail(buildSource(), buildConfig()),
      ).not.toThrow();
    });
  });

  describe('6. extractEmailBody por separado', () => {
    it('6.1 deberia exponer la cascada sin pasar por el payload completo', () => {
      // 1. Arrange / 2. Act
      const fromText = extractEmailBody('Hola mundo.', '<p>Marcado</p>');
      const fromHtml = extractEmailBody('', '<p>Marcado</p>');
      const empty = extractEmailBody('   ', '  ');

      // 3. Assert
      expect(fromText.source).toBe('text');
      expect(fromHtml.source).toBe('html');
      expect(empty.source).toBe('none');
      expect(empty.originalLength).toBe(0);
    });
  });
});
