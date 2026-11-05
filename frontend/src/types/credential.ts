// Replica exacta de los DTO de `CredentialsController` (backend
// `modules/credentials`). La boveda NUNCA devuelve el secreto: estos tipos solo
// describen metadatos, y los campos secretos existen unicamente en los
// payloads de alta y edicion (solo escritura).

import type { AuditableData } from '@/types/auditable';

/** Replica de `CredentialAuthType`: literales del CHECK de la migracion 055. */
export enum CredentialAuthType {
  BEARER_TOKEN = 'BEARER_TOKEN',
  BASIC_AUTH = 'BASIC_AUTH',
  API_KEY = 'API_KEY',
}

/** Replica de `ApiKeyPlacement`. */
export enum ApiKeyPlacement {
  HEADER = 'HEADER',
  QUERY = 'QUERY',
}

export const CREDENTIAL_AUTH_TYPE_LABELS: Readonly<Record<CredentialAuthType, string>> = {
  [CredentialAuthType.BEARER_TOKEN]: 'Token Bearer',
  [CredentialAuthType.BASIC_AUTH]: 'Usuario y clave (Basic)',
  [CredentialAuthType.API_KEY]: 'API key',
};

export const API_KEY_PLACEMENT_LABELS: Readonly<Record<ApiKeyPlacement, string>> = {
  [ApiKeyPlacement.HEADER]: 'Cabecera HTTP',
  [ApiKeyPlacement.QUERY]: 'Parámetro de consulta',
};

/** Replica de `MAX_CREDENTIAL_NAME_LENGTH`. */
export const MAX_CREDENTIAL_NAME_LENGTH = 100;

/** Replica de `MAX_SECRET_LENGTH`. */
export const MAX_SECRET_LENGTH = 4096;

/** Replica de `API_KEY_NAME_PATTERN`. */
export const API_KEY_NAME_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * `CredentialResponseDto`: metadatos, sin secreto. Desde la migracion 058 trae
 * tambien la autoria (`createdBy` / `updatedBy`), como el resto de tablas
 * maestras.
 */
export interface Credential extends AuditableData {
  id: string;
  name: string;
  authType: CredentialAuthType;
}

/** `CredentialOptionDto`: lo unico que ve un EDITOR (selector del nodo). */
export interface CredentialOption {
  id: string;
  name: string;
  authType: CredentialAuthType;
}

/** Campos secretos, segun el tipo. Solo viajan del panel al backend. */
export interface CredentialSecretFields {
  token?: string;
  username?: string;
  password?: string;
  keyName?: string;
  apiKey?: string;
  placement?: ApiKeyPlacement;
}

/** `CreateCredentialDto`. */
export interface CreateCredentialPayload extends CredentialSecretFields {
  name: string;
  authType: CredentialAuthType;
}

/**
 * `UpdateCredentialDto`. Sin campos secretos, el cifrado guardado se conserva;
 * con alguno, el backend exige el juego COMPLETO del tipo.
 */
export interface UpdateCredentialPayload extends CredentialSecretFields {
  name?: string;
  authType?: CredentialAuthType;
}
