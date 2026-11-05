/**
 * Clase de estado de un campo numerico con rango.
 *
 * Helper PURO de presentacion (`frontend-architecture.md` §2.1): sin estado, sin
 * E/S y sin dependencia de Pinia, asi que se prueba aislado y lo comparten
 * todos los configuradores que exponen minimos y maximos.
 *
 * DA LECTURA CONTINUA, que es su razon de ser. Quasar solo pinta el error
 * DESPUES de tocar el campo y no dice nada cuando el valor es correcto, de modo
 * que un formulario con rangos se recorria sin saber si lo escrito valia hasta
 * intentar guardar. Verde mientras el valor cae dentro, rojo en cuanto se sale.
 *
 * Vivia dentro de `WebScraperConfig.vue`; subio aqui al necesitarlo tambien los
 * nodos de IA y OCR, cuyo techo de reintentos bajo a 3.
 *
 * Las dos clases estan definidas en `app.scss` y consumen `--pd-positive` y
 * `--pd-negative`: ningun componente declara el color por su cuenta.
 */
export const rangeClass = (value: number, min: number, max: number): string =>
  value >= min && value <= max ? 'pd-field--in-range' : 'pd-field--out-of-range';
