import { foldDiacritics } from '@modules/nodes/utils/diacritics.util';

describe('foldDiacritics', () => {
  it('1.1 deberia retirar las tildes de las vocales castellanas', () => {
    // 1. Arrange 📐
    const acentuado = 'Verificación de Títulos';

    // 2. Act ⚙️
    const plegado = foldDiacritics(acentuado);

    // 3. Assert 🎯
    expect(plegado).toBe('Verificacion de Titulos');
  });

  it('1.2 deberia cubrir las cinco vocales con acento grave y dieresis', () => {
    // 1. Arrange 📐
    const vocales = 'àèìòù äëïöü âêîôû';

    // 2. Act ⚙️
    const plegado = foldDiacritics(vocales);

    // 3. Assert 🎯
    expect(plegado).toBe('aeiou aeiou aeiou');
  });

  it('1.3 deberia dejar intacta una cadena que ya viene sin diacriticos', () => {
    // 1. Arrange 📐
    const llano = '(?:verificacion|titulos)';

    // 2. Act ⚙️
    const plegado = foldDiacritics(llano);

    // 3. Assert 🎯
    expect(plegado).toBe(llano);
  });

  it('1.4 deberia conservar intactos los metacaracteres de una expresion regular', () => {
    // 1. Arrange 📐
    // Es la garantia que permite plegar el PATRON y no solo el asunto: si el
    // plegado tocase la sintaxis, un patron valido dejaria de compilar.
    const patron = '^S_2026_.*\\d{3}(?:a|b)[\\w-]+$';

    // 2. Act ⚙️
    const plegado = foldDiacritics(patron);

    // 3. Assert 🎯
    expect(plegado).toBe(patron);
  });

  it('1.5 deberia plegar tambien la enie, que es la perdida asumida', () => {
    // 1. Arrange 📐
    // Documentado en el TSDoc: el rango de marcas combinantes incluye la tilde
    // de la enie, de modo que "Diseño" casa con el filtro "diseno". Amplia lo
    // que casa, nunca lo reduce.
    const conEnie = 'Diseño';

    // 2. Act ⚙️
    const plegado = foldDiacritics(conEnie);

    // 3. Assert 🎯
    expect(plegado).toBe('Diseno');
  });
});
