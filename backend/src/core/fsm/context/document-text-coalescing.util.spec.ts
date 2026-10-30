import {
  coalesceDocumentTextMarkers,
  stripDocumentTextMarkers,
} from './document-text-coalescing.util';

/** Lector sobre un mapa plano `ruta -> texto`. */
const readerOf =
  (texts: Record<string, string>) =>
  (path: string): string | null =>
    texts[path] ?? null;

describe('coalesceDocumentTextMarkers', () => {
  it('deberia dejar intacto un marcador que ya tiene texto', () => {
    // 1. Arrange 📐
    const prompt = 'Resume {{ocr_result.clean_body}}';

    // 2. Act ⚙️
    const result = coalesceDocumentTextMarkers(
      prompt,
      readerOf({ 'ocr_result.clean_body': 'escaneo' }),
    );

    // 3. Assert 🎯
    expect(result.prompt).toBe(prompt);
    expect(result.substitutions).toEqual([]);
  });

  it('deberia recorrer la cadena completa hasta el cuerpo del correo', () => {
    // 1. Arrange 📐
    const prompt = 'Resume {{ ocr_result.clean_body }}';

    // 2. Act ⚙️
    const result = coalesceDocumentTextMarkers(
      prompt,
      readerOf({ 'parsed_email.clean_body': 'cuerpo' }),
    );

    // 3. Assert 🎯
    expect(result.prompt).toBe('Resume {{parsed_email.clean_body}}');
    expect(result.substitutions).toEqual([
      { from: 'ocr_result.clean_body', to: 'parsed_email.clean_body' },
    ]);
  });

  it('deberia buscar desde la posicion del marcador, nunca hacia arriba', () => {
    // 1. Arrange 📐: pedir los adjuntos no debe devolver el OCR.
    const prompt = '{{parsed_email.extracted_documents_text}}';

    // 2. Act ⚙️
    const result = coalesceDocumentTextMarkers(
      prompt,
      readerOf({
        'ocr_result.clean_body': 'escaneo',
        'parsed_email.clean_body': 'cuerpo',
      }),
    );

    // 3. Assert 🎯
    expect(result.prompt).toBe('{{parsed_email.clean_body}}');
  });

  it('deberia dejar el marcador si ninguna ruta tiene texto', () => {
    // 1. Arrange 📐
    const prompt = 'Resume {{ocr_result.clean_body}}';

    // 2. Act ⚙️
    const result = coalesceDocumentTextMarkers(prompt, readerOf({}));

    // 3. Assert 🎯: la interpolacion fallara con el marcador original.
    expect(result.prompt).toBe(prompt);
    expect(result.substitutions).toEqual([]);
  });

  it('NO deberia tocar marcadores fuera de la cadena documental', () => {
    // 1. Arrange 📐
    const prompt = '{{scraped_web.article_title}} {{parsed_email.clean_title}}';

    // 2. Act ⚙️
    const result = coalesceDocumentTextMarkers(prompt, readerOf({}));

    // 3. Assert 🎯
    expect(result.prompt).toBe(prompt);
  });
});

describe('stripDocumentTextMarkers', () => {
  it('deberia quitar solo los marcadores de texto documental', () => {
    // 1. Arrange 📐
    const template = 'A {{ocr_result.clean_body}} B {{trigger.flow_name}}';

    // 2. Act ⚙️
    const result = stripDocumentTextMarkers(template);

    // 3. Assert 🎯
    expect(result).toBe('A  B {{trigger.flow_name}}');
  });
});
