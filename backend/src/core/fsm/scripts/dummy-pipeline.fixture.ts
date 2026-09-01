import { DummyInputStrategy } from '@core/fsm/strategies/dummies/dummy-input.strategy';
import { DummyLogDispatcherStrategy } from '@core/fsm/strategies/dummies/local-log-dispatcher.strategy';
import { DummyTemplateMapperStrategy } from '@core/fsm/strategies/dummies/template-mapper.strategy';
import { ExecutionState } from '@core/fsm/types/fsm.enums';
import { NodeType } from '@core/fsm/types/pipeline-schema.types';

import type { PipelineSchemaDto } from '@core/fsm/dto/pipeline-schema.dto';
import type { FsmExecution } from '@core/fsm/entities/fsm-execution.entity';
import type { NodeStrategyFactory } from '@core/fsm/factories/node-strategy.factory';
import type { DataSource, Repository } from 'typeorm';

/**
 * Andamiaje compartido por el runner manual y la suite e2e.
 *
 * Vive bajo `scripts/` para quedar excluido de `tsconfig.build.json` junto al
 * resto del andamiaje: nada de esto debe viajar a `dist/`.
 */

/** Marca con la que se identifican las filas creadas por las pruebas. */
export const E2E_FLOW_NAME = '[E2E] Pipeline dummy';

/** Datos que el nodo de entrada inyecta en el contexto. */
export const DUMMY_INPUT_PARAMS: Record<string, unknown> = {
  remitente: 'prensa@unuware.com',
  articulos: [
    { titulo: 'Innovacion en Madrid', score: 9 },
    { titulo: 'Segunda noticia', score: 4 },
  ],
};

/**
 * Plantilla del nodo mapeador. Combina a proposito una ruta compuesta con indice
 * de arreglo y otra simple, para que el e2e ejercite ambas gramaticas del
 * resolutor de PROT-10 sobre datos que ya pasaron por el checkpoint.
 */
export const DUMMY_TEMPLATE =
  'Noticia: {{ input_data.articulos[0].titulo }} | remitente: {{ input_data.remitente }}';

/** Resultado exacto que debe producir la interpolacion de `DUMMY_TEMPLATE`. */
export const EXPECTED_COMPILED_TEXT =
  'Noticia: Innovacion en Madrid | remitente: prensa@unuware.com';

/**
 * Pipeline lineal de 3 nodos.
 *
 * Usa `NodeType` reales en lugar de tipos inventados, de modo que el esquema
 * sigue siendo validable por `PipelineValidatorService` y las estrategias dummy
 * ocupan exactamente el hueco que tomaran las definitivas.
 */
export const DUMMY_SCHEMA: PipelineSchemaDto = {
  flowId: 'se-sustituye-en-tiempo-de-ejecucion',
  name: 'Pipeline dummy de verificacion e2e',
  version: '1.0.0',
  entrypoint: 'nodo_input',
  nodes: {
    nodo_input: {
      nodeId: 'nodo_input',
      nodeType: NodeType.TRIGGER_IMAP,
      outputNamespace: 'input_data',
      nextStep: 'nodo_template',
      onErrorStep: null,
      params: DUMMY_INPUT_PARAMS,
    },
    nodo_template: {
      nodeId: 'nodo_template',
      nodeType: NodeType.MAPEADOR_PLANTILLA,
      outputNamespace: 'rendered_message',
      nextStep: 'nodo_dispatch',
      onErrorStep: null,
      params: { template: DUMMY_TEMPLATE },
    },
    nodo_dispatch: {
      nodeId: 'nodo_dispatch',
      nodeType: NodeType.DESTINO_HTTP,
      outputNamespace: 'dispatch_result',
      nextStep: null,
      onErrorStep: null,
      params: {},
    },
  },
};

/** Namespaces que el pipeline debe haber dejado en `contexto_acumulado`. */
export const EXPECTED_NAMESPACES = [
  'input_data',
  'rendered_message',
  'dispatch_result',
] as const;

/** Devuelve el esquema apuntando al flujo recien sembrado. */
export const buildDummySchema = (flowId: string): PipelineSchemaDto => ({
  ...DUMMY_SCHEMA,
  flowId,
});

/**
 * Inscribe las tres estrategias de andamiaje en la factoria.
 *
 * Se instancian con `new` y no via inyeccion porque no estan declaradas en
 * ningun modulo: `FsmModule` no puede referenciarlas sin romper `nest build`,
 * que las excluye de la compilacion.
 */
export const registerDummyStrategies = (factory: NodeStrategyFactory): void => {
  factory.registerStrategy(new DummyInputStrategy());
  factory.registerStrategy(new DummyTemplateMapperStrategy());
  factory.registerStrategy(new DummyLogDispatcherStrategy());
};

/** Identificadores de la fila sembrada para una corrida. */
export interface SeededExecution {
  flowId: string;
  executionId: string;
}

/**
 * Siembra el flujo y la ejecucion necesarios para arrancar el motor.
 *
 * `ejecuciones_flujo.id_flujo` es clave foranea a `flujos`, y `flujos` exige a su
 * vez un `id_usuario_creador` existente: sin esta cadena, insertar con un UUID
 * aleatorio fallaria con violacion de integridad referencial. Se reutiliza el
 * primer ADMIN activo en lugar de crear usuarios de prueba.
 *
 * `flujos` no tiene entidad TypeORM todavia, de ahi el SQL directo.
 */
export const seedDummyExecution = async (
  dataSource: DataSource,
  repository: Repository<FsmExecution>,
): Promise<SeededExecution> => {
  const admins = await dataSource.query<Array<{ id_usuario: string }>>(
    `SELECT id_usuario FROM usuarios WHERE rol = 'ADMIN' AND activo = TRUE LIMIT 1`,
  );

  if (admins.length === 0) {
    throw new Error(
      'No hay ningun usuario ADMIN activo: aplica db/migrations/002-bootstrap-admin.sql.',
    );
  }

  const [{ id_usuario: creatorId }] = admins;

  const flows = await dataSource.query<Array<{ id_flujo: string }>>(
    `INSERT INTO flujos (nombre, descripcion, id_usuario_creador)
     VALUES ($1, $2, $3)
     RETURNING id_flujo`,
    [
      E2E_FLOW_NAME,
      'Flujo sembrado por el runner de verificacion del motor FSM.',
      creatorId,
    ],
  );

  const [{ id_flujo: flowId }] = flows;

  const execution = await repository.save(
    repository.create({
      flowId,
      currentState: ExecutionState.INACTIVO,
      activeCursor: null,
      contextPayload: {},
      retryState: {},
    }),
  );

  return { flowId, executionId: execution.executionId };
};
