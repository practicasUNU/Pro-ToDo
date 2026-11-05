// Replica del contrato de `SmtpAlertConfigDto` (backend). Cualquier cambio alla
// debe reflejarse aqui.

/**
 * Asunto con el que se pre-puebla un nodo recien anadido.
 *
 * REPLICA EXACTA de `DEFAULT_ALERT_SUBJECT` en `smtp-alert.strategy.ts`, y la
 * prueba 7.6 del spec de la estrategia vigila que el backend no la cambie por su
 * cuenta. La copia no es redundancia: el operador tiene que VER en el formulario
 * el asunto que se enviara si no toca nada, y el unico modo de ensenarselo sin
 * pedir el valor al servidor es tenerlo aqui.
 *
 * Si el marcador no resuelve en ejecucion, el backend envia igualmente con un
 * asunto de respaldo. Borrar el campo es una accion legitima.
 */
export const DEFAULT_ALERT_SUBJECT =
  '[ALERTA PROTO-DO] Notificacion de incidencia en flujo {{trigger.flow_name}}';

/** Tope de destinatarios por aviso, replicado de `MAX_ALERT_RECIPIENTS`. */
export const MAX_ALERT_RECIPIENTS = 10;

/** Longitud maxima del asunto, replicada de `MAX_ALERT_SUBJECT_LENGTH`. */
export const MAX_ALERT_SUBJECT_LENGTH = 255;

/** Longitud maxima de la nota, replicada de `MAX_ALERT_NOTE_LENGTH`. */
export const MAX_ALERT_NOTE_LENGTH = 2000;

/**
 * Configuracion del nodo `DESTINO_SMTP` en el cliente.
 *
 * NINGUN campo es opcional aqui, aunque el DTO del backend los admita todos
 * ausentes. Un `undefined` enlazado a un `q-input` lo convierte en campo
 * descontrolado en Vue, y Quasar avisa por consola en cada pulsacion. La
 * ausencia se representa con `''` o `[]`, y es `toNodeParams()` quien decide que
 * se publica en el `pipeline_schema` y que se omite.
 *
 * NO hay cuerpo del mensaje: la carta la compone el backend con la identidad
 * institucional. `customMessage` es una nota en TEXTO PLANO que se incrusta en
 * ella, y no se interpola.
 */
export interface SmtpAlertNodeConfig {
  to: string[];
  subject: string;
  customMessage: string;
}
