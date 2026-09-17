/**
 * Contrato de un adjunto de correo dentro del namespace `raw_email`.
 *
 * UBICACION: vive en `@modules/nodes` y NO en `@core/fsm/types/` a proposito.
 * Aquello son contratos del MOTOR (`INodeStrategy`, `NodeResult`,
 * `PipelineSchema`), y `@core` no puede depender de `@modules`. Este tipo lo
 * escribe `ImapTriggerStrategy` y lo lee `ParserEmailStrategy`: los dos viven en
 * este modulo, y subirlo al nucleo obligaria al motor a conocer el formato de un
 * correo. Cuando el motor libera el binario lo hace de forma ESTRUCTURAL, por el
 * nombre de la clave, justamente para no tener que importar esta interfaz.
 */

/** Tipo asumido cuando la parte MIME no declara `Content-Type`. */
export const DEFAULT_ATTACHMENT_CONTENT_TYPE = 'application/octet-stream';

/** Raiz del nombre sustituto cuando el MIME no declara `filename`. */
export const FALLBACK_ATTACHMENT_NAME_PREFIX = 'attachment';

/**
 * Adjunto ya proyectado al payload del pipeline.
 *
 * Los tres metadatos son `readonly` porque describen el fichero que envio el
 * remitente y no cambian nunca. `contentBase64` es la unica clave mutable, y lo
 * es a proposito: es la palanca de liberacion de memoria que el motor acciona en
 * cuanto algun nodo ha extraido texto aprovechable.
 */
export interface RawEmailAttachment {
  /**
   * Nombre declarado por el remitente, o `attachment-N` si el MIME no traia
   * ninguno.
   *
   * PROHIBIDO usarlo para construir una ruta de fichero: es una cadena que
   * controla quien envia el correo, y admite `../` y separadores de ruta. Hoy
   * nadie escribe ficheros con el; esta nota existe para que siga siendo asi.
   */
  readonly filename: string;

  /** Tipo MIME declarado, o `DEFAULT_ATTACHMENT_CONTENT_TYPE` si falta. */
  readonly contentType: string;

  /**
   * Bytes del binario YA DECODIFICADO, no la longitud de `contentBase64`.
   *
   * Los dos numeros difieren en torno a un 33%, que es lo que engorda base64.
   * Quien compare `size` con `contentBase64.length` y los vea distintos no ha
   * encontrado un fallo.
   */
  readonly size: number;

  /**
   * Contenido en base64 PLANO: sin prefijo `data:`, sin saltos de linea.
   *
   * `null` tiene dos lecturas segun el momento del pipeline, y ambas significan
   * "aqui no hay bytes que leer": antes de que ningun nodo extraiga texto quiere
   * decir que el adjunto no se ingirio —`includeAttachments` apagado, o descarte
   * por tamano—; despues, que el motor ya libero el binario porque habia texto
   * aprovechable y nadie volvera a necesitarlo.
   */
  contentBase64: string | null;
}

/**
 * Inventario de un adjunto SIN su binario.
 *
 * Es lo que `PARSER_PRE_IA` publica en `parsed_email`: los nodos posteriores
 * necesitan saber que adjuntos venian y de que tipo, pero repetir el base64 en
 * un segundo namespace duplicaria los mismos megabytes dentro de la misma fila
 * `contexto_acumulado`.
 */
export type RawEmailAttachmentMetadata = Omit<
  RawEmailAttachment,
  'contentBase64'
>;
