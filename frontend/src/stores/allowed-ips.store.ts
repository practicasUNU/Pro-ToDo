import { defineStore, acceptHMRUpdate } from 'pinia';
import { ref } from 'vue';

import * as allowedIpsService from '@services/allowed-ips.service';

import type { AllowedIp, CreateAllowedIpPayload, UpdateAllowedIpPayload } from '@/types/allowed-ip';
import type { CrudAction } from '@/types/crud-events';

// Logica de negocio y estado compartido del dominio IP Whitelist. Esta capa no
// conoce Axios ni rutas del backend (ver frontend-architecture.md §2.1): solo
// invoca al servicio y muta el estado de forma inmutable con su resultado.
export const useAllowedIpsStore = defineStore('allowedIps', () => {
  const entries = ref<AllowedIp[]>([]);
  const isLoading = ref(false);

  const fetchAllowedIps = async (): Promise<void> => {
    isLoading.value = true;

    try {
      entries.value = await allowedIpsService.fetchAllowedIps();
    } finally {
      isLoading.value = false;
    }
  };

  const createAllowedIp = async (payload: CreateAllowedIpPayload): Promise<AllowedIp> => {
    isLoading.value = true;

    try {
      const created = await allowedIpsService.createAllowedIp(payload);
      entries.value = [...entries.value, created];
      return created;
    } finally {
      isLoading.value = false;
    }
  };

  const updateAllowedIp = async (
    id: string,
    payload: UpdateAllowedIpPayload,
  ): Promise<AllowedIp> => {
    isLoading.value = true;

    try {
      const updated = await allowedIpsService.updateAllowedIp(id, payload);
      entries.value = entries.value.map((entry) => (entry.id === id ? updated : entry));
      return updated;
    } finally {
      isLoading.value = false;
    }
  };

  // Borrado fisico: a diferencia de los usuarios, una IP eliminada desaparece del listado.
  const deleteAllowedIp = async (id: string): Promise<void> => {
    isLoading.value = true;

    try {
      await allowedIpsService.deleteAllowedIp(id);
      entries.value = entries.value.filter((entry) => entry.id !== id);
    } finally {
      isLoading.value = false;
    }
  };

  /**
   * Aplica una mutacion llegada por WebSocket.
   *
   * Es IDEMPOTENTE a proposito: quien origino el cambio ya actualizo esta lista
   * con la respuesta REST y recibe ademas su propio evento, de modo que un
   * `CREATED` que insertara a ciegas le duplicaria la fila en pantalla.
   *
   * `UPDATED` inserta si no encuentra el id, porque una baja logica puede
   * llegar a una lista que todavia no tenia esa fila cargada.
   */
  const applyMutation = (action: CrudAction, item: AllowedIp | undefined, id: string): void => {
    if (action === 'DELETED') {
      entries.value = entries.value.filter((entry) => entry.id !== id);

      return;
    }

    // Un evento sin fila solo puede ser una baja; cualquier otra cosa es
    // un emisor incoherente y se ignora antes que corromper la lista.
    if (item === undefined) {
      return;
    }

    const exists = entries.value.some((entry) => entry.id === item.id);

    entries.value = exists
      ? entries.value.map((entry) => (entry.id === item.id ? item : entry))
      : [item, ...entries.value];
  };

  return {
    entries,
    isLoading,
    fetchAllowedIps,
    createAllowedIp,
    updateAllowedIp,
    deleteAllowedIp,
    applyMutation,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useAllowedIpsStore, import.meta.hot));
}
