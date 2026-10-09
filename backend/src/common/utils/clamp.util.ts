/**
 * Recorta un numero al intervalo `[minimum, maximum]`.
 *
 * Existe porque los valores que llegan del ENTORNO no pasan por
 * `class-validator`: los `@Min`/`@Max` de un DTO solo alcanzan a lo que viene en
 * los `params` del nodo, de modo que un `LLM_HTTP_TIMEOUT_MS=999999999` entraria
 * intacto hasta Axios. Recortar y no lanzar es deliberado: un `.env` con una
 * errata no debe impedir que el flujo corra, solo que corra con un valor
 * absurdo.
 *
 * Funcion pura, sin estado ni E/S (`code-conventions.md` §2.1).
 */
export const clamp = (
  value: number,
  minimum: number,
  maximum: number,
): number => Math.min(Math.max(value, minimum), maximum);
