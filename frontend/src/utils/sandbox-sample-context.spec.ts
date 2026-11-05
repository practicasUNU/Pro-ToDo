import { describe, expect, it } from 'vitest';

import { DRUPAL_PRESETS, DrupalOperationMode } from '@/types/nodes/drupal-http.types';
import { NodeType } from '@/types/pipeline';

import {
  SAMPLE_TENDER_MARKUP,
  buildSampleContext,
  buildSampleOverrides,
  parseSampleContext,
  withAttachment,
} from './sandbox-sample-context';

import type { UpstreamNamespace } from '@stores/nodes/node-store-registry';

const UPSTREAM = [
  {
    namespace: 'parsed_email',
    fields: [
      { name: 'clean_title', type: 'text' },
      { name: 'extracted_urls', type: 'url[]' },
    ],
  },
] as unknown as readonly UpstreamNamespace[];

describe('sandbox-sample-context', () => {
  it('1.1 deberia generar un valor de ejemplo por campo segun su tipo', () => {
    // 1. Arrange + 2. Act
    const context = buildSampleContext(UPSTREAM);

    // 3. Assert
    expect(context.parsed_email?.clean_title).toBe('Texto de ejemplo para clean_title');
    expect(Array.isArray(context.parsed_email?.extracted_urls)).toBe(true);
  });

  it('1.2 deberia anadir el adjunto en raw_email sin mutar el contexto', () => {
    // 1. Arrange
    const context = { raw_email: { subject: 'Hola' } };
    const attachment = { filename: 'a.png', contentType: 'image/png', contentBase64: 'AAA=' };

    // 2. Act
    const next = withAttachment(context, attachment);

    // 3. Assert
    expect(next.raw_email).toEqual({ subject: 'Hola', attachments: [attachment] });
    expect(context.raw_email).toEqual({ subject: 'Hola' });
  });

  it.each([
    ['{roto', 'JSON valido'],
    ['[]', 'namespace'],
    ['{"parsed_email": "texto"}', 'namespace'],
  ])('1.3 deberia explicar por que %s no es un contexto', (text, reason) => {
    // 1. Arrange + 2. Act
    const outcome = parseSampleContext(text);

    // 3. Assert
    expect('error' in outcome && outcome.error).toContain(reason);
  });

  it('1.4 deberia aceptar un contexto bien formado', () => {
    // 1. Arrange + 2. Act
    const outcome = parseSampleContext('{"parsed_email": {"clean_title": "x"}}');

    // 3. Assert
    expect(outcome).toEqual({ context: { parsed_email: { clean_title: 'x' } } });
  });

  describe('2. Ejemplo de «Abrir licitación»', () => {
    const abrirParams = {
      isSandbox: true,
      operationMode: DrupalOperationMode.APPEND_HTML_BLOCK,
      containerSelector: DRUPAL_PRESETS.ABRIR_LICITACION.containerSelector,
    };

    it('2.1 deberia entregar la licitacion envuelta en pd-licitacion-block con su expediente', () => {
      // 1. Arrange + 2. Act
      const context = buildSampleContext(
        UPSTREAM,
        buildSampleOverrides(NodeType.DESTINO_DRUPAL, abrirParams),
      );

      // 3. Assert: el namespace de origen por defecto aparece aunque no se
      //    marcara, y lo simulado no se pierde.
      expect(context.validated_drupal_json?.validated_markup).toBe(SAMPLE_TENDER_MARKUP);
      expect(SAMPLE_TENDER_MARKUP).toContain(
        'class="licitacion-entry pd-licitacion-block" data-expediente="S_2026_015"',
      );
      expect(context.parsed_email?.clean_title).toBe('Texto de ejemplo para clean_title');
    });

    it('2.2 deberia respetar el origen configurado en el nodo', () => {
      const overrides = buildSampleOverrides(NodeType.DESTINO_DRUPAL, {
        ...abrirParams,
        sourceNamespace: 'llm_response',
        sourceField: 'html',
      });

      expect(overrides).toEqual({ llm_response: { html: SAMPLE_TENDER_MARKUP } });
    });

    it('2.3 NO deberia aplicarse a Verificacion de titulos ni a otros nodos', () => {
      expect(
        buildSampleOverrides(NodeType.DESTINO_DRUPAL, {
          ...abrirParams,
          containerSelector: DRUPAL_PRESETS.VERIFICACION_TITULOS.containerSelector,
        }),
      ).toEqual({});
      expect(buildSampleOverrides(NodeType.DESTINO_HTTP_GENERICO, abrirParams)).toEqual({});
    });
  });
});
