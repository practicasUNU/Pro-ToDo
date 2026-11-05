import { describe, expect, it } from 'vitest';

import {
  buildMarker,
  chipClassFor,
  extractMandatoryPromptVariables,
  isMandatoryMarker,
  PROMPT_MARKER_PATTERN,
} from '@/utils/prompt-markers';
import { MARKER_PATTERN } from '@/utils/codemirror-markers';

/** Los patrones son globales y con estado: se recorren desde cero cada vez. */
const matchesIn = (pattern: RegExp, text: string): string[] =>
  [...text.matchAll(pattern)].map(([m]) => m);

describe('prompt-markers · marcas obligatorias y opcionales', () => {
  it('1. deberia reconocer marcas obligatorias con y sin espacios', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const found = matchesIn(
      PROMPT_MARKER_PATTERN,
      '{{*parsed_email.clean_body}} {{ * scraped_web.byline }} {{ocr_result.clean_body}}',
    );

    // 3. Assert 🎯
    expect(found).toEqual([
      '{{*parsed_email.clean_body}}',
      '{{ * scraped_web.byline }}',
      '{{ocr_result.clean_body}}',
    ]);
  });

  it('2. NO deberia resaltar el asterisco en el patron de plantillas HTML', () => {
    // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯: alli seria un residuo.
    expect(matchesIn(MARKER_PATTERN, '{{*parsed_email.clean_body}}')).toEqual([]);
  });

  it('3. deberia distinguir la obligatoriedad y su chip por el texto', () => {
    // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
    expect(isMandatoryMarker('{{ *ns.campo}}')).toBe(true);
    expect(isMandatoryMarker('{{ns.campo}}')).toBe(false);
    expect(chipClassFor('{{*ns.campo}}')).toBe('pd-chip-mandatory');
    expect(chipClassFor('{{ns.campo}}')).toBe('pd-chip-optional');
  });

  it('4. deberia componer marcadores con o sin asterisco', () => {
    // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
    expect(buildMarker('parsed_email', 'clean_title')).toBe('{{parsed_email.clean_title}}');
    expect(buildMarker('parsed_email', 'clean_title', true)).toBe('{{*parsed_email.clean_title}}');
  });

  it('5. deberia extraer solo las rutas obligatorias, sin duplicados y en orden', () => {
    // 1. Arrange 📐
    const prompt =
      'Usa {{ * scraped_web.full_article_content }} y {{parsed_email.sender}}; ' +
      'titular {{*parsed_email.clean_title}}; repite {{*scraped_web.full_article_content}}.';

    // 2. Act ⚙️
    const required = extractMandatoryPromptVariables(prompt);

    // 3. Assert 🎯
    expect(required).toEqual(['scraped_web.full_article_content', 'parsed_email.clean_title']);
  });
});
