import type { NodeErrorSeverity } from '@/types/execution';

/** Como se presenta un incidente segun su severidad. */
export interface AlertPresentation {
  /** Tipo de `$q.notify`, que decide el color de fondo del aviso. */
  readonly type: 'info' | 'warning' | 'negative';
  /** Glifo que acompana al color. El color NUNCA viaja solo. */
  readonly icon: string;
  /** Clase de acento de `app.scss`, que pinta la franja superior de 3px. */
  readonly accentClass: string;
  /**
   * Si el aviso espera a que alguien lo cierre.
   *
   * Solo lo merece un incidente que exige una decision humana. Un `LEVE` se
   * desvanece: el motor lo cierra por su cuenta y no hay nada que decidir.
   */
  readonly persistent: boolean;
  /**
   * `timeout` de `$q.notify`, en ms. `0` = hasta que alguien lo cierre.
   *
   * CONCEPTO DISTINTO de `persistent`, aunque se parezcan. Aquel decide si la
   * severidad merece interrumpir al operador (`ALERTING_SEVERITIES`); este,
   * cuanto dura el aviso en pantalla. Un `GRAVE` interrumpe —hay una ejecucion
   * pausada esperando una decision— pero su toast no tiene por que quedarse
   * para siempre: la decision se toma en la tabla de flujos, no en el toast.
   */
  readonly timeoutMs: number;
}

/**
 * Cuanto permanece en pantalla un aviso de incidencia, en ms.
 *
 * Diez segundos y no los 5000 por defecto de Quasar: el aviso de un fallo trae
 * nodo, codigo, intento y ahora tambien un consejo de que hacer. Cinco
 * segundos no dan para leer todo eso, y el operador se quedaba con el color y
 * poco mas. Son cinco segundos mas que antes, a cambio de que el texto sirva.
 */
export const ALERT_TIMEOUT_MS = 10_000;

/**
 * Severidad -> presentacion. Fuente UNICA de esa traduccion.
 *
 * Antes estaba repartida entre un arreglo en `useExecutionSocket`, cadenas de
 * clase repetidas en tres `notify` distintos y un bloque de `app.scss`, con dos
 * consecuencias visibles: `GRAVE` y `URGENTE` se pintaban EXACTAMENTE IGUAL
 * —mismo rojo, mismo tipo `negative`—, de modo que un fallo recuperable y uno
 * irreversible eran indistinguibles de un vistazo; y `.pd-accent-leve`, que
 * existe en la hoja de estilos desde el principio, no lo usaba nadie.
 *
 * Las tres severidades son las del backend (`NodeResult.error.level`) y aqui
 * solo se DECIDE COMO SE PINTAN. La clasificacion es del motor: reescribirla en
 * el cliente crearia dos fuentes de verdad que se contradirian en cuanto una de
 * las dos cambiase.
 *
 * Por que cada una es la que es:
 *
 * - `LEVE`: el motor lo cierra solo, sin pausar ni reservar cursor. No hay nada
 *   que hacer, asi que se informa y se aparta.
 * - `GRAVE`: ambar. Es el unico que el motor REINTENTA y el unico que deja la
 *   ejecucion PAUSADA esperando a CU-09, de modo que el operador tiene algo que
 *   decidir y el aviso se queda hasta que lo atienda.
 * - `URGENTE`: rojo. Irrecuperable: ni se reintenta ni se puede reanudar.
 */
const PRESENTATION_BY_SEVERITY: Record<NodeErrorSeverity, AlertPresentation> = {
  LEVE: {
    type: 'info',
    icon: 'info',
    accentClass: 'pd-accent-leve',
    persistent: false,
    timeoutMs: ALERT_TIMEOUT_MS,
  },
  GRAVE: {
    type: 'warning',
    icon: 'warning',
    accentClass: 'pd-accent-grave',
    persistent: true,
    timeoutMs: ALERT_TIMEOUT_MS,
  },
  URGENTE: {
    type: 'negative',
    icon: 'report',
    accentClass: 'pd-accent-urgente',
    persistent: true,
    // El unico que se queda hasta que alguien lo cierre: es irrecuperable, ni
    // se reintenta ni se puede reanudar, asi que perderselo por mirar a otro
    // lado deja una ejecucion muerta sin que nadie se entere.
    timeoutMs: 0,
  },
};

/**
 * Severidades que merecen interrumpir al operador con un aviso flotante.
 *
 * Se deriva de la tabla y no se declara aparte: son exactamente las que se
 * presentan como persistentes, y mantener dos listas garantizaba que algun dia
 * dejasen de coincidir.
 */
export const ALERTING_SEVERITIES: readonly NodeErrorSeverity[] = (
  Object.keys(PRESENTATION_BY_SEVERITY) as NodeErrorSeverity[]
).filter((severity) => PRESENTATION_BY_SEVERITY[severity].persistent);

