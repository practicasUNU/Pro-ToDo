import {
  detectDelimiter,
  parseDelimitedDocument,
  parseDelimitedText,
  stripBom,
} from './delimited-text.util';

/** Marca de orden de bytes que Excel antepone al exportar en UTF-8. */
const BOM = String.fromCharCode(0xfeff);

describe('delimited-text.util', () => {
  describe('0. parseDelimitedText', () => {
    it('0.1 deberia respetar una coma dentro de un campo entrecomillado', () => {
      // 1. Arrange: es el caso que rompia el aplanado con separador.
      const text = 'titulo,ciudad\n"Sede, nueva",Madrid';

      // 2. Act
      const result = parseDelimitedText(text, ',');

      // 3. Assert
      expect(result).toEqual([
        ['titulo', 'ciudad'],
        ['Sede, nueva', 'Madrid'],
      ]);
    });

    it('0.2 deberia leer la comilla doble escapada como una comilla', () => {
      // 1. Arrange
      const text = 'a\n"dijo ""hola"""';

      // 2. Act
      const result = parseDelimitedText(text, ',');

      // 3. Assert
      expect(result[1]).toEqual(['dijo "hola"']);
    });

    it('0.3 deberia contar CRLF como un unico final de linea', () => {
      // 1. Arrange
      const text = 'a,b\r\nuno,dos\r\n';

      // 2. Act
      const result = parseDelimitedText(text, ',');

      // 3. Assert
      expect(result).toHaveLength(2);
    });

    it('0.4 NO deberia convertir un numero con ceros a la izquierda', () => {
      // 1. Arrange: `exceljs.csv.read` devolveria 123 y el codigo postal se
      //    perderia. Esta prueba es la que justifica el analizador propio.
      const text = 'cp\n00123';

      // 2. Act
      const result = parseDelimitedText(text, ',');

      // 3. Assert
      expect(result[1][0]).toBe('00123');
    });

    it('0.5 deberia descartar las lineas totalmente vacias', () => {
      // 1. Arrange
      const text = 'a,b\n\n,\nuno,dos';

      // 2. Act
      const result = parseDelimitedText(text, ',');

      // 3. Assert
      expect(result).toEqual([
        ['a', 'b'],
        ['uno', 'dos'],
      ]);
    });
  });

  describe('1. detectDelimiter', () => {
    it('1.1 deberia elegir el punto y coma de un CSV de Excel espanol', () => {
      // 1. Arrange
      const text = 'titulo;ciudad;empleos\nNueva sede;Madrid;200';

      // 2. Act / 3. Assert
      expect(detectDelimiter(text)).toBe(';');
    });

    it('1.2 NO deberia dejarse enganar por comas dentro de comillas', () => {
      // 1. Arrange: contar apariciones sueltas elegiria la coma.
      const text = 'titulo;ciudad\n"Sede, nueva, grande";Madrid';

      // 2. Act / 3. Assert
      expect(detectDelimiter(text)).toBe(';');
    });

    it('1.3 deberia caer a la coma cuando no hay ninguna senal', () => {
      // 1. Arrange
      const text = 'unicolumna\nunvalor';

      // 2. Act / 3. Assert
      expect(detectDelimiter(text)).toBe(',');
    });
  });

  describe('2. stripBom y parseDelimitedDocument', () => {
    it('2.1 deberia retirar el BOM del primer encabezado', () => {
      // 1. Arrange
      const text = `${BOM}titulo,ciudad\nNueva sede,Madrid`;

      // 2. Act
      const result = parseDelimitedDocument(text);

      // 3. Assert
      expect(result[0][0]).toBe('titulo');
    });

    it('2.2 deberia dejar intacto un texto sin BOM', () => {
      // 1. Arrange / 2. Act / 3. Assert
      expect(stripBom('titulo')).toBe('titulo');
    });
  });
});
