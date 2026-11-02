// ---------------------------------------------------------------------------
// AISLAMIENTO. Va ANTES de cualquier import de la aplicacion, y no es opcional.
//
// Mismo preambulo que `fsm-canvas-execution.e2e-spec.ts`: montar `AppModule`
// ejecuta los `onModuleInit`, que con el `.env` de desarrollo abririan el buzon
// corporativo real, programarian los cron y atenderian ordenes por correo; y
// `FsmModule.onModuleInit` arrastra a PAUSADO toda ejecucion EN_PROCESO.
//
// Ademas se apunta Drupal a un dominio `.invalid` (RFC 2606: nunca resuelve) y
// con credenciales de juguete. El cliente HTTP va doblado igualmente; esto es
// la segunda barrera, por si un cambio futuro dejara una peticion sin doblar.
// `ConfigModule` no pisa lo que ya esta en `process.env`, asi que gana al
// `backend/.env`.
// ---------------------------------------------------------------------------
process.env.IMAP_POLLING_ENABLED = 'false';
process.env.CRON_SCHEDULING_ENABLED = 'false';
process.env.INBOUND_RESUME_ENABLED = 'false';
process.env.DRUPAL_API_BASE_URL = 'https://drupal.e2e.invalid/jsonapi';
process.env.DRUPAL_API_TOKEN = 'token-e2e';
process.env.DRUPAL_API_USER = 'editor_e2e';
process.env.DRUPAL_AUTH_TYPE = 'BASIC';
// La base sale de `DB_NAME` del entorno y la valida `test/helpers/e2e-database.guard.ts`
// (cargado por `setupFiles`) antes de este archivo: nada de nombres escritos aqui.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as cheerio from 'cheerio';
import { Workbook } from 'exceljs';
import request from 'supertest';
import { io } from 'socket.io-client';
import { DataSource } from 'typeorm';

import { createGlobalValidationPipe } from '@common/pipes/global-validation.pipe';
import { FsmExecution } from '@core/fsm/entities/fsm-execution.entity';
import { ExecutionState } from '@core/fsm/types/fsm.enums';
import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { HttpClientService } from '@core/http/http-client.service';
import { DrupalOperationMode } from '@modules/nodes/dto/drupal-http-config.dto';
import { ERR_PROMPT_REQUIRED_VARIABLE_MISSING } from '@modules/nodes/strategies/llm-extractor.strategy';
import { MOCK_LLM_MODEL } from '@modules/nodes/strategies/providers/mock-llm.provider';
import { ERR_PARSER_UNEXTRACTABLE_MEDIA } from '@modules/nodes/strategies/parser-email.strategy';

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
import type { AxiosRequestConfig } from 'axios';
import type { Socket } from 'socket.io-client';
import type { App } from 'supertest/types';
import type { Repository } from 'typeorm';

/**
 * Pipelines OPERATIVOS de punta a punta sobre la base de pruebas.
 *
 * El motor, las estrategias y la persistencia son los REALES; solo se doblan
 * los bordes que saldrian a la red:
 *
 * - Drupal: `HttpClientService` se sustituye por un portal en memoria que
 *   registra cada peticion y mantiene el HTML de cada pagina.
 * - IA y OCR: proveedor `MOCK`, el simulador del propio backend. Coste $0 y
 *   salida determinista, pero con la telemetria real escribiendo en la BD.
 * - Correo entrante: el `raw_email` se siembra en el contexto, como si el
 *   disparador IMAP ya hubiera corrido.
 *
 * Cada caso siembra su flujo y su ejecucion y la conduce con
 * `POST /api/executions/:id/resume`, igual que la suite del canvas.
 */

/** EDITOR propio de esta suite (ver `e2eEditor`). */
const E2E_EDITOR = e2eEditor(E2E_SLOTS.PIPELINES, 'editor-pipelines');

/** Arrancar Nest y conectar con PostgreSQL excede el timeout por defecto. */
const BOOTSTRAP_TIMEOUT_MS = 30_000;

/** Margen para que un evento viaje por el canal antes de darlo por perdido. */
const EVENT_TIMEOUT_MS = 10_000;

/** Holgura por caso: cada uno recorre varios nodos contra PostgreSQL real. */
const CASE_TIMEOUT_MS = 30_000;

const E2E_FLOW_PREFIX = '[E2E pipelines]';

const DRUPAL_BASE_URL = 'https://drupal.e2e.invalid/jsonapi';
const JSON_API_CONTENT_TYPE = 'application/vnd.api+json';

