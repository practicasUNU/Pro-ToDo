// Helper puro de presentacion (frontend-architecture.md §2.1): decide si una
// tecla llega al campo, sin estado ni I/O.

/**
 * Teclas que `<input type="number">` acepta y que no son un numero entero.
 *
 * `e` y `E` abren notacion exponencial, de modo que `1e5` entra como valor
 * valido: el navegador lo da por bueno y `:max` no lo ataja, porque el campo
 * nunca llega a estar en estado invalido. Los signos permiten negativos donde
 * todos los campos del proyecto son duraciones, cuentas o reintentos. La coma y
 * el punto abren decimales en campos que son enteros.
 */
const BLOCKED_KEYS: ReadonlySet<string> = new Set(['e', 'E', '+', '-', ',', '.']);

/**
 * Impide que esas teclas lleguen al campo.
 *
 * NO ES LA VALIDACION, y conviene tenerlo claro: el pegado, el autorrelleno y
 * las flechas del propio `input` la esquivan por completo. Las barreras reales
 * siguen siendo las cotas `:min`/`:max` del campo y el DTO del backend, que es
 * el unico que decide. Esto solo evita que el operador teclee algo que iba a
 * ser rechazado y no se entere hasta guardar.
 *
 * Se deja pasar todo lo que no sea un caracter suelto —`Backspace`, `Tab`,
 * `ArrowUp`, `Enter`— mirando la longitud de `key`: enumerar las teclas de
 * control seria una lista larga, incompleta y distinta en cada navegador. Los
 * atajos con modificador tambien pasan, o se romperian «pegar» y «deshacer».
 */
const blockKeys =
  (blocked: ReadonlySet<string>) =>
  (event: KeyboardEvent): void => {
    if (event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }

    if (blocked.has(event.key)) {
      event.preventDefault();
    }
  };

export const blockNonNumericKeys = blockKeys(BLOCKED_KEYS);

/**
 * Variante para importes con decimales (tarifas en USD por millon de tokens).
 *
 * Deja pasar el PUNTO, que es el separador que `<input type="number">` entiende
 * en todos los navegadores. La COMA sigue bloqueada: segun el idioma del
 * navegador se interpreta como separador decimal o se descarta en silencio, y
 * `1,5` acabaria guardado como `15` o como nada. Mejor una sola forma de
 * escribir un decimal que dos que se comportan distinto.
 */
const BLOCKED_DECIMAL_KEYS: ReadonlySet<string> = new Set(['e', 'E', '+', '-', ',']);

export const blockNonDecimalKeys = blockKeys(BLOCKED_DECIMAL_KEYS);
