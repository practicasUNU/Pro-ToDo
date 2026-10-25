import { describe, expect, it } from 'vitest';

import { buildSampleContext, parseSampleContext, withAttachment } from './sandbox-sample-context';

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
});
