import {
  deriveOrganizationFromHost,
  extractDateFromUrl,
} from '@modules/nodes/utils/article-metadata.util';

describe('article-metadata.util', () => {
  describe('1. extractDateFromUrl', () => {
    it.each([
      [
        'https://f-droid.org/es/2026/02/24/open-letter-to-the-community/',
        '2026-02-24',
      ],
      ['https://blog.example/2026-3-5/nota', '2026-03-05'],
      ['https://blog.example/archivo/2025/12/31', '2025-12-31'],
    ])('1.1 deberia leer la fecha de %s', (url: string, expected: string) => {
      // 1. Arrange 📐 (la URL) · 2. Act ⚙️ · 3. Assert 🎯
      expect(extractDateFromUrl(url)).toBe(expected);
    });

    it.each([
      ['https://blog.example/2026/02/31/dia-imposible/'],
      ['https://blog.example/2026/13/01/mes-imposible/'],
      ['https://blog.example/noticia/20260224123/'],
      ['https://blog.example/1850/01/01/fuera-de-rango/'],
      ['no es una url'],
    ])('1.2 deberia devolver null para %s', (url: string) => {
      // 1. Arrange 📐 (la URL) · 2. Act ⚙️ · 3. Assert 🎯
      expect(extractDateFromUrl(url)).toBeNull();
    });
  });

  describe('2. deriveOrganizationFromHost', () => {
    it.each([
      ['https://f-droid.org/es/2026/02/24/open-letter/', 'F-Droid'],
      ['https://www.madrimasd.org/noticias', 'Madrimasd'],
      ['https://noticias.ejemplo.com.es/nota', 'Ejemplo'],
      ['https://www.bbc.co.uk/news', 'Bbc'],
    ])(
      '2.1 deberia derivar la organizacion de %s',
      (url: string, expected: string) => {
        // 1. Arrange 📐 (la URL) · 2. Act ⚙️ · 3. Assert 🎯
        expect(deriveOrganizationFromHost(url)).toBe(expected);
      },
    );

    it.each([
      ['http://192.168.1.50/nota'],
      ['http://localhost/nota'],
      ['no es una url'],
    ])('2.2 deberia devolver null para %s', (url: string) => {
      // 1. Arrange 📐 (la URL) · 2. Act ⚙️ · 3. Assert 🎯
      expect(deriveOrganizationFromHost(url)).toBeNull();
    });
  });
});
