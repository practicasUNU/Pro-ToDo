import { defineStore, acceptHMRUpdate } from 'pinia';
import { ref } from 'vue';

import * as nodeCatalogService from '@services/node-catalog.service';

import type { NodeCatalogEntry } from '@/types/node-catalog';

// Estado compartido del catalogo de tipos de nodo. Esta capa no conoce Axios ni
// rutas (`frontend-architecture.md` §2.1): invoca al servicio y muta el estado
// con su resultado.

export const useNodeCatalogStore = defineStore('nodeCatalog', () => {
  const entries = ref<NodeCatalogEntry[]>([]);
  const isLoading = ref(false);

  /**
   * Si el motor sabe ejecutar un tipo de nodo, por su `code`.
   *
   * Sirve para juzgar topologias YA GUARDADAS —una plantilla creada cuando el
   * catalogo marcaba como implementados tipos que no lo estaban— sin que quien
   * pregunta tenga que recorrer `entries`.
   *
   * Devuelve `true` cuando el catalogo aun no se ha cargado, y esto es
   * deliberado: con `entries` vacio, responder `false` marcaria TODOS los tipos
   * como no ejecutables y bloquearia cada plantilla de la lista durante la
   * carga, o para siempre si la peticion falla. Ante la duda no se bloquea: el
   * asistente vuelve a explicar el motivo paso a paso, y el backend valida el
   * esquema de todos modos.
   */
  const isNodeTypeImplemented = (code: string): boolean => {
    if (entries.value.length === 0) return true;

    return findByCode(code)?.implemented ?? false;
  };

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
    isNodeTypeImplemented,
    fetchCatalog,
    findByCode,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useNodeCatalogStore, import.meta.hot));
}
