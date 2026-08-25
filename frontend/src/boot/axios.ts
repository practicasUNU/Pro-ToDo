import { defineBoot } from '#q-app';
import axios, { type AxiosInstance } from 'axios';

declare module 'vue' {
  interface ComponentCustomProperties {
    $axios: AxiosInstance;
    $api: AxiosInstance;
  }
}

// Instancia unica de Axios apuntando al backend NestJS
const api = axios.create({ baseURL: import.meta.env.VITE_API_BASE_URL });

export default defineBoot(({ app }) => {
  app.config.globalProperties.$axios = axios;
  app.config.globalProperties.$api = api;
});

export { api };
