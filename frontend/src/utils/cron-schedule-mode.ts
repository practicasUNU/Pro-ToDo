// Helper puro de dominio (frontend-architecture.md §2.1): sin estado ni E/S.
//
// Traduce entre la EXPRESION que persiste el nodo TRIGGER_CRON
// (`params.cronExpression`) y los dos modos que ofrece el formulario. El DTO
// del backend valida con `forbidNonWhitelisted`, de modo que el modo elegido NO
// puede guardarse como una clave mas: se DERIVA de la forma de la expresion al
// hidratar, igual que `subject-filter-mode.ts` hace con el filtro de asunto del
// disparador IMAP.

/**
 * Modos de programacion del disparador.
 *
 * `ADVANCED` es la valvula de escape y tambien el respaldo: cualquier
 * expresion que no sea exactamente uno de los intervalos asistidos cae aqui, de
 * modo que un flujo heredado jamas pierde su programacion ni la ve reescrita.
 */
export type CronScheduleMode = 'SIMPLE' | 'ADVANCED';

/** Modo con el que arranca un nodo nuevo. */
export const DEFAULT_CRON_SCHEDULE_MODE: CronScheduleMode = 'SIMPLE';

/**
 * Intervalos del asistente, en orden de frecuencia.
 *
 * Son los cuatro casos que cubren la practica totalidad de los flujos de
 * ingesta: sondear un buzon o una web cada pocos minutos. Lo demas —una hora
 * concreta, un dia del mes— se escribe en modo manual, que es donde la sintaxis
 * cron de verdad hace falta.
 *
 * Lista CERRADA (§4): el selector no lleva `new-value-mode`, asi que teclear
 * filtra pero no da de alta ninguna expresion inventada.
 */
export const CRON_INTERVAL_PRESETS: ReadonlyArray<{
  readonly label: string;
  readonly value: string;
}> = [
  { label: 'Cada 5 min', value: '*/5 * * * *' },
  { label: 'Cada 15 min', value: '*/15 * * * *' },
  { label: 'Cada 30 min', value: '*/30 * * * *' },
  { label: 'Cada 1 hora', value: '0 * * * *' },
];

/** Expresion del intervalo asistido que coincide con la dada, o `null`. */
export const findCronIntervalPreset = (
  expression: string,
): (typeof CRON_INTERVAL_PRESETS)[number] | null =>
  CRON_INTERVAL_PRESETS.find((preset) => preset.value === expression.trim()) ?? null;

/**
 * Modo que corresponde a una expresion ya guardada.
 *
 * La expresion VACIA cae en `SIMPLE` porque es un nodo recien anadido: abrirlo
 * en modo manual obligaria a teclear sintaxis cron a quien solo quiere sondear
 * cada cuarto de hora, que es justo el trabajo que el asistente ahorra.
 */
export const deriveCronScheduleMode = (expression: string): CronScheduleMode => {
  if (expression.trim() === '') return DEFAULT_CRON_SCHEDULE_MODE;

  return findCronIntervalPreset(expression) === null ? 'ADVANCED' : 'SIMPLE';
};
