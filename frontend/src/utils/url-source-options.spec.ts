import { describe, expect, it } from 'vitest';

import {
  buildUrlOptions,
  FIRST_ELIGIBLE_LABEL_SUFFIX,
  insertAtCaret,
  SELECTABLE_URL_SLOTS,
} from './url-source-options';

import type { UpstreamNamespace } from '@stores/nodes/node-store-registry';

const CONTEXT: readonly UpstreamNamespace[] = [
  {
    namespace: 'parsed_email',
    fields: [
      { name: 'extracted_urls', type: 'url[]' },
      { name: 'clean_title', type: 'string' },
    ],
  },
  { namespace: 'scraped_web', fields: [{ name: 'url', type: 'url' }] },
] as unknown as readonly UpstreamNamespace[];

describe('url-source-options', () => {
  describe('1. buildUrlOptions', () => {
    it('1.1 deberia ofrecer solo posiciones concretas al destino HTTP', () => {
      // 1. Arrange + 2. Act
      const options = buildUrlOptions(CONTEXT, { includeFirstEligible: false });

      // 3. Assert: N posiciones del arreglo + el escalar; nunca el arreglo entero.
      expect(options).toHaveLength(SELECTABLE_URL_SLOTS + 1);
      expect(options.map((option) => option.value)).toContain('{{parsed_email.extracted_urls[0]}}');
      expect(options.map((option) => option.value)).toContain('{{scraped_web.url}}');
      expect(options.map((option) => option.value)).not.toContain(
        '{{parsed_email.extracted_urls}}',
      );
    });

    it('1.2 deberia anteponer el criterio del extractor web cuando se pide', () => {
      // 1. Arrange + 2. Act
      const options = buildUrlOptions(CONTEXT, { includeFirstEligible: true });

      // 3. Assert
      expect(options[0]?.value).toBe('{{parsed_email.extracted_urls}}');
      expect(options[0]?.label).toContain(FIRST_ELIGIBLE_LABEL_SUFFIX);
    });

    it('1.3 NO deberia ofrecer campos que no son URL', () => {
      // 1. Arrange + 2. Act
      const options = buildUrlOptions(CONTEXT, { includeFirstEligible: false });

      // 3. Assert
      expect(options.some((option) => option.value.includes('clean_title'))).toBe(false);
    });
  });

  describe('2. insertAtCaret', () => {
    it('2.1 deberia insertar en medio y dejar el cursor detras', () => {
      // 1. Arrange
      const text = 'https://api.ejemplo.org//avisos';

      // 2. Act
      const result = insertAtCaret(text, '{{ns.id}}', 24, 24);

      // 3. Assert
      expect(result.text).toBe('https://api.ejemplo.org/{{ns.id}}/avisos');
      expect(result.caret).toBe(24 + '{{ns.id}}'.length);
    });

    it('2.2 deberia sustituir la seleccion', () => {
      // 1. Arrange + 2. Act
      const result = insertAtCaret('https://x.org/ID/a', '{{ns.id}}', 14, 16);

      // 3. Assert
      expect(result.text).toBe('https://x.org/{{ns.id}}/a');
    });

    it('2.3 deberia anadir al final sin posicion conocida', () => {
      // 1. Arrange + 2. Act
      const result = insertAtCaret('https://x.org/', '{{ns.id}}', null, null);

      // 3. Assert
      expect(result.text).toBe('https://x.org/{{ns.id}}');
    });

    it('2.4 deberia acotar posiciones fuera de rango', () => {
      // 1. Arrange + 2. Act
      const result = insertAtCaret('abc', 'X', 99, 120);

      // 3. Assert
      expect(result.text).toBe('abcX');
    });
  });
});
