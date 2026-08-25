import { defineStore, acceptHMRUpdate } from 'pinia';
import { ref } from 'vue';

import * as usersService from '@services/users.service';

import type { CreateUserPayload, UpdateUserPayload, User } from '@/types/user';

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

  return { users, isLoading, fetchUsers, createUser, updateUser, deactivateUser };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useUsersStore, import.meta.hot));
}
