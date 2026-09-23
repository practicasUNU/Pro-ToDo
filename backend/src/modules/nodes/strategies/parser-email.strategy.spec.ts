import { NodeType } from '@core/fsm/types/pipeline-schema.types';

// El motor de PDF se dobla: esta suite examina el CONTRATO del nodo, no la
// capacidad de pdf.js de leer un fichero. La extraccion real se prueba en
// `document-extractor.util.spec.ts` contra un PDF versionado.
jest.mock('pdf-parse', () =>
  jest.fn(() => Promise.reject(new Error('Invalid PDF structure.'))),
);

/* eslint-disable @typescript-eslint/no-require-imports */
const pdfParse = require('pdf-parse') as jest.Mock;
/* eslint-enable @typescript-eslint/no-require-imports */
import { createMockStatePayloadContext } from '@test/factories/state-payload-context.factory';

import {
  ERR_PARSER_CONFIG,
  ParserEmailStrategy,
} from './parser-email.strategy';

import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import type { RawEmailAttachment } from '@modules/nodes/interfaces/raw-email-attachment.interface';

const BASE64_CONTENT = 'Y29udGVuaWRvLWJpbmFyaW8=';

/** Cuerpo largo que supera con holgura el umbral por defecto (50). */
const LONG_BODY = 'Texto suficiente para un modelo de lenguaje. '.repeat(10);

/** Cuerpo que se queda por debajo del umbral por defecto. */
const SHORT_BODY = 'Adjunto la nota de prensa.';

/** Cuerpo que lo supera por poco: fija el nuevo defecto contra una regresion. */
const BODY_OVER_THRESHOLD =
  'Adjunto la nota de prensa institucional del gabinete para su publicacion.';

/**
 * Correo HTML realista: tabla de Outlook, hoja de estilos, enlaces de todas las
 * familias, firma y aviso legal. Sostiene a la vez los bloques 6, 7 y 9.3.
 */
const OUTLOOK_HTML = `
  <style type="text/css">
    .MsoNormal { margin: 0cm; font-family: Calibri, sans-serif; font-size: 11pt; }
    table.MsoTableGrid { border-collapse: collapse; border: none; }
  </style>
  <script>window.track('open');</script>
  <table class="MsoTableGrid" width="100%" cellpadding="0" cellspacing="0">
    <tr><td><h1>Nueva sede corporativa en Madrid</h1></td></tr>
    <tr><td>
      <p class="MsoNormal">La compania inaugura su nueva sede en Madrid.&nbsp;La
      instalacion generar&aacute; m&aacute;s de doscientos empleos directos en la
      region durante el proximo ejercicio.</p>
      <p class="MsoNormal">El acto de apertura se celebrar&aacute; en marzo con
      representantes institucionales.<br>Mas informacion en la
      <a href="https://unuware.com/notas/sede?utm_source=boletin&id=42">nota completa</a>
      y en el <a href="https://unuware.com/notas/sede?utm_content=b&id=42">dossier</a>.</p>
    </td></tr>
  </table>
  <p>
    <a href="https://twitter.com/unuware">Twitter</a> |
    <a href="https://www.linkedin.com/company/unuware">LinkedIn</a> |
    <a href="https://unuware.com/unsubscribe?u=9f2a">Cancelar suscripcion</a> |
    <a href="/notas/relativa">Version interna</a> |
    <a href="mailto:prensa@unuware.com">Escribenos</a>
  </p>
  <div class="gmail_signature">
    Juan Perez &mdash; Gabinete de Prensa
    <a href="https://firma.example/perfil">Perfil</a>
  </div>
  <p>AVISO LEGAL: este mensaje es confidencial y va dirigido unicamente a su
  destinatario.</p>
`;

/** Adjunto ya proyectado por el nodo IMAP. */
const buildAttachment = (
  overrides: Partial<RawEmailAttachment> = {},
): RawEmailAttachment => ({
  filename: 'escaneo.pdf',
  contentType: 'application/pdf',
  size: 1024,
  contentBase64: BASE64_CONTENT,
  ...overrides,
});

/** Namespace `raw_email` tal como lo deja `ImapTriggerStrategy`. */
const buildRawEmail = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  message_id: '<abc-123@unuware.com>',
  from: 'prensa@unuware.com',
  subject: 'Innovacion en Madrid',
  text: LONG_BODY,
  html: '<h1>Innovacion</h1>',
  date: '2026-03-01T10:30:00.000Z',
  attachments: [],
  ...overrides,
});

