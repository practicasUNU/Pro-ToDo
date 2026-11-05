import * as cheerio from 'cheerio';

import {
  escapeSelectorString,
  isSafeLinkValue,
  replaceLinkAttribute,
} from './link-attribute.util';

describe('replaceLinkAttribute', () => {
  it('deberia anadir el atributo si el elemento no lo tenia, sin tocar el resto', () => {
    // 1. Arrange 📐
    const html = '<p>Antes</p><a class="cta">Inscribete</a><img alt="x" />';

    // 2. Act ⚙️
    const linked = replaceLinkAttribute(html, 'a.cta', 'href', '/alta');
    const pictured = replaceLinkAttribute(html, 'img', 'src', '/foto.jpg');

    // 3. Assert 🎯
    expect(linked).toEqual({
      html: '<p>Antes</p><a class="cta" href="/alta">Inscribete</a><img alt="x" />',
      previousValue: null,
    });
    expect(pictured).toMatchObject({
      html: '<p>Antes</p><a class="cta">Inscribete</a><img alt="x"  src="/foto.jpg"/>',
    });
  });

  it('deberia escapar las comillas y los angulos del nuevo valor', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const result = replaceLinkAttribute(
      '<a href="/a">x</a>',
      'a',
      'href',
      '/b?q="1"&r=<2>',
    );

    // 3. Assert 🎯: el valor no puede cerrar el atributo ni abrir etiquetas.
    expect(result).toMatchObject({
      html: '<a href="/b?q=&quot;1&quot;&amp;r=&lt;2&gt;">x</a>',
      previousValue: '/a',
    });
  });

  it('deberia informar del numero de coincidencias si no es exactamente una', () => {
    // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
    expect(replaceLinkAttribute('<p>x</p>', 'a', 'href', '/a')).toEqual({
      matches: 0,
    });
    expect(replaceLinkAttribute('<a>1</a><a>2</a>', 'a', 'href', '/a')).toEqual(
      { matches: 2 },
    );
  });

  it('deberia devolver el selector invalido en vez de lanzar', () => {
    // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
    expect(replaceLinkAttribute('<a>1</a>', 'a[', 'href', '/a')).toEqual({
      invalidSelector: 'a[',
    });
  });
});

describe('isSafeLinkValue', () => {
  it('deberia aceptar rutas relativas, http(s) y mailto solo en enlaces', () => {
    // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
    expect(isSafeLinkValue('/sites/default/files/a.pdf', 'href')).toBe(true);
    expect(isSafeLinkValue('https://www.madrimasd.org/x', 'src')).toBe(true);
    expect(isSafeLinkValue('mailto:info@madrimasd.org', 'href')).toBe(true);
    expect(isSafeLinkValue('mailto:info@madrimasd.org', 'src')).toBe(false);
  });

  it('deberia rechazar esquemas ejecutables aunque vengan disfrazados', () => {
    // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯: el navegador ignora los
    //    espacios y tabuladores dentro del esquema.
    expect(isSafeLinkValue('javascript:alert(1)', 'href')).toBe(false);
    expect(isSafeLinkValue(' JaVa\tScRiPt:alert(1)', 'href')).toBe(false);
    expect(isSafeLinkValue('data:image/png;base64,AAAA', 'src')).toBe(false);
    expect(isSafeLinkValue('   ', 'href')).toBe(false);
  });
});

describe('escapeSelectorString', () => {
  const PAGE =
    '<table>' +
    '<tr><td>Mentoring (Encuentro Anual)</td><td><a href="/1">x</a></td></tr>' +
    '<tr><td>O\'Donnell &amp; Cía.</td><td><a href="/2">x</a></td></tr>' +
    '<tr><td>[Beta]</td><td><a href="/3">x</a></td></tr>' +
    '<tr><td>a, b</td><td><a href="/4">x</a></td></tr>' +
    '<tr><td>Otro</td><td><a href="/5">x</a></td></tr>' +
    '</table>';

  it.each([
    ['Mentoring (Encuentro Anual)', '/1'],
    ["O'Donnell & Cía.", '/2'],
    ['[Beta]', '/3'],
    ['a, b', '/4'],
  ])(
    'deberia casar EXACTAMENTE la fila de %s dentro de :contains()',
    (value, href) => {
      // 1. Arrange 📐
      const $ = cheerio.load(PAGE, { xml: { xmlMode: false } }, false);

      // 2. Act ⚙️
      const matches = $(
        `table tr:contains('${escapeSelectorString(value)}') a`,
      );

      // 3. Assert 🎯: parsea, casa una sola fila y es la esperada.
      expect(matches).toHaveLength(1);
      expect(matches.attr('href')).toBe(href);
    },
  );

  it('deberia colapsar espacios y quitar caracteres de control', () => {
    expect(
      escapeSelectorString('  Mentoring\n\t (Encuentro\u00a0Anual)\u0007 '),
    ).toBe('Mentoring \\(Encuentro Anual\\)');
  });

  it('NO deberia dejar que el valor abra una segunda clausula', () => {
    // 1. Arrange 📐
    const $ = cheerio.load(PAGE, { xml: { xmlMode: false } }, false);
    const value = escapeSelectorString("zzz') a, tr:contains('Otro");

    // 2. Act ⚙️ + 3. Assert 🎯
    expect($(`table tr:contains('${value}') a`)).toHaveLength(0);
  });
});
