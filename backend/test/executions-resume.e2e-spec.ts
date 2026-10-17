// ---------------------------------------------------------------------------
// AISLAMIENTO. Va ANTES de cualquier import de la aplicacion, y no es opcional.
//
// `ConfigModule` no sobrescribe lo que ya esta en `process.env`, asi que esto
// gana sobre `backend/.env`. Y hace falta ganar por dos motivos distintos:
//
// 1. El `.env` de desarrollo tiene los disparadores ENCENDIDOS. Montar
//    `AppModule` ejecuta sus `onModuleInit`, que programarian temporizadores
//    reales, abririan conexion contra el buzon corporativo y marcarian correos
//    como leidos. Una suite de pruebas no puede consumir la bandeja de nadie.
// 2. `FsmModule.onModuleInit` hace un `UPDATE ejecuciones_flujo SET
//    estado='PAUSADO' WHERE estado='EN_PROCESO'` SIN filtro por flujo. Contra
//    la base de desarrollo le arrancaria las ejecuciones vivas a cualquier
//    `npm run start:dev` que estuviera corriendo.
//
// Los dos guardas exigen literalmente `=== 'true'`, asi que cualquier otro
// valor los apaga.
// ---------------------------------------------------------------------------
process.env.IMAP_POLLING_ENABLED = 'false';
process.env.CRON_SCHEDULING_ENABLED = 'false';
process.env.DB_NAME = process.env.E2E_DB_NAME ?? '<nombre_bd_test>';

import { ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { generateDevJwt } from '@common/utils/dev-jwt.util';
import { FsmExecution } from '@core/fsm/entities/fsm-execution.entity';
import { SystemCapacityExceededException } from '@core/fsm/exceptions/system-capacity-exceeded.exception';
import { NodeStrategyFactory } from '@core/fsm/factories/node-strategy.factory';
import {
  buildDummySchema,
  DUMMY_INPUT_PARAMS,
  registerDummyStrategies,
} from '@core/fsm/scripts/dummy-pipeline.fixture';
import { FsmEngineService } from '@core/fsm/services/fsm-engine.service';
import { ExecutionState } from '@core/fsm/types/fsm.enums';
import { UserRole } from '@modules/users/enums/user-role.enum';

import { AppModule } from './../src/app.module';

import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types';
import type { Repository } from 'typeorm';

/** Arrancar Nest y conectar con PostgreSQL excede el timeout por defecto. */
const BOOTSTRAP_TIMEOUT_MS = 30_000;

/** Identidad del token de pruebas. `JwtStrategy` no consulta `usuarios`. */
const TEST_USER_ID = '00000000-0000-0000-0000-0000000000e2';

const E2E_FLOW_PREFIX = '[E2E CU-09]';

/** Nodo intermedio del esquema dummy: donde se simula la pausa. */
const PAUSED_NODE_ID = 'nodo_template';

/** Ruta ficticia del volcado, para comprobar que la reanudacion NO la borra. */
const SEEDED_LOG_PATH = 'logs/execution-2026-10-10.log';

const SEEDED_FAILURE_REASON = 'El nodo "nodo_template" fallo (GRAVE).';

/**
 * Namespace deliberadamente voluminoso.
 *
 * El listado omite `contexto_acumulado` justamente para no arrastrar esto en
 * cada fila. Con un payload de juguete la prueba pasaria igual sin demostrar
 * nada; con 64 KB, una regresion que lo reexpusiera se nota.
 */
const BULKY_CONTEXT = {
  // Los campos del fixture son obligatorios: el nodo en el que se reanuda
  // interpola `{{ raw_email.articulos[0].titulo }}`, de modo que un checkpoint
  // sembrado sin ellos no representaria un estado reanudable y la prueba
  // mediria un fallo de datos en lugar de la reanudacion.
  raw_email: {
    ...DUMMY_INPUT_PARAMS,
    asunto: 'Nota de prensa con adjunto',
    contentBase64: 'A'.repeat(64 * 1024),
  },
};

describe('CU-09 · reanudacion manual de ejecuciones (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let repository: Repository<FsmExecution>;
  let token: string;
  let creatorId: string;

  /** Flujos sembrados por esta suite, para borrarlos por id en el teardown. */
  const seededFlowIds: string[] = [];

  /**
   * Siembra un flujo con su esquema y una ejecucion en el estado pedido.
   *
   * No se reutiliza `seedDummyExecution` del fixture porque aquel deja
   * `configuracion_pipeline` a NULL, y la reanudacion necesita el esquema para
   * revalidarlo: sin el, todos los casos moririan en el mismo 400.
   */
  const seedPausedExecution = async (
    overrides: {
      activeCursor?: string;
      state?: ExecutionState;
    } = {},
  ): Promise<{ flowId: string; executionId: string }> => {
    const flows = await dataSource.query<Array<{ id_flujo: string }>>(
      // `status` y no `activo`: la migracion 040 sustituyo el booleano por el
      // enum triestatal y dejo caer la columna vieja. La suite seguia
      // insertando en ella, asi que fallaba contra cualquier base migrada —y
      // pasaba solo mientras la de pruebas se mantuvo desfasada a mano—.
      //
      // INACTIVO conserva la intencion del `FALSE` original: el flujo no debe
      // exponerse a los disparadores automaticos durante la prueba.
      `INSERT INTO flujos (nombre, descripcion, status, id_usuario_creador)
       VALUES ($1, $2, 'INACTIVO', $3)
       RETURNING id_flujo`,
      [
        `${E2E_FLOW_PREFIX} ${Date.now()}-${seededFlowIds.length}`,
        'Flujo sembrado por la suite de reanudacion manual.',
        creatorId,
      ],
    );

    const [{ id_flujo: flowId }] = flows;
    seededFlowIds.push(flowId);

    // El esquema se escribe despues del INSERT para poder interpolar el
    // `flowId` que acaba de generar la base.
    await dataSource.query(
      `UPDATE flujos SET configuracion_pipeline = $1 WHERE id_flujo = $2`,
      [JSON.stringify(buildDummySchema(flowId)), flowId],
    );

    const execution = await repository.save(
      repository.create({
        flowId,
        currentState: overrides.state ?? ExecutionState.PAUSADO,
        activeCursor: overrides.activeCursor ?? PAUSED_NODE_ID,
        contextPayload: BULKY_CONTEXT,
        retryState: { [PAUSED_NODE_ID]: 5 },
        logFilePath: SEEDED_LOG_PATH,
        failureReason: SEEDED_FAILURE_REASON,
      }),
    );

    return { flowId, executionId: execution.executionId };
  };

  const countExecutionsOf = async (flowId: string): Promise<number> => {
    const rows = await dataSource.query<Array<{ total: string }>>(
      `SELECT count(*)::text AS total FROM ejecuciones_flujo WHERE id_flujo = $1`,
      [flowId],
    );

    return Number(rows[0]?.total ?? '0');
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication<App>();

    // `AppModule` NO aplica ninguna de las dos: viven en `main.ts`. Sin
    // replicarlas, las rutas colgarian de la raiz en vez de `/api` y los DTO
    // no se validarian, de modo que la suite probaria una aplicacion que no es
    // la que se despliega.
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true }),
    );

    await app.init();

    dataSource = app.get(DataSource);
    repository = app.get<Repository<FsmExecution>>(
      getRepositoryToken(FsmExecution),
    );
    token = generateDevJwt(app.get(JwtService), {
      userId: TEST_USER_ID,
      role: UserRole.EDITOR,
    });

    // DESPUES de `init()`: `registerStrategy` sustituye ante un duplicado, asi
    // que estas tres pisan a las diez reales que `NodesModule.onModuleInit`
    // acaba de inscribir. Es lo que evita que la reanudacion salga a la red.
    registerDummyStrategies(app.get(NodeStrategyFactory));

    const admins = await dataSource.query<Array<{ id_usuario: string }>>(
      `SELECT id_usuario FROM usuarios WHERE rol = 'ADMIN' AND activo = TRUE LIMIT 1`,
    );

    if (admins.length === 0) {
      throw new Error(
        'No hay ningun usuario ADMIN activo en la base de pruebas: aplica db/migrations/002-bootstrap-admin.sql.',
      );
    }

    creatorId = admins[0].id_usuario;
  }, BOOTSTRAP_TIMEOUT_MS);

  afterAll(async () => {
    if (seededFlowIds.length > 0) {
      // Borrado POR ID, nunca por patron de nombre ni TRUNCATE: si alguien
      // lanza la suite contra la base de desarrollo, un filtro amplio
      // arrasaria datos ajenos. `ejecuciones_flujo` cae en cascada.
      await dataSource.query(`DELETE FROM flujos WHERE id_flujo = ANY($1)`, [
        seededFlowIds,
      ]);
    }

    // Sin cerrar, Jest queda colgado del pool de conexiones de TypeORM.
    await app.close();
  });

  describe('1. Listado', () => {
    it('1.1 deberia devolver la ejecucion pausada SIN el contexto acumulado', async () => {
      // 1. Arrange
      const { executionId } = await seedPausedExecution();

      // 2. Act
      const response = await request(app.getHttpServer())
        .get('/api/executions')
        .query({ state: ExecutionState.PAUSADO, limit: 10 })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      // 3. Assert
      const body = response.body as {
        items: Array<Record<string, unknown>>;
        total: number;
        limit: number;
        offset: number;
      };

      const seeded = body.items.find(
        (item) => item.executionId === executionId,
      );

      expect(seeded).toBeDefined();
      expect(seeded?.logFilePath).toBe(SEEDED_LOG_PATH);
      expect(seeded?.activeCursor).toBe(PAUSED_NODE_ID);

      // LA ASERCION QUE IMPORTA. El `select` explicito del servicio de consulta
      // existe para que un listado de cincuenta filas no arrastre cincuenta
      // correos en base64.
      expect(seeded).not.toHaveProperty('context');
      expect(seeded).not.toHaveProperty('contextPayload');
      expect(JSON.stringify(body)).not.toContain('contentBase64');

      expect(body.limit).toBe(10);
      expect(body.offset).toBe(0);
      expect(body.total).toBeGreaterThanOrEqual(1);
    });

    it('1.2 deberia rechazar un filtro invalido con 400', async () => {
      // 1. Arrange & 2. Act & 3. Assert: el query-DTO valida en la frontera, de
      //    modo que un limite absurdo no llega al `take` de TypeORM.
      await request(app.getHttpServer())
        .get('/api/executions')
        .query({ limit: 99999 })
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
    });
  });

  describe('2. Detalle', () => {
    it('2.1 deberia devolver el contexto acumulado y el cursor', async () => {
      // 1. Arrange
      const { executionId } = await seedPausedExecution();

      // 2. Act
      const response = await request(app.getHttpServer())
        .get(`/api/executions/${executionId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      // 3. Assert: aqui el contexto SI es el dato pedido, y va una fila por
      //    peticion en vez de cincuenta.
      const body = response.body as {
        activeCursor: string;
        context: Record<string, Record<string, unknown>>;
        retryState: Record<string, unknown>;
      };

      expect(body.activeCursor).toBe(PAUSED_NODE_ID);
      expect(body.context.raw_email?.asunto).toBe('Nota de prensa con adjunto');
      expect(body.retryState).toEqual({ [PAUSED_NODE_ID]: 5 });
    });
  });

  describe('3. Reanudacion', () => {
    it(
      '3.1 deberia reanudar sobre la MISMA fila, limpiar el motivo y conservar la ruta del log',
      async () => {
        // 1. Arrange
        const { flowId, executionId } = await seedPausedExecution();
        const executionsBefore = await countExecutionsOf(flowId);

        // 2. Act
        const response = await request(app.getHttpServer())
          .post(`/api/executions/${executionId}/resume`)
          .set('Authorization', `Bearer ${token}`)
          .send({})
          .expect(200);

        // 3. Assert: forma de `WorkflowExecutionResponseDto`
        const body = response.body as {
          executionId: string;
          workflowId: string;
          status: ExecutionState;
          activeCursor: string | null;
          context: Record<string, unknown>;
        };

        expect(body.executionId).toBe(executionId);
        expect(body.workflowId).toBe(flowId);
        expect(body.status).toBe(ExecutionState.EXITOSO);
        expect(body.activeCursor).toBeNull();

        // Y en la base: ni una fila nueva. Es la propiedad que define CU-09.
        expect(await countExecutionsOf(flowId)).toBe(executionsBefore);

        const [persisted] = await dataSource.query<
          Array<{
            motivo_fallo: string | null;
            ruta_archivo_log: string | null;
          }>
        >(
          `SELECT motivo_fallo, ruta_archivo_log FROM ejecuciones_flujo WHERE id_ejecucion = $1`,
          [executionId],
        );

        // El motivo describia un cierre que ya no es el estado de la fila.
        expect(persisted.motivo_fallo).toBeNull();
        // La ruta, en cambio, es el rastro de por que hubo que reanudar.
        expect(persisted.ruta_archivo_log).toBe(SEEDED_LOG_PATH);
      },
      BOOTSTRAP_TIMEOUT_MS,
    );

    it('3.2 deberia responder 409 al reanudar una ejecucion que ya no esta PAUSADO', async () => {
      // 1. Arrange: el mismo escenario del caso anterior, reanudado dos veces.
      const { executionId } = await seedPausedExecution();

      await request(app.getHttpServer())
        .post(`/api/executions/${executionId}/resume`)
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(200);

      // 2. Act & 3. Assert: la segunda llamada encuentra la fila EXITOSO.
      await request(app.getHttpServer())
        .post(`/api/executions/${executionId}/resume`)
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(409);
    });

    it('3.3 deberia responder 400 si el nodo del cursor no existe en el esquema', async () => {
      // 1. Arrange: simula un flujo editado mientras la ejecucion estaba
      //    pausada. Sin esta guarda, el motor volveria a pausar en el mismo
      //    sitio y la respuesta seria un 200 que no ha hecho nada.
      const { executionId } = await seedPausedExecution({
        activeCursor: 'nodo_que_ya_no_existe',
      });

      // 2. Act & 3. Assert
      await request(app.getHttpServer())
        .post(`/api/executions/${executionId}/resume`)
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(400);
    });

    it('3.4 deberia responder 404 si la ejecucion no existe', async () => {
      // 1. Arrange & 2. Act & 3. Assert
      await request(app.getHttpServer())
        .post('/api/executions/3f2504e0-4f89-41d3-9a0c-0305e82c3301/resume')
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(404);
    });
  });

  describe('4. Contrapresion y perimetro', () => {
    it('4.1 deberia responder 429 cuando el motor esta saturado', async () => {
      // 1. Arrange: reanudar entra al motor por `executeWorkflow` y no por
      //    `createExecution`, asi que sin la llamada explicita a la guarda cada
      //    reintento manual sumaria una ejecucion por encima del techo global.
      //
      //    Se espia el metodo PUBLICO, sin `as any`: es publico precisamente
      //    porque este camino tiene que poder invocarlo.
      const { executionId } = await seedPausedExecution();
      const engine = app.get(FsmEngineService);
      const guard = jest
        .spyOn(engine, 'assertGlobalCapacityAvailable')
        .mockRejectedValue(new SystemCapacityExceededException(5, 5));

      try {
        // 2. Act & 3. Assert
        await request(app.getHttpServer())
          .post(`/api/executions/${executionId}/resume`)
          .set('Authorization', `Bearer ${token}`)
          .send({})
          .expect(429);

        // La fila no se toca: el motivo sigue ahi porque `prepareResume` no
        // llego a correr.
        const [persisted] = await dataSource.query<
          Array<{ estado: string; motivo_fallo: string | null }>
        >(
          `SELECT estado, motivo_fallo FROM ejecuciones_flujo WHERE id_ejecucion = $1`,
          [executionId],
        );

        expect(persisted.estado).toBe(ExecutionState.PAUSADO);
        expect(persisted.motivo_fallo).toBe(SEEDED_FAILURE_REASON);
      } finally {
        guard.mockRestore();
      }
    });

    it('4.2 deberia responder 401 sin token en las tres rutas', async () => {
      // 1. Arrange: los guards se declaran a nivel de clase justamente para que
      //    ningun endpoint quede desprotegido por olvido.
      const server = app.getHttpServer();

      // 2. Act & 3. Assert
      await request(server).get('/api/executions').expect(401);
      await request(server)
        .get('/api/executions/3f2504e0-4f89-41d3-9a0c-0305e82c3301')
        .expect(401);
      await request(server)
        .post('/api/executions/3f2504e0-4f89-41d3-9a0c-0305e82c3301/resume')
        .send({})
        .expect(401);
    });
  });
});
