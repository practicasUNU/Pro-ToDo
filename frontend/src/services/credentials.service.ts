import { api } from '@boot/axios';

import type {
  CreateCredentialPayload,
  Credential,
  CredentialAuthType,
  CredentialOption,
  UpdateCredentialPayload,
} from '@/types/credential';

// Unica capa que conoce las rutas de `CredentialsController`. El CRUD es de
// ADMIN; `/credentials/options` lo puede leer tambien un EDITOR y solo trae
// id, nombre y tipo. Ninguna respuesta incluye secretos.

export const fetchCredentials = async (): Promise<Credential[]> => {
  const { data } = await api.get<Credential[]>('/credentials');
  return data;
};

export const fetchCredentialOptions = async (
  authType?: CredentialAuthType,
): Promise<CredentialOption[]> => {
  const { data } = await api.get<CredentialOption[]>('/credentials/options', {
    params: authType === undefined ? {} : { authType },
  });
  return data;
};

export const createCredential = async (payload: CreateCredentialPayload): Promise<Credential> => {
  const { data } = await api.post<Credential>('/credentials', payload);
  return data;
};

export const updateCredential = async (
  id: string,
  payload: UpdateCredentialPayload,
): Promise<Credential> => {
  const { data } = await api.patch<Credential>(`/credentials/${id}`, payload);
  return data;
};

// Borrado FISICO: el backend responde 409 si algun flujo la cita.
export const deleteCredential = async (id: string): Promise<Credential> => {
  const { data } = await api.delete<Credential>(`/credentials/${id}`);
  return data;
};
