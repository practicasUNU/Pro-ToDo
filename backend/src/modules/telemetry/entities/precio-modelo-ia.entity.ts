import { Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { AuditableEntity } from '@common/entities/auditable.entity';
import { numericTransformer } from '@modules/telemetry/utils/numeric.transformer';

/** Comodin de `modelo_ia`: tarifa generica del proveedor para modelos sin fila propia. */
export const ANY_MODEL = '*';

/**
 * Tarifa de un modelo de IA, en USD por millon de tokens (migracion 045).
 *
 * VERSIONADA por `vigente_desde` en lugar de editarse en sitio: cuando un
 * proveedor cambia precios se inserta una fila nueva, y la vigente es la mas
 * reciente que ya haya entrado en vigor. Aun asi la telemetria no depende de
 * este historial: cada fila de `telemetria_tokens_ia` guarda su propia copia de
 * las tarifas aplicadas.
 *
 * Tres tarifas y no dos porque Gemini factura el razonamiento aparte de la
 * salida; en los proveedores que no lo distinguen vale lo mismo que la de
 * completacion y no se usa (su `tokensReasoning` es 0).
 */
@Entity('precios_modelos_ia')
@Unique('uq_precios_modelos_ia_vigencia', [
  'aiProvider',
  'aiModel',
  'validFrom',
])
export class PrecioModeloIa extends AuditableEntity {
  @PrimaryGeneratedColumn('uuid', { name: 'id_precio_modelo_ia' })
  id: string;

  /** Valor de `LlmProvider` (`GEMINI`, `ANTHROPIC`...). */
  @Column({ name: 'proveedor_ia', type: 'varchar', length: 30 })
  aiProvider: string;

  /** Identificador exacto del modelo, o `ANY_MODEL` para la tarifa generica. */
  @Column({ name: 'modelo_ia', type: 'varchar', length: 100 })
  aiModel: string;

  @Column({
    name: 'tarifa_prompt_usd_mtok',
    type: 'numeric',
    precision: 12,
    scale: 6,
    transformer: numericTransformer,
  })
  promptRateUsdPerMTok: number;

  @Column({
    name: 'tarifa_completacion_usd_mtok',
    type: 'numeric',
    precision: 12,
    scale: 6,
    transformer: numericTransformer,
  })
  completionRateUsdPerMTok: number;

  @Column({
    name: 'tarifa_razonamiento_usd_mtok',
    type: 'numeric',
    precision: 12,
    scale: 6,
    transformer: numericTransformer,
  })
  reasoningRateUsdPerMTok: number;

  @Column({ name: 'vigente_desde', type: 'timestamptz' })
  validFrom: Date;

  @Column({ name: 'activo', type: 'boolean', default: true })
  active: boolean;
}