/** Paginas agregadoras del portal doblado. UUID v4 inventados. */
const OPEN_TENDERS_UUID = '0f7c2a51-6b1d-4c3e-9a8f-1e2d3c4b5a60';
const CLOSED_TENDERS_UUID = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const TITLES_UUID = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';
const INNODAYS_UUID = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';

/** UUID que el portal doblado asigna a la noticia creada. */
const CREATED_NODE_UUID = 'c4d5e6f7-a8b9-4c0d-8e1f-2a3b4c5d6e7f';

/** PNG de 1x1: un escaneo sin capa de texto, que es lo que obliga al OCR. */
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const DOCX_FIXTURE = join(__dirname, 'fixtures', 'tabla-simple.docx');

// ---------------------------------------------------------------------------
// Portal Drupal en memoria
// ---------------------------------------------------------------------------

/** Peticion registrada por el portal doblado. */
interface RecordedCall {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, unknown>;
  readonly body: unknown;
}

/** Forma minima de una respuesta de `HttpClientService.requestWithStatus`. */
type StatusOutcome =
  | { readonly data: unknown; readonly status: number }
  | {
      readonly failure: { level: 'GRAVE'; code: string; message: string };
      readonly status: number;
    };

/**
 * Sustituto de `HttpClientService` que simula la API JSON:API del portal.
 *
 * Solo entiende las rutas que usan los modos del destino Drupal:
 * `GET|PATCH /node/<bundle>/<uuid>` y `POST /node/<bundle>`. Cualquier otra
 * peticion responde 404, de modo que una salida a un sitio inesperado falla
 * la prueba en vez de pasar en silencio.
 */
class FakeDrupalPortal {
  public readonly pages = new Map<string, string>();
  public readonly calls: RecordedCall[] = [];

  public readonly requestWithStatus = jest.fn(
    (config: AxiosRequestConfig): Promise<StatusOutcome> =>
      Promise.resolve(this.route(config)),
  );

  public readonly request = jest.fn(async (config: AxiosRequestConfig) => {
    const outcome = await this.requestWithStatus(config);

    return 'failure' in outcome
      ? { failure: outcome.failure }
      : { data: outcome.data };
  });

  public readonly requestWithResponse = jest.fn(
    async (config: AxiosRequestConfig) => ({
      ...(await this.requestWithStatus(config)),
      statusText: 'OK',
      headers: {},
    }),
  );

  public reset(): void {
    this.pages.clear();
    this.calls.length = 0;
    this.requestWithStatus.mockClear();
    this.request.mockClear();
    this.requestWithResponse.mockClear();
  }

  /** Cuerpos `body.value` enviados en los PATCH a una pagina, en orden. */
  public patchedHtml(uuid: string): string[] {
    return this.calls
      .filter((call) => call.method === 'PATCH' && call.url.endsWith(uuid))
      .map((call) => readBodyValue(call.body));
  }

  private route(config: AxiosRequestConfig): StatusOutcome {
    const method = (config.method ?? 'GET').toUpperCase();
    const url = config.url ?? '';

    this.calls.push({
      method,
      url,
      headers: { ...(config.headers as Record<string, unknown>) },
      body: config.data,
    });

    const path = url.startsWith(DRUPAL_BASE_URL)
      ? url.slice(DRUPAL_BASE_URL.length).split('?')[0]
      : null;
    const segments = path?.split('/').filter(Boolean) ?? [];

    if (segments[0] !== 'node') {
      return notFound(url);
    }

    // POST /node/<bundle>: alta de una entidad (Notiweb).
    if (method === 'POST' && segments.length === 2) {
      return entityResponse(CREATED_NODE_UUID, '', 201);
    }

    const uuid = segments[2];

    if (uuid === undefined || !this.pages.has(uuid)) {
      return notFound(url);
    }

    if (method === 'PATCH') {
      this.pages.set(uuid, readBodyValue(config.data));
    }

    return entityResponse(uuid, this.pages.get(uuid) ?? '');
  }
}

const notFound = (url: string): StatusOutcome => ({
  failure: {
    level: 'GRAVE',
    code: 'ERR_HTTP_CLIENT_REJECTED',
    message: `El portal doblado no conoce ${url}`,
  },
  status: 404,
});

