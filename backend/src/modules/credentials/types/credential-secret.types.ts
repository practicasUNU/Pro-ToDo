import {
  ApiKeyPlacement,
  CredentialAuthType,
} from '../enums/credential-auth-type.enum';

/**
 * Contenido descifrado de una credencial, discriminado por su tipo.
 *
 * Es lo que viaja CIFRADO en `credenciales.datos_cifrados` (como JSON) y lo
 * unico que devuelve `CredentialsService.resolveSecret`. Vive en memoria solo
 * mientras la estrategia del nodo construye la peticion: nunca se persiste en
 * claro, nunca entra al `StatePayloadContext` y nunca sale por la API.
 */
export type CredentialSecret =
  | {
      readonly authType: CredentialAuthType.BEARER_TOKEN;
      readonly token: string;
    }
  | {
      readonly authType: CredentialAuthType.BASIC_AUTH;
      readonly username: string;
      readonly password: string;
    }
  | {
      readonly authType: CredentialAuthType.API_KEY;
      readonly keyName: string;
      readonly apiKey: string;
      readonly placement: ApiKeyPlacement;
    };

/** Mascara con la que la auditoria sustituye cada campo de la credencial. */
export const SECRET_MASK = '********';

/**
 * Campos que guarda cada tipo, en el orden en que se muestran.
 *
 * Los consume la auditoria para pintar `{ token: '********' }` sin descifrar
 * nada: sabe QUE campos tiene la credencial por su tipo, no por su contenido.
 */
export const SECRET_FIELDS_BY_TYPE: Readonly<
  Record<CredentialAuthType, readonly string[]>
> = {
  [CredentialAuthType.BEARER_TOKEN]: ['token'],
  [CredentialAuthType.BASIC_AUTH]: ['username', 'password'],
  [CredentialAuthType.API_KEY]: ['keyName', 'apiKey', 'placement'],
};

/** Vista enmascarada de una credencial, para `datos_anteriores` / `datos_nuevos`. */
export const maskCredentialFields = (
  authType: CredentialAuthType,
): Record<string, string> =>
  Object.fromEntries(
    SECRET_FIELDS_BY_TYPE[authType].map((field) => [field, SECRET_MASK]),
  );
