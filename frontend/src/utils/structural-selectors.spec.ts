// @vitest-environment happy-dom
//
// Directiva POR ARCHIVO: este helper usa `DOMParser`, que no existe en el
// entorno `node` con el que corre la mayoria de los specs.
import { describe, expect, it } from 'vitest';

import { extractStructuralSelectors } from './structural-selectors';

describe('extractStructuralSelectors · ranuras candidatas de una plantilla', () => {
  describe('1. Etiquetas estructurales', () => {
    it('1.1 deberia detectar solo las etiquetas presentes en el documento', () => {
      // 1. Arrange 📐
      const html = '<h1></h1><p>texto</p><table><tr><td></td></tr></table>';

      // 2. Act ⚙️
      const selectors = extractStructuralSelectors(html);

      // 3. Assert 🎯: `p` no se ofrece a proposito; una plantilla tiene decenas
      //    y sugerirlos ahogaria las ranuras que de verdad importan.
      expect(selectors).toContain('h1');
      expect(selectors).toContain('table');
      expect(selectors).not.toContain('p');
      expect(selectors).not.toContain('h2');
    });

    it('1.2 deberia poner las etiquetas antes que las clases', () => {
      // 1. Arrange 📐: el autocompletado corta por la cabeza, asi que el orden
      //    decide que se rellena primero.
      const html = '<div class="resumen"></div><h1></h1>';

      // 2. Act ⚙️
      const [first] = extractStructuralSelectors(html);

      // 3. Assert 🎯
      expect(first).toBe('h1');
    });
  });

  describe('2. Clases con semantica de contenido', () => {
    it('2.1 deberia prefijar con punto las clases reconocidas', () => {
      // 1. Arrange 📐
      const html = '<div class="titular"></div><div class="resumen"></div>';

      // 2. Act ⚙️
      const selectors = extractStructuralSelectors(html);

      // 3. Assert 🎯
      expect(selectors).toContain('.titular');
      expect(selectors).toContain('.resumen');
    });

    it('2.2 deberia reconocer la clase por SUBCADENA y no por igualdad', () => {
      // 1. Arrange 📐: las plantillas reales nombran sus ranuras con sufijos, y
      //    exigir el nombre exacto no encontraria ninguna.
      const html = '<h2 class="titular-noticia"></h2><div class="resumen_corto"></div>';

      // 2. Act ⚙️
      const selectors = extractStructuralSelectors(html);

      // 3. Assert 🎯
      expect(selectors).toContain('.titular-noticia');
      expect(selectors).toContain('.resumen_corto');
    });

    it('2.3 deberia ignorar las clases sin semantica de contenido', () => {
      // 1. Arrange 📐
      const html = '<div class="row q-pa-md flex"></div>';

      // 2. Act ⚙️
      const selectors = extractStructuralSelectors(html);

      // 3. Assert 🎯: una clase de maquetacion no es una ranura que rellenar.
      expect(selectors).toEqual([]);
    });

    it('2.4 deberia conservar las mayusculas originales de la clase', () => {
      // 1. Arrange 📐: el reconocimiento no distingue mayusculas, pero el
      //    selector resultante tiene que casar con el documento real, y en CSS
      //    el nombre de clase SI las distingue.
      const html = '<div class="Titular"></div>';

      // 2. Act ⚙️
      const selectors = extractStructuralSelectors(html);

      // 3. Assert 🎯
      expect(selectors).toContain('.Titular');
    });

    it('2.5 deberia recorrer las clases en orden de aparicion', () => {
      // 1. Arrange 📐
      const html = '<div class="cuerpo"></div><div class="titular"></div>';

      // 2. Act ⚙️
      const selectors = extractStructuralSelectors(html);

      // 3. Assert 🎯
      expect(selectors).toEqual(['.cuerpo', '.titular']);
    });
  });

  describe('3. Deduplicado y limites', () => {
    it('3.1 deberia devolver una sola vez una clase repetida', () => {
      // 1. Arrange 📐
      const html = '<div class="titular"></div><span class="titular"></span>';

      // 2. Act ⚙️
      const selectors = extractStructuralSelectors(html);

      // 3. Assert 🎯
      expect(selectors).toEqual(['.titular']);
    });

    it('3.2 deberia descartar un candidato mas largo que el tope del DTO', () => {
      // 1. Arrange 📐: se DESCARTA en vez de recortarse, porque un selector
      //    truncado no casa con nada y pareceria valido.
      const className = `titular-${'x'.repeat(130)}`;

      // 2. Act ⚙️
      const selectors = extractStructuralSelectors(`<div class="${className}"></div>`);

      // 3. Assert 🎯
      expect(selectors).toEqual([]);
    });
  });

  describe('4. Entradas degeneradas', () => {
    it('4.1 deberia devolver vacio ante un HTML en blanco', () => {
      // 1. Arrange 📐 & 2. Act ⚙️ & 3. Assert 🎯
      expect(extractStructuralSelectors('')).toEqual([]);
      expect(extractStructuralSelectors('   ')).toEqual([]);
    });

    it('4.2 NO deberia lanzar ante un HTML malformado', () => {
      // 1. Arrange 📐: el gestor sanea lo que guarda, pero el marcado puede
      //    llegar de una plantilla heredada. Vacio significa "nada que
      //    sugerir", nunca un error que rompa el formulario.
      const html = '<h1><div class="titular"</h1><table>';

      // 2. Act ⚙️ & 3. Assert 🎯
      expect(() => extractStructuralSelectors(html)).not.toThrow();
    });

    it('4.3 deberia tolerar marcadores de plantilla sin resolver', () => {
      // 1. Arrange 📐: una plantilla base puede traer `{{ns.campo}}` dentro.
      const html = '<h1 class="titular">{{llm_response.headline}}</h1>';

      // 2. Act ⚙️
      const selectors = extractStructuralSelectors(html);

      // 3. Assert 🎯
      expect(selectors).toEqual(['h1', '.titular']);
    });
  });
});
