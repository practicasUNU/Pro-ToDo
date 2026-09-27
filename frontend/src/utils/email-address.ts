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
