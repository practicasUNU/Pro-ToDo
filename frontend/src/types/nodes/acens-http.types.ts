// Replica de `acens-http-config.dto.ts` del backend (nodo DESTINO_ACENS).
// La URL base y la clave NO aparecen: viven en el entorno del servidor.

import type { KeyValueRow } from '@/types/nodes/http-generic-destination.types';

/** Verbos que admite la API de Acens; replica de `AcensHttpMethod`. */
export enum AcensHttpMethod {
  GET = 'GET',
  POST = 'POST',
  PUT = 'PUT',
  DELETE = 'DELETE',
}

export const DEFAULT_ACENS_METHOD = AcensHttpMethod.POST;
export const DEFAULT_ACENS_TIMEOUT_MS = 15_000;
export const MIN_ACENS_TIMEOUT_MS = 1_000;
export const MAX_ACENS_TIMEOUT_MS = 60_000;
export const MAX_ACENS_ENDPOINT_PATH_LENGTH = 512;
export const MAX_ACENS_PAYLOAD_TEMPLATE_LENGTH = 100_000;

/**
 * Ruta RELATIVA a la raiz de Acens. Replica de `ACENS_ENDPOINT_PATH_PATTERN`:
 * empieza por `/`, sin `//`, sin `..`, sin `\` y sin espacios.
 */
export const ACENS_ENDPOINT_PATH_PATTERN = /^\/(?!\/)(?!.*\.\.)[^\s\\]*$/;

/** Verbos sin cuerpo: espejo de `IsCoherentAcensPayloadConstraint`. */
export const BODYLESS_ACENS_METHODS: ReadonlySet<AcensHttpMethod> = new Set([
  AcensHttpMethod.GET,
  AcensHttpMethod.DELETE,
]);

/** Configuracion editable del nodo. Las cabeceras van como filas. */
export interface AcensHttpNodeConfig {
  readonly method: AcensHttpMethod;
  readonly endpointPath: string | null;
  readonly headers: readonly KeyValueRow[];
  readonly payloadTemplate: string | null;
  readonly timeoutMs: number;
}
