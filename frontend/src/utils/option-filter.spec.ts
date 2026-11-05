import { describe, expect, it } from 'vitest';

import { filterOptions, foldText, searchableText } from '@/utils/option-filter';

describe('option-filter · busqueda insensible a acentos y mayusculas', () => {
  describe('1. Plegado del texto', () => {
    it('1.1 deberia quitar diacriticos y bajar a minusculas', () => {
      // 1. Arrange & 2. Act & 3. Assert 🎯: sin esto, buscar en un idioma con
      // tildes obliga a teclearlas igual que quien creo el registro.
      expect(foldText('  Licitación ABIERTA ')).toBe('licitacion abierta');
      expect(foldText('Verificación de Títulos')).toBe('verificacion de titulos');
    });

    it('1.2 deberia dejar intacto lo que ya esta plegado', () => {
      // 1. Arrange & 2. Act & 3. Assert 🎯
      expect(foldText('ocr_result')).toBe('ocr_result');
    });
  });

  describe('2. Texto por el que se busca', () => {
    it('2.1 deberia mirar etiqueta Y valor', () => {
      // 1. Arrange 📐: los selectores del proyecto usan las dos formas, y quien
      //    escribe marcadores recuerda la clave tecnica, no la etiqueta.
      const option = { label: 'Procesador OCR', value: 'PROCESADOR_OCR' };

      // 2. Act ⚙️
      const text = searchableText(option);

      // 3. Assert 🎯
      expect(text).toContain('procesador ocr');
      expect(text).toContain('procesador_ocr');
    });

    it('2.2 deberia admitir opciones que son cadenas sueltas', () => {
      // 1. Arrange 📐: varios selectores listan `NODE_OUTPUT_NAMESPACES` tal cual.
      // 2. Act & 3. Assert 🎯
      expect(searchableText('rendered_html')).toBe('rendered_html');
    });

    it('2.3 deberia mirar `name` en los objetos de dominio', () => {
      // 1. Arrange 📐: los campos del explorador de variables son
      //    `NodeOutputField`, que no tiene `label` sino `name`.
      // 2. Act & 3. Assert 🎯
      expect(searchableText({ name: 'clean_body', type: 'text' })).toBe('clean_body');
    });
  });

  describe('3. Filtrado', () => {
    const OPTIONS = [
      { label: 'Licitación abierta', value: 'LICITACION_ABIERTA' },
      { label: 'Notiweb', value: 'NOTIWEB' },
      { label: 'Verificación de títulos', value: 'TITULOS' },
    ];

    it('3.1 deberia encontrar por SUBCADENA, no solo por prefijo', () => {
      // 1. Arrange 📐: el operador recuerda un trozo del nombre, no como empieza.
      // 2. Act ⚙️
      const found = filterOptions(OPTIONS, 'titulos');

      // 3. Assert 🎯
      expect(found).toHaveLength(1);
      expect(found[0]?.value).toBe('TITULOS');
    });

    it('3.2 deberia ignorar acentos del lado de la BUSQUEDA', () => {
      // 1. Arrange & 2. Act ⚙️
      const sinTilde = filterOptions(OPTIONS, 'licitacion');
      const conTilde = filterOptions(OPTIONS, 'Licitación');

      // 3. Assert 🎯: los dos caminos llegan al mismo sitio.
      expect(sinTilde).toEqual(conTilde);
      expect(sinTilde).toHaveLength(1);
    });

    it('3.3 deberia devolver la lista entera con la busqueda vacia', () => {
      // 1. Arrange 📐: es lo que Quasar pide al abrir el desplegable sin teclear.
      // 2. Act & 3. Assert 🎯
      expect(filterOptions(OPTIONS, '')).toHaveLength(3);
      expect(filterOptions(OPTIONS, '   ')).toHaveLength(3);
    });

    it('3.4 deberia devolver vacio cuando no casa nada', () => {
      // 1. Arrange & 2. Act & 3. Assert 🎯: honesto, y lo que hace que Quasar
      // pinte su aviso de "sin resultados".
      expect(filterOptions(OPTIONS, 'zzz')).toEqual([]);
    });

    it('3.5 NO deberia mutar la lista de origen', () => {
      // 1. Arrange 📐: `filteredOptions` se reasigna en cada tecla; si el filtro
      //    recortara el arreglo original, la lista completa se perderia tras la
      //    primera busqueda y ya no volveria.
      const source = [...OPTIONS];

      // 2. Act ⚙️
      filterOptions(source, 'notiweb');

      // 3. Assert 🎯
      expect(source).toHaveLength(3);
    });
  });
});
