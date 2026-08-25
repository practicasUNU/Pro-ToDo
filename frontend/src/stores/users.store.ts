import { defineStore, acceptHMRUpdate } from 'pinia';
import { ref } from 'vue';

import { api } from '@boot/axios';

import type { CreateUserPayload, UpdateUserPayload, User } from '@/types/user';

export const useUsersStore = defineStore('users', () => {
  const users = ref<User[]>([]);
  const isLoading = ref(false);

  const fetchUsers = async (): Promise<void> => {
    isLoading.value = true;

    try {
      const { data } = await api.get<User[]>('/users');
      users.value = data;
    } finally {
      isLoading.value = false;
    }
  };

  const createUser = async (payload: CreateUserPayload): Promise<User> => {
    isLoading.value = true;

    try {
      const { data } = await api.post<User>('/users', payload);
      users.value = [...users.value, data];
      return data;
    } finally {
      isLoading.value = false;
    }
  };

  const updateUser = async (id: string, payload: UpdateUserPayload): Promise<User> => {
    isLoading.value = true;

    try {
      const { data } = await api.patch<User>(`/users/${id}`, payload);
      users.value = users.value.map((user) => (user.id === id ? data : user));
      return data;
    } finally {
      isLoading.value = false;
    }
  };

  // Borrado logico: el backend solo desactiva isActive, nunca elimina el registro
  const deactivateUser = async (id: string): Promise<User> => {
    isLoading.value = true;

    try {
      const { data } = await api.delete<User>(`/users/${id}`);
      users.value = users.value.map((user) => (user.id === id ? data : user));
      return data;
    } finally {
      isLoading.value = false;
    }
  };

  return { users, isLoading, fetchUsers, createUser, updateUser, deactivateUser };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useUsersStore, import.meta.hot));
}
