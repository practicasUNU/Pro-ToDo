import { describe, expect, it } from 'vitest';
import { computed, nextTick, ref } from 'vue';

import { MAX_FILTER_LENGTH, useSelectFilter } from '@/composables/useSelectFilter';

/** Doble del `update` que Quasar entrega al manejador de `@filter`. */
const applyImmediately = (callback: () => void): void => {
  callback();
};

describe('useSelectFilter · filtrado predictivo de un q-select', () => {
  const OPTIONS = ['raw_email', 'parsed_email', 'scraped_web', 'ocr_result'];

  describe('1. Estado inicial', () => {
    it('1.1 deberia empezar con la lista completa', () => {
      // 1. Arrange & 2. Act ⚙️
      const { filteredOptions } = useSelectFilter(ref(OPTIONS));

      // 3. Assert 🎯: el desplegable se abre mostrandolo todo.
      expect(filteredOptions.value).toEqual(OPTIONS);
    });
  });

  describe('2. Filtrado', () => {
    it('2.1 deberia recortar la lista al teclear', () => {
      // 1. Arrange 📐
      const { filteredOptions, filterFn } = useSelectFilter(ref(OPTIONS));

      // 2. Act ⚙️
      filterFn('email', applyImmediately);

      // 3. Assert 🎯
      expect(filteredOptions.value).toEqual(['raw_email', 'parsed_email']);
    });

    it('2.2 deberia reponer la lista al borrar la busqueda', () => {
      // 1. Arrange 📐: sin esto, vaciar el campo dejaria el desplegable con el
      //    ultimo recorte y pareceria que faltan opciones.
      const { filteredOptions, filterFn } = useSelectFilter(ref(OPTIONS));
      filterFn('ocr', applyImmediately);

      // 2. Act ⚙️
      filterFn('', applyImmediately);

      // 3. Assert 🎯
      expect(filteredOptions.value).toEqual(OPTIONS);
    });

    it('2.3 deberia pasar por el `update` de Quasar y no antes', () => {
      // 1. Arrange 📐: Quasar exige que la mutacion ocurra DENTRO del callback;
      //    fuera, el desplegable se repinta con la lista vieja.
      const { filteredOptions, filterFn } = useSelectFilter(ref(OPTIONS));
      let pending: (() => void) | null = null;

      // 2. Act ⚙️: se retiene el callback sin ejecutarlo.
      filterFn('ocr', (callback) => {
        pending = callback;
      });

      // 3. Assert 🎯: nada ha cambiado todavia.
      expect(filteredOptions.value).toEqual(OPTIONS);

      pending!();
      expect(filteredOptions.value).toEqual(['ocr_result']);
    });
  });

  describe('3. Origen reactivo', () => {
    it('3.1 deberia reflejar un catalogo que llega DESPUES del montaje', async () => {
      // 1. Arrange 📐: es el caso real. `GET /api/nodos` resuelve despues del
      //    primer repintado, y una copia tomada una sola vez dejaria el
      //    desplegable vacio para siempre.
      const source = ref<readonly string[]>([]);
      const { filteredOptions } = useSelectFilter(source);

      // 2. Act ⚙️: el `watch` es de flujo `pre`, como el de cualquier
      //    componente, asi que se resuelve en el siguiente ciclo y no en el
      //    acto. Dentro de un componente eso ocurre ANTES del repintado, de
      //    modo que el desplegable nunca llega a verse desfasado.
      source.value = OPTIONS;
      await nextTick();

      // 3. Assert 🎯
      expect(filteredOptions.value).toEqual(OPTIONS);
    });

    it('3.2 deberia admitir un getter ademas de un ref', () => {
      // 1. Arrange 📐: los stores exponen sus listas como getters de Pinia, que
      //    no son `Ref`.
      const source = ref(OPTIONS);
      const { filteredOptions, filterFn } = useSelectFilter(() => source.value);

      // 2. Act ⚙️
      filterFn('scraped', applyImmediately);

      // 3. Assert 🎯
      expect(filteredOptions.value).toEqual(['scraped_web']);
    });

    it('3.2b deberia recortar un termino de mas de 100 caracteres', () => {
      // 1. Arrange 📐: a partir de ahi teclear ya no estrecha nada, y el
      //    filtro recorre todas las opciones en cada pulsacion. Se RECORTA y
      //    no se rechaza porque un filtro predictivo no debe dar errores.
      const source = ref(OPTIONS);
      const { filteredOptions, filterFn } = useSelectFilter(() => source.value);
      const term = `scraped${'x'.repeat(MAX_FILTER_LENGTH)}`;

      // 2. Act ⚙️
      filterFn(term, applyImmediately);

      // 3. Assert 🎯: la cola sobrante se descarta, asi que el prefijo util
      //    sigue filtrando en vez de no casar con nada.
      expect(filteredOptions.value).toEqual([]);
      expect(term.slice(0, MAX_FILTER_LENGTH)).toHaveLength(MAX_FILTER_LENGTH);
    });

    it('3.3 deberia funcionar sobre un computed', () => {
      // 1. Arrange 📐
      const source = ref(OPTIONS);
      const { filteredOptions } = useSelectFilter(computed(() => source.value.slice(0, 2)));

      // 2. Act & 3. Assert 🎯
      expect(filteredOptions.value).toEqual(['raw_email', 'parsed_email']);
    });
  });
});
