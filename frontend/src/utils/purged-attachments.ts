/**
 * Deteccion de adjuntos cuyo binario ya libero el motor (RNF-01).
 *
 * Helper PURO, sin estado ni E/S (`frontend-architecture.md` §2.1): recibe el
 * namespace tal y como llega en `ExecutionDetail.context` y responde una sola
 * pregunta.
 *
 * Existe porque el frontend NO tiene un tipo espejo del adjunto del backend:
 * `context` es `Record<string, Record<string, unknown>>` a proposito —el
 * contexto es un payload abierto que cada nodo amplia— y replicar aqui la forma
 * de `RawEmailAttachment` crearia una segunda definicion destinada a
 * desincronizarse. Lo que si se puede afirmar con seguridad es la forma MINIMA
 * que esta pregunta necesita, y eso es lo que comprueban estas guardas.
 */

/** Namespace donde `TRIGGER_IMAP` deposita el correo crudo con sus adjuntos. */
const RAW_EMAIL_NAMESPACE = 'raw_email';

/** Clave del inventario de adjuntos dentro de ese namespace. */
const ATTACHMENTS_KEY = 'attachments';

/**
 * El adjunto existe pero ya no lleva binario.
 *
 * `null` y ausente se tratan IGUAL: el motor escribe `null` al liberar
 * (`withReplacedBinaryContent`), pero un adjunto que nunca lo tuvo tampoco se
 * puede reenviar a un modelo, y para la advertencia que dispara esta funcion
 * las dos situaciones aconsejan lo mismo.
 */
const isPurgedAttachment = (candidate: unknown): boolean => {
  if (typeof candidate !== 'object' || candidate === null) {
    return false;
  }

  const { contentBase64 } = candidate as { contentBase64?: unknown };

  return contentBase64 === null || contentBase64 === undefined || contentBase64 === '';
};

/**
 * El correo de esta ejecucion llego con adjuntos y ya no conserva sus binarios.
 *
 * Exige que TODOS esten liberados y no solo alguno: mientras quede uno con
 * contenido, el nodo puede volver a transcribirlo de verdad y advertir de que
 * se reutilizara una extraccion en cache seria falso.
 *
 * @param context Namespaces de la ejecucion observada, tal cual los sirve la API.
 * @returns `true` solo si habia adjuntos y todos estan ya sin binario.
 */
export const hasPurgedAttachments = (
  context: Readonly<Record<string, Record<string, unknown>>>,
): boolean => {
  const attachments = context[RAW_EMAIL_NAMESPACE]?.[ATTACHMENTS_KEY];

  if (!Array.isArray(attachments) || attachments.length === 0) {
    return false;
  }

  return attachments.every(isPurgedAttachment);
};
