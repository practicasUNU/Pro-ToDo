import { getMetadataArgsStorage } from 'typeorm';

import { AuditableEntity } from '@common/entities/auditable.entity';
import { FsmExecution } from '@core/fsm/entities/fsm-execution.entity';
import { TelemetriaTokensIa } from '@modules/telemetry/entities/telemetria-tokens-ia.entity';
import { Workflow } from '@modules/workflows/entities/workflow.entity';

/**
 * Las once columnas pedidas por la especificacion de telemetria. Se comprueban
 * contra los metadatos que registran los decoradores, sin base de datos: con
 * `synchronize: false` un nombre mal escrito aqui no lo corregiria TypeORM, se
 * descubriria en el primer INSERT de produccion.
 */
const REQUIRED_COLUMNS = [
  'id_telemetria_tokens_ia',
  'ejecucion_id',
  'flujo_id',
  'nodo_id',
  'proveedor_ia',
  'modelo_ia',
  'tokens_prompt',
  'tokens_completacion',
  'tokens_razonamiento',
  'tokens_totales',
  'costo_estimado_usd',
  'creado_en',
] as const;

/** Fotografia de tarifas que garantiza la inmutabilidad historica del coste. */
const SNAPSHOT_COLUMNS = [
  'tarifa_prompt_usd',
  'tarifa_completacion_usd',
  'tarifa_razonamiento_usd',
  'es_estimado',
] as const;

/**
 * Nombres SQL de las columnas declaradas por una clase, sin las heredadas.
 * `@PrimaryGeneratedColumn` tambien se registra como columna, asi que la PK
 * aparece aqui igual que el resto.
 */
/** Clase de entidad, tal y como la guardan los metadatos de TypeORM. */
type EntityClass = abstract new (...args: never[]) => unknown;

const columnNamesOf = (target: EntityClass): string[] =>
  getMetadataArgsStorage()
    .columns.filter((column) => column.target === target)
    .map((column) => String(column.options.name));

describe('TelemetriaTokensIa', () => {
  it('deberia instanciarse con sus propiedades tipadas', () => {
    // 1. Arrange 📐
    const entity = new TelemetriaTokensIa();

    // 2. Act ⚙️
    Object.assign(entity, {
      executionId: 'exec-1',
      nodeId: 'nodo_ia',
      promptTokens: 10,
      completionTokens: 20,
      reasoningTokens: 5,
      totalTokens: 35,
      estimatedCostUsd: 0.0001,
      isEstimated: false,
    });

    // 3. Assert 🎯
    expect(entity).toBeInstanceOf(TelemetriaTokensIa);
    expect(entity.totalTokens).toBe(35);
    expect(entity.estimatedCostUsd).toBe(0.0001);
  });

  it('deberia mapear la tabla telemetria_tokens_ia', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const table = getMetadataArgsStorage().tables.find(
      (entry) => entry.target === TelemetriaTokensIa,
    );

    // 3. Assert 🎯
    expect(table?.name).toBe('telemetria_tokens_ia');
  });

  it('deberia declarar las once columnas en castellano', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const columns = columnNamesOf(TelemetriaTokensIa);

    // 3. Assert 🎯
    expect(columns).toEqual(expect.arrayContaining([...REQUIRED_COLUMNS]));
  });

  it('deberia guardar la fotografia de tarifas y la marca de estimacion', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const columns = columnNamesOf(TelemetriaTokensIa);

    // 3. Assert 🎯
    expect(columns).toEqual(expect.arrayContaining([...SNAPSHOT_COLUMNS]));
  });

  it('deberia relacionarse ManyToOne con la ejecucion y el flujo', () => {
    // 1. Arrange 📐
    const relations = getMetadataArgsStorage().relations.filter(
      (relation) => relation.target === TelemetriaTokensIa,
    );

    // 2. Act ⚙️
    const byProperty = Object.fromEntries(
      relations.map((relation) => [
        relation.propertyName,
        {
          type: relation.relationType,
          target: (relation.type as () => EntityClass)(),
        },
      ]),
    );

    // 3. Assert 🎯
    expect(byProperty.execution).toEqual({
      type: 'many-to-one',
      target: FsmExecution,
    });
    expect(byProperty.flow).toEqual({ type: 'many-to-one', target: Workflow });
  });

  it('NO deberia heredar la auditoria: la telemetria es inmutable', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const entity = new TelemetriaTokensIa();

    // 3. Assert 🎯: nadie la edita, asi que `actualizado_por` no tiene sentido.
    expect(entity).not.toBeInstanceOf(AuditableEntity);
  });
});

describe('AuditableEntity', () => {
  it('deberia declarar las cuatro columnas de auditoria en castellano', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const columns = columnNamesOf(AuditableEntity);

    // 3. Assert 🎯
    expect(columns.sort()).toEqual(
      [
        'actualizado_por',
        'creado_por',
        'fecha_actualizacion',
        'fecha_creacion',
      ].sort(),
    );
  });
});
