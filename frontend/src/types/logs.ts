/**
 * Traza de una ejecucion para el visor de logs. Replica
 * `ExecutionLogResponseDto` del backend
 * (`backend/src/modules/logs/dto/execution-log-response.dto.ts`).
 */
export interface ExecutionLog {
  readonly executionId: string;
  /** Instante del ultimo fallo, ISO. */
  readonly timestamp: string | null;
  /** Severidad del fallo (LEVE, GRAVE, URGENTE), o `null` si no hubo. */
  readonly level: string | null;
  /** Stack del ultimo fallo (o codigo y mensaje si fue un fallo de dominio). */
  readonly stackTrace: string | null;
  /**
   * Entradas de la ejecucion en los `.log`, una por linea (JSON), sin el
   * contexto de negocio y con rutas relativas. Vacio si ya se rotaron.
   */
  readonly rawLog: string;
  /** Se alcanzo el tope de entradas o de tamano: faltan las mas antiguas. */
  readonly truncated: boolean;
}
