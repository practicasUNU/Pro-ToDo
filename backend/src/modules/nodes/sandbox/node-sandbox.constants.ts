import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { UserRole } from '@modules/users/enums/user-role.enum';

/**
 * Tipos de nodo que el banco de pruebas puede EJECUTAR de forma aislada, y los
 * roles que pueden hacerlo.
 *
 * Lista CERRADA: un tipo ausente no se ejecuta, aunque tenga estrategia. Cada
 * entrada es una decision de coste y de riesgo, no un detalle tecnico:
 *
 * - `PROCESADOR_IA` y `PROCESADOR_OCR`, SOLO ADMIN: cada prueba es una
 *   inferencia facturada contra un proveedor de pago.
 * - `DESTINO_HTTP_GENERICO`, ADMIN y EDITOR: el editor configura los
 *   destinos y necesita comprobar que la API responde. Sale por la misma
 *   guarda SSRF que en produccion, asi que no abre la red interna.
 * - `DESTINO_DRUPAL`, ADMIN y EDITOR, ENCERRADO en el entorno de pruebas: el
 *   servicio fuerza `isSandbox`, deja las altas despublicadas y rechaza
 *   cualquier pagina que no este en la lista blanca de pruebas del `.env`.
 *
 * Replicado en el frontend (`types/node-sandbox.ts`) solo para ocultar el
 * boton a quien no puede usarlo; la autoridad es esta tabla.
 */
export const SANDBOX_ROLES_BY_NODE_TYPE: Readonly<
  Partial<Record<NodeType, readonly UserRole[]>>
> = {
  [NodeType.PROCESADOR_IA]: [UserRole.ADMIN],
  [NodeType.PROCESADOR_OCR]: [UserRole.ADMIN],
  [NodeType.DESTINO_HTTP_GENERICO]: [UserRole.ADMIN, UserRole.EDITOR],
  [NodeType.DESTINO_DRUPAL]: [UserRole.ADMIN, UserRole.EDITOR],
};

/** Cursor con el que se siembra el contexto del nodo aislado. */
export const SANDBOX_NODE_ID = 'nodo_banco';

/** Pruebas por minuto y usuario: cada una cuesta dinero o una peticion real. */
export const SANDBOX_THROTTLE_LIMIT = 10;
export const SANDBOX_THROTTLE_TTL_MS = 60_000;

/** Codigo de rechazo cuando el tipo no se puede probar aislado. */
export const ERR_SANDBOX_NODE_TYPE = 'ERR_SANDBOX_NODE_TYPE';

/** Codigo de rechazo cuando los params no superan el DTO del nodo. */
export const ERR_SANDBOX_PARAMS = 'ERR_SANDBOX_PARAMS';

/**
 * Codigo de rechazo cuando una prueba de Drupal pide salir del entorno de
 * pruebas: `isSandbox: false` o una pagina fuera de la lista blanca.
 */
export const ERR_SANDBOX_DRUPAL_PRODUCTION = 'ERR_SANDBOX_DRUPAL_PRODUCTION';

/** Parametros de un nodo Drupal que apuntan a una pagina existente. */
export const DRUPAL_SANDBOX_TARGET_PARAMS = [
  'targetNodeUuid',
  'destinationNodeUuid',
] as const;
