import { defineStore, acceptHMRUpdate } from 'pinia';
import { ref } from 'vue';

import * as credentialsService from '@services/credentials.service';

import type {
  CreateCredentialPayload,
  Credential,
  CredentialOption,
  UpdateCredentialPayload,
} from '@/types/credential';
import type { CrudAction } from '@/types/crud-events';

// Estado de la boveda de credenciales. Dos colecciones y no una, porque las
// leen roles distintos: `credentials` (metadatos completos) la carga el panel
// de ADMIN; `options` (id, nombre, tipo) la carga el nodo DESTINO_HTTP_GENERICO
// para su selector cerrado, y es la unica a la que llega un EDITOR.
export const useCredentialsStore = defineStore('credentials', () => {
  const credentials = ref<Credential[]>([]);
  const options = ref<CredentialOption[]>([]);
  const isLoading = ref(false);
  const isLoadingOptions = ref(false);

  /** Las opciones ya se pidieron alguna vez: evita repetir la carga en cada paso. */
  const optionsLoaded = ref(false);

  const fetchCredentials = async (): Promise<void> => {
    isLoading.value = true;

    try {
      credentials.value = await credentialsService.fetchCredentials();
    } finally {
      isLoading.value = false;
    }
  };

  /**
   * Carga TODAS las opciones; el filtrado por tipo lo hace cada nodo en
   * memoria, para que cambiar el `authType` no vuelva a la red.
   */
  const fetchOptions = async (): Promise<void> => {
    isLoadingOptions.value = true;

    try {
      options.value = await credentialsService.fetchCredentialOptions();
      optionsLoaded.value = true;
    } finally {
      isLoadingOptions.value = false;
    }
  };

  /** Igual que `fetchOptions`, pero solo la primera vez. */
  const ensureOptions = async (): Promise<void> => {
    if (optionsLoaded.value || isLoadingOptions.value) return;

    await fetchOptions();
  };

  const toOption = ({ id, name, authType }: Credential): CredentialOption => ({
    id,
    name,
    authType,
  });

  const createCredential = async (payload: CreateCredentialPayload): Promise<Credential> => {
    isLoading.value = true;

    try {
      const created = await credentialsService.createCredential(payload);
      applyMutation('CREATED', created, created.id);
      return created;
    } finally {
      isLoading.value = false;
    }
  };

  const updateCredential = async (
    id: string,
    payload: UpdateCredentialPayload,
  ): Promise<Credential> => {
    isLoading.value = true;

    try {
      const updated = await credentialsService.updateCredential(id, payload);
      applyMutation('UPDATED', updated, id);
      return updated;
    } finally {
      isLoading.value = false;
    }
  };

  const deleteCredential = async (id: string): Promise<void> => {
    isLoading.value = true;

    try {
      await credentialsService.deleteCredential(id);
      applyMutation('DELETED', undefined, id);
    } finally {
      isLoading.value = false;
    }
  };

  /**
   * Aplica una mutacion (respuesta REST o evento del socket) a las DOS listas.
   *
   * Idempotente, como en `users.store.ts`: quien origino el cambio lo aplica
   * con la respuesta y recibe ademas su propio evento.
   */
  const applyMutation = (action: CrudAction, item: Credential | undefined, id: string): void => {
    if (action === 'DELETED') {
      credentials.value = credentials.value.filter((credential) => credential.id !== id);
      options.value = options.value.filter((option) => option.id !== id);
      return;
    }

    if (item === undefined) return;

    const upsert = <T extends { id: string }>(list: T[], next: T): T[] =>
      list.some((entry) => entry.id === next.id)
        ? list.map((entry) => (entry.id === next.id ? next : entry))
        : [...list, next];

    credentials.value = upsert(credentials.value, item);
    options.value = upsert(options.value, toOption(item));
  };

  return {
    credentials,
    options,
    isLoading,
    isLoadingOptions,
    fetchCredentials,
    fetchOptions,
    ensureOptions,
    createCredential,
    updateCredential,
    deleteCredential,
    applyMutation,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useCredentialsStore, import.meta.hot));
}
