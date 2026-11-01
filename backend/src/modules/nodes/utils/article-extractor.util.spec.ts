import {
  MIN_ARTICLE_LENGTH,
  extractArticle,
} from '@modules/nodes/utils/article-extractor.util';

const SOURCE_URL = 'https://diario.example/nota-de-prensa';

/**
 * Parrafo de relleno con prosa suficiente para que Readability lo puntue como
 * contenido y para superar `MIN_ARTICLE_LENGTH`. Un texto corto haria fallar las
 * pruebas por el listado y no por lo que cada una examina.
 */
const FILLER = [
  'La delegacion municipal presento esta manana el plan de actuacion previsto',
  'para el proximo ejercicio, que contempla una inversion repartida entre las',
  'distintas areas de servicio y un calendario de ejecucion por fases.',
].join(' ');

/** Documento minimo que Readability reconoce como articulo. */
const buildDocument = (body: string): string =>
  `<!DOCTYPE html><html lang="es"><head><title>Titular de la nota</title></head>` +
  `<body><article>${body}</article></body></html>`;

describe('extractArticle', () => {
  describe('0. Aplanado a texto plano', () => {
    it('0.1 deberia separar los parrafos con un salto de linea', () => {
      // 1. Arrange: dos parrafos hermanos, sin separador textual entre ellos.
      const html = buildDocument(
        `<h1>Titular</h1><p>${FILLER}</p><p>Segundo parrafo. ${FILLER}</p>`,
      );

      // 2. Act
      const article = extractArticle(html, SOURCE_URL);

      // 3. Assert: sin la insercion de saltos en el DOM, Readability y
      //    sanitize-html devolverian los parrafos pegados ("...fases.Segundo").
      expect(article).not.toBeNull();
      expect(article?.content).toContain('fases.\n\nSegundo parrafo.');
    });

    it('0.2 deberia convertir cada <br> en un salto de linea', () => {
      // 1. Arrange
      const html = buildDocument(
        `<p>${FILLER}</p><p>Linea uno<br>linea dos. ${FILLER}</p>`,
      );

      // 2. Act
      const article = extractArticle(html, SOURCE_URL);

      // 3. Assert
      expect(article?.content).toContain('Linea uno\nlinea dos.');
    });

    it('0.3 no deberia dejar ninguna etiqueta en el contenido', () => {
      // 1. Arrange: marcado con enfasis, enlaces y un script de por medio.
      const html = buildDocument(
        `<p>${FILLER} <strong>negrita</strong> y <a href="/otra">un enlace</a>.</p>` +
          `<script>window.rastreo = 1;</script><p>${FILLER}</p>`,
      );

      // 2. Act
      const article = extractArticle(html, SOURCE_URL);

      // 3. Assert: ni marcado ni el cuerpo del script, que `sanitize-html`
      //    descarta entero por ser una etiqueta de no-texto.
      expect(article?.content).not.toMatch(/<[a-z/]/i);
      expect(article?.content).toContain('negrita');
      expect(article?.content).not.toContain('window.rastreo');
    });

    it('0.4 deberia devolver las entidades HTML ya decodificadas', () => {
      // 1. Arrange
      const html = buildDocument(
        `<p>${FILLER}</p><p>AT&amp;T firmo cuando 3 &lt; 5. ${FILLER}</p>`,
      );

      // 2. Act
      const article = extractArticle(html, SOURCE_URL);

      // 3. Assert: es la razon por la que el aplanado final es `textContent` y
      //    no una segunda pasada de `sanitize-html`, que RE-ESCAPA su salida y
      //    publicaria "AT&amp;amp;T" en el articulo destino.
      expect(article?.content).toContain('AT&T firmo cuando 3 < 5.');
      expect(article?.content).not.toContain('&amp;');
      expect(article?.content).not.toContain('&lt;');
    });

    it('0.5 deberia colapsar los espacios duros y las lineas en blanco de mas', () => {
      // 1. Arrange
      const html = buildDocument(
        `<p>${FILLER}</p><p>Con&nbsp;espacios&nbsp;duros. ${FILLER}</p>`,
      );

      // 2. Act
      const article = extractArticle(html, SOURCE_URL);

      // 3. Assert: `normalizeWhitespace` convierte U+00A0 y limita a un unico
      //    parrafo en blanco.
      expect(article?.content).toContain('Con espacios duros.');
      expect(article?.content).not.toMatch(/\u00A0/);
      expect(article?.content).not.toMatch(/\n{3,}/);
    });
  });

  describe('1. Metadatos del articulo', () => {
    it('1.1 deberia devolver el titulo y la firma cuando el marcado los declara', () => {
      // 1. Arrange
      const html = buildDocument(
        `<h1>Titular de la nota</h1>` +
          `<p class="byline" rel="author">Redaccion Local</p>` +
          `<p>${FILLER}</p><p>${FILLER}</p>`,
      );

      // 2. Act
      const article = extractArticle(html, SOURCE_URL);

      // 3. Assert
      expect(article?.title).toBe('Titular de la nota');
      expect(article?.byline).toBe('Redaccion Local');
    });

    it('1.2 deberia devolver byline nulo cuando no hay firma', () => {
      // 1. Arrange
      const html = buildDocument(`<p>${FILLER}</p><p>${FILLER}</p>`);

      // 2. Act
      const article = extractArticle(html, SOURCE_URL);

      // 3. Assert: `null` y no cadena vacia. El contrato de salida distingue
      //    "sin firma" de "firmado por nadie".
      expect(article?.byline).toBeNull();
    });
  });

  describe('2. Ausencia de contenido aprovechable', () => {
    it('2.1 deberia devolver null ante un documento vacio', () => {
      // 1. Arrange, 2. Act
      const article = extractArticle('   ', SOURCE_URL);

      // 3. Assert
      expect(article).toBeNull();
    });

    it('2.2 deberia devolver null cuando el contenido no llega al minimo', () => {
      // 1. Arrange: un aviso de cookies es exactamente lo que Readability
      //    devuelve cuando la pagina no tiene articulo.
      const html = buildDocument('<p>Utilizamos cookies propias.</p>');
      const onContentTooShort = jest.fn();

      // 2. Act
      const article = extractArticle(html, SOURCE_URL, { onContentTooShort });

      // 3. Assert: sin este listado, el PROCESADOR_IA redactaria una noticia a
      //    partir del aviso de cookies.
      expect(article).toBeNull();
      expect(onContentTooShort).toHaveBeenCalledTimes(1);

      const [length] = onContentTooShort.mock.calls[0] as [number];

      expect(length).toBeLessThan(MIN_ARTICLE_LENGTH);
    });

    it('2.3 deberia avisar cuando Readability no identifica contenido', () => {
      // 1. Arrange
      const onReadabilityFailure = jest.fn();

      // 2. Act
      extractArticle('', SOURCE_URL, { onReadabilityFailure });

      // 3. Assert
      expect(onReadabilityFailure).toHaveBeenCalledTimes(1);
    });
  });

  describe('2. Metadatos editoriales (autor, fecha y referencias)', () => {
    const withHead = (head: string, body: string): string =>
      `<!DOCTYPE html><html lang="es"><head><title>Titular de la nota</title>${head}</head>` +
      `<body><article>${body}</article></body></html>`;

    it('2.1 deberia leer autor y fecha de los <meta>', () => {
      // 1. Arrange 📐
      const html = withHead(
        '<meta name="author" content="Ana Perez">' +
          '<meta property="article:published_time" content="2026-09-20T08:00:00Z">',
        `<p>${FILLER}</p>`,
      );

      // 2. Act ⚙️
      const article = extractArticle(html, SOURCE_URL);

      // 3. Assert 🎯
      expect(article?.author).toBe('Ana Perez');
      expect(article?.publishedAt).toBe('2026-09-20T08:00:00.000Z');
    });

    it('2.2 deberia caer en JSON-LD con @graph y autores en array', () => {
      // 1. Arrange 📐
      const jsonLd = JSON.stringify({
        '@graph': [
          {
            '@type': 'NewsArticle',
            author: [{ name: 'Ana Perez' }, 'Luis Gil'],
            datePublished: '2026-09-19',
          },
        ],
      });
      const html = withHead(
        `<script type="application/ld+json">${jsonLd}</script>`,
        `<p>${FILLER}</p>`,
      );

      // 2. Act ⚙️
      const article = extractArticle(html, SOURCE_URL);

      // 3. Assert 🎯
      expect(article?.author).toBe('Ana Perez, Luis Gil');
      expect(article?.publishedAt).toBe('2026-09-19T00:00:00.000Z');
    });

    it('2.3 NO deberia romperse con un JSON-LD malformado y usar <time>', () => {
      // 1. Arrange 📐
      const html = withHead(
        '<script type="application/ld+json">{ roto </script>',
        `<time datetime="2026-09-18T10:00:00Z">18 sep</time><p>${FILLER}</p>`,
      );

      // 2. Act ⚙️
      const article = extractArticle(html, SOURCE_URL);

      // 3. Assert 🎯
      expect(article).not.toBeNull();
      expect(article?.author).toBeNull();
      expect(article?.publishedAt).toBe('2026-09-18T10:00:00.000Z');
    });

    it('2.4 deberia citar solo enlaces externos, sin duplicados ni mailto', () => {
      // 1. Arrange 📐
      const html = buildDocument(
        `<p>${FILLER} <a href="https://doi.org/10.1000/xyz">Estudio</a>` +
          ` <a href="https://doi.org/10.1000/xyz#sec">Estudio bis</a>` +
          ` <a href="/otra-nota">Interna</a>` +
          ` <a href="mailto:prensa@diario.example">Prensa</a>` +
          ` <a href="https://revista.example/art">Revista</a></p>`,
      );

      // 2. Act ⚙️
      const article = extractArticle(html, SOURCE_URL);

      // 3. Assert 🎯
      expect(article?.references).toEqual([
        { title: 'Estudio', url: 'https://doi.org/10.1000/xyz' },
        { title: 'Revista', url: 'https://revista.example/art' },
      ]);
    });
  });
});
