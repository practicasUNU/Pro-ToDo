import { escapeHtml } from './escape-html.util';

describe('escapeHtml', () => {
  describe('1. Los cinco caracteres con significado', () => {
    it.each([
      ['&', '&amp;'],
      ['<', '&lt;'],
      ['>', '&gt;'],
      ['"', '&quot;'],
      ["'", '&#39;'],
    ])('1.1 deberia escapar %s', (input, expected) => {
      // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
      expect(escapeHtml(input)).toBe(expected);
    });

    it('1.2 no deberia tocar un texto sin marcado', () => {
      // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
      expect(escapeHtml('Nota de prensa institucional')).toBe(
        'Nota de prensa institucional',
      );
    });

    it('1.3 deberia devolver la cadena vacia intacta', () => {
      expect(escapeHtml('')).toBe('');
    });
  });

  describe('2. Doble escapado', () => {
    it('2.1 no deberia escapar dos veces el ampersand de una entidad', () => {
      // 1. Arrange 📐: es el fallo clasico de escapar `<` antes que `&`. Un
      //    "AT&T" acabaria como "&amp;amp;" y el cliente de correo pintaria
      //    "&amp;" literal en mitad del nombre de la empresa.
      // 2. Act ⚙️ + 3. Assert 🎯
      expect(escapeHtml('AT&T')).toBe('AT&amp;T');
      expect(escapeHtml('3 < 5 & 5 > 3')).toBe('3 &lt; 5 &amp; 5 &gt; 3');
    });
  });

  describe('3. Vectores de inyeccion', () => {
    it('3.1 deberia neutralizar un manejador de evento', () => {
      // 1. Arrange 📐: el caso que motiva el util. `error_message` cita el asunto
      //    del correo ENTRANTE, que escribe cualquiera.
      const payload = '<img src=x onerror="alert(1)">';

      // 2. Act ⚙️
      const escaped = escapeHtml(payload);

      // 3. Assert 🎯: no queda ni una etiqueta que el cliente pueda abrir.
      expect(escaped).not.toContain('<');
      expect(escaped).not.toContain('>');
      expect(escaped).toContain(
        '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;',
      );
    });

    it('3.2 deberia neutralizar un cierre de atributo', () => {
      // 1. Arrange 📐: el valor se incrusta dentro de `style="..."` en varias
      //    filas de la carta; sin escapar la comilla se sale del atributo.
      // 2. Act ⚙️ + 3. Assert 🎯
      expect(escapeHtml('" onmouseover="robar()')).toBe(
        '&quot; onmouseover=&quot;robar()',
      );
    });
  });
});
