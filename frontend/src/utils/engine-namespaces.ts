import { ASSETS_FIELDS, ASSETS_NAMESPACE } from '@/types/html-template';

import type { UpstreamNamespace } from '@stores/nodes/node-store-registry';

/**
 * Origenes que NO declara ninguna estrategia y que el catalogo debe anadir.
 *
 * El catalogo de variables se construye desde `GET /api/nodos`, es decir, desde
 * lo que cada estrategia publica en `outputFields`. Lo que escribe el MOTOR por
 * su cuenta no puede aparecer por esa via, asi que se replica aqui.
 *
 * ## Por que solo queda `_assets`
 *
 * Hubo tres. `trigger` y `error_context` se RETIRARON del selector, y la
 * omision es deliberada: los dos describen la mecanica interna del motor y no
 * datos del negocio, de modo que ofrecerlos en el desplegable invitaba a
 * construir plantillas sobre detalles de implementacion. `error_context` ademas
 * solo existe en las ejecuciones que se desviaron por `onErrorStep`, asi que
 * citado desde el camino feliz interpola vacio —un marcador que unas veces trae
 * dato y otras no es justo lo que el Poka-Yoke de la regla §4 intenta evitar—.
 *
 * NO DEJAN DE FUNCIONAR: nada valida el texto de un prompt, y el motor sigue
 * resolviendo `{{trigger.flow_name}}` si alguien lo teclea. Lo que se retira es
 * la invitacion a usarlos desde la interfaz.
 *
 * `_assets` SE CONSERVA porque no es mecanica del motor sino contenido: es la
 * base de las URL con las que una plantilla enlaza los binarios subidos a
 * Drupal, y sin el no hay forma de componer esa referencia.
 */
export const ENGINE_PROVIDED_CONTEXT: readonly UpstreamNamespace[] = [
  { namespace: ASSETS_NAMESPACE, fields: ASSETS_FIELDS },
];
