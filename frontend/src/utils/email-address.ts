// Helper puro de validacion (frontend-architecture.md §2.1). Sin estado y sin
// red: solo responde si una cadena tiene forma de direccion de correo.

/**
 * Forma de una direccion de correo, a efectos de interfaz.
 *
 * NO pretende implementar RFC 5322, que admite comentarios, comillas y
 * direcciones literales por IP que ningun operador va a teclear en un campo de
 * alertas. Es una guarda Poka-Yoke: atrapa el error frecuente —la coma que
 * sobra, el dominio sin punto, el espacio en medio— antes de que el flujo se
 * guarde y el backend devuelva un 400 sobre el esquema entero. Quien manda sobre
 * la validez sigue siendo el `@IsEmail()` del DTO.
 *
 * Cada tramo usa clases de caracteres DISJUNTAS y ningun cuantificador anida a
 * otro, de modo que el motor no puede retroceder de forma exponencial. Importa
 * porque esto se evalua en cada pulsacion sobre lo que el usuario teclea, que es
 * el escenario de manual de un ReDoS.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/**
 * Comprueba que el valor tenga forma de direccion de correo.
 *
 * Distinta de `isCorporateEmail`, y no la sustituye: aquella comprueba que el
 * dominio este entre los autorizados para INICIAR SESION. Un destinatario de
 * alerta puede ser perfectamente externo —un proveedor, una guardia
 * subcontratada—, asi que exigirle el dominio corporativo dejaria fuera al
 * destinatario mas probable de una incidencia de integracion.
 */
export const isEmailAddress = (value: string): boolean => EMAIL_PATTERN.test(value.trim());

/**
 * Extrae las direcciones VALIDAS de un texto pegado o tecleado.
 *
 * Existe porque el campo de destinatarios es uno de los dos selectores de
 * entrada libre del proyecto, y pegar una lista de correos es justo lo que hace
 * un operador con una guardia ya definida en otro sitio. Sin esto, pegar
 * "a@x.com, b@y.com" registraba la cadena ENTERA como una unica direccion, y
 * cada fragmento a medio teclear entraba como un chip suelto que el backend
 * rechazaba despues con un 400 sobre el esquema completo.
 *
 * Se DESCARTA lo que no valida en vez de conservarlo marcado: el proposito es
 * que no llegue basura al chip, y un fragmento incompleto —"a@", "guardia"— no
 * es una direccion que el operador quiera corregir, es ruido del pegado.
 *
 * Deduplica preservando el orden de aparicion: el mismo correo dos veces en la
 * lista de origen no es un error que merezca un aviso, pero mandar dos copias
 * del aviso si molesta a quien lo recibe.
 *
 * @param raw Texto en crudo, con separadores arbitrarios.
 * @returns Direcciones validas, sin repetir y en su orden original.
 */
export const parseEmailList = (raw: string): string[] => [
  ...new Set(
    raw
      .split(/[\s,;]+/)
      .map((fragment) => fragment.trim())
      .filter((fragment) => fragment !== '' && isEmailAddress(fragment)),
  ),
];