/** Entidad JSON:API con el HTML en `body.value`, como la del portal real. */
const entityResponse = (
  uuid: string,
  html: string,
  status = 200,
): StatusOutcome => ({
  status,
  data: {
    data: {
      id: uuid,
      attributes: {
        drupal_internal__nid: 4242,
        path: { alias: '/e2e' },
        body: { value: html, format: 'full_html' },
        changed: '2026-11-02T10:00:00+00:00',
      },
      relationships: { field_adjuntos: { data: null } },
    },
  },
});

/** `data.attributes.body.value` de un cuerpo JSON:API, o cadena vacia. */
const readBodyValue = (body: unknown): string => {
  const attributes = (
    body as { data?: { attributes?: Record<string, unknown> } }
  )?.data?.attributes;
  const value = (attributes?.body as { value?: unknown } | undefined)?.value;

  return typeof value === 'string' ? value : '';
};

// ---------------------------------------------------------------------------
// Esquemas
// ---------------------------------------------------------------------------

type NodeEntry = PipelineSchemaDto['nodes'][string];

/** Nodo con los campos que el esquema exige y valores neutros por defecto. */
const node = (
  nodeId: string,
  nodeType: NodeType,
  outputNamespace: string,
  nextStep: string | null,
  params: Record<string, unknown> = {},
  extra: Partial<NodeEntry> = {},
): NodeEntry => ({
  nodeId,
  nodeType,
  outputNamespace,
  nextStep,
  onErrorStep: null,
  params,
  ...extra,
});

const schemaOf = (
  flowId: string,
  name: string,
  entrypoint: string,
  nodes: readonly NodeEntry[],
): PipelineSchemaDto => ({
  flowId,
  name,
  version: '1.0.0',
  entrypoint,
  nodes: Object.fromEntries(nodes.map((entry) => [entry.nodeId, entry])),
});

/** Disparador IMAP de cabecera. Nunca corre: el cursor arranca despues. */
const imapTrigger = (nextStep: string): NodeEntry =>
  node('disparador_imap', NodeType.TRIGGER_IMAP, 'raw_email', nextStep);

/** Procesador IA con el simulador: coste $0 y salida determinista. */
const mockLlm = (
  nodeId: string,
  nextStep: string | null,
  inlinePrompt: string,
  extra: Partial<NodeEntry> = {},
): NodeEntry =>
  node(
    nodeId,
    NodeType.PROCESADOR_IA,
    'llm_response',
    nextStep,
    { inlinePrompt, provider: 'MOCK', model: MOCK_LLM_MODEL },
    extra,
  );

/** Correo crudo tal y como lo publica el disparador IMAP. */
const rawEmail = (
  subject: string,
  text: string,
  attachments: readonly Record<string, unknown>[] = [],
): Record<string, unknown> => ({
  subject,
  from: 'convocatorias@madrimasd.org',
  text,
  html: '',
  attachments,
});

/** Adjunto codificado como lo deja el disparador. */
const attachment = (
  filename: string,
  contentType: string,
  buffer: Buffer,
): Record<string, unknown> => ({
  filename,
  contentType,
  size: buffer.length,
  contentBase64: buffer.toString('base64'),
});

/** `.xlsx` real de evaluadores, construido con la libreria que lo leera. */
const buildTitlesWorkbook = async (): Promise<Buffer> => {
  const workbook = new Workbook();
  const sheet = workbook.addWorksheet('Evaluadores');

  sheet.addRow(['Universidad', 'Sigla', 'Titulo', 'Evaluador']);
  sheet.addRow([
    'Universidad Politecnica de Madrid',
    'UPM',
    'Grado en Ingenieria Informatica',
    'Dra. Ana Ruiz',
  ]);
  sheet.addRow([
    'Universidad Politecnica de Madrid',
    'UPM',
    'Master en Ciencia de Datos',
    'Dr. Luis Gomez',
  ]);

  return Buffer.from(await workbook.xlsx.writeBuffer());
};

