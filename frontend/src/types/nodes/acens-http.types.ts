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

/**
 * Que hace el nodo con Acens; replica de `AcensOperation`.
 *
 * `RAW_REQUEST`: peticion libre (la de siempre). `CREATE_CAMPAIGN`: crea la
 * campana del boletin en `/api/1/createCampaign/` con el marcado ya validado.
 */
export type AcensOperation = 'RAW_REQUEST' | 'CREATE_CAMPAIGN';

export const DEFAULT_ACENS_OPERATION: AcensOperation = 'RAW_REQUEST';

/** Opciones cerradas del selector de operacion (Poka-Yoke). */
export const ACENS_OPERATION_OPTIONS: ReadonlyArray<{
  readonly value: AcensOperation;
  readonly label: string;
  readonly description: string;
}> = [
  {
    value: 'CREATE_CAMPAIGN',
    label: 'Crear campana del boletin',
    description: 'Crea la campana en Acens con las noticias ya validadas por el escudo.',
  },
  {
    value: 'RAW_REQUEST',
    label: 'Peticion libre',
    description: 'Verbo, ruta, cabeceras y cuerpo a mano.',
  },
];

/** Replicas de los defectos y limites de `acens-http-config.dto.ts`. */
export const DEFAULT_ACENS_CAMPAIGN_FROM_NAME = 'Notiweb';
export const DEFAULT_ACENS_CAMPAIGN_FROM_EMAIL = 'notiweb@madrimasd.org';
export const DEFAULT_ACENS_CAMPAIGN_NAME_PREFIX = 'Notiweb';
export const DEFAULT_ACENS_CAMPAIGN_SUBJECT_PREFIX = 'Servicio NotiWEB de madri+d';
export const DEFAULT_ACENS_CONTENT_NAMESPACE = 'validated_drupal_json';
export const MAX_ACENS_CAMPAIGN_TEXT_LENGTH = 200;
export const MAX_ACENS_LIST_ID_LENGTH = 64;
export const ACENS_LIST_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
export const ACENS_NAMESPACE_PATTERN = /^[a-z][a-z0-9_]*$/;

/** Formato de correo suficiente para el Poka-Yoke; el DTO hace la validacion final. */
export const ACENS_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Configuracion editable del nodo. Las cabeceras van como filas. */
export interface AcensHttpNodeConfig {
  readonly operation: AcensOperation;
  readonly method: AcensHttpMethod;
  readonly endpointPath: string | null;
  readonly headers: readonly KeyValueRow[];
  readonly payloadTemplate: string | null;
  readonly timeoutMs: number;
  readonly listId: string;
  readonly fromName: string;
  readonly fromEmail: string;
  readonly campaignNamePrefix: string;
  readonly subjectPrefix: string;
  readonly contentNamespace: string;
}
