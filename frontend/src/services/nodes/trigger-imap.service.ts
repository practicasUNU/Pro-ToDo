import { api } from '@boot/axios';

import type { CheckImapPayload, CheckImapResult } from '@/types/pipeline';

// Frontera HTTP del nodo TRIGGER_IMAP (regla frontend-quasar.md §3.1).
//
// A diferencia del servicio del mapeador, que delega en `templates.service.ts`
// porque comparte recurso con el gestor, esta ruta es exclusiva del asistente y
// se declara aqui. Cero logica de negocio: la decision de que hacer con el
// resultado vive en el store, y el mensaje al usuario en el componente.

/**
 * Comprueba las credenciales IMAP contra el servidor de correo.
 *
 * El backend resuelve la contrasena desde su propio entorno a partir de
 * `passwordEnvKey`, asi que el secreto NUNCA viaja en este payload: el navegador
 * manda el NOMBRE de la variable, no su valor (`security-and-scope.md` §0.1).
 *
 * Un fallo de conexion NO es un error HTTP: llega como 200 con
 * `success: false`, porque el diagnostico del servidor de correo es parte de la
 * respuesta que el asistente tiene que mostrar. Solo un cuerpo mal formado
 * produce un 4xx, y ese si se propaga como excepcion.
 */
export const checkImapConnection = async (payload: CheckImapPayload): Promise<CheckImapResult> => {
  const { data } = await api.post<CheckImapResult>('/wizard/check-imap', payload);
  return data;
};
