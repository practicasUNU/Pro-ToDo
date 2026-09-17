import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { createMockStatePayloadContext } from '@test/factories/state-payload-context.factory';

import {
  ERR_PARSER_CONFIG,
  ERR_PARSER_SOURCE_MISSING,
  ParserEmailStrategy,
} from './parser-email.strategy';

import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import type { RawEmailAttachment } from '@modules/nodes/interfaces/raw-email-attachment.interface';

const BASE64_CONTENT = 'Y29udGVuaWRvLWJpbmFyaW8=';

/** Cuerpo largo que supera con holgura el umbral por defecto (200). */
const LONG_BODY = 'Texto suficiente para un modelo de lenguaje. '.repeat(10);

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

/** Contexto en el que ningun nodo anterior escribio `raw_email`. */
const buildEmptyContext = (): StatePayloadContext =>
  createMockStatePayloadContext({ currentStep: 'parser_pre_ia' });

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
    it('1.1 deberia exponer las siete claves deterministas', async () => {
      // 1. Arrange
      const strategy = new ParserEmailStrategy();

      // 2. Act
      const result = await strategy.execute(buildContext(), {});

      // 3. Assert
      expect(result.success).toBe(true);
      expect(Object.keys(result.data ?? {})).toEqual([
        'subject',
        'clean_body',
        'body_source',
        'attachment_count',
        'attachments',
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
    });

    it('1.3 deberia declarar el marcado pendiente de sanear si no hay texto', async () => {
      // 1. Arrange: el caso del multipart/alternative sin parte text/plain.
      const strategy = new ParserEmailStrategy();
      const context = buildContext(buildRawEmail({ text: '' }));

      // 2. Act
      const result = await strategy.execute(context, {});

      // 3. Assert: `clean_body` a null en vez de volcar el HTML crudo, que
      //    envenenaria el prompt del nodo de inferencia con etiquetas.
      expect(result.data?.body_source).toBe('html_pending_sanitize');
      expect(result.data?.clean_body).toBeNull();
    });

    it('1.4 deberia declarar body_source "none" en un correo sin cuerpo', async () => {
      // 1. Arrange
      const strategy = new ParserEmailStrategy();
      const context = buildContext(buildRawEmail({ text: '', html: '' }));

      // 2. Act
      const result = await strategy.execute(context, {});

      // 3. Assert
      expect(result.data?.body_source).toBe('none');
      expect(result.data?.clean_body).toBeNull();
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

  describe('5. Namespace de origen ausente', () => {
    it('5.1 deberia fallar como GRAVE si ningun nodo escribio el origen', async () => {
      // 1. Arrange
      const strategy = new ParserEmailStrategy();

      // 2. Act
      const result = await strategy.execute(buildEmptyContext(), {});

      // 3. Assert: GRAVE y no URGENTE para que el flujo quede PAUSADO y
      //    reanudable tras corregir la topologia (CU-09).
      expect(result.success).toBe(false);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.code).toBe(ERR_PARSER_SOURCE_MISSING);
      expect(result.error?.missingFields).toContain('raw_email');
    });
  });
});