const buildContext = (
  rawEmail: Record<string, unknown> = buildRawEmail(),
): StatePayloadContext =>
  createMockStatePayloadContext({
    currentStep: 'parser_pre_ia',
    namespaces: { raw_email: rawEmail },
  });

describe('ParserEmailStrategy', () => {
  describe('0. Identidad del nodo', () => {
    it('0.1 deberia declarar el tipo PARSER_PRE_IA', () => {
      // 1. Arrange / 2. Act
      const strategy = new ParserEmailStrategy();

      // 3. Assert: la factoria indexa por este valor.
      expect(strategy.nodeType).toBe(NodeType.PARSER_PRE_IA);
    });
  });

  describe('1. Proyeccion del payload', () => {
    it('1.1 deberia exponer las trece claves deterministas', async () => {
      // 1. Arrange
      const strategy = new ParserEmailStrategy();

      // 2. Act
      const result = await strategy.execute(buildContext(), {});

      // 3. Assert: el ORDEN es parte del contrato del payload.
      expect(result.success).toBe(true);
      expect(Object.keys(result.data ?? {})).toEqual([
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
        'extracted_documents_text',
        'requires_multimodal_fallback',
        'multimodal_reason',
      ]);
    });

    it('1.2 deberia tomar el texto plano como cuerpo cuando existe', async () => {
      // 1. Arrange
      const strategy = new ParserEmailStrategy();

      // 2. Act
      const result = await strategy.execute(buildContext(), {});

      // 3. Assert
      expect(result.data?.body_source).toBe('text');
      expect(result.data?.clean_body).toBe(LONG_BODY.trim());
      // El original se mide contra la fuente CONSUMIDA, que aqui es `text`.
      expect(result.data?.original_character_count).toBe(LONG_BODY.length);
      expect(result.data?.character_count).toBe(LONG_BODY.trim().length);
    });

    it('1.3 deberia sanear el marcado cuando no hay parte de texto plano', async () => {
      // 1. Arrange: el caso del multipart/alternative sin parte text/plain, que
      //    es el habitual de un boletin institucional.
      const strategy = new ParserEmailStrategy();
      const context = buildContext(buildRawEmail({ text: '' }));

      // 2. Act
      const result = await strategy.execute(context, {});

      // 3. Assert: texto real, nunca el marcado crudo, que envenenaria el prompt
      //    del nodo de inferencia con etiquetas.
      expect(result.data?.body_source).toBe('html');
      expect(result.data?.clean_body).toBe('Innovacion');
      expect(result.data?.clean_body).not.toContain('<');
    });

    it('1.4 deberia declarar body_source "none" en un correo sin cuerpo', async () => {
      // 1. Arrange
      const strategy = new ParserEmailStrategy();
      const context = buildContext(buildRawEmail({ text: '', html: '' }));

      // 2. Act
      const result = await strategy.execute(context, {});

      // 3. Assert: cadena vacia y no `null`. Interpolar un `null` lanzaba igual
      //    que una variable ausente; una cadena vacia no, asi que las plantillas
      //    montadas sobre este nodo son seguras por construccion.
      expect(result.data?.body_source).toBe('none');
      expect(result.data?.clean_body).toBe('');
      expect(result.data?.character_count).toBe(0);
      expect(result.data?.original_character_count).toBe(0);
      expect(result.data?.reduction_percentage).toBe(0);
    });

    it('1.5 deberia inventariar los adjuntos SIN reintroducir el base64', async () => {
      // 1. Arrange
      const strategy = new ParserEmailStrategy();
      const context = buildContext(
        buildRawEmail({ attachments: [buildAttachment()] }),
      );

      // 2. Act
      const result = await strategy.execute(context, {});

      // 3. Assert: repetir los bytes en un segundo namespace los duplicaria en
      //    la misma fila y los devolveria despues de que el motor los liberase.
      expect(result.data?.attachment_count).toBe(1);
      expect(result.data?.attachments).toEqual([
        { filename: 'escaneo.pdf', contentType: 'application/pdf', size: 1024 },
      ]);
      expect(JSON.stringify(result.data)).not.toContain(BASE64_CONTENT);
    });
  });

  describe('2. Bandera de respaldo multimodal', () => {
    it('2.1 deberia levantarla con cuerpo corto y un PDF adjunto', async () => {
      // 1. Arrange: el caso que la motiva, el PDF escaneado.
      const strategy = new ParserEmailStrategy();
      const context = buildContext(
        buildRawEmail({
          text: 'Ver adjunto.',
          attachments: [buildAttachment()],
        }),
      );

      // 2. Act
      const result = await strategy.execute(context, {});

      // 3. Assert
      expect(result.data?.requires_multimodal_fallback).toBe(true);
      expect(result.data?.multimodal_reason).toContain('imagen o PDF');
    });

    it('2.2 NO deberia levantarla con cuerpo largo aunque haya imagenes', async () => {
      // 1. Arrange: un boletin con su logo en PNG no necesita vision, y usarla
      //    seria la llamada mas cara del pipeline sin motivo.
      const strategy = new ParserEmailStrategy();
      const context = buildContext(
        buildRawEmail({
          attachments: [
            buildAttachment({ filename: 'logo.png', contentType: 'image/png' }),
          ],
        }),
      );

      // 2. Act
      const result = await strategy.execute(context, {});

      // 3. Assert
      expect(result.data?.requires_multimodal_fallback).toBe(false);
      expect(result.data?.multimodal_reason).toBe('');
    });

    it('2.3 NO deberia levantarla con un adjunto que no exige vision', async () => {
      // 1. Arrange: un CSV lo decodifica otro nodo sin gastar un multimodal.
      const strategy = new ParserEmailStrategy();
      const context = buildContext(
        buildRawEmail({
          text: 'Ver adjunto.',
          attachments: [
            buildAttachment({ filename: 'datos.csv', contentType: 'text/csv' }),
          ],
        }),
      );

      // 2. Act
      const result = await strategy.execute(context, {});

      // 3. Assert
      expect(result.data?.requires_multimodal_fallback).toBe(false);
    });

    it('2.4 NO deberia levantarla sin adjuntos aunque no haya cuerpo', async () => {
      // 1. Arrange
      const strategy = new ParserEmailStrategy();
      const context = buildContext(buildRawEmail({ text: '', html: '' }));

      // 2. Act
      const result = await strategy.execute(context, {});

      // 3. Assert: sin binario que mirar, la vision no tiene nada que aportar.
      expect(result.data?.requires_multimodal_fallback).toBe(false);
    });

    it('2.5 deberia respetar el umbral configurado en minBodyLength', async () => {
      // 1. Arrange: cuerpo que basta por defecto pero no con un umbral alto.
      const strategy = new ParserEmailStrategy();
      const context = buildContext(
        buildRawEmail({ attachments: [buildAttachment()] }),
      );

      // 2. Act
      const result = await strategy.execute(context, {
        minBodyLength: 100_000,
      });

      // 3. Assert
      expect(result.data?.requires_multimodal_fallback).toBe(true);
      expect(result.data?.multimodal_reason).toContain('100000');
    });

    it('2.6 deberia usar el umbral por defecto de 50 caracteres', async () => {
      // 1. Arrange: fija el recalibrado de 200 a 50 contra una regresion
      //    silenciosa. Va en pareja con `FSM_MIN_USEFUL_TEXT_LENGTH` del motor.
      const strategy = new ParserEmailStrategy();
      const below = buildContext(
        buildRawEmail({ text: SHORT_BODY, attachments: [buildAttachment()] }),
      );
      const above = buildContext(
        buildRawEmail({
          text: BODY_OVER_THRESHOLD,
          attachments: [buildAttachment()],
        }),
      );

      // 2. Act
      const shortResult = await strategy.execute(below, {});
      const longResult = await strategy.execute(above, {});

      // 3. Assert
      expect(SHORT_BODY.length).toBeLessThan(50);
      expect(BODY_OVER_THRESHOLD.length).toBeGreaterThanOrEqual(50);
      expect(shortResult.data?.requires_multimodal_fallback).toBe(true);
      expect(longResult.data?.requires_multimodal_fallback).toBe(false);
    });
  });

  describe('2bis. Extraccion de texto de los adjuntos', () => {
    it('2bis.1 deberia publicar el texto nativo del PDF y NO pedir vision', async () => {
      // 1. Arrange: la nota de prensa viaja entera en el PDF y el cuerpo es un
      //    "Ver adjunto.". Antes esto gastaba un modelo con vision.
      const strategy = new ParserEmailStrategy();
      const nativeText =
        'La compania abre una nueva sede en Madrid que generara doscientos empleos.';
      pdfParse.mockResolvedValueOnce({ text: nativeText });
      const context = buildContext(
        buildRawEmail({
          text: 'Ver adjunto.',
          attachments: [buildAttachment()],
        }),
      );

      // 2. Act
      const result = await strategy.execute(context, {});

      // 3. Assert
      expect(result.data?.extracted_documents_text).toContain(nativeText);
      expect(result.data?.requires_multimodal_fallback).toBe(false);
    });

    it('2bis.2 deberia dejar la bandera alta si del PDF no salio ni un caracter', async () => {
      // 1. Arrange: el PDF escaneado, que es el caso que la bandera cubre.
      const strategy = new ParserEmailStrategy();
      const context = buildContext(
        buildRawEmail({
          text: 'Ver adjunto.',
          attachments: [buildAttachment()],
        }),
      );

      // 2. Act
      const result = await strategy.execute(context, {});

      // 3. Assert
      expect(result.data?.extracted_documents_text).toBe('');
      expect(result.data?.requires_multimodal_fallback).toBe(true);
    });
  });

  describe('3. Pureza: no muta namespaces ajenos', () => {
    it('3.1 NO deberia liberar el base64 de raw_email', async () => {
      // 1. Arrange: liberar memoria es competencia EXCLUSIVA del motor. Un nodo
      //    que escribe en un namespace ajeno rompe "un nodo, un namespace" y
      //    obliga a cada estrategia futura a acordarse de purgar.
      const strategy = new ParserEmailStrategy();
      const context = buildContext(
        buildRawEmail({
          text: LONG_BODY,
          attachments: [buildAttachment()],
        }),
      );

      // 2. Act
      await strategy.execute(context, {});

      // 3. Assert
      const rawEmail = context.getNamespace('raw_email');
      const attachments = rawEmail?.attachments as RawEmailAttachment[];
      expect(attachments[0].contentBase64).toBe(BASE64_CONTENT);
    });

    it('3.2 deberia dejar el namespace de origen byte a byte igual', async () => {
      // 1. Arrange
      const strategy = new ParserEmailStrategy();
      const rawEmail = buildRawEmail({ attachments: [buildAttachment()] });
      const context = buildContext(rawEmail);
      const before = JSON.stringify(context.getNamespace('raw_email'));

      // 2. Act
      await strategy.execute(context, {});

      // 3. Assert
      expect(JSON.stringify(context.getNamespace('raw_email'))).toBe(before);
    });
  });

  describe('4. Configuracion invalida', () => {
    it('4.1 deberia rechazar una clave desconocida como GRAVE', async () => {
      // 1. Arrange: sin esto, un `minBodyLenght` mal escrito se ignoraria en
      //    silencio y el criterio lo decidiria un defecto que nadie pidio.
      const strategy = new ParserEmailStrategy();

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        minBodyLenght: 50,
      });

      // 3. Assert
      expect(result.success).toBe(false);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.code).toBe(ERR_PARSER_CONFIG);
    });

    it('4.2 deberia rechazar un sourceNamespace que ningun nodo escribe', async () => {
      // 1. Arrange
      const strategy = new ParserEmailStrategy();

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        sourceNamespace: 'inventado',
      });

      // 3. Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_PARSER_CONFIG);
      expect(result.error?.missingFields).toContain('sourceNamespace');
    });
  });

  describe('5. Namespaces requeridos', () => {
    it('5.1 deberia declarar raw_email por defecto', () => {
      // 1. Arrange & 2. Act
      const strategy = new ParserEmailStrategy();

      // 3. Assert: es lo que el motor comprueba ANTES de invocar el nodo, y lo
      //    que el validador de topologia comprueba antes de guardar el flujo.
      //    Sustituye a la antigua guarda `ERR_PARSER_SOURCE_MISSING`, que era
      //    reactiva: se descubria con la ejecucion ya creada.
      expect(strategy.getRequiredNamespaces({})).toEqual(['raw_email']);
    });

    it('5.2 deberia declarar el namespace que el esquema configure', () => {
      // 1. Arrange & 2. Act
      const strategy = new ParserEmailStrategy();

      // 3. Assert: `sourceNamespace` es configurable, y por eso el requisito se
      //    DERIVA de `params` en vez de ser una constante de clase: una
      //    constante rechazaria esta configuracion, que es legitima.
      expect(
        strategy.getRequiredNamespaces({ sourceNamespace: 'scraped_web' }),
      ).toEqual(['scraped_web']);
    });

    it('5.3 deberia caer al defecto ante unos params mal formados', () => {
      // 1. Arrange & 2. Act
      const strategy = new ParserEmailStrategy();

      // 3. Assert: validar el DTO es competencia de `execute`; adelantarlo aqui
      //    daria dos mensajes distintos para el mismo error.
      expect(strategy.getRequiredNamespaces({ sourceNamespace: 42 })).toEqual([
        'raw_email',
      ]);
    });
  });

  describe('6. Saneado del cuerpo', () => {
    it('6.1 deberia eliminar script y style con su contenido', async () => {
      // 1. Arrange
      const strategy = new ParserEmailStrategy();
      const context = buildContext(
        buildRawEmail({ text: '', html: OUTLOOK_HTML }),
      );

      // 2. Act
      const result = await strategy.execute(context, {});
      const body = result.data?.clean_body as string;

      // 3. Assert: el texto interior de `style` acabaria en el prompt como si
      //    fuera prosa.
      expect(body).not.toContain('MsoTableGrid');
      expect(body).not.toContain('window.track');
      expect(body).not.toContain('<');
    });

    it('6.2 deberia conservar el texto util con parrafos coherentes', async () => {
      // 1. Arrange
      const strategy = new ParserEmailStrategy();
      const context = buildContext(
        buildRawEmail({ text: '', html: OUTLOOK_HTML }),
      );

      // 2. Act
      const result = await strategy.execute(context, {});
      const body = result.data?.clean_body as string;

      // 3. Assert
      expect(body).toContain('Nueva sede corporativa en Madrid');
      expect(body).toContain('doscientos empleos directos');
      expect(body).not.toMatch(/\n{3,}/);
    });

    it('6.3 deberia decodificar entidades sin dejar espacios duros', async () => {
      // 1. Arrange: `&nbsp;` decodifica a U+00A0, que no es un espacio ASCII;
      //    sin normalizarlo el recuento de caracteres queda inflado.
      const strategy = new ParserEmailStrategy();
      const context = buildContext(
        buildRawEmail({ text: '', html: OUTLOOK_HTML }),
      );

      // 2. Act
      const result = await strategy.execute(context, {});
      const body = result.data?.clean_body as string;

      // 3. Assert
      expect(body).toContain('generará más de doscientos');
      expect(body).not.toContain('\u00A0');
      expect(body).not.toContain('&nbsp;');
    });

    it('6.4 deberia cortar la cadena de respuesta en el divisor de Outlook', async () => {
      // 1. Arrange
      const strategy = new ParserEmailStrategy();
      const html =
        '<p>Os envio la nota de prensa adjunta.</p>' +
        '<p>-----Mensaje original-----</p><p>hilo citado que sobra</p>';
      const context = buildContext(buildRawEmail({ text: '', html }));

      // 2. Act
      const result = await strategy.execute(context, {});

      // 3. Assert
      expect(result.data?.clean_body).toBe(
        'Os envio la nota de prensa adjunta.',
      );
    });

    it('6.5 deberia cortar en la linea de atribucion "El ... escribio:"', async () => {
      // 1. Arrange
      const strategy = new ParserEmailStrategy();
      const text = [
        'Os envio la nota de prensa adjunta.',
        '',
        'El 12/03/2026, Ana <ana@ext.com> escribio:',
        '> hilo citado que sobra',
      ].join('\n');
      const context = buildContext(buildRawEmail({ text }));

      // 2. Act
      const result = await strategy.execute(context, {});

      // 3. Assert
      expect(result.data?.clean_body).toBe(
        'Os envio la nota de prensa adjunta.',
      );
    });

    it('6.6 deberia retirar la firma y el aviso legal del final', async () => {
      // 1. Arrange
      const strategy = new ParserEmailStrategy();
      const context = buildContext(
        buildRawEmail({ text: '', html: OUTLOOK_HTML }),
      );

      // 2. Act
      const result = await strategy.execute(context, {});
      const body = result.data?.clean_body as string;

      // 3. Assert
      expect(body).not.toContain('Gabinete de Prensa');
      expect(body).not.toContain('AVISO LEGAL');
    });

    it('6.7 NO deberia retirar un parrafo que menciona el RGPD en mitad del cuerpo', async () => {
      // 1. Arrange: el anti-falso-positivo que sostiene toda la heuristica. El
      //    corpus son notas de prensa institucionales, donde un comunicado puede
      //    hablar de proteccion de datos como CONTENIDO. Solo se barre la racha
      //    FINAL de parrafos, nunca el cuerpo entero.
      const strategy = new ParserEmailStrategy();
      const text = [
        'La compania abre una nueva sede en Madrid.',
        '',
        'La nueva normativa aplica el RGPD a todo el sector publico afectado.',
        '',
        'El acto de inauguracion se celebrara el proximo mes de marzo.',
      ].join('\n');
      const context = buildContext(buildRawEmail({ text }));

      // 2. Act
      const result = await strategy.execute(context, {});
      const body = result.data?.clean_body as string;

      // 3. Assert
      expect(body).toContain('RGPD');
      expect(body).toContain('inauguracion');
    });

    it('6.8 NO deberia vaciar un reenvio cuyo unico contenido es la cita', async () => {
      // 1. Arrange: es preferible entregar la cita que entregar la nada.
      const strategy = new ParserEmailStrategy();
      const text =
        '-----Mensaje original-----\nLa nota de prensa iba integramente aqui.';
      const context = buildContext(buildRawEmail({ text }));

      // 2. Act
      const result = await strategy.execute(context, {});

      // 3. Assert
      expect(result.data?.clean_body).toContain('La nota de prensa iba');
    });
  });

  describe('7. Extraccion de enlaces', () => {
    /** Lista de enlaces del correo realista, ya filtrada por el nodo. */
    const extractUrls = async (): Promise<readonly string[]> => {
      const strategy = new ParserEmailStrategy();
      const context = buildContext(
        buildRawEmail({ text: '', html: OUTLOOK_HTML }),
      );
      const result = await strategy.execute(context, {});

      return result.data?.extracted_urls as readonly string[];
    };

    it('7.1 deberia recoger los enlaces de contenido sin duplicados', async () => {
      // 1. Arrange / 2. Act
      const urls = await extractUrls();

      // 3. Assert: los dos enlaces al mismo articulo solo diferian en el
      //    parametro de campana, asi que colapsan en uno. El de la firma entra
      //    desde que la recoleccion va ANTES de podar (ver 7.6).
      expect(urls).toEqual([
        'https://unuware.com/notas/sede?id=42',
        'https://firma.example/perfil',
      ]);
    });

    it('7.2 deberia descartar el enlace de desuscripcion', async () => {
      // 1. Arrange / 2. Act
      const urls = await extractUrls();

      // 3. Assert
      expect(urls.join(' ')).not.toContain('unsubscribe');
    });

    it('7.3 deberia descartar Twitter/X, Facebook, LinkedIn e Instagram', async () => {
      // 1. Arrange / 2. Act
      const urls = await extractUrls();

      // 3. Assert
      expect(urls.join(' ')).not.toContain('twitter.com');
      expect(urls.join(' ')).not.toContain('linkedin.com');
    });

    it('7.4 deberia descartar mailto y las rutas relativas', async () => {
      // 1. Arrange: un correo no tiene documento base, y EXTRACTOR_WEB solo
      //    sabe navegar http(s).
      const urls = await extractUrls();

      // 3. Assert
      expect(urls.join(' ')).not.toContain('mailto');
      expect(urls.join(' ')).not.toContain('relativa');
    });

    it('7.5 deberia retirar los parametros utm_* conservando los funcionales', async () => {
      // 1. Arrange / 2. Act
      const urls = await extractUrls();

      // 3. Assert
      expect(urls[0]).not.toContain('utm_');
      expect(urls[0]).toContain('id=42');
    });

    it('7.6 SI deberia recoger enlaces que vivian dentro de la firma eliminada', async () => {
      // 1. Arrange: esta prueba afirmaba lo contrario y se invirtio a proposito.
      //    La recoleccion pasa a ir ANTES de podar porque un correo REENVIADO
      //    lleva sus referencias bibliograficas dentro del blockquote que la
      //    poda retira, y perderlas dejaba a `EXTRACTOR_WEB` sin trabajo (7.9).
      //    El coste es este: los enlaces dejan de describir el MISMO documento
      //    que `clean_body`.
      const urls = await extractUrls();

      // 3. Assert
      expect(urls.join(' ')).toContain('firma.example');
    });

    it('7.7 deberia recoger los enlaces del MARCADO aunque el cuerpo sea texto plano', async () => {
      // 1. Arrange: el caso real de Gmail, que envia SIEMPRE las dos partes. La
      //    cascada elige el texto para el cuerpo —es mas barato que el DOM— pero
      //    ese texto parte las URLs a 78 columnas (RFC 5322) y rescatarlas de
      //    ahi daria direcciones truncadas. El marcado del MISMO correo las
      //    declara enteras, asi que los enlaces salen de ahi.
      const strategy = new ParserEmailStrategy();
      const context = buildContext(
        buildRawEmail({
          text: '1. https://www.youtube.com/\n2. https://fast.com/\nMira estos links',
          html:
            '<div><div>1. <a href="https://www.youtube.com/">YouTube</a></div>' +
            '<div>2. <a href="https://fast.com/">Fast</a></div></div>',
        }),
      );

      // 2. Act
      const result = await strategy.execute(context, {});

      // 3. Assert: antes de este cambio salia `[]` y `EXTRACTOR_WEB` se quedaba
      //    sin nada que escrapear.
      expect(result.data?.body_source).toBe('text');
      expect(result.data?.extracted_urls).toEqual([
        'https://www.youtube.com/',
        'https://fast.com/',
      ]);
      // El cuerpo y la bandera multimodal no se tocan.
      expect(result.data?.clean_body).toContain('Mira estos links');
      expect(result.data?.requires_multimodal_fallback).toBe(false);
    });

    it('7.8 deberia devolver una lista vacia en un correo sin marcado', async () => {
      // 1. Arrange: delimita el alcance de 7.7. Sin HTML no hay ningun `<a>` que
      //    recoger, y del texto plano no se rescata nada por lo dicho alli.
      const strategy = new ParserEmailStrategy();
      const context = buildContext(
        buildRawEmail({
          text: 'Un cuerpo de texto plano con https://unuware.com dentro.',
          html: '',
        }),
      );

      // 2. Act
      const result = await strategy.execute(context, {});

      // 3. Assert
      expect(result.data?.body_source).toBe('text');
      expect(result.data?.extracted_urls).toEqual([]);
    });

    it('7.9 deberia recoger las referencias de un correo REENVIADO', async () => {
      // 1. Arrange: el caso que motiva el cambio de orden. El contenido citado
      //    —y con el las referencias bibliograficas— vive dentro del blockquote
      //    que la poda retira del cuerpo.
      const strategy = new ParserEmailStrategy();
      const context = buildContext(
        buildRawEmail({
          text: '',
          html:
            '<p>Os reenvio la convocatoria.</p>' +
            '<blockquote class="gmail_quote">' +
            '<p>Bases completas en <a href="https://unuware.com/bases">este enlace</a>.</p>' +
            '</blockquote>',
        }),
      );

      // 2. Act
      const result = await strategy.execute(context, {});

      // 3. Assert: el cuerpo sigue SIN la cita, pero la URL llega al extractor.
      expect(result.data?.clean_body).not.toContain('Bases completas');
      expect(result.data?.extracted_urls).toEqual([
        'https://unuware.com/bases',
      ]);
    });

    it('7.10 deberia descartar un href con sintaxis Markdown', async () => {
      // 1. Arrange: valor que aparece de verdad en `raw_email.html` de algunas
      //    ejecuciones. Su ORIGEN es un problema aparte, aguas arriba de este
      //    nodo; aqui solo se fija que el descarte ocurre y por que.
      const strategy = new ParserEmailStrategy();
      const context = buildContext(
        buildRawEmail({
          text: '',
          html: '<a href="[https://www.youtube.com/](https://www.youtube.com/)">video</a>',
        }),
      );

      // 2. Act
      const result = await strategy.execute(context, {});

      // 3. Assert: `new URL()` lanza porque un esquema URI debe empezar por
      //    letra ASCII. Descartarlo es correcto: `EXTRACTOR_WEB` fallaria al
      //    intentar descargar `[https://...`.
      expect(result.data?.extracted_urls).toEqual([]);
    });
  });

  describe('8. Normalizacion del asunto', () => {
    /** Ejecuta el nodo con un asunto concreto y devuelve el titulo limpio. */
    const titleOf = async (subject: string): Promise<unknown> => {
      const strategy = new ParserEmailStrategy();
      const result = await strategy.execute(
        buildContext(buildRawEmail({ subject })),
        {},
      );

      return result.data?.clean_title;
    };

    it('8.1 deberia reducir "Fwd: Re: Noticia" a "Noticia"', async () => {
      // 1. Arrange / 2. Act / 3. Assert
      await expect(titleOf('Fwd: Re: Noticia')).resolves.toBe('Noticia');
    });

    it('8.2 deberia deshacer una cadena larga de prefijos', async () => {
      // 1. Arrange / 2. Act / 3. Assert
      await expect(titleOf('RV: ENC: Re[2]: FW: Noticia')).resolves.toBe(
        'Noticia',
      );
    });

    it('8.3 deberia ser insensible a mayusculas y a los espacios sueltos', async () => {
      // 1. Arrange / 2. Act / 3. Assert
      await expect(titleOf('  re:   RV:  Noticia  ')).resolves.toBe('Noticia');
    });

    it('8.4 deberia dejar intacto un asunto sin prefijos', async () => {
      // 1. Arrange / 2. Act / 3. Assert
      await expect(titleOf('Nueva sede en Madrid')).resolves.toBe(
        'Nueva sede en Madrid',
      );
    });

    it('8.5 NO deberia vaciar el asunto cuando solo habia prefijos', async () => {
      // 1. Arrange: un titulo vacio rompe cualquier plantilla que lo interpole.
      // 2. Act / 3. Assert
      await expect(titleOf('Re:')).resolves.toBe('Re:');
    });

    it('8.6 deberia conservar el asunto crudo en la clave subject', async () => {
      // 1. Arrange: la traza forense necesita poder reconstruir que llego. Son
      //    dos datos distintos, no uno normalizado.
      const strategy = new ParserEmailStrategy();
      const context = buildContext(buildRawEmail({ subject: 'Fwd: Noticia' }));

      // 2. Act
      const result = await strategy.execute(context, {});

      // 3. Assert
      expect(result.data?.subject).toBe('Fwd: Noticia');
      expect(result.data?.clean_title).toBe('Noticia');
    });
  });

  describe('9. Metricas de reduccion (RNF-01)', () => {
    it('9.1 deberia igualar character_count a la longitud de clean_body', async () => {
      // 1. Arrange
      const strategy = new ParserEmailStrategy();
      const context = buildContext(
        buildRawEmail({ text: '', html: OUTLOOK_HTML }),
      );

      // 2. Act
      const result = await strategy.execute(context, {});

      // 3. Assert
      expect(result.data?.character_count).toBe(
        (result.data?.clean_body as string).length,
      );
    });

    it('9.2 deberia medir el original contra la fuente consumida', async () => {
      // 1. Arrange: la pareja (original, final) tiene que ser la entrada y la
      //    salida de la MISMA transformacion, no del correo entero.
      const strategy = new ParserEmailStrategy();
      const context = buildContext(
        buildRawEmail({ text: '', html: OUTLOOK_HTML }),
      );

      // 2. Act
      const result = await strategy.execute(context, {});

      // 3. Assert
      expect(result.data?.body_source).toBe('html');
      expect(result.data?.original_character_count).toBe(OUTLOOK_HTML.length);
    });

    it('9.3 deberia reducir mas del 50% de un correo HTML realista', async () => {
      // 1. Arrange: es el criterio verificable de RNF-01. El nodo existe para
      //    que el PROCESADOR_IA no pague por etiquetas, estilos, firmas ni
      //    avisos legales.
      const strategy = new ParserEmailStrategy();
      const context = buildContext(
        buildRawEmail({ text: '', html: OUTLOOK_HTML }),
      );

      // 2. Act
      const result = await strategy.execute(context, {});

      // 3. Assert
      expect(result.data?.reduction_percentage).toBeGreaterThan(50);
      expect(result.data?.character_count).toBeLessThan(
        result.data?.original_character_count as number,
      );
    });

    it('9.4 deberia devolver 0 y no NaN cuando el original es cero', async () => {
      // 1. Arrange: `NaN` se serializa a `null` en el jsonb y romperia en
      //    silencio la regla de "toda clave presente CON SU TIPO".
      const strategy = new ParserEmailStrategy();
      const context = buildContext(buildRawEmail({ text: '', html: '' }));

      // 2. Act
      const result = await strategy.execute(context, {});

      // 3. Assert
      expect(result.data?.reduction_percentage).toBe(0);
      expect(Number.isNaN(result.data?.reduction_percentage)).toBe(false);
    });

    it('9.5 deberia acotar el porcentaje al rango 0..100', async () => {
      // 1. Arrange
      const strategy = new ParserEmailStrategy();
      const context = buildContext(
        buildRawEmail({ text: '', html: OUTLOOK_HTML }),
      );

      // 2. Act
      const result = await strategy.execute(context, {});
      const percentage = result.data?.reduction_percentage as number;

      // 3. Assert
      expect(percentage).toBeGreaterThanOrEqual(0);
      expect(percentage).toBeLessThanOrEqual(100);
    });
  });
});
