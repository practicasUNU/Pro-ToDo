import { describe, expect, it } from '@jest/globals';

import { stripCodeFence } from '@modules/nodes/utils/code-fence.util';

describe('stripCodeFence · purga de vallas de bloque', () => {
  it('1. deberia quitar la valla con etiqueta de lenguaje', () => {
    // 1. Arrange 📐: es la forma en que un modelo entrega un objeto cuando
    //    decide "ayudar" formateandolo, y la que revienta `JSON.parse`.
    const wrapped = '```json\n{"headline":"Titular"}\n```';

    // 2. Act ⚙️
    const clean = stripCodeFence(wrapped);

    // 3. Assert 🎯
    expect(clean).toBe('{"headline":"Titular"}');
  });

  it('2. deberia quitar la valla sin etiqueta', () => {
    // 1. Arrange 📐
    const wrapped = '```\nTexto transcrito\n```';

    // 2. Act ⚙️
    const clean = stripCodeFence(wrapped);

    // 3. Assert 🎯
    expect(clean).toBe('Texto transcrito');
  });

  it('3. deberia dejar intacto un texto sin vallas', () => {
    // 1. Arrange 📐: el caso corriente. Recortar de mas aqui mutilaria la
    //    transcripcion.
    const plain = '# Acta municipal\n\nPrimer parrafo.';

    // 2. Act ⚙️
    const clean = stripCodeFence(plain);

    // 3. Assert 🎯
    expect(clean).toBe(plain);
  });

  it('4. deberia respetar una valla en MITAD del texto', () => {
    // 1. Arrange 📐: un ``` interior puede ser contenido legitimo del documento
    //    transcrito —un manual con un ejemplo de codigo—, y borrarlo destruiria
    //    justo lo que el nodo viene a conservar. Solo se tocan los extremos.
    const document = 'Antes\n\n```bash\nls -la\n```\n\nDespues';

    // 2. Act ⚙️
    const clean = stripCodeFence(document);

    // 3. Assert 🎯
    expect(clean).toBe(document);
  });

  it('5. deberia ser reutilizable sin arrastrar estado', () => {
    // 1. Arrange 📐: la expresion es global, y una `RegExp` con `/g` conserva
    //    `lastIndex` entre llamadas cuando se usa con `test`. Con `replace` no,
    //    pero el contrato se fija aqui porque de ello depende que dos clientes
    //    compartan la misma instancia.
    const wrapped = '```json\n{"a":1}\n```';

    // 2. Act ⚙️
    const first = stripCodeFence(wrapped);
    const second = stripCodeFence(wrapped);

    // 3. Assert 🎯
    expect(second).toBe(first);
  });

  it('6. deberia tolerar espacios previos, CRLF y la etiqueta ```html del escudo', () => {
    // 1. Arrange 📐: el escudo post-IA recibe markup con estas variantes, y
    //    hasta ahora tenia su propia pareja de patrones para cubrirlas.
    const wrapped = '  \r\n```HTML\r\n<p>Hola</p>\r\n```  \n';

    // 2. Act ⚙️
    const clean = stripCodeFence(wrapped);

    // 3. Assert 🎯
    expect(clean).toBe('<p>Hola</p>');
  });
});
