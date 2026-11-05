import { escapeHtmlAttribute, wrapTenderBlock } from './tender-block.util';

describe('wrapTenderBlock', () => {
  it('deberia no duplicar la clase si el bloque ya la trae', () => {
    // 1. Arrange 📐
    const markup =
      '<div class="pd-licitacion-block" data-expediente="X"><p>a</p></div>';

    // 2. Act ⚙️ + 3. Assert 🎯
    expect(wrapTenderBlock(markup, 'Y')).toBe(markup);
  });

  it('deberia envolver un fragmento de varios elementos con el expediente', () => {
    // 1. Arrange 📐: dos raices; ninguna es "el" envoltorio.
    const markup = '<h2>T</h2><p>c</p>';

    // 2. Act ⚙️
    const result = wrapTenderBlock(markup, ' S-1 ');

    // 3. Assert 🎯
    expect(result).toBe(
      '<div class="pd-licitacion-block" data-expediente="S-1"><h2>T</h2><p>c</p></div>',
    );
  });

  it('deberia ignorar un data-expediente vacio del propio marcado', () => {
    // 1. Arrange 📐: la plantilla sin rellenar deja `data-expediente=""`.
    const markup =
      '<div class="licitacion-entry" data-expediente=""><p>a</p></div>';

    // 2. Act ⚙️ + 3. Assert 🎯
    expect(wrapTenderBlock(markup, null)).toBe(markup);
  });
});

describe('escapeHtmlAttribute', () => {
  it('deberia escapar las cinco entidades basicas', () => {
    // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
    expect(escapeHtmlAttribute(`a&"'<>`)).toBe('a&amp;&quot;&#39;&lt;&gt;');
  });
});
