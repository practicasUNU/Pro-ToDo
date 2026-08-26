import { defineStore, acceptHMRUpdate } from 'pinia';
import { computed, ref } from 'vue';

import * as authService from '@services/auth.service';

import { getMillisecondsUntilExpiry } from '@/utils/jwt';
import { clearSession, readSession, writeSession } from '@/utils/session-storage';

import type { AuthTokenResponse, SessionUser } from '@/types/auth';

// Estado compartido de la sesion y logica de negocio asociada. No conoce Axios
// ni rutas del backend (frontend-architecture.md §2.1): delega en auth.service y
// muta el estado con el resultado ya parseado.
export const useSessionStore = defineStore('session', () => {
  // Rehidratacion sincrona en la creacion del store: una recarga de pagina no
  // debe expulsar al usuario mientras sus credenciales sigan siendo validas.
  const persisted = readSession();

  const accessToken = ref<string | null>(persisted.accessToken);
  const refreshToken = ref<string | null>(persisted.refreshToken);
  const user = ref<SessionUser | null>(persisted.user);

  /** Cierto solo tras validar el OTP; distingue "tengo token" de "acabo de autenticarme". */
  const otpVerified = ref<boolean>(Boolean(persisted.accessToken));
  const isLoading = ref(false);

  const isAuthenticated = computed<boolean>(
    () => Boolean(accessToken.value) && Boolean(user.value),
  );

  /** Milisegundos hasta la caducidad del access token; `null` si no hay token legible. */
  const millisecondsUntilExpiry = computed<number | null>(() =>
    getMillisecondsUntilExpiry(accessToken.value),
  );

  /** Aplica el par de tokens recibido y lo persiste. Punto unico de escritura. */
  const applyTokens = (response: AuthTokenResponse): void => {
    accessToken.value = response.accessToken;
    refreshToken.value = response.refreshToken;
    user.value = response.user;
    otpVerified.value = true;

    writeSession(response);
  };

  /** Borra el estado en memoria y en disco. No hace red. */
  const clear = (): void => {
    accessToken.value = null;
    refreshToken.value = null;
    user.value = null;
    otpVerified.value = false;

    clearSession();
  };

  /**
   * Solicita el envio del codigo.
   * @returns Vigencia del codigo en segundos, para la cuenta regresiva de la vista.
   */
  const requestOtp = async (email: string): Promise<number> => {
    isLoading.value = true;

    try {
      const { expiresInSeconds } = await authService.requestOtp(email);
      return expiresInSeconds;
    } finally {
      isLoading.value = false;
    }
  };

  /** Valida el codigo y abre la sesion. */
  const verifyOtp = async (email: string, code: string): Promise<void> => {
    isLoading.value = true;

    try {
      applyTokens(await authService.verifyOtp(email, code));
    } finally {
      isLoading.value = false;
    }
  };

  /**
   * Renueva el par de tokens. Si el backend rechaza la renovacion, la sesion se
   * purga aqui mismo: un refresh invalido no admite reintento, y dejar el estado
   * a medias haria que el monitor reprogramara sobre un token muerto.
   */
  const refreshTokens = async (): Promise<void> => {
    if (!refreshToken.value) {
      clear();
      throw new Error('No hay token de renovacion disponible.');
    }

    isLoading.value = true;

    try {
      applyTokens(await authService.refreshSession(refreshToken.value));
    } catch (error) {
      clear();
      throw error;
    } finally {
      isLoading.value = false;
    }
  };

  /**
   * Cierra la sesion. La revocacion en servidor es best-effort: si la red falla,
   * el estado local se limpia igualmente — lo contrario dejaria al usuario
   * atrapado dentro de una sesion que pidio cerrar.
   */
  const logout = async (): Promise<void> => {
    const tokenToRevoke = refreshToken.value;

    clear();

    if (!tokenToRevoke) return;

    try {
      await authService.logout(tokenToRevoke);
    } catch {
      // El token caducara solo; el usuario ya esta fuera en este dispositivo.
    }
  };

  return {
    accessToken,
    refreshToken,
    user,
    otpVerified,
    isLoading,
    isAuthenticated,
    millisecondsUntilExpiry,
    requestOtp,
    verifyOtp,
    refreshTokens,
    logout,
    clear,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useSessionStore, import.meta.hot));
}
