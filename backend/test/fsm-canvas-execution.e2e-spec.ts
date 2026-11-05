// ---------------------------------------------------------------------------
// AISLAMIENTO. Va ANTES de cualquier import de la aplicacion, y no es opcional.
//
// Mismo preambulo que `executions-resume.e2e-spec.ts`, y por los mismos dos
// motivos: montar `AppModule` ejecuta los `onModuleInit`, que con el `.env` de
// desarrollo abririan el buzon corporativo real y marcarian correos como
// leidos; y `FsmModule.onModuleInit` arrastra a PAUSADO todas las ejecuciones
// EN_PROCESO sin filtrar por flujo, lo que le arrancaria las suyas a cualquier
// `npm run start:dev` que estuviera corriendo contra la base de desarrollo.
//
// Se apaga ademas el canal de ordenes por correo: esta suite lo ejercita
// invocando el servicio a mano, nunca leyendo un buzon de verdad.
// ---------------------------------------------------------------------------
process.env.IMAP_POLLING_ENABLED = 'false';
process.env.CRON_SCHEDULING_ENABLED = 'false';
process.env.INBOUND_RESUME_ENABLED = 'false';
// La base sale de `DB_NAME` del entorno y la valida `test/helpers/e2e-database.guard.ts`
// (cargado por `setupFiles`) antes de este archivo: nada de nombres escritos aqui.

import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { io } from 'socket.io-client';
import { DataSource } from 'typeorm';

import { createGlobalValidationPipe } from '@common/pipes/global-validation.pipe';
import { FlowPollingCoordinator } from '@common/services/flow-polling.coordinator';
import { FsmExecution } from '@core/fsm/entities/fsm-execution.entity';
import { NodeStrategyFactory } from '@core/fsm/factories/node-strategy.factory';
import {
  buildDummySchema,
  registerDummyStrategies,
} from '@core/fsm/scripts/dummy-pipeline.fixture';
import { ExecutionState } from '@core/fsm/types/fsm.enums';
import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { ExecutionsService } from '@modules/workflows/executions.service';
import { InboundEmailResumeService } from '@modules/workflows/inbound-email-resume.service';
import { UserRole } from '@modules/users/enums/user-role.enum';
import { WorkflowsService } from '@modules/workflows/workflows.service';

import { AppModule } from './../src/app.module';
import {
  E2E_SLOTS,
  e2eEditor,
  ensureE2eUser,
  removeE2eUsers,
  signFor,
} from './helpers/e2e-users.helper';

import type { INestApplication } from '@nestjs/common';
import type { PipelineSchemaDto } from '@core/fsm/dto/pipeline-schema.dto';
import type { Socket } from 'socket.io-client';
import type { App } from 'supertest/types';
import type { Repository } from 'typeorm';

/** EDITOR propio de esta suite (ver `e2eEditor`). */
const E2E_EDITOR = e2eEditor(E2E_SLOTS.CANVAS, 'editor-canvas');

/** Arrancar Nest y conectar con PostgreSQL excede el timeout por defecto. */
const BOOTSTRAP_TIMEOUT_MS = 30_000;

/** Margen para que un evento viaje por el canal antes de darlo por perdido. */
const EVENT_TIMEOUT_MS = 10_000;

/** Holgura por caso: cada uno arranca el motor contra PostgreSQL real. */
const CASE_TIMEOUT_MS = 30_000;

const E2E_FLOW_PREFIX = '[E2E canvas]';

const PAUSE_NODE_ID = 'pausa_revision';
const RESUME_NODE_ID = 'nodo_dispatch';
const FIRST_NODE_ID = 'nodo_input';

/** Remitente de la orden que llega por correo, para el aviso del canal. */
const INBOUND_SENDER = 'editor@unuware.com';

/**
 * Pipeline con un `PAUSA_FLOW` en medio.
 *
 * Los nodos de los extremos son los de andamiaje, cuyas estrategias se
 * sustituyen por dobles para que el pipeline no salga a la red. El de pausa va
 * con la estrategia REAL: es justo lo que se esta probando, y no toca nada
 * fuera del proceso mientras no se le pida avisar por correo.
 */
