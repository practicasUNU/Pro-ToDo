import { computed, ref, watch } from 'vue';

import { filterOptions } from '@/utils/option-filter';

import type { Ref } from 'vue';

/**
 * Filtrado predictivo para un `<q-select>`.
 *
 * ## Que resuelve
 *
 * Los desplegables del proyecto son CERRADOS por Poka-Yoke (§4), y algunos
 * listan decenas de entradas: plantillas HTML, plantillas de prompt, modelos de
 * un proveedor, namespaces del contexto. Sin poder teclear, elegir es
 * desplazarse hasta encontrarlo a ojo.
 *
 * ## Por que NO rompe el Poka-Yoke
 *
 * `use-input` habilita teclear para FILTRAR, no para inventar. Lo que permite
 * dar de alta un valor libre es `new-value-mode`, y este composable no lo
 * declara en ninguna parte: la seleccion sigue acotada a la lista.
 *
 * ## Uso
 *
 * ```vue
 * const { filteredOptions, filterFn } = useSelectFilter(options);
 *
 * <q-select :options="filteredOptions" use-input input-debounce="0" @filter="filterFn" />
 * ```
 *
 * Para un selector SIMPLE se anaden ademas `fill-input` y `hide-selected`, que
 * dejan el texto elegido dentro del campo. Para uno MULTIPLE no se ponen: con
 * `hide-selected` los chips dejan de pintarse.
 *
 * @param source Opciones completas. Puede ser un `ref` o un `computed`, y se
 *        reobserva: una lista que llega por HTTP cambia despues del montaje, y
 *        una copia tomada una sola vez se quedaria vacia para siempre.
 */
export const useSelectFilter = <T>(
  source: Ref<readonly T[]> | (() => readonly T[]),
): {
  filteredOptions: Ref<readonly T[]>;
  filterFn: (needle: string, update: (callback: () => void) => void) => void;
} => {
  const allOptions = computed<readonly T[]>(() =>
    typeof source === 'function' ? source() : source.value,
  );

  const filteredOptions = ref<readonly T[]>([...allOptions.value]) as Ref<readonly T[]>;

  // Sin esto, un catalogo que llega por HTTP despues del montaje nunca se
  // veria: el desplegable seguiria pintando la copia vacia del primer render
  // hasta que alguien teclease algo.
  watch(allOptions, (options) => {
    filteredOptions.value = [...options];
  });

  const filterFn = (needle: string, update: (callback: () => void) => void): void => {
    update(() => {
      filteredOptions.value = filterOptions(allOptions.value, needle);
    });
  };

  return { filteredOptions, filterFn };
};
