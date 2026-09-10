import { defineStore, acceptHMRUpdate } from 'pinia';
import { computed, ref } from 'vue';

import * as nodeCatalogService from '@services/node-catalog.service';

import { isImplementedNodeType } from '@/types/node-catalog';

import type { NodeCatalogEntry } from '@/types/node-catalog';

// Estado compartido del catalogo de tipos de nodo. Esta capa no conoce Axios ni
// rutas (`frontend-architecture.md` §2.1): invoca al servicio y muta el estado
// con su resultado.

export const useNodeCatalogStore = defineStore('nodeCatalog', () => {
  const entries = ref<NodeCatalogEntry[]>([]);
  const isLoading = ref(false);

  /** Tipos que el motor sabe ejecutar; el resto se pinta deshabilitado. */
  const selectableEntries = computed<NodeCatalogEntry[]>(() =>
    entries.value.filter(isImplementedNodeType),
  );

  /**
   * Carga el catalogo una sola vez.
   *
   * Es data de INSTALACION: las filas las siembra `init.sql` y no cambian entre
   * despliegues, asi que volver a pedirlas cada vez que se abre el dialogo solo
   * gastaria una peticion. `force` existe para el caso en que una migracion las
   * amplie con el frontend ya cargado.
   */
  const fetchCatalog = async (force = false): Promise<void> => {
    if (!force && entries.value.length > 0) return;

    isLoading.value = true;

    try {
      entries.value = await nodeCatalogService.fetchNodeCatalog();
    } finally {
      isLoading.value = false;
    }
  };

  /** Entrada por su `code`, para resolver lo que el esquema ya declara. */
  const findByCode = (code: string): NodeCatalogEntry | null =>
    entries.value.find((entry) => entry.code === code) ?? null;

  return {
    entries,
    isLoading,
    selectableEntries,
    fetchCatalog,
    findByCode,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useNodeCatalogStore, import.meta.hot));
}
