import { defineStore, acceptHMRUpdate } from 'pinia';
import { ref } from 'vue';

import * as usersService from '@services/users.service';

import type { CreateUserPayload, UpdateUserPayload, User } from '@/types/user';
import type { CrudAction } from '@/types/crud-events';

// Logica de negocio y estado compartido del dominio Usuarios. Esta capa no
// conoce Axios ni rutas del backend (ver frontend-architecture.md §2.1): solo
// invoca al servicio y muta el estado de forma inmutable con su resultado.
export const useUsersStore = defineStore('users', () => {
  const users = ref<User[]>([]);
  const isLoading = ref(false);

  const fetchUsers = async (): Promise<void> => {
    isLoading.value = true;

    try {
      users.value = await usersService.fetchUsers();
    } finally {
      isLoading.value = false;
    }
  };

  const createUser = async (payload: CreateUserPayload): Promise<User> => {
    isLoading.value = true;

    try {
      const created = await usersService.createUser(payload);
      users.value = [...users.value, created];
      return created;
    } finally {
      isLoading.value = false;
    }
  };

  const updateUser = async (id: string, payload: UpdateUserPayload): Promise<User> => {
    isLoading.value = true;

    try {
      const updated = await usersService.updateUser(id, payload);
      users.value = users.value.map((user) => (user.id === id ? updated : user));
      return updated;
    } finally {
      isLoading.value = false;
    }
  };

  // Borrado logico: el backend solo desactiva isActive, nunca elimina el registro
  const deactivateUser = async (id: string): Promise<User> => {
    isLoading.value = true;

    try {
      const deactivated = await usersService.deactivateUser(id);
      users.value = users.value.map((user) => (user.id === id ? deactivated : user));
      return deactivated;
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
  const applyMutation = (action: CrudAction, item: User | undefined, id: string): void => {
    if (action === 'DELETED') {
      users.value = users.value.filter((user) => user.id !== id);

      return;
    }

    // Un evento sin fila solo puede ser una baja; cualquier otra cosa es
    // un emisor incoherente y se ignora antes que corromper la lista.
    if (item === undefined) {
      return;
    }

    const exists = users.value.some((user) => user.id === item.id);

    users.value = exists
      ? users.value.map((user) => (user.id === item.id ? item : user))
      : [item, ...users.value];
  };

  return {
    users,
    isLoading,
    fetchUsers,
    createUser,
    updateUser,
    deactivateUser,
    applyMutation,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useUsersStore, import.meta.hot));
}
