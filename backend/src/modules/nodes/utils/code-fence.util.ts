/**
 * Valla de bloque de codigo al principio o al final de un fragmento.
 *
 * Solo caza los EXTREMOS a proposito. Un ``` en mitad del texto puede ser
 * contenido legitimo del documento transcrito, y borrarlo seria destruir
 * justamente lo que el nodo de OCR viene a conservar.
 */
const CODE_FENCE_PATTERN = /^```(?:[a-zA-Z]*)?[ \t]*\n?|\n?[ \t]*```$/g;

/**
 * Quita las vallas de los extremos y el espacio sobrante.
 *
 * Tiene DOS consumidores con el mismo problema y en momentos distintos del
 * camino:
 *
 * 1. Los clientes de proveedor, ANTES de `JSON.parse`. Se le pide al modelo un
 *    objeto JSON y a veces lo entrega envuelto en ```json ... ```, lo que
 *    revienta el parseo con un error que acusa al contrato en vez de a la
 *    envoltura.
 * 2. El nodo de OCR, DESPUES, sobre el texto ya transcrito: el prompt le
 *    prohibe las vallas al modelo, pero esto es la red —una que se cuele acaba
 *    publicada tal cual en la noticia, porque nada mas abajo vuelve a mirar el
 *    texto—.
 *
 * Vivia dentro de `ocr-processor.strategy.ts` y era privada del modulo, asi que
 * el primer consumidor no podia usarla; copiarla habria dejado dos reglas que
 * divergen a la primera edicion.
 *
 * La expresion es global y `String.replace` con `/g` no conserva estado entre
 * llamadas (a diferencia de `RegExp.test`), de modo que es segura reutilizada.
 */
export const stripCodeFence = (text: string): string =>
  text.replace(CODE_FENCE_PATTERN, '').trim();
