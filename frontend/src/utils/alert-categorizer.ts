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
}

/**
 * Cuanto permanece en pantalla un aviso que no exige decision, en ms.
 *
 * `0` significaria "hasta que lo cierren", que es justo lo contrario.
 */
const TRANSIENT_TIMEOUT_MS = 6000;

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
  },
  GRAVE: {
    type: 'warning',
    icon: 'warning',
    accentClass: 'pd-accent-grave',
    persistent: true,
  },
  URGENTE: {
    type: 'negative',
    icon: 'report',
    accentClass: 'pd-accent-urgente',
    persistent: true,
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
 * `0` en Quasar significa "no se cierra solo", que es lo que necesita un aviso
 * con acciones: un toast que desaparece mientras el operador lee las opciones
 * es peor que no ofrecerlas.
 */
export const notifyTimeoutOf = (severity: NodeErrorSeverity | undefined): number =>
  presentationOf(severity).persistent ? 0 : TRANSIENT_TIMEOUT_MS;
