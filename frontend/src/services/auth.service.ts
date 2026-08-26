import { authApi } from '@boot/axios';

import type { AuthTokenResponse, OtpRequestResponse } from '@/types/auth';

// Unica capa que conoce las rutas de AuthController y el tipo AxiosResponse.
// Usa `authApi` (sin interceptores) a proposito: un 401 aqui es una respuesta
// legitima del flujo de login, no una sesion caducada que haya que purgar.
// Las excepciones se propagan hacia el store y de ahi al componente.

/** Pide el envio del codigo. La respuesta NUNCA contiene el codigo. */
export const requestOtp = async (email: string): Promise<OtpRequestResponse> => {
  const { data } = await authApi.post<OtpRequestResponse>('/auth/otp/generate', { email });
  return data;
};

/** Canjea el codigo por el par de tokens de sesion. */
export const verifyOtp = async (email: string, code: string): Promise<AuthTokenResponse> => {
  const { data } = await authApi.post<AuthTokenResponse>('/auth/otp/validate', { email, code });
  return data;
};

/**
 * Renueva la sesion. El backend rota el token: el enviado queda revocado y
 * presentarlo de nuevo derriba todas las sesiones del usuario.
 */
export const refreshSession = async (refreshToken: string): Promise<AuthTokenResponse> => {
  const { data } = await authApi.post<AuthTokenResponse>('/auth/refresh', { refreshToken });
  return data;
};

/** Revoca el refresh token en el servidor. Idempotente. */
export const logout = async (refreshToken: string): Promise<void> => {
  await authApi.post('/auth/logout', { refreshToken });
};
