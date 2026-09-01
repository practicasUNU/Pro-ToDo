import { api } from '@boot/axios';

import type { AllowedIp, CreateAllowedIpPayload, UpdateAllowedIpPayload } from '@/types/allowed-ip';

// Unica capa que conoce las rutas del backend NestJS (AllowedIpsController) y el
// tipo AxiosResponse. Todas las funciones retornan la data ya desestructurada;
// las excepciones HTTP se propagan hacia el store y de ahi al componente.

export const fetchAllowedIps = async (): Promise<AllowedIp[]> => {
  const { data } = await api.get<AllowedIp[]>('/allowed-ips');
  return data;
};

export const createAllowedIp = async (payload: CreateAllowedIpPayload): Promise<AllowedIp> => {
  const { data } = await api.post<AllowedIp>('/allowed-ips', payload);
  return data;
};

export const updateAllowedIp = async (
  id: string,
  payload: UpdateAllowedIpPayload,
): Promise<AllowedIp> => {
  const { data } = await api.patch<AllowedIp>(`/allowed-ips/${id}`, payload);
  return data;
};

export const deleteAllowedIp = async (id: string): Promise<AllowedIp> => {
  const { data } = await api.delete<AllowedIp>(`/allowed-ips/${id}`);
  return data;
};
