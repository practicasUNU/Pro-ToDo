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