const buildPauseSchema = (flowId: string): PipelineSchemaDto => ({
  flowId,
  name: 'Pipeline con pausa programada',
  version: '1.0.0',
  entrypoint: FIRST_NODE_ID,
  nodes: {
    [FIRST_NODE_ID]: {
      nodeId: FIRST_NODE_ID,
      nodeType: NodeType.TRIGGER_IMAP,
      outputNamespace: 'raw_email',
      nextStep: PAUSE_NODE_ID,
      onErrorStep: null,
      params: {},
    },
    [PAUSE_NODE_ID]: {
      nodeId: PAUSE_NODE_ID,
      nodeType: NodeType.PAUSA_FLOW,
      outputNamespace: 'pause_context',
      nextStep: RESUME_NODE_ID,
      onErrorStep: null,
      params: { pauseMode: 'IMMEDIATE' },
    },
    [RESUME_NODE_ID]: {
      nodeId: RESUME_NODE_ID,
      nodeType: NodeType.DESTINO_DRUPAL,
      outputNamespace: 'http_result',
      nextStep: null,
      onErrorStep: null,
      params: {},
    },
  },
});

describe('Canvas FSM · pausa, reanudacion y descarte (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let repository: Repository<FsmExecution>;
  let token: string;
  let creatorId: string;
  let baseUrl: string;

  const seededFlowIds: string[] = [];
  const openSockets: Socket[] = [];

  /** Siembra un flujo ACTIVO con el esquema de pausa. */
  const seedFlow = async (): Promise<string> => {
    const flows = await dataSource.query<Array<{ id_flujo: string }>>(
      `INSERT INTO flujos (nombre, descripcion, status, id_usuario_creador)
       VALUES ($1, $2, 'ACTIVO', $3)
       RETURNING id_flujo`,
      [
        `${E2E_FLOW_PREFIX} ${Date.now()}-${seededFlowIds.length}`,
        'Flujo sembrado por la suite del canvas.',
        creatorId,
      ],
    );

    const [{ id_flujo: flowId }] = flows;
    seededFlowIds.push(flowId);

    await dataSource.query(
      `UPDATE flujos SET configuracion_pipeline = $1 WHERE id_flujo = $2`,
      [JSON.stringify(buildPauseSchema(flowId)), flowId],
    );

    return flowId;
  };

  /** Ejecucion lista para arrancar desde el principio. */
  const seedExecution = async (
    flowId: string,
    cursor: string = FIRST_NODE_ID,
  ): Promise<string> => {
    const execution = await repository.save(
      repository.create({
        flowId,
        // PAUSADO y no INACTIVO. `POST /executions/:id/resume` exige PAUSADO y
        // devuelve 409 con cualquier otro estado —una guarda deliberada: solo
        // una ejecucion detenida tiene desde donde retomarse—, asi que sembrar
        // INACTIVO hacia que los siete casos que reanudan fallaran en su
        // primera peticion, antes de ejercitar nada de lo que vienen a probar.
        currentState: ExecutionState.PAUSADO,
        activeCursor: cursor,
        contextPayload: {},
        retryState: {},
      }),
    );

    return execution.executionId;
  };

  /**
   * Cliente de socket ya dentro de la sala del flujo.
   *
   * El `path` y el namespace son los del gateway: `setGlobalPrefix` no alcanza
   * al adaptador de Socket.io, asi que el canal no cuelga de `/api` por si solo.
   */
  const joinFlowRoom = async (flowId: string): Promise<Socket> => {
    const socket = io(`${baseUrl}/events`, {
      path: '/api/socket.io',
      auth: { token },
      transports: ['websocket'],
      forceNew: true,
    });

    openSockets.push(socket);

    await new Promise<void>((resolve, reject) => {
      socket.on('connect', () => {
        resolve();
      });
      socket.on('connect_error', (error: Error) => {
        reject(error);
      });
    });

    await new Promise<void>((resolve, reject) => {
      socket.emit('flow:subscribe', { flowId }, (ack: { ok: boolean }) => {
        if (ack.ok) {
          resolve();

          return;
        }

        reject(new Error('El gateway denego la sala del flujo.'));
      });
    });

    return socket;
  };

  /** Espera UN evento del canal, o falla con un mensaje util. */
  const waitForEvent = <T>(socket: Socket, name: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(`El evento "${name}" no llego en ${EVENT_TIMEOUT_MS} ms.`),
        );
      }, EVENT_TIMEOUT_MS);

      socket.once(name, (payload: T) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });

  /**
   * El servidor HTTP ya tipado para `supertest`.
   *
   * `getHttpServer()` devuelve `any`, de modo que pasarlo directo en cada
   * llamada esparce una docena de afirmaciones de tipo por el archivo. Se
   * concentra en un sitio.
   */
  const httpServer = (): App => app.getHttpServer() as App;

  const readExecution = async (executionId: string): Promise<FsmExecution> => {
    const found = await repository.findOne({ where: { executionId } });

    if (found === null) {
      throw new Error(`La ejecucion ${executionId} desaparecio de la tabla.`);
    }

    return found;
  };

  const readWorkflowStatus = async (flowId: string): Promise<string> => {
    const rows = await dataSource.query<Array<{ status: string }>>(
      `SELECT status FROM flujos WHERE id_flujo = $1`,
      [flowId],
    );

    return rows[0]?.status ?? '';
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(createGlobalValidationPipe());

    // `listen(0)` y no `init()`: esta suite necesita un puerto real al que
    // pueda conectarse el cliente de sockets, y el cero deja que el sistema
    // elija uno libre para no chocar con un backend en marcha.
    await app.listen(0);

    const server = app.getHttpServer() as {
      address: () => { port: number };
    };
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    dataSource = app.get(DataSource);
    repository = app.get<Repository<FsmExecution>>(
      getRepositoryToken(FsmExecution),
    );
    // Un EDITOR REAL: desde la 051 `JwtStrategy` consulta `usuarios`, y un
    // token firmado para un id inventado recibiria un 401 en cada peticion.
    await ensureE2eUser(dataSource, E2E_EDITOR);
    token = await signFor(app.get(JwtService), dataSource, E2E_EDITOR);

    // DESPUES de `init`: pisan a las reales que `NodesModule` acaba de
    // inscribir, salvo la de pausa, que no esta entre las tres dobles.
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
    for (const socket of openSockets) {
      socket.disconnect();
    }

    if (seededFlowIds.length > 0) {
      // Borrado POR ID, nunca por patron ni TRUNCATE: si alguien lanza la
      // suite contra la base de desarrollo, un filtro amplio arrasaria datos
      // ajenos. `ejecuciones_flujo` y `logs_nodo` caen en cascada.
      await dataSource.query(`DELETE FROM flujos WHERE id_flujo = ANY($1)`, [
        seededFlowIds,
      ]);
    }

    await removeE2eUsers(dataSource, [E2E_EDITOR]);
    await app.close();
  });

  describe('1. Ciclo de vida de una pausa programada', () => {
    it(
      '1.1 deberia detener flujo y ejecucion, y senalar el NODO DE PAUSA',
      async () => {
        // 1. Arrange 📐
        const flowId = await seedFlow();
        const executionId = await seedExecution(flowId);
        const socket = await joinFlowRoom(flowId);
        const paused = waitForEvent<Record<string, unknown>>(
          socket,
          'flow:paused',
        );

        // 2. Act ⚙️: el motor recorre el pipeline hasta toparse con la pausa.
        await request(httpServer())
          .post(`/api/executions/${executionId}/resume`)
          .set('Authorization', `Bearer ${token}`)
          .send({})
          .expect(200);

        const event = await paused;
        const execution = await readExecution(executionId);

        // 3. Assert 🎯
        expect(execution.currentState).toBe(ExecutionState.PAUSADO);
        expect(await readWorkflowStatus(flowId)).toBe('PAUSADO');

        // EL PUNTO DE LA PRUEBA: el evento senala el nodo de pausa y NO el
        // cursor. El cursor apunta al paso siguiente —reanudar entrando otra
        // vez en la pausa seria un bucle—, asi que sin esta distincion la
        // interfaz marcaria como detenido un nodo que nunca arranco.
        expect(event.pausedStepId).toBe(PAUSE_NODE_ID);
        expect(event.activeCursor).toBe(RESUME_NODE_ID);
        expect(event.isProgrammedPause).toBe(true);
        expect(event.severity).toBeUndefined();
      },
      EVENT_TIMEOUT_MS * 2,
    );

    it('1.2 deberia dejar la topologia de la pausa en el contexto', async () => {
      // 1. Arrange 📐: es lo que permite reconstruir la pausa al recargar la
      //    pagina, cuando ya no hay evento que escuchar.
      const flowId = await seedFlow();
      const executionId = await seedExecution(flowId);

      // 2. Act ⚙️
      await request(httpServer())
        .post(`/api/executions/${executionId}/resume`)
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(200);

      const execution = await readExecution(executionId);
      const pauseContext = execution.contextPayload.pause_context;

      // 3. Assert 🎯
      expect(pauseContext).toMatchObject({
        pausedAtStepId: PAUSE_NODE_ID,
        resumeStepId: RESUME_NODE_ID,
        shouldPause: true,
      });
    });

    it('1.3 deberia registrar el paso de pausa en logs_nodo', async () => {
      // 1. Arrange 📐: una pausa deliberada es trabajo HECHO, no una
      //    incidencia; la fila tiene que decirlo.
      const flowId = await seedFlow();
      const executionId = await seedExecution(flowId);

      // 2. Act ⚙️
      await request(httpServer())
        .post(`/api/executions/${executionId}/resume`)
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(200);

      const rows = await dataSource.query<
        Array<{ estado_nodo: string; tipo_nodo: string }>
      >(
        `SELECT estado_nodo, tipo_nodo FROM logs_nodo
          WHERE id_ejecucion = $1 AND id_nodo = $2`,
        [executionId, PAUSE_NODE_ID],
      );

      // 3. Assert 🎯
      expect(rows).toHaveLength(1);
      expect(rows[0]?.estado_nodo).toBe('OK');
      expect(rows[0]?.tipo_nodo).toBe(NodeType.PAUSA_FLOW);
    });
  });

  describe('2. Reanudacion manual con retroceso de cursor', () => {
    it(
      '2.1 deberia retomar desde un paso anterior y terminar EXITOSO',
      async () => {
        // 1. Arrange 📐: la ejecucion quedo con el cursor en `nodo_dispatch`;
        //    el operador elige volver al primero, que ya corrio.
        const flowId = await seedFlow();
        const executionId = await seedExecution(flowId);

        await request(httpServer())
          .post(`/api/executions/${executionId}/resume`)
          .set('Authorization', `Bearer ${token}`)
          .send({})
          .expect(200);

        const socket = await joinFlowRoom(flowId);
        const resumed = waitForEvent<Record<string, unknown>>(
          socket,
          'flow:resumed',
        );

        // 2. Act ⚙️
        const response = await request(httpServer())
          .post(`/api/executions/${executionId}/resume`)
          .set('Authorization', `Bearer ${token}`)
          .send({ targetStepId: FIRST_NODE_ID })
          .expect(200);

        const event = await resumed;

        // 3. Assert 🎯: vuelve a pasar por la pausa, asi que acaba PAUSADO otra
        //    vez. Lo que se comprueba es que el cursor retrocedio de verdad.
        expect(event.targetStepId).toBe(FIRST_NODE_ID);
        expect(event.previousCursor).toBe(RESUME_NODE_ID);
        expect(response.body).toHaveProperty('executionId', executionId);
      },
      EVENT_TIMEOUT_MS * 2,
    );

    it('2.2 deberia dejar una fila ADVERTENCIA de demarcacion', async () => {
      // 1. Arrange 📐: reanudar NO borra las filas del intento anterior —son la
      //    evidencia que CU-09 existe para conservar—, asi que hace falta algo
      //    que separe las dos tandas en la trazabilidad.
      const flowId = await seedFlow();
      const executionId = await seedExecution(flowId);

      await request(httpServer())
        .post(`/api/executions/${executionId}/resume`)
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(200);

      // 2. Act ⚙️
      await request(httpServer())
        .post(`/api/executions/${executionId}/resume`)
        .set('Authorization', `Bearer ${token}`)
        .send({ targetStepId: FIRST_NODE_ID })
        .expect(200);

      const rows = await dataSource.query<Array<{ mensaje: string }>>(
        `SELECT mensaje FROM logs_nodo
          WHERE id_ejecucion = $1 AND estado_nodo = 'ADVERTENCIA'
          ORDER BY fecha_creacion DESC`,
        [executionId],
      );

      // 3. Assert 🎯
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]?.mensaje).toContain(FIRST_NODE_ID);
    });

    it('2.3 deberia RECHAZAR un paso que no llego a ejecutarse', async () => {
      // 1. Arrange 📐: saltar hacia adelante dejaria sin escribir los
      //    namespaces intermedios y el flujo reventaria al interpolarlos.
      const flowId = await seedFlow();
      const executionId = await seedExecution(flowId);

      await repository.update(
        { executionId },
        { currentState: ExecutionState.PAUSADO, activeCursor: FIRST_NODE_ID },
      );

      // 2. Act ⚙️ + 3. Assert 🎯
      await request(httpServer())
        .post(`/api/executions/${executionId}/resume`)
        .set('Authorization', `Bearer ${token}`)
        .send({ targetStepId: RESUME_NODE_ID })
        .expect(400);
    });
  });

  describe('3. Reanudacion por correo entrante', () => {
    /**
     * ALCANCE DE ESTE BLOQUE, dicho por escrito.
     *
     * La validacion del canal —testigo desconocido, caducado o ya usado;
     * remitente inexistente, dado de baja o sin rol; resolucion del paso por
     * sus tres nombres; marcado del correo en todos los caminos— esta cubierta
     * exhaustivamente en `inbound-email-resume.service.spec.ts`, con dobles del
     * cliente IMAP. Repetirla aqui exigiria un servidor de correo de pruebas y
     * no mediria nada nuevo.
     *
     * Lo que SI exige extremo a extremo es lo que aquel no puede ver: que una
     * orden ya validada atraviesa el servicio real, mueve la fila en PostgreSQL
     * y sale por el canal marcada como llegada por correo, de modo que la
     * interfaz pueda decir de donde vino. Por eso se invoca el mismo punto de
     * entrada que usa el servicio tras conceder el permiso.
     */
    it('3.1 NO deberia abrir el buzon con el canal apagado', async () => {
      // 1. Arrange 📐: `INBOUND_RESUME_ENABLED` va a `false` en el preambulo.
      //    Una instalacion que no lo configure no abre conexion ninguna.
      const service = app.get(InboundEmailResumeService);

      // 2. Act ⚙️
      const dispatched = await service.processInbox();

      // 3. Assert 🎯
      expect(dispatched).toBe(0);
    });

    it(
      '3.2 deberia anunciar por el canal que la orden llego por correo',
      async () => {
        // 1. Arrange 📐: es lo unico que distingue este aviso del de un clic en
        //    la interfaz, y lo necesita: nadie esta mirando la pantalla cuando
        //    ocurre, asi que el toast tiene que decir de donde salio la orden.
        const flowId = await seedFlow();
        const executionId = await seedExecution(flowId);

        await request(httpServer())
          .post(`/api/executions/${executionId}/resume`)
          .set('Authorization', `Bearer ${token}`)
          .send({})
          .expect(200);

        const socket = await joinFlowRoom(flowId);
        const resumed = waitForEvent<Record<string, unknown>>(
          socket,
          'flow:resumed',
        );

        // 2. Act ⚙️: el mismo punto de entrada que invoca el servicio de correo
        //    una vez ha validado el testigo y el remitente.
        await app.get(ExecutionsService).resumeExecution(
          executionId,
          { targetStepId: FIRST_NODE_ID },
          {
            id: creatorId,
            email: INBOUND_SENDER,
            role: UserRole.EDITOR,
          },
          { isEmailResume: true },
        );

        const event = await resumed;

        // 3. Assert 🎯
        expect(event.isEmailResume).toBe(true);
        expect(event.resumedBy).toMatchObject({ email: INBOUND_SENDER });
        expect(event.targetStepId).toBe(FIRST_NODE_ID);
      },
      EVENT_TIMEOUT_MS * 2,
    );
  });

  describe('4. Descarte de una ejecucion detenida', () => {
    it('4.1 deberia cerrar la ejecucion, liberar el cursor y dar de baja el flujo', async () => {
      // 1. Arrange 📐
      const flowId = await seedFlow();
      const executionId = await seedExecution(flowId);

      await request(httpServer())
        .post(`/api/executions/${executionId}/resume`)
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(200);

      // 2. Act ⚙️
      await request(httpServer())
        .delete(`/api/executions/${executionId}/discard`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const execution = await readExecution(executionId);

      // 3. Assert 🎯
      expect(execution.currentState).toBe(ExecutionState.DESCARTADO);
      expect(execution.activeCursor).toBeNull();
      expect(await readWorkflowStatus(flowId)).toBe('INACTIVO');
    });
  });

  describe('5. Autodesactivacion tras una reanudacion exitosa', () => {
    /**
     * EL DEFECTO QUE CIERRA ESTA SECCION. `applyStopOnFirstSuccess` solo corria
     * desde el despacho automatico, de modo que un flujo que se atascaba, se
     * reanudaba a mano y terminaba bien se quedaba ACTIVO con su sondeo en
     * marcha: la politica "una sola corrida" se cumplia solo si nadie habia
     * tenido que intervenir, que es justo cuando menos falta hacia.
     */
    /**
     * Flujo que recorre el grafo ENTERO y cierra EXITOSO.
     *
     * Reutiliza `buildDummySchema`, el pipeline de andamiaje de tres nodos cuyas
     * estrategias dobles estan hechas para completar: escribirlo a mano aqui
     * obligaba a replicar los `params` que espera cada doble —el disparador
     * falla sin los suyos— y a mantener esa copia al dia.
     *
     * El de la suite no sirve: se detiene a mitad por diseno, y lo que aqui se
     * mide es el desenlace de una ejecucion que TERMINA.
     */
    const seedStraightFlow = async (
      stopOnFirstSuccess: boolean,
    ): Promise<string> => {
      const flowId = await seedFlow();
      const schema = buildDummySchema(flowId);

      await dataSource.query(
        `UPDATE flujos SET configuracion_pipeline = $1 WHERE id_flujo = $2`,
        [
          JSON.stringify(
            stopOnFirstSuccess
              ? { ...schema, executionPolicy: { stopOnFirstSuccess: true } }
              : schema,
          ),
          flowId,
        ],
      );

      return flowId;
    };

    it(
      '5.1 deberia apagar el flujo cuando la ejecucion reanudada termina EXITOSO',
      async () => {
        // 1. Arrange 📐: un flujo que recorre el grafo entero y cierra EXITOSO.
        const flowId = await seedStraightFlow(true);
        const executionId = await seedExecution(flowId, 'nodo_input');

        // 2. Act ⚙️: se reanuda desde el CURSOR, que es donde quedo. La
        //    reanudacion selectiva solo admite pasos que ya corrieron, y aqui
        //    no ha corrido ninguno.
        await request(httpServer())
          .post(`/api/executions/${executionId}/resume`)
          .set('Authorization', `Bearer ${token}`)
          .send({})
          .expect(200);

        // 3. Assert 🎯
        const execution = await readExecution(executionId);

        expect(execution.currentState).toBe(ExecutionState.EXITOSO);
        // LO QUE IMPORTA: el flujo queda INACTIVO, de modo que su sondeo deja
        // de crear ejecuciones nuevas.
        expect(await readWorkflowStatus(flowId)).toBe('INACTIVO');
      },
      CASE_TIMEOUT_MS,
    );

    it(
      '5.2 NO deberia apagar un flujo SIN la politica declarada',
      async () => {
        // 1. Arrange 📐: la contrapartida. Sin `stopOnFirstSuccess` el flujo
        //    sigue armado, que es el comportamiento de siempre.
        const flowId = await seedStraightFlow(false);
        const executionId = await seedExecution(flowId, 'nodo_input');

        // 2. Act ⚙️
        await request(httpServer())
          .post(`/api/executions/${executionId}/resume`)
          .set('Authorization', `Bearer ${token}`)
          .send({})
          .expect(200);

        // 3. Assert 🎯
        expect(await readExecution(executionId)).toMatchObject({
          currentState: ExecutionState.EXITOSO,
        });
        expect(await readWorkflowStatus(flowId)).toBe('ACTIVO');
      },
      CASE_TIMEOUT_MS,
    );

    it(
      '5.3 deberia apagar el flujo y soltar su sondeo en el despacho AUTOMATICO',
      async () => {
        // 1. Arrange 📐: el otro camino que llega al final del grafo, y el que
        //    no estaba cubierto. 5.1 mide la reanudacion manual; esto mide el
        //    disparo por trigger, que es el que corre sin nadie delante.
        //
        //    Se inscribe un puerto de sondeo postizo en el coordinador real: es
        //    la unica forma de comprobar que el worker se desregistra DE
        //    VERDAD, y no solo que la columna cambia.
        const flowId = await seedStraightFlow(true);
        const stopPollingForFlow = jest.fn();
        const port = {
          stopPollingForFlow,
          refreshPolling: (): Promise<void> => Promise.resolve(),
        };
        const coordinator = app.get(FlowPollingCoordinator);
        coordinator.register(port);

        try {
          // 2. Act ⚙️
          const executionId = await app
            .get(WorkflowsService)
            .runAutomaticWorkflow(flowId);

          // 3. Assert 🎯
          const execution = await readExecution(executionId);

          expect(execution.currentState).toBe(ExecutionState.EXITOSO);
          expect(await readWorkflowStatus(flowId)).toBe('INACTIVO');
          // LO QUE IMPORTA ADEMAS DEL ESTADO: sin esta baja el temporizador
          // seguiria abriendo conexiones IMAP contra el buzon de un flujo que
          // ya nadie debe disparar, hasta la siguiente reconciliacion.
          expect(stopPollingForFlow).toHaveBeenCalledWith(flowId);
        } finally {
          coordinator.unregister(port);
        }
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe('6. Limites Poka-Yoke de los nodos de IA', () => {
    it(
      '6.1 deberia rechazar un `maxRetries` por encima del techo',
      async () => {
        // 1. Arrange 📐: el motor ejecuta los nodos EN LINEA, asi que el tiempo
        //    bloqueado es `timeoutMs x (maxRetries + 1)` y se repite por cada
        //    proveedor de respaldo. El techo bajo de 5 a 3.
        const flowId = await seedFlow();
        const schema = buildPauseSchema(flowId);
        const withTooManyRetries = {
          ...schema,
          nodes: {
            ...schema.nodes,
            [PAUSE_NODE_ID]: {
              ...schema.nodes[PAUSE_NODE_ID],
              nodeType: NodeType.PROCESADOR_IA,
              outputNamespace: 'llm_response',
              params: {
                provider: 'MOCK',
                model: 'mock-1',
                promptText: 'Redacta algo.',
                maxRetries: 4,
              },
            },
          },
        };

        // 2. Act ⚙️ + 3. Assert 🎯: el DTO valida al GUARDAR, no al ejecutar,
        // asi que el rechazo llega aqui y no con el flujo ya en marcha.
        await request(httpServer())
          .patch(`/api/workflows/${flowId}`)
          .set('Authorization', `Bearer ${token}`)
          .send({ pipelineSchema: withTooManyRetries })
          .expect(400);
      },
      CASE_TIMEOUT_MS,
    );
  });
});
