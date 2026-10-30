import { isSafeLinkValue, replaceLinkAttribute } from './link-attribute.util';

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
