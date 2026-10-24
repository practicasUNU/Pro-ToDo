// ---------------------------------------------------------------------------
// AISLAMIENTO. Va ANTES de cualquier import de la aplicacion, y no es opcional:
// `ConfigModule` no sobrescribe lo que ya esta en `process.env`, asi que esto
// gana sobre `backend/.env`.
//
// Esta suite NO lo tenia: `npm run test:e2e` arrancaba el `AppModule` contra
// la base de DESARROLLO, con el sondeo IMAP, la reanudacion por correo y el
// cron del `.env` encendidos. Cada pasada dejaba un "[E2E] Pipeline dummy" mas
// en la base real (habia catorce) y abria el buzon corporativo. Detectado al
// preparar la purga de datos de prueba (GUIA_PRUEBAS_MALA_LECHE.md §8).
// ---------------------------------------------------------------------------
process.env.IMAP_POLLING_ENABLED = 'false';
process.env.CRON_SCHEDULING_ENABLED = 'false';
process.env.INBOUND_RESUME_ENABLED = 'false';
process.env.DB_NAME = process.env.E2E_DB_NAME ?? '<nombre_bd_test>';

import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { FsmExecution } from '@core/fsm/entities/fsm-execution.entity';
import { NodeStrategyFactory } from '@core/fsm/factories/node-strategy.factory';
import {
  buildDummySchema,
  EXPECTED_COMPILED_TEXT,
  EXPECTED_NAMESPACES,
  registerDummyStrategies,
  seedDummyExecution,
} from '@core/fsm/scripts/dummy-pipeline.fixture';
import { FsmEngineService } from '@core/fsm/services/fsm-engine.service';
import { PipelineValidatorService } from '@core/fsm/services/pipeline-validator.service';
import { ExecutionState } from '@core/fsm/types/fsm.enums';

import { AppModule } from './../src/app.module';

import type { TestingModule } from '@nestjs/testing';
import type { Repository } from 'typeorm';

/** Arrancar Nest y conectar con PostgreSQL excede el timeout por defecto. */
const BOOTSTRAP_TIMEOUT_MS = 30_000;

/**
 * Verificacion de integracion del motor FSM contra PostgreSQL real.
 *
 * A diferencia de `fsm-engine.service.spec.ts`, que mockea el repositorio, aqui
 * se ejercita la cadena completa: AppModule -> FsmModule -> FsmEngineService ->
 * StatePayloadContext -> ejecuciones_flujo. Lo que se asevera es lo que quedo
 * ESCRITO en la base, no lo que el motor creia haber escrito.
 *
 * Las filas sembradas se conservan a proposito para poder inspeccionarlas
 * despues con psql.
 */
describe('FsmEngineService (integracion con PostgreSQL)', () => {
  let moduleRef: TestingModule;
  let repository: Repository<FsmExecution>;
  let dataSource: DataSource;
  let executionId: string;
  let flowId: string;
  let result: FsmExecution;

  beforeAll(async () => {
    // 1. Arrange: contexto real de Nest, con lifecycle hooks incluidos
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    await moduleRef.init();

    repository = moduleRef.get<Repository<FsmExecution>>(
      getRepositoryToken(FsmExecution),
    );
    dataSource = moduleRef.get(DataSource);

    registerDummyStrategies(moduleRef.get(NodeStrategyFactory));

    const seeded = await seedDummyExecution(dataSource, repository);
    flowId = seeded.flowId;
    executionId = seeded.executionId;

    // 2. Act: una sola ejecucion, sobre la que asevera todo el bloque
    result = await moduleRef
      .get(FsmEngineService)
      .executeWorkflow(executionId, buildDummySchema(flowId));
  }, BOOTSTRAP_TIMEOUT_MS);

  afterAll(async () => {
    // Sin cerrar, Jest queda colgado del pool de conexiones de TypeORM.
    await moduleRef.close();
  });

  it('deberia aceptar el esquema dummy como pipeline valido', async () => {
    // 1. Arrange: las estrategias dummy usan NodeType reales, asi que el
    // esquema sigue siendo validable por el contrato de PROT-07
    const validator = moduleRef.get(PipelineValidatorService);

    // 2. Act
    const validated = await validator.validateSchema(buildDummySchema(flowId));

    // 3. Assert
    expect(Object.keys(validated.nodes)).toHaveLength(3);
    expect(validated.entrypoint).toBe('nodo_input');
  });

  it('deberia completar el flujo devolviendo EXITOSO con el cursor nulo', () => {
    // 3. Assert
    expect(result.currentState).toBe(ExecutionState.EXITOSO);
    expect(result.activeCursor).toBeNull();
  });

  it('deberia persistir los tres namespaces en contexto_acumulado', async () => {
    // 2. Act: se relee de la base, no se reutiliza la instancia en memoria
    const persisted = await repository.findOne({ where: { executionId } });

    // 3. Assert
    expect(persisted).not.toBeNull();
    expect(Object.keys(persisted?.contextPayload ?? {}).sort()).toEqual(
      [...EXPECTED_NAMESPACES].sort(),
    );
    expect(persisted?.retryState).toEqual({});
  });

  it('deberia haber interpolado la plantilla contra el contexto acumulado', async () => {
    // 2. Act
    const persisted = await repository.findOne({ where: { executionId } });
    const rendered = persisted?.contextPayload.rendered_html;

    // 3. Assert: incluye la ruta compuesta con indice de arreglo de PROT-10,
    // resuelta sobre datos que pasaron por structuredClone y por el checkpoint
    expect(rendered?.compiled_text).toBe(EXPECTED_COMPILED_TEXT);
  });

  it('deberia dejar el estado terminal escrito en la tabla', async () => {
    // 2. Act: SQL directo, al margen del mapeo de TypeORM
    const rows = await dataSource.query<
      Array<{ estado: string; paso_actual: string | null; nombre: string }>
    >(
      `SELECT e.estado, e.paso_actual, f.nombre
         FROM ejecuciones_flujo e
         JOIN flujos f ON f.id_flujo = e.id_flujo
        WHERE e.id_ejecucion = $1`,
      [executionId],
    );

    // 3. Assert
    expect(rows).toHaveLength(1);
    expect(rows[0].estado).toBe('EXITOSO');
    expect(rows[0].paso_actual).toBeNull();
    expect(rows[0].nombre).toContain('[E2E]');
  });

  it('deberia registrar la salida del nodo despachador', async () => {
    // 2. Act
    const persisted = await repository.findOne({ where: { executionId } });
    const dispatch = persisted?.contextPayload.http_result;

    // 3. Assert
    expect(dispatch?.status).toBe('SUCCESS');
    expect(typeof dispatch?.loggedAt).toBe('string');
  });
});