describe('Pipelines operativos de la FSM (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let repository: Repository<FsmExecution>;
  let token: string;
  let creatorId: string;
  let baseUrl: string;

  const portal = new FakeDrupalPortal();
  const seededFlowIds: string[] = [];
  const openSockets: Socket[] = [];

  const httpServer = (): App => app.getHttpServer() as App;

  /** Siembra un flujo ACTIVO con el esquema que devuelva `build`. */
  const seedFlow = async (
    build: (flowId: string) => PipelineSchemaDto,
  ): Promise<string> => {
    const rows = await dataSource.query<Array<{ id_flujo: string }>>(
      `INSERT INTO flujos (nombre, descripcion, status, id_usuario_creador)
       VALUES ($1, $2, 'ACTIVO', $3)
       RETURNING id_flujo`,
      [
        `${E2E_FLOW_PREFIX} ${Date.now()}-${seededFlowIds.length}`,
        'Flujo sembrado por la suite de pipelines operativos.',
        creatorId,
      ],
    );

    const [{ id_flujo: flowId }] = rows;
    seededFlowIds.push(flowId);

    await dataSource.query(
      `UPDATE flujos SET configuracion_pipeline = $1 WHERE id_flujo = $2`,
      [JSON.stringify(build(flowId)), flowId],
    );

    return flowId;
  };

  /**
   * Ejecucion detenida en `cursor` con el contexto dado.
   *
   * PAUSADO porque `POST /executions/:id/resume` solo acepta ejecuciones
   * detenidas; es la misma via que usa la suite del canvas para arrancar.
   */
  const seedExecution = async (
    flowId: string,
    cursor: string,
    contextPayload: Record<string, Record<string, unknown>>,
  ): Promise<string> => {
    const execution = await repository.save(
      repository.create({
        flowId,
        currentState: ExecutionState.PAUSADO,
        activeCursor: cursor,
        contextPayload,
        retryState: {},
      }),
    );

    return execution.executionId;
  };

  const resume = async (executionId: string): Promise<void> => {
    const response = await request(httpServer())
      .post(`/api/executions/${executionId}/resume`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    // El cuerpo del rechazo en el mensaje: un 4xx a secas no dice que regla
    // del validador o del motor lo provoco.
    if (response.status !== 200) {
      throw new Error(
        `resume respondio ${response.status}: ${JSON.stringify(response.body)}`,
      );
    }
  };

  const readExecution = async (executionId: string): Promise<FsmExecution> => {
    const found = await repository.findOne({ where: { executionId } });

    if (found === null) {
      throw new Error(`La ejecucion ${executionId} desaparecio de la tabla.`);
    }

    return found;
  };

  /** Filas de `logs_nodo` de una ejecucion, por nodo. */
  const readNodeLogs = async (
    executionId: string,
  ): Promise<
    Array<{ id_nodo: string; estado_nodo: string; codigo_error: string | null }>
  > =>
    dataSource.query(
      `SELECT id_nodo, estado_nodo, codigo_error FROM logs_nodo
        WHERE id_ejecucion = $1 ORDER BY fecha_creacion`,
      [executionId],
    );

  /** Filas de telemetria de tokens de una ejecucion. */
  const countTelemetry = async (executionId: string): Promise<number> => {
    const rows = await dataSource.query<Array<{ total: string }>>(
      `SELECT count(*)::text AS total FROM telemetria_tokens_ia
        WHERE ejecucion_id = $1`,
      [executionId],
    );

    return Number(rows[0]?.total ?? 0);
  };

  /** Cliente de socket ya dentro de la sala del flujo. */
  const joinFlowRoom = async (flowId: string): Promise<Socket> => {
    const socket = io(`${baseUrl}/events`, {
      path: '/api/socket.io',
      auth: { token },
      transports: ['websocket'],
      forceNew: true,
    });

    openSockets.push(socket);

    await new Promise<void>((resolve, reject) => {
      socket.on('connect', () => resolve());
      socket.on('connect_error', (error: Error) => reject(error));
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

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(HttpClientService)
      .useValue(portal)
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(createGlobalValidationPipe());

    // `listen(0)`: el cliente de sockets necesita un puerto real.
    await app.listen(0);

    const server = app.getHttpServer() as {
      address: () => { port: number };
    };
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    dataSource = app.get(DataSource);
    repository = app.get<Repository<FsmExecution>>(
      getRepositoryToken(FsmExecution),
    );

    await ensureE2eUser(dataSource, E2E_EDITOR);
    token = await signFor(app.get(JwtService), dataSource, E2E_EDITOR);

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

  beforeEach(() => {
    portal.reset();
  });

  afterAll(async () => {
    for (const socket of openSockets) {
      socket.disconnect();
    }

    if (seededFlowIds.length > 0) {
      // Borrado POR ID, nunca TRUNCATE ni por patron: ejecuciones, logs,
      // alertas y telemetria caen en cascada desde el flujo.
      await dataSource.query(`DELETE FROM flujos WHERE id_flujo = ANY($1)`, [
        seededFlowIds,
      ]);
    }

    await removeE2eUsers(dataSource, [E2E_EDITOR]);
    await app.close();
  });

  describe('1. Notiweb: redaccion con moderacion humana', () => {
    it(
      '1.1 deberia pausar ante la aprobacion y publicar en Drupal al reanudar',
      async () => {
        // 1. Arrange 📐
        const flowId = await seedFlow((id) =>
          schemaOf(id, 'Notiweb', 'disparador_imap', [
            imapTrigger('parser'),
            node(
              'parser',
              NodeType.PARSER_PRE_IA,
              'parsed_email',
              'redaccion_ia',
            ),
            mockLlm(
              'redaccion_ia',
              'escudo',
              'Redacta una noticia sobre {{*parsed_email.clean_title}}. Remitente: {{parsed_email.sender_name}}.',
            ),
            node(
              'escudo',
              NodeType.ESCUDO_POST_IA,
              'validated_drupal_json',
              'aprobacion',
              {
                contentMode: 'TEXT',
                sourceNamespace: 'llm_response',
                sourceFields: ['headline', 'summary'],
              },
            ),
            node(
              'aprobacion',
              NodeType.PAUSA_FLOW,
              'pause_context',
              'destino_drupal',
              {
                pauseMode: 'IMMEDIATE',
              },
            ),
            node(
              'destino_drupal',
              NodeType.DESTINO_DRUPAL,
              'http_result',
              null,
              {
                operationMode: DrupalOperationMode.CREATE_NODE,
                sourceNamespace: 'llm_response',
                sourceField: 'summary',
                titleTemplate:
                  '{{validated_drupal_json.validated_fields.headline}}',
              },
            ),
          ]),
        );
        const executionId = await seedExecution(flowId, 'parser', {
          raw_email: rawEmail(
            'Investigadores de Madrid descubren una enzima que degrada plasticos',
            [
              'Un equipo del CSIC ha identificado una enzima capaz de degradar PET en 48 horas.',
              'El estudio, publicado en Nature, abre la via a reciclar envases sin calor.',
              'Articulo original: https://www.nature.com/articles/s41586-026-00001-x',
            ].join('\n'),
          ),
        });
        const socket = await joinFlowRoom(flowId);
        const paused = waitForEvent<Record<string, unknown>>(
          socket,
          'flow:paused',
        );

        // 2. Act ⚙️: primera vuelta, hasta la aprobacion humana.
        await resume(executionId);
        const pauseEvent = await paused;
        const atGate = await readExecution(executionId);

        // 3. Assert 🎯: detenida ANTES de Drupal, sin una sola peticion al portal.
        expect(atGate.currentState).toBe(ExecutionState.PAUSADO);
        expect(atGate.activeCursor).toBe('destino_drupal');
        expect(pauseEvent.pausedStepId).toBe('aprobacion');
        expect(portal.calls).toHaveLength(0);

        // 2. Act ⚙️: un EDITOR aprueba y reanuda.
        await resume(executionId);
        const done = await readExecution(executionId);

        // 3. Assert 🎯
        expect(done.currentState).toBe(ExecutionState.EXITOSO);
        const posts = portal.calls.filter((call) => call.method === 'POST');
        expect(posts).toHaveLength(1);
        expect(posts[0]?.url).toBe(`${DRUPAL_BASE_URL}/node/noticias`);
        expect(posts[0]?.headers['Content-Type']).toBe(JSON_API_CONTENT_TYPE);
        const sentTitle = (
          posts[0]?.body as { data: { attributes: { title: string } } }
        ).data.attributes.title;
        expect(sentTitle).toBe(
          (
            done.contextPayload.validated_drupal_json
              ?.validated_fields as Record<string, string>
          ).headline,
        );
        expect(done.contextPayload.http_result).toMatchObject({
          node_id: CREATED_NODE_UUID,
        });
      },
      EVENT_TIMEOUT_MS * 2,
    );
  });

  describe('2. Apertura de licitaciones (APPEND_HTML_BLOCK)', () => {
    it(
      '2.1 deberia extraer el .docx sin OCR y anteponer el bloque en la pagina de abiertas',
      async () => {
        // 1. Arrange 📐
        portal.pages.set(
          OPEN_TENDERS_UUID,
          '<div data-expediente="LIC-2026-001"><p>Licitacion anterior</p></div>',
        );
        const flowId = await seedFlow((id) =>
          schemaOf(id, 'Apertura de licitaciones', 'disparador_imap', [
            imapTrigger('parser'),
            node(
              'parser',
              NodeType.PARSER_PRE_IA,
              'parsed_email',
              'destino_drupal',
            ),
            node(
              'destino_drupal',
              NodeType.DESTINO_DRUPAL,
              'http_result',
              null,
              {
                operationMode: DrupalOperationMode.APPEND_HTML_BLOCK,
                bundle: 'node--page',
                targetNodeUuid: OPEN_TENDERS_UUID,
                sourceNamespace: 'parsed_email',
                sourceField: 'extracted_documents_text',
              },
            ),
          ]),
        );
        const executionId = await seedExecution(flowId, 'parser', {
          raw_email: rawEmail(
            'Nueva Licitacion Madrid+D - Suministros IT',
            'Se adjunta el pliego de la licitacion de suministros informaticos.',
            [
              attachment(
                'pliego.docx',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                readFileSync(DOCX_FIXTURE),
              ),
            ],
          ),
        });

        // 2. Act ⚙️
        await resume(executionId);
        const done = await readExecution(executionId);

        // 3. Assert 🎯: GET + PATCH, bloque nuevo DELANTE del anterior.
        expect(done.currentState).toBe(ExecutionState.EXITOSO);
        const [patched] = portal.patchedHtml(OPEN_TENDERS_UUID);
        expect(patched).toContain('Madrid');
        expect(patched.indexOf('Madrid')).toBeLessThan(
          patched.indexOf('Licitacion anterior'),
        );
        expect(done.contextPayload.http_result).toMatchObject({
          operation_applied: DrupalOperationMode.APPEND_HTML_BLOCK,
        });

        // Sin ninguna fila ERROR y con los dos nodos en OK. El parser puede
        // dejar ademas una ADVERTENCIA (aviso LEVE del adjunto), que no cuenta.
        const logs = await readNodeLogs(executionId);
        expect(logs.filter((log) => log.estado_nodo === 'ERROR')).toEqual([]);
        expect(
          logs
            .filter((log) => log.estado_nodo === 'OK')
            .map((log) => log.id_nodo),
        ).toEqual(['parser', 'destino_drupal']);
        expect(await countTelemetry(executionId)).toBe(0);
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe('3. Cierre de licitaciones (TRANSFER_HTML_BLOCK)', () => {
    it(
      '3.1 deberia trasladar el expediente de abiertas a cerradas sin tocar la IA',
      async () => {
        // 1. Arrange 📐
        portal.pages.set(
          OPEN_TENDERS_UUID,
          '<div data-expediente="LIC-2026-004"><p>Suministros IT</p></div>' +
            '<div data-expediente="LIC-2026-001"><p>Otra abierta</p></div>',
        );
        portal.pages.set(CLOSED_TENDERS_UUID, '');
        const flowId = await seedFlow((id) =>
          schemaOf(id, 'Cierre de licitaciones', 'disparador_cron', [
            node(
              'disparador_cron',
              NodeType.TRIGGER_CRON,
              'cron_trigger',
              'destino_drupal',
              {
                cronExpression: '0 8 * * 1-5',
              },
            ),
            node(
              'destino_drupal',
              NodeType.DESTINO_DRUPAL,
              'http_result',
              null,
              {
                operationMode: DrupalOperationMode.TRANSFER_HTML_BLOCK,
                bundle: 'node--page',
                targetNodeUuid: OPEN_TENDERS_UUID,
                destinationNodeUuid: CLOSED_TENDERS_UUID,
                // Selector fijo: el trabajo programado se da de alta por
                // expediente, igual que un cierre agendado en el portal.
                itemSelector: '[data-expediente="LIC-2026-004"]',
              },
            ),
          ]),
        );
        const executionId = await seedExecution(flowId, 'disparador_cron', {});

        // 2. Act ⚙️
        await resume(executionId);
        const done = await readExecution(executionId);

        // 3. Assert 🎯
        expect(done.currentState).toBe(ExecutionState.EXITOSO);
        expect(portal.pages.get(CLOSED_TENDERS_UUID)).toContain('LIC-2026-004');
        expect(portal.pages.get(OPEN_TENDERS_UUID)).not.toContain(
          'LIC-2026-004',
        );
        expect(portal.pages.get(OPEN_TENDERS_UUID)).toContain('LIC-2026-001');
        // Coste $0: ninguna inferencia registrada.
        expect(await countTelemetry(executionId)).toBe(0);
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe('4. Verificacion de titulos universitarios', () => {
    it(
      '4.1 deberia insertar la tabla del .xlsx en el acordeon de su sigla y purgar el binario',
      async () => {
        // 1. Arrange 📐
        portal.pages.set(
          TITLES_UUID,
          '<div id="accordion">' +
            '<div class="panel"><div id="collapseUCM"><p>Complutense</p></div></div>' +
            '<div class="panel"><div id="collapseUPM"><p>Politecnica</p></div></div>' +
            '</div>',
        );
        const flowId = await seedFlow((id) =>
          schemaOf(id, 'Verificacion de titulos', 'disparador_imap', [
            imapTrigger('parser'),
            node(
              'parser',
              NodeType.PARSER_PRE_IA,
              'parsed_email',
              'destino_drupal',
            ),
            node(
              'destino_drupal',
              NodeType.DESTINO_DRUPAL,
              'http_result',
              null,
              {
                operationMode: DrupalOperationMode.APPEND_HTML_BLOCK,
                bundle: 'node--page',
                targetNodeUuid: TITLES_UUID,
                containerSelector: '#collapseUPM',
                sourceNamespace: 'parsed_email',
                sourceField: 'extracted_documents_text',
              },
            ),
          ]),
        );
        const executionId = await seedExecution(flowId, 'parser', {
          raw_email: rawEmail(
            'Evaluadores de titulos UPM',
            'Adjuntamos la matriz de evaluadores de la UPM.',
            [
              attachment(
                'evaluadores.xlsx',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                await buildTitlesWorkbook(),
              ),
            ],
          ),
        });

        // 2. Act ⚙️
        await resume(executionId);
        const done = await readExecution(executionId);

        // 3. Assert 🎯: la tabla entra en el panel de la UPM, no en el de la UCM.
        expect(done.currentState).toBe(ExecutionState.EXITOSO);
        const [patched] = portal.patchedHtml(TITLES_UUID);
        const $ = cheerio.load(patched ?? '');
        expect($('#collapseUPM').text()).toContain(
          'Grado en Ingenieria Informatica',
        );
        expect($('#collapseUCM').text()).not.toContain(
          'Grado en Ingenieria Informatica',
        );

        // Purga del binario: el checkpoint ya no guarda los bytes del adjunto.
        const attachments = done.contextPayload.raw_email?.attachments as Array<
          Record<string, unknown>
        >;
        expect(attachments[0]?.contentBase64).toBeNull();
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe('5. Contingencia OCR multimodal', () => {
    it(
      '5.1 deberia desviar un escaneo al OCR, retomar la IA y publicar su consumo',
      async () => {
        // 1. Arrange 📐
        const flowId = await seedFlow((id) =>
          schemaOf(id, 'Contingencia OCR', 'disparador_imap', [
            imapTrigger('parser'),
            node(
              'parser',
              NodeType.PARSER_PRE_IA,
              'parsed_email',
              'redaccion_ia',
              { failOnUnextractableMedia: true },
              { onErrorStep: 'ocr_ia', retryPolicy: { maxRetries: 0 } },
            ),
            node(
              'ocr_ia',
              NodeType.PROCESADOR_OCR,
              'ocr_result',
              'redaccion_ia',
              {
                provider: 'MOCK',
              },
            ),
            mockLlm(
              'redaccion_ia',
              null,
              'Resume la convocatoria: {{*ocr_result.clean_body}}',
            ),
          ]),
        );
        const executionId = await seedExecution(flowId, 'parser', {
          raw_email: rawEmail('Convocatoria escaneada', '', [
            attachment(
              'convocatoria.png',
              'image/png',
              Buffer.from(PNG_1X1_BASE64, 'base64'),
            ),
          ]),
        });

        // 2. Act ⚙️
        await resume(executionId);
        const done = await readExecution(executionId);

        // 3. Assert 🎯
        expect(done.currentState).toBe(ExecutionState.EXITOSO);
        expect(done.contextPayload.ocr_result?.clean_body).toEqual(
          expect.any(String),
        );

        const logs = await readNodeLogs(executionId);
        // El parser puede dejar ademas filas ADVERTENCIA (avisos LEVE del
        // adjunto): se busca la de ERROR, que es la que desvia al OCR.
        const parserError = logs.find(
          (log) => log.id_nodo === 'parser' && log.estado_nodo === 'ERROR',
        );
        expect(parserError?.codigo_error).toBe(ERR_PARSER_UNEXTRACTABLE_MEDIA);
        expect(logs.map((log) => log.id_nodo)).toEqual(
          expect.arrayContaining(['ocr_ia', 'redaccion_ia']),
        );
        // Telemetria: las dos inferencias publican su consumo en `metadata`,
        // marcadas `isMock`. El simulador NO escribe filas en la tabla de
        // telemetria por diseno (`recordResponseUsage`): no se factura, y una
        // fila a cero contaminaria la tasa de exito de los modelos reales.
        expect(done.contextPayload.ocr_result?.metadata).toMatchObject({
          isMock: true,
        });
        expect(done.contextPayload.llm_response?.metadata).toMatchObject({
          isMock: true,
        });
        expect(await countTelemetry(executionId)).toBe(0);
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe('6. Innodays / Innobar (UPDATE_LINK_SOURCE)', () => {
    it(
      '6.1 deberia cambiar solo el href del enlace seleccionado',
      async () => {
        // 1. Arrange 📐
        const html =
          '<table><tr><td>Agrifood</td><td><a href="/old-agrifood.pdf">PDF</a></td></tr>' +
          '<tr><td>Salud</td><td><a href="/old-salud.pdf">PDF</a></td></tr></table>';
        portal.pages.set(INNODAYS_UUID, html);
        const flowId = await seedFlow((id) =>
          // La IA que redacta la URL va en el esquema porque el validador
          // exige un productor de `llm_response`; el cursor arranca despues de
          // ella con su salida ya sembrada, asi que no corre.
          schemaOf(id, 'Innodays', 'disparador_imap', [
            imapTrigger('parser'),
            node(
              'parser',
              NodeType.PARSER_PRE_IA,
              'parsed_email',
              'redaccion_ia',
            ),
            mockLlm(
              'redaccion_ia',
              'destino_drupal',
              'Extrae la URL del PDF de Agrifood.',
            ),
            node(
              'destino_drupal',
              NodeType.DESTINO_DRUPAL,
              'http_result',
              null,
              {
                operationMode: DrupalOperationMode.UPDATE_LINK_SOURCE,
                bundle: 'node--page',
                targetNodeUuid: INNODAYS_UUID,
                linkSelector: "table tr:contains('Agrifood') a",
                linkAttribute: 'href',
                linkValueTemplate: '{{llm_response.url}}',
              },
            ),
          ]),
        );
        const executionId = await seedExecution(flowId, 'destino_drupal', {
          llm_response: {
            url: 'https://www.madrimasd.org/innodays/agrifood-2026.pdf',
          },
        });

        // 2. Act ⚙️
        await resume(executionId);
        const done = await readExecution(executionId);

        // 3. Assert 🎯
        expect(done.currentState).toBe(ExecutionState.EXITOSO);
        expect(portal.pages.get(INNODAYS_UUID)).toBe(
          html.replace(
            'href="/old-agrifood.pdf"',
            'href="https://www.madrimasd.org/innodays/agrifood-2026.pdf"',
          ),
        );
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe('7. Variables obligatorias del prompt', () => {
    it(
      '7.1 deberia pausar con GRAVE y sin consumo si falta una variable {{*ns.campo}}',
      async () => {
        // 1. Arrange 📐: `parsed_email` existe, pero no trae ese campo.
        const flowId = await seedFlow((id) =>
          schemaOf(id, 'Prompt con variable obligatoria', 'disparador_imap', [
            imapTrigger('parser'),
            node(
              'parser',
              NodeType.PARSER_PRE_IA,
              'parsed_email',
              'redaccion_ia',
            ),
            mockLlm(
              'redaccion_ia',
              null,
              'Resume {{*parsed_email.full_article_content}} para el boletin.',
              { retryPolicy: { maxRetries: 0 } },
            ),
          ]),
        );
        const executionId = await seedExecution(flowId, 'parser', {
          raw_email: rawEmail(
            'Boletin semanal de innovacion',
            'Cuerpo suficiente para que el parser no lo considere vacio en absoluto.',
          ),
        });

        // 2. Act ⚙️
        await resume(executionId);
        const done = await readExecution(executionId);

        // 3. Assert 🎯
        expect(done.currentState).toBe(ExecutionState.PAUSADO);
        expect(done.activeCursor).toBe('redaccion_ia');
        const iaLog = (await readNodeLogs(executionId)).find(
          (log) => log.id_nodo === 'redaccion_ia',
        );
        expect(iaLog?.codigo_error).toBe(ERR_PROMPT_REQUIRED_VARIABLE_MISSING);
        expect(await countTelemetry(executionId)).toBe(0);
      },
      CASE_TIMEOUT_MS,
    );
  });
});