/**
 * Como pintar un incidente de esta severidad.
 *
 * Funcion pura, sin estado ni E/S (`frontend-architecture.md` §2.1).
 *
 * Cae a `URGENTE` ante un valor desconocido, y la direccion importa: lo que
 * llega por el socket es texto, y un valor que no reconocemos describe una
 * severidad NUEVA del backend. Degradar a `info` la escondería; tratarla como
 * lo peor la hace visible.
 */
export const presentationOf = (severity: NodeErrorSeverity | undefined): AlertPresentation =>
  (severity === undefined ? undefined : PRESENTATION_BY_SEVERITY[severity]) ??
  PRESENTATION_BY_SEVERITY.URGENTE;

/** Clases completas del aviso flotante, tarjeta incluida. */
export const notifyClassesOf = (severity: NodeErrorSeverity | undefined): string =>
  `pd-card pd-card--accent ${presentationOf(severity).accentClass}`;

/**
 * `timeout` de `$q.notify` para esta severidad.
 *
 * `0` en Quasar significa "no se cierra solo", y se reserva a `URGENTE`. Los
 * avisos CON ACCIONES —la pausa de un flujo, con su boton de reanudar— fijan
 * su propio `0` sin pasar por aqui: un toast que desaparece mientras el
 * operador lee las opciones es peor que no ofrecerlas.
 */
export const notifyTimeoutOf = (severity: NodeErrorSeverity | undefined): number =>
  presentationOf(severity).timeoutMs;

/**
 * Consejo por defecto de cada severidad.
 *
 * Responde la pregunta que el mensaje de error nunca contesta: «y ahora que
 * hago». El codigo y el texto del motor describen la averia, pero quien mira
 * el toast necesita saber si debe esperar, tocar algo o avisar a alguien.
 */
const ADVICE_BY_SEVERITY: Record<NodeErrorSeverity, string> = {
  LEVE: 'El flujo continuará en el siguiente ciclo. Puedes incrementar el tiempo de espera en la configuración del nodo o esperar a la siguiente ejecución.',
  GRAVE:
    'Verifica la configuración del nodo, el contrato de la plantilla HTML/prompt y el estado de conexión del servidor antes de reanudar el flujo.',
  URGENTE:
    'La ejecución no admite reintento: revisa la traza del nodo y lanza una ejecución nueva cuando hayas corregido la causa.',
};

/**
 * Consejo afinado para los codigos que de verdad se repiten.
 *
 * Es una lista CORTA a proposito. El backend define mas de sesenta codigos
 * repartidos por las estrategias y no existe ningun catalogo unico: escribir
 * sesenta consejos aqui crearia un texto sin dueno que se desincronizaria en
 * cuanto una estrategia anadiese el suyo. Estos son los que un operador ve a
 * diario, y para el resto basta el consejo de la severidad.
 */
const ADVICE_BY_ERROR_CODE: Readonly<Record<string, string>> = {
  ERR_IMAP_TIMEOUT:
    'El buzón no respondió a tiempo. El flujo continuará en el siguiente ciclo; si se repite, sube el tiempo de espera del nodo de correo.',
  ERR_SCRAPING_TIMEOUT_EXCEEDED:
    'La web tardó más de lo permitido. Sube el tiempo de espera del extractor o comprueba que la página siga publicada.',
  ERR_ACCESS_DENIED_BLOCK_DETECTED:
    'El sitio bloqueó la extracción. Revisa si exige navegación con cabeceras propias antes de volver a lanzarlo.',
  ERR_POST_IA_DOM_MUTATED:
    'La IA alteró la estructura HTML de la plantilla. Revisa el contrato de la plantilla y el prompt del nodo antes de reanudar.',
  ERR_TEMPLATE_PENDING_VARS:
    'La plantilla aún tiene marcadores sin resolver. Comprueba que el nodo que los rellena se ejecutó y publicó su namespace.',
  ERR_LLM_PROVIDER_FAILURE:
    'El proveedor de IA rechazó la petición. Verifica su credencial en el servidor y el estado del servicio antes de reanudar.',
  ERR_LLM_MAX_RETRIES_EXCEEDED:
    'Se agotaron los reintentos contra el proveedor de IA. Espera unos minutos o cambia de modelo antes de reanudar.',
};

/**
 * Que hacer ante este incidente.
 *
 * Prefiere el consejo del CODIGO y cae al de la severidad: el codigo es el
 * contrato estable que identifica el fallo y puede decir algo mucho mas
 * concreto, mientras que la severidad siempre tiene algo que responder.
 */
export const adviceFor = (
  severity: NodeErrorSeverity | undefined,
  errorCode: string | null | undefined,
): string => {
  const byCode =
    errorCode === null || errorCode === undefined ? undefined : ADVICE_BY_ERROR_CODE[errorCode];

  return byCode ?? ADVICE_BY_SEVERITY[severity ?? 'URGENTE'] ?? ADVICE_BY_SEVERITY.URGENTE;
};
