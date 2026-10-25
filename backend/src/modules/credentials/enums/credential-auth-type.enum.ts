/**
 * Esquemas de autenticacion que puede guardar la boveda de credenciales.
 *
 * Son los literales del CHECK `credenciales_tipo_autenticacion_check`
 * (migracion 055): cambiarlos aqui exige una migracion. Coinciden con los
 * valores de `authType` del nodo DESTINO_HTTP_GENERICO, salvo `NONE`, que no
 * necesita credencial y por tanto no se guarda.
 */
export enum CredentialAuthType {
  BEARER_TOKEN = 'BEARER_TOKEN',
  BASIC_AUTH = 'BASIC_AUTH',
  API_KEY = 'API_KEY',
}

/** Donde viaja una API key: cabecera o parametro de consulta. */
export enum ApiKeyPlacement {
  HEADER = 'HEADER',
  QUERY = 'QUERY',
}
