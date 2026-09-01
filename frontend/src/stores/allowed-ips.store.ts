import { defineStore, acceptHMRUpdate } from 'pinia';
import { ref } from 'vue';

import * as allowedIpsService from '@services/allowed-ips.service';

import type { AllowedIp, CreateAllowedIpPayload, UpdateAllowedIpPayload } from '@/types/allowed-ip';

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

  return {
    entries,
    isLoading,
    fetchAllowedIps,
    createAllowedIp,
    updateAllowedIp,
    deleteAllowedIp,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useAllowedIpsStore, import.meta.hot));
}
