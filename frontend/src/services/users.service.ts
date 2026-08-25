import { api } from '@boot/axios';

import type { CreateUserPayload, UpdateUserPayload, User } from '@/types/user';

// Unica capa que conoce las rutas del backend NestJS (UsersController) y el
// tipo AxiosResponse. Todas las funciones retornan la data ya desestructurada;
// las excepciones HTTP se propagan hacia el store y de ahi al componente.

export const fetchUsers = async (): Promise<User[]> => {
  const { data } = await api.get<User[]>('/users');
  return data;
};

export const createUser = async (payload: CreateUserPayload): Promise<User> => {
  const { data } = await api.post<User>('/users', payload);
  return data;
};

export const updateUser = async (id: string, payload: UpdateUserPayload): Promise<User> => {
  const { data } = await api.patch<User>(`/users/${id}`, payload);
  return data;
};

// Borrado logico: el endpoint DELETE del backend solo cambia `activo` a false
// y devuelve el registro actualizado, nunca elimina la fila.
export const deactivateUser = async (id: string): Promise<User> => {
  const { data } = await api.delete<User>(`/users/${id}`);
  return data;
};
