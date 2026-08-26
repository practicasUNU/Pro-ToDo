import { defineBoot } from '#q-app';
import axios, { type AxiosInstance } from 'axios';

import { clearSession, readAccessToken } from '@/utils/session-storage';

declare module 'vue' {
  interface ComponentCustomProperties {
    $axios: AxiosInstance;
    $api: AxiosInstance;
  }
}

/** Ruta del login: destino del rechazo por sesion invalida. */
const LOGIN_ROUTE = '/login';

// Instancia unica de Axios apuntando al backend NestJS. Lleva los interceptores
// de sesion: es la que usan todos los servicios de dominio.
const api = axios.create({ baseURL: import.meta.env.VITE_API_BASE_URL });

// Instancia HERMANA para las rutas de autenticacion, deliberadamente SIN
// interceptores. Sin ella, un 401 de `POST /auth/refresh` dispararia el manejador
// de abajo, que a su vez limpia la sesion y redirige: el propio intento de
// renovar la sesion la cerraria, y un 401 del login se comeria el mensaje de
// error antes de que LoginPage.vue pudiera mostrarlo.
const authApi = axios.create({ baseURL: import.meta.env.VITE_API_BASE_URL });

export default defineBoot(({ app, router }) => {
  // Peticion: adjunta el token en cada llamada. Se lee del almacenamiento y no
  // del store de Pinia para evitar el ciclo de imports (ver session-storage.ts).
  api.interceptors.request.use((config) => {
    const accessToken = readAccessToken();

    if (accessToken) {
      config.headers.Authorization = `Bearer ${accessToken}`;
    }

    return config;
  });

  // Respuesta: un 401 significa que el backend ya no reconoce este token
  // (caducado, revocado o firmado con otro secreto). No se reintenta ni se
  // renueva en silencio: la renovacion es tarea del monitor proactivo, que
  // avisa al usuario. Aqui solo se purga y se sale.
  api.interceptors.response.use(
    (response) => response,
    async (error: unknown) => {
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        clearSession();

        if (router.currentRoute.value.path !== LOGIN_ROUTE) {
          await router.replace(LOGIN_ROUTE);
        }
      }

      // La excepcion se propaga igualmente: el componente decide que mostrar.
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    },
  );

  app.config.globalProperties.$axios = axios;
  app.config.globalProperties.$api = api;
});

export { api, authApi };
