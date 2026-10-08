import { describe, expect, it } from 'vitest';

import { MARKER_PATTERN } from '@/utils/codemirror-markers';

/** `MARKER_PATTERN` es global y con estado: se recorre desde cero cada vez. */
const matchesIn = (text: string): string[] => [...text.matchAll(MARKER_PATTERN)].map(([m]) => m);

describe('codemirror-markers · gramatica compartida del marcador', () => {
  it('1. deberia reconocer la ruta namespace.campo', () => {
    // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
    expect(matchesIn('Redacta a partir de {{parsed_email.clean_body}} y nada mas.')).toEqual([
      '{{parsed_email.clean_body}}',
    ]);
  });

  it('2. deberia reconocer el indice de un campo de lista', () => {
    // 1. Arrange 📐 + 2. Act ⚙️: el extractor web publica `url[]`, y una
    // plantilla cita una posicion concreta.
    expect(matchesIn('{{parsed_email.extracted_urls.[0]}}')).toEqual([
      '{{parsed_email.extracted_urls.[0]}}',
    ]);
  });

  it('3. deberia tolerar los espacios interiores', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    expect(matchesIn('{{ scraped_web.full_article_content }}')).toHaveLength(1);
  });

  it('4. NO deberia reconocer un marcador sin campo ni las formas de bloque', () => {
    // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯: `{{#each}}` y `{{#if}}` los
    // rechaza el backend (`assertDeterministicSyntax`); resaltarlos como si
    // fueran validos invitaria a escribirlos.
    expect(matchesIn('{{solo_namespace}} {{#each items}} {{/each}}')).toEqual([]);
  });

  it('5. deberia encontrar varios marcadores en el mismo texto', () => {
    // 1. Arrange 📐 + 2. Act ⚙️: comprueba ademas que `lastIndex` no se queda
    // colgado entre llamadas, que es el fallo clasico de un regex global.
    const text = '{{a.b}} y {{c.d}}';

    expect(matchesIn(text)).toEqual(['{{a.b}}', '{{c.d}}']);
    expect(matchesIn(text)).toEqual(['{{a.b}}', '{{c.d}}']);
  });
});
