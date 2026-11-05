import { Transform } from 'class-transformer';

/**
 * Recorta y pasa a minusculas un correo ANTES de validarlo.
 *
 * Amplia `TrimmedString` para los correos: `" Admin@UNUWARE.com "` es la misma
 * cuenta que `admin@unuware.com`, y `UsersService` ya la busca normalizada. Sin
 * esto, la auditoria y los logs de `AuthService`, que guardan el correo tal
 * como llega, registrarian dos grafias de una misma identidad.
 *
 * SOLO TOCA CADENAS, igual que `TrimmedString`: un `undefined` o un numero
 * pasan intactos para que `@IsEmail` los rechace con su propio mensaje.
 */
export const NormalizedEmail = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  );
