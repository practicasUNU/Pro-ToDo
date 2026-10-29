import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { FsmExecution } from '@core/fsm/entities/fsm-execution.entity';
import { Workflow } from '@modules/workflows/entities/workflow.entity';
import { AiCallStatus } from '@modules/telemetry/enums/ai-call-status.enum';
import { TelemetryOperationOrigin } from '@modules/telemetry/enums/telemetry-origin.enum';
import { numericTransformer } from '@modules/telemetry/utils/numeric.transformer';

import type { User } from '@modules/users/entities/user.entity';

/**
 * Consumo de tokens de UNA inferencia de IA (migracion 045).
 *
 * Hasta ahora el gasto solo sobrevivia dentro del JSONB
 * `ejecuciones_flujo.contexto_acumulado`, imposible de agregar por flujo,
 * proveedor o mes. Esta tabla es esa misma traza en columnas.
 *
 * INMUTABLE por diseno: no hereda `AuditableEntity` (nadie la edita) y guarda
 * una FOTOGRAFIA de las tarifas aplicadas (`tarifa_*_usd`), no una referencia a
 * `precios_modelos_ia`. Si un proveedor cambia precios manana, el coste de las
 * inferencias de hoy no debe cambiar con el.
 *
 * `es_estimado` se activa cuando el coste no es exacto: el proveedor no informo
 * del uso, o el modelo no tenia tarifa propia y se aplico la generica.
 *
 * Desde la migracion 049 no todo consumo nace de una ejecucion: el asistente
 * de prompts (`origen_operacion = 'PROMPT_OPTIMIZATION'`) no tiene ejecucion,
 * flujo ni nodo, y en su lugar guarda el `usuario_id` que lo pidio. Un CHECK de
 * la tabla obliga a que cada origen traiga sus columnas.
 */
@Entity('telemetria_tokens_ia')
export class TelemetriaTokensIa {
  @PrimaryGeneratedColumn('uuid', { name: 'id_telemetria_tokens_ia' })
  id: string;

  @Column({ name: 'ejecucion_id', type: 'uuid', nullable: true })
  executionId: string | null;

  @ManyToOne(() => FsmExecution, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ejecucion_id' })
  execution?: FsmExecution;

  /**
   * Flujo de la ejecucion. Redundante con `ejecucion_id` a proposito: es el eje
   * de agregacion mas comun y evita un JOIN en cada informe. Lo resuelve el
   * propio INSERT desde `ejecuciones_flujo`, nunca el `flowId` del JSON del
   * pipeline, que es texto libre y no tiene por que ser este UUID.
   */
  @Column({ name: 'flujo_id', type: 'uuid', nullable: true })
  flowId: string | null;

  @ManyToOne(() => Workflow, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'flujo_id' })
  flow?: Workflow;

  /** `nodeId` del pipeline; sin FK, igual que `logs_nodo.id_nodo`. */
  @Column({ name: 'nodo_id', type: 'varchar', length: 50, nullable: true })
  nodeId: string | null;

  @Column({
    name: 'origen_operacion',
    type: 'varchar',
    length: 30,
    default: TelemetryOperationOrigin.FLOW_EXECUTION,
  })
  operationOrigin: TelemetryOperationOrigin;

  /**
   * Quien pidio la inferencia o lanzo la ejecucion. Si el backend la omite, el
   * DEFAULT de la columna pone la cuenta de respaldo (migracion 060).
   */
  @Column({ name: 'usuario_id', type: 'uuid', nullable: true })
  userId: string | null;

  /** Por nombre (`'User'`), como en `AuditableEntity`, para no abrir ciclos. */
  @ManyToOne('User', { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'usuario_id' })
  user?: User | null;

  @Column({ name: 'proveedor_ia', type: 'varchar', length: 30 })
  aiProvider: string;

  @Column({ name: 'modelo_ia', type: 'varchar', length: 100 })
  aiModel: string;

  @Column({ name: 'tokens_prompt', type: 'integer', default: 0 })
  promptTokens: number;

  @Column({ name: 'tokens_completacion', type: 'integer', default: 0 })
  completionTokens: number;

  @Column({ name: 'tokens_razonamiento', type: 'integer', default: 0 })
  reasoningTokens: number;

  @Column({ name: 'tokens_totales', type: 'integer', default: 0 })
  totalTokens: number;

  /** Tarifas aplicadas, en USD por millon de tokens, congeladas al registrar. */
  @Column({
    name: 'tarifa_prompt_usd',
    type: 'numeric',
    precision: 12,
    scale: 6,
    default: 0,
    transformer: numericTransformer,
  })
  promptRateUsd: number;

  @Column({
    name: 'tarifa_completacion_usd',
    type: 'numeric',
    precision: 12,
    scale: 6,
    default: 0,
    transformer: numericTransformer,
  })
  completionRateUsd: number;

  @Column({
    name: 'tarifa_razonamiento_usd',
    type: 'numeric',
    precision: 12,
    scale: 6,
    default: 0,
    transformer: numericTransformer,
  })
  reasoningRateUsd: number;

  @Column({
    name: 'costo_estimado_usd',
    type: 'numeric',
    precision: 12,
    scale: 6,
    default: 0,
    transformer: numericTransformer,
  })
  estimatedCostUsd: number;

  @Column({ name: 'es_estimado', type: 'boolean', default: false })
  isEstimated: boolean;

  /** Si el proveedor respondio o la llamada fallo (migracion 060). */
  @Column({
    name: 'estado',
    type: 'varchar',
    length: 10,
    default: AiCallStatus.SUCCESS,
  })
  status: AiCallStatus;

  /** Motivo del fallo, recortado; NULL en las llamadas exitosas. */
  @Column({
    name: 'mensaje_error',
    type: 'varchar',
    length: 500,
    nullable: true,
  })
  errorMessage: string | null;

  @CreateDateColumn({ name: 'creado_en', type: 'timestamptz' })
  createdAt: Date;
}
