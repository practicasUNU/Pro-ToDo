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
// Acens doblado: la campana del boletin sale por el mismo cliente HTTP, que el
// portal en memoria contesta.
process.env.ACENS_API_BASE_URL = 'https://acens.e2e.invalid';
process.env.ACENS_API_KEY = 'acens-token-e2e';
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
import { WebScraperRunner } from '@modules/nodes/services/web-scraper.runner';
import { extractArticle } from '@modules/nodes/utils/article-extractor.util';

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
import type { ScrapeOutcome } from '@modules/nodes/services/web-scraper.runner';
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
 *   salida determinista: el titular es el primer parrafo del prompt, y con
 *   una plantilla base devuelve tambien `filled_markup`.
 * - Navegador del extractor web: `WebScraperRunner` se sustituye por uno que
 *   pasa un HTML fijo por el extractor REAL (`extractArticle`), de modo que la
 *   fecha por URL y el autor por dominio se ejercitan de verdad.
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

/** Articulo enlazado por el editor de Notiweb: fecha en la ruta, sin firma. */
const ARTICLE_URL =
  'https://f-droid.org/es/2026/02/24/open-letter-to-the-community/';

/** Raiz publica del portal doblado: la base de la API sin `/jsonapi`. */
const DRUPAL_SITE_ROOT = 'https://drupal.e2e.invalid';

/** Ruta absoluta de la creacion de campanas en el Acens doblado. */
const ACENS_CAMPAIGN_URL = 'https://acens.e2e.invalid/api/1/createCampaign/';
const ACENS_CAMPAIGN_ID = 'campana-e2e-1';

/**
 * HTML del articulo, SIN `<meta>` de autor ni de fecha: obliga al extractor a
 * caer en la fecha de la URL y en la organizacion del dominio.
 */
const ARTICLE_HTML =
  '<!DOCTYPE html><html lang="es"><head><title>Carta abierta a la comunidad</title></head>' +
  '<body><article><h1>Carta abierta a la comunidad</h1>' +
  '<p>El proyecto explica en esta carta abierta como afectan las nuevas reglas de distribucion de aplicaciones a los repositorios libres y a quienes los mantienen.</p>' +
  '<p>La comunidad de desarrolladores ha reunido firmas de organizaciones europeas que piden mantener la instalacion directa de aplicaciones sin intermediarios.</p>' +
  '<p>El texto propone una mesa de trabajo con los reguladores y recuerda que la soberania digital depende de poder auditar el software que se instala.</p>' +
  '</article></body></html>';

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

  /** Peticiones registradas con ese verbo cuya URL empieza por `prefix`. */
  public callsTo(method: string, prefix: string): RecordedCall[] {
    return this.calls.filter(
      (call) => call.method === method && call.url.startsWith(prefix),
    );
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

    // Acens: solo la creacion de campanas; contesta con un id fijo.
    if (method === 'POST' && url === ACENS_CAMPAIGN_URL) {
      return { status: 200, data: { campaign_id: ACENS_CAMPAIGN_ID } };
    }

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
  html = '',
): Record<string, unknown> => ({
  subject,
  from: 'convocatorias@madrimasd.org',
  text,
  html,
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
  const seededTemplateIds: string[] = [];

  /**
   * Navegador doblado: sin Playwright ni red, pero con el extractor real. Solo
   * conoce `ARTICLE_URL`; cualquier otra direccion falla como un portal caido.
   */
  const scraper = {
    run: jest.fn((url: URL): Promise<ScrapeOutcome> => {
      const sourceUrl = url.toString();
      const article =
        sourceUrl === ARTICLE_URL
          ? extractArticle(ARTICLE_HTML, sourceUrl)
          : null;

      return Promise.resolve(
        article === null
          ? {
              success: false,
              code: 'ERR_EXTERNAL_SERVER_UNREACHABLE',
              message: `El navegador doblado no conoce ${sourceUrl}`,
              attempts: 1,
            }
          : { success: true, sourceUrl, article, attempts: 1 },
      );
    }),
  };
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

  /** Plantilla HTML propia de la suite, para el MAPEADOR_PLANTILLA. */
  const seedTemplate = async (label: string, html: string): Promise<string> => {
    const rows = await dataSource.query<Array<{ id_plantilla: string }>>(
      `INSERT INTO plantillas_html (nombre, descripcion, contenido_html, id_usuario_creador)
       VALUES ($1, $2, $3, $4)
       RETURNING id_plantilla`,
      [
        `${E2E_FLOW_PREFIX} ${label} ${Date.now()}-${seededTemplateIds.length}`,
        'Plantilla sembrada por la suite de pipelines operativos.',
        html,
        creatorId,
      ],
    );

    const [{ id_plantilla: templateId }] = rows;
    seededTemplateIds.push(templateId);

    return templateId;
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
      .overrideProvider(WebScraperRunner)
      .useValue(scraper)
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
    scraper.run.mockClear();
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

    if (seededTemplateIds.length > 0) {
      // Despues de los flujos, que son quienes las citaban.
      await dataSource.query(
        `DELETE FROM plantillas_html WHERE id_plantilla = ANY($1)`,
        [seededTemplateIds],
      );
    }

    await removeE2eUsers(dataSource, [E2E_EDITOR]);
    await app.close();
  });

  describe('1. Notiweb: redaccion con moderacion humana', () => {
    it(
      '1.1 deberia pausar ante la aprobacion y publicar en Drupal con su enlace al reanudar',
      async () => {
        // 1. Arrange 📐: topologia canonica. El MAPEADOR va DESPUES del
        //    extractor y ANTES de la IA, que rellena su cascaron.
        const templateId = await seedTemplate(
          'Notiweb',
          '<div class="notiweb-cuerpo"><hr /><h2>Referencia bibliográfica</h2>' +
            '<p class="notiweb-referencia"></p></div>',
        );
        const flowId = await seedFlow((id) =>
          schemaOf(id, 'Notiweb', 'disparador_imap', [
            imapTrigger('parser'),
            node(
              'parser',
              NodeType.PARSER_PRE_IA,
              'parsed_email',
              'extractor_web',
            ),
            node(
              'extractor_web',
              NodeType.EXTRACTOR_WEB,
              'scraped_web',
              'mapeador',
              {
                targetUrl: '{{parsed_email.extracted_urls}}',
                skipIfEmpty: true,
                maxRetries: 0,
              },
            ),
            node(
              'mapeador',
              NodeType.MAPEADOR_PLANTILLA,
              'rendered_html',
              'redaccion_ia',
              { templateId },
            ),
            mockLlm(
              'redaccion_ia',
              'escudo',
              [
                'Redacta una noticia sobre {{*parsed_email.clean_title}}.',
                'Articulo de {{scraped_web.author}} ({{scraped_web.published_at}}): {{scraped_web.full_article_content}}',
                'PLANTILLA BASE: {{*rendered_html.compiled_markup}}',
              ].join('\n\n'),
            ),
            node(
              'escudo',
              NodeType.ESCUDO_POST_IA,
              'validated_drupal_json',
              'aprobacion',
              {
                contentMode: 'HTML',
                sourceNamespace: 'llm_response',
                sourceField: 'filled_markup',
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
                sourceNamespace: 'validated_drupal_json',
                sourceField: 'validated_markup',
                titleTemplate: '{{llm_response.headline}}',
              },
            ),
          ]),
        );
        const executionId = await seedExecution(flowId, 'parser', {
          // El enlace va en la parte HTML: es de donde el parser saca
          // `extracted_urls` (el texto plano parte las URL a 78 columnas).
          raw_email: rawEmail(
            'Carta abierta sobre la distribucion de aplicaciones libres',
            'Preparad una noticia para Notiweb sobre esta carta abierta.',
            [],
            '<p>Preparad una noticia para Notiweb sobre esta carta abierta.</p>' +
              `<p><a href="${ARTICLE_URL}">Articulo original</a></p>`,
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
        // El extractor REAL leyo el articulo: fecha de la ruta y organizacion
        // del dominio, porque el HTML no declara ninguna de las dos.
        expect(scraper.run).toHaveBeenCalledTimes(1);
        expect(atGate.contextPayload.scraped_web).toMatchObject({
          published_at: '2026-02-24',
          author: 'F-Droid',
          byline: 'F-Droid',
        });
        expect(atGate.contextPayload.rendered_html).toBeDefined();

        // 2. Act ⚙️: un EDITOR aprueba y reanuda.
        const completed = waitForEvent<Record<string, unknown>>(
          socket,
          'flow:completed',
        );
        await resume(executionId);
        const completedEvent = await completed;
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
          (done.contextPayload.llm_response as Record<string, string>).headline,
        );
        expect(readBodyValue(posts[0]?.body)).toBe(
          (done.contextPayload.validated_drupal_json as Record<string, string>)
            .validated_markup,
        );
        // El enlace a la noticia creada, en el namespace y en el aviso.
        expect(done.contextPayload.http_result).toMatchObject({
          node_id: CREATED_NODE_UUID,
          published_url: `${DRUPAL_SITE_ROOT}/e2e`,
          exit_page: '/e2e',
        });
        expect(completedEvent).toMatchObject({
          executionId,
          finalState: ExecutionState.EXITOSO,
          publishedUrl: `${DRUPAL_SITE_ROOT}/e2e`,
          exitPage: '/e2e',
        });
      },
      EVENT_TIMEOUT_MS * 3,
    );
  });

  describe('2. Apertura de licitaciones (APPEND_HTML_BLOCK)', () => {
    it(
      '2.1 deberia rellenar la plantilla con el .docx y anteponer el bloque en abiertas',
      async () => {
        // 1. Arrange 📐
        portal.pages.set(
          OPEN_TENDERS_UUID,
          '<div data-expediente="LIC-2026-001"><p>Licitacion anterior</p></div>',
        );
        const templateId = await seedTemplate(
          'Apertura',
          '<div class="licitacion-entry pd-licitacion-block" data-expediente="">' +
            '<h3 class="licitacion-title"></h3></div>',
        );
        const flowId = await seedFlow((id) =>
          schemaOf(id, 'Apertura de licitaciones', 'disparador_imap', [
            imapTrigger('parser'),
            node('parser', NodeType.PARSER_PRE_IA, 'parsed_email', 'mapeador'),
            node(
              'mapeador',
              NodeType.MAPEADOR_PLANTILLA,
              'rendered_html',
              'extraccion_ia',
              { templateId },
            ),
            // El prompt NO interpola el adjunto: asi viaja como materia prima
            // (`buildInputText`), que es de donde el simulador redacta.
            mockLlm(
              'extraccion_ia',
              'escudo',
              'Rellena la convocatoria de {{*parsed_email.clean_title}} con el pliego adjunto.\n\n' +
                'PLANTILLA BASE: {{*rendered_html.compiled_markup}}',
            ),
            node(
              'escudo',
              NodeType.ESCUDO_POST_IA,
              'validated_drupal_json',
              'destino_drupal',
              {
                contentMode: 'HTML',
                sourceNamespace: 'llm_response',
                sourceField: 'filled_markup',
              },
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
                sourceNamespace: 'validated_drupal_json',
                sourceField: 'validated_markup',
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

        // 3. Assert 🎯: GET + PATCH, bloque nuevo DELANTE del anterior, y es el
        //    marcado que valido el escudo, no el texto crudo del adjunto.
        expect(done.currentState).toBe(ExecutionState.EXITOSO);
        const [patched] = portal.patchedHtml(OPEN_TENDERS_UUID);
        expect(patched).toContain('Madrid');
        expect(patched.indexOf('Madrid')).toBeLessThan(
          patched.indexOf('Licitacion anterior'),
        );
        expect(done.contextPayload.http_result).toMatchObject({
          operation_applied: DrupalOperationMode.APPEND_HTML_BLOCK,
          published_url: `${DRUPAL_SITE_ROOT}/e2e`,
          exit_page: '/e2e',
        });

        // Sin ninguna fila ERROR y con los cinco nodos en OK, en orden. El
        // parser puede dejar ademas una ADVERTENCIA, que no cuenta.
        const logs = await readNodeLogs(executionId);
        expect(logs.filter((log) => log.estado_nodo === 'ERROR')).toEqual([]);
        expect(
          logs
            .filter((log) => log.estado_nodo === 'OK')
            .map((log) => log.id_nodo),
        ).toEqual([
          'parser',
          'mapeador',
          'extraccion_ia',
          'escudo',
          'destino_drupal',
        ]);
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe('3. Cierre de licitaciones (TRANSFER_HTML_BLOCK)', () => {
    it(
      '3.1 deberia identificar el expediente con IA y trasladarlo sin mapeador de plantilla',
      async () => {
        // 1. Arrange 📐: el simulador devuelve como titular la primera linea
        //    de la materia prima (el correo), que hace aqui de expediente.
        portal.pages.set(
          OPEN_TENDERS_UUID,
          '<div data-expediente="LIC-2026-004"><p>Suministros IT</p></div>' +
            '<div data-expediente="LIC-2026-001"><p>Otra abierta</p></div>',
        );
        portal.pages.set(CLOSED_TENDERS_UUID, '');
        const flowId = await seedFlow((id) =>
          schemaOf(id, 'Cierre de licitaciones', 'disparador_imap', [
            imapTrigger('parser'),
            node(
              'parser',
              NodeType.PARSER_PRE_IA,
              'parsed_email',
              'identificacion_ia',
            ),
            mockLlm(
              'identificacion_ia',
              'escudo',
              'Identifica el expediente que se cierra en "{{*parsed_email.clean_title}}".',
            ),
            node(
              'escudo',
              NodeType.ESCUDO_POST_IA,
              'validated_drupal_json',
              'destino_drupal',
              {
                contentMode: 'TEXT',
                sourceNamespace: 'llm_response',
                sourceFields: ['headline', 'summary'],
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
                // El selector fija el expediente VALIDADO por el escudo.
                itemSelector:
                  '[data-expediente="{{validated_drupal_json.validated_fields.headline}}"]',
              },
            ),
          ]),
        );
        const executionId = await seedExecution(flowId, 'parser', {
          raw_email: rawEmail(
            'Cierre de la licitacion LIC-2026-004',
            'LIC-2026-004\nSe comunica la adjudicacion del expediente de suministros IT.',
          ),
        });

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
        // Hubo inferencia (simulada) y validacion post-IA, pero NO mapeador.
        expect(done.contextPayload.llm_response?.metadata).toMatchObject({
          isMock: true,
        });
        expect(done.contextPayload.rendered_html).toBeUndefined();
        const okNodes = (await readNodeLogs(executionId))
          .filter((log) => log.estado_nodo === 'OK')
          .map((log) => log.id_nodo);
        expect(okNodes).toEqual([
          'parser',
          'identificacion_ia',
          'escudo',
          'destino_drupal',
        ]);
        // El enlace apunta a la pagina de DESTINO del traslado.
        expect(done.contextPayload.http_result).toMatchObject({
          published_url: `${DRUPAL_SITE_ROOT}/e2e`,
          exit_page: '/e2e',
        });
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe('4. Verificacion de titulos universitarios', () => {
    it(
      '4.1 deberia ensamblar el .xlsx en la plantilla e insertarlo en el acordeon de su sigla',
      async () => {
        // 1. Arrange 📐
        portal.pages.set(
          TITLES_UUID,
          '<div id="accordion">' +
            '<div class="panel"><div id="collapseUCM"><p>Complutense</p></div></div>' +
            '<div class="panel"><div id="collapseUPM"><p>Politecnica</p></div></div>' +
            '</div>',
        );
        const templateId = await seedTemplate(
          'Titulos',
          '<div class="panel panel-default"><div class="panel-body"></div></div>',
        );
        const flowId = await seedFlow((id) =>
          schemaOf(id, 'Verificacion de titulos', 'disparador_imap', [
            imapTrigger('parser'),
            node('parser', NodeType.PARSER_PRE_IA, 'parsed_email', 'mapeador'),
            node(
              'mapeador',
              NodeType.MAPEADOR_PLANTILLA,
              'rendered_html',
              'estructuracion_ia',
              { templateId },
            ),
            mockLlm(
              'estructuracion_ia',
              'escudo',
              'Estructura el panel de {{*parsed_email.clean_title}} con la tabla adjunta.\n\n' +
                'PLANTILLA BASE: {{*rendered_html.compiled_markup}}',
            ),
            node(
              'escudo',
              NodeType.ESCUDO_POST_IA,
              'validated_drupal_json',
              'destino_drupal',
              {
                contentMode: 'HTML',
                sourceNamespace: 'llm_response',
                sourceField: 'filled_markup',
              },
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
                sourceNamespace: 'validated_drupal_json',
                sourceField: 'validated_markup',
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
        expect(done.contextPayload.rendered_html).toBeDefined();
        expect(
          typeof done.contextPayload.validated_drupal_json?.audit_status,
        ).toBe('string');

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
      '6.1 deberia extraer el enlace con IA, validarlo y cambiar solo el href seleccionado',
      async () => {
        // 1. Arrange 📐: sin mapeador. El simulador devuelve como titular la
        //    primera linea del correo, que hace aqui de URL extraida.
        const html =
          '<table><tr><td>Agrifood</td><td><a href="/old-agrifood.pdf">PDF</a></td></tr>' +
          '<tr><td>Salud</td><td><a href="/old-salud.pdf">PDF</a></td></tr></table>';
        portal.pages.set(INNODAYS_UUID, html);
        const flowId = await seedFlow((id) =>
          schemaOf(id, 'Innodays', 'disparador_imap', [
            imapTrigger('parser'),
            node('parser', NodeType.PARSER_PRE_IA, 'parsed_email', 'enlace_ia'),
            mockLlm(
              'enlace_ia',
              'escudo',
              'Extrae el enlace del evento de "{{*parsed_email.clean_title}}".',
            ),
            node(
              'escudo',
              NodeType.ESCUDO_POST_IA,
              'validated_drupal_json',
              'destino_drupal',
              {
                contentMode: 'TEXT',
                sourceNamespace: 'llm_response',
                sourceFields: ['headline'],
              },
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
                // El valor que escribe es el que VALIDO el escudo.
                linkValueTemplate:
                  '{{validated_drupal_json.validated_fields.headline}}',
              },
            ),
          ]),
        );
        const executionId = await seedExecution(flowId, 'parser', {
          raw_email: rawEmail(
            'Innoday Agrifood: enlace de inscripcion',
            'https://www.madrimasd.org/innodays/agrifood-2026.pdf\nYa esta disponible el programa del Innoday Agrifood.',
          ),
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
        expect(done.contextPayload.llm_response?.metadata).toMatchObject({
          isMock: true,
        });
        expect(done.contextPayload.rendered_html).toBeUndefined();
        expect(
          (await readNodeLogs(executionId))
            .filter((log) => log.estado_nodo === 'OK')
            .map((log) => log.id_nodo),
        ).toEqual(['parser', 'enlace_ia', 'escudo', 'destino_drupal']);
        expect(done.contextPayload.http_result).toMatchObject({
          published_url: `${DRUPAL_SITE_ROOT}/e2e`,
          exit_page: '/e2e',
        });
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

  describe('8. Cardinalidad 1 a N (lotes)', () => {
    /**
     * Tramo IA -> escudo -> destino con la ejecucion parada en el ESCUDO y un
     * `llm_response` ya sembrado. Fija el marcado exacto de cada elemento
     * (bloques de licitacion, paneles por universidad) sin depender del
     * simulador, y deja que escudo y destino corran de verdad.
     */
    const shieldedSchema = (
      flowId: string,
      name: string,
      shieldParams: Record<string, unknown>,
      destinationParams: Record<string, unknown>,
    ): PipelineSchemaDto =>
      schemaOf(flowId, name, 'disparador_imap', [
        imapTrigger('parser'),
        node('parser', NodeType.PARSER_PRE_IA, 'parsed_email', 'lote_ia'),
        mockLlm('lote_ia', 'escudo', 'Procesa el lote.', {
          params: {
            inlinePrompt: 'Procesa el lote.',
            provider: 'MOCK',
            model: MOCK_LLM_MODEL,
            outputCardinality: 'MULTIPLE',
          },
        }),
        node(
          'escudo',
          NodeType.ESCUDO_POST_IA,
          'validated_drupal_json',
          'destino_drupal',
          { sourceNamespace: 'llm_response', ...shieldParams },
        ),
        node(
          'destino_drupal',
          NodeType.DESTINO_DRUPAL,
          'http_result',
          null,
          destinationParams,
        ),
      ]);

    /** Bloque de apertura con su titulo formal, como lo exige el prompt. */
    const tenderBlock = (code: string, title: string): string =>
      `<div class="licitacion-entry pd-licitacion-block" data-expediente="${code}">` +
      `<h3 class="licitacion-title">${title}</h3>` +
      '<ul class="licitacion-presupuesto"><li><span class="total">39.930,00 euros</span></li></ul>' +
      '</div>';

    /** Panel de comite que apunta al sub-acordeon de su universidad. */
    const universityPanel = (code: string, accordion: string): string =>
      '<div class="panel panel-default"><div class="panel-heading"><h5 class="panel-title">' +
      `<a class="panel-toggle-link" data-parent="${accordion}" href="#collapse${code}">` +
      `<strong class="panel-comite-codigo">${code}</strong></a></h5></div>` +
      `<div class="collapse" id="collapse${code}"><div class="panel-body"><p>Comite ${code}</p></div></div></div>`;

    it(
      '8.1 Notiweb (N=5): deberia crear cinco noticias en Drupal y UNA campana en Acens con todas',
      async () => {
        // 1. Arrange 📐: el correo reenviado de un boletin con cinco noticias y
        //    un Word adjunto. El simulador, con cardinalidad MULTIPLE, devuelve
        //    un elemento por parrafo: la raiz y cuatro en `items`.
        const templateId = await seedTemplate(
          'Notiweb lote',
          '<div class="notiweb-cuerpo"></div>',
        );
        const news = [
          'La Comunidad abre la convocatoria de doctorados industriales',
          'Un consorcio madrileno lidera un proyecto europeo de baterias',
          'El parque cientifico estrena un laboratorio de biotecnologia',
          'Cuatro universidades firman una alianza de ciencia abierta',
          'La red de incubadoras incorpora diez nuevas empresas de base tecnologica',
        ];
        const flowId = await seedFlow((id) =>
          schemaOf(id, 'Notiweb en lote', 'disparador_imap', [
            imapTrigger('parser'),
            node('parser', NodeType.PARSER_PRE_IA, 'parsed_email', 'mapeador'),
            node(
              'mapeador',
              NodeType.MAPEADOR_PLANTILLA,
              'rendered_html',
              'redaccion_ia',
              { templateId },
            ),
            // El prompt cita el adjunto como marcador: asi la materia prima es
            // SOLO el cuerpo del correo, sin etiqueta, y cada noticia es un
            // parrafo para el simulador.
            mockLlm('redaccion_ia', 'escudo', '', {
              params: {
                inlinePrompt:
                  'Redacta cada noticia del boletin. Adjuntos: {{parsed_email.extracted_documents_text}}\n\n' +
                  'PLANTILLA BASE: {{*rendered_html.compiled_markup}}',
                provider: 'MOCK',
                model: MOCK_LLM_MODEL,
                outputCardinality: 'MULTIPLE',
              },
            }),
            node(
              'escudo',
              NodeType.ESCUDO_POST_IA,
              'validated_drupal_json',
              'destino_drupal',
              {
                contentMode: 'HTML',
                sourceNamespace: 'llm_response',
                sourceField: 'filled_markup',
              },
            ),
            node(
              'destino_drupal',
              NodeType.DESTINO_DRUPAL,
              'http_result',
              'campana_acens',
              {
                operationMode: DrupalOperationMode.CREATE_NODE,
                bundle: 'node--article',
                sourceNamespace: 'validated_drupal_json',
                sourceField: 'validated_markup',
                titleTemplate: '{{llm_response.headline}}',
                publishStatus: false,
              },
            ),
            node(
              'campana_acens',
              NodeType.DESTINO_ACENS,
              'acens_result',
              null,
              {
                operation: 'CREATE_CAMPAIGN',
                listId: 'boletin-e2e',
              },
            ),
          ]),
        );
        const executionId = await seedExecution(flowId, 'parser', {
          raw_email: rawEmail(
            'RV: NOTIWEB 03 de noviembre',
            news.join('\n\n'),
            [
              attachment(
                'boletin.docx',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                readFileSync(DOCX_FIXTURE),
              ),
            ],
          ),
        });

        // 2. Act ⚙️
        await resume(executionId);
        const done = await readExecution(executionId);

        // 3. Assert 🎯: cinco altas, en orden y cada una con su titular.
        expect(done.currentState).toBe(ExecutionState.EXITOSO);
        const creations = portal.callsTo('POST', `${DRUPAL_BASE_URL}/node/`);
        expect(creations).toHaveLength(5);
        expect(
          creations.map(
            (call) =>
              (call.body as { data: { attributes: { title: string } } }).data
                .attributes.title,
          ),
        ).toEqual(news);
        expect(done.contextPayload.http_result).toMatchObject({
          total_published: 5,
        });

        // Una sola campana, con el marcado validado de las cinco noticias, la
        // lista pedida y el token del entorno SOLO en la peticion.
        const campaigns = portal.callsTo('POST', ACENS_CAMPAIGN_URL);
        expect(campaigns).toHaveLength(1);
        const campaign = campaigns[0]?.body as Record<string, unknown>;
        expect(campaign.auth_token).toBe('acens-token-e2e');
        expect(campaign.lists).toEqual({ '0': 'boletin-e2e' });
        for (const headline of news) {
          expect(String(campaign.content)).toContain(headline);
        }
        expect(done.contextPayload.acens_result).toMatchObject({
          status: 'CAMPAIGN_CREATED',
          campaign_id: ACENS_CAMPAIGN_ID,
          recipient_list: 'boletin-e2e',
        });
        expect(JSON.stringify(done.contextPayload)).not.toContain(
          'acens-token-e2e',
        );
      },
      CASE_TIMEOUT_MS,
    );

    it(
      '8.2 Apertura (N=2): deberia anteponer los dos expedientes en orden, con su titulo formal y un solo PATCH',
      async () => {
        // 1. Arrange 📐
        portal.pages.set(
          OPEN_TENDERS_UUID,
          '<div data-expediente="LIC-2026-001"><p>Licitacion anterior</p></div>',
        );
        const flowId = await seedFlow((id) =>
          shieldedSchema(
            id,
            'Apertura en lote',
            {
              contentMode: 'HTML',
              sourceField: 'filled_markup',
              requiredSelectors: ['h3.licitacion-title'],
            },
            {
              operationMode: DrupalOperationMode.APPEND_HTML_BLOCK,
              bundle: 'node--page',
              targetNodeUuid: OPEN_TENDERS_UUID,
              expedienteTemplate: '{{llm_response.headline}}',
            },
          ),
        );
        const executionId = await seedExecution(flowId, 'escudo', {
          raw_email: rawEmail('Abrir licitacion V5', 'Dos expedientes nuevos.'),
          llm_response: {
            headline: 'S_2026_015',
            summary: 'Servicios de apoyo al emprendimiento innovador',
            body_paragraphs: [],
            filled_markup: tenderBlock(
              'S_2026_015',
              'S_2026_015 Servicios de apoyo al emprendimiento innovador',
            ),
            items: [
              {
                headline: 'S_2026_016',
                summary: 'Mantenimiento de la plataforma de datos',
                body_paragraphs: [],
                filled_markup: tenderBlock(
                  'S_2026_016',
                  'S_2026_016 Mantenimiento de la plataforma de datos',
                ),
              },
            ],
          },
        });

        // 2. Act ⚙️
        await resume(executionId);
        const done = await readExecution(executionId);

        // 3. Assert 🎯
        expect(done.currentState).toBe(ExecutionState.EXITOSO);
        const patches = portal.patchedHtml(OPEN_TENDERS_UUID);
        expect(patches).toHaveLength(1);
        const [patched] = patches;
        expect(patched.indexOf('S_2026_015 Servicios')).toBeLessThan(
          patched.indexOf('S_2026_016 Mantenimiento'),
        );
        expect(patched.indexOf('S_2026_016 Mantenimiento')).toBeLessThan(
          patched.indexOf('Licitacion anterior'),
        );
        // El asunto del correo no acaba como titulo de nada.
        expect(patched).not.toContain('Abrir licitacion V5');
        expect(done.contextPayload.http_result).toMatchObject({
          total_appended: 2,
        });
      },
      CASE_TIMEOUT_MS,
    );

    it(
      '8.3 Cierre (N=2): deberia trasladar los dos expedientes sin mapeador ni inferencia',
      async () => {
        // 1. Arrange 📐: la ejecucion arranca en el escudo; ningun nodo de IA
        //    corre.
        portal.pages.set(
          OPEN_TENDERS_UUID,
          '<div data-expediente="LIC-2026-004"><p>Cuatro</p></div>' +
            '<div data-expediente="LIC-2026-005"><p>Cinco</p></div>' +
            '<div data-expediente="LIC-2026-006"><p>Sigue abierta</p></div>',
        );
        portal.pages.set(CLOSED_TENDERS_UUID, '<p>Cerradas</p>');
        const flowId = await seedFlow((id) =>
          shieldedSchema(
            id,
            'Cierre en lote',
            { contentMode: 'TEXT', sourceFields: ['headline'] },
            {
              operationMode: DrupalOperationMode.TRANSFER_HTML_BLOCK,
              bundle: 'node--page',
              targetNodeUuid: OPEN_TENDERS_UUID,
              destinationNodeUuid: CLOSED_TENDERS_UUID,
              itemSelector:
                '[data-expediente="{{validated_drupal_json.validated_fields.headline}}"]',
            },
          ),
        );
        const executionId = await seedExecution(flowId, 'escudo', {
          llm_response: {
            headline: 'LIC-2026-004',
            summary: 'Adjudicada',
            body_paragraphs: [],
            items: [
              {
                headline: 'LIC-2026-005',
                summary: 'Desierta',
                body_paragraphs: [],
              },
            ],
          },
        });

        // 2. Act ⚙️
        await resume(executionId);
        const done = await readExecution(executionId);

        // 3. Assert 🎯: un PATCH por pagina, los dos movidos y el tercero quieto.
        expect(done.currentState).toBe(ExecutionState.EXITOSO);
        const [closed] = portal.patchedHtml(CLOSED_TENDERS_UUID);
        const [open] = portal.patchedHtml(OPEN_TENDERS_UUID);
        expect(portal.patchedHtml(CLOSED_TENDERS_UUID)).toHaveLength(1);
        expect(closed).toContain('LIC-2026-004');
        expect(closed).toContain('LIC-2026-005');
        expect(open).not.toContain('LIC-2026-004');
        expect(open).toContain('LIC-2026-006');
        expect(done.contextPayload.http_result).toMatchObject({
          total_transferred: 2,
        });
        expect(
          (await readNodeLogs(executionId)).map((log) => log.id_nodo),
        ).not.toContain('lote_ia');
      },
      CASE_TIMEOUT_MS,
    );

    it(
      '8.3bis Cierre (N=2) con escudo JSON: deberia trasladar los dos expedientes y parar el lote sin expediente',
      async () => {
        // 1. Arrange 📐: el escudo del maestro de cierre de la 069 (modo JSON
        //    con un esquema que exige `headline`). El payload trae arreglos
        //    (`body_paragraphs`), que el modo TEXT no podia auditar.
        const closingShield = {
          contentMode: 'JSON',
          sourceNamespace: 'llm_response',
          jsonSchema: {
            type: 'object',
            required: ['headline'],
            properties: {
              headline: { type: 'string', minLength: 1 },
              summary: { type: 'string' },
              body_paragraphs: { type: 'array', items: { type: 'string' } },
            },
          },
        };
        const transfer = {
          operationMode: DrupalOperationMode.TRANSFER_HTML_BLOCK,
          bundle: 'node--page',
          targetNodeUuid: OPEN_TENDERS_UUID,
          destinationNodeUuid: CLOSED_TENDERS_UUID,
          itemSelector:
            '[data-expediente="{{validated_drupal_json.validated_fields.headline}}"]',
        };
        portal.pages.set(
          OPEN_TENDERS_UUID,
          '<div data-expediente="LIC-2026-004"><p>Cuatro</p></div>' +
            '<div data-expediente="LIC-2026-005"><p>Cinco</p></div>' +
            '<div data-expediente="LIC-2026-006"><p>Sigue abierta</p></div>',
        );
        portal.pages.set(CLOSED_TENDERS_UUID, '<p>Cerradas</p>');
        const flowId = await seedFlow((id) =>
          shieldedSchema(id, 'Cierre JSON', closingShield, transfer),
        );
        const executionId = await seedExecution(flowId, 'escudo', {
          llm_response: {
            headline: 'LIC-2026-004',
            summary: 'Adjudicada',
            body_paragraphs: ['fecha_cierre: 2026-09-21T14:00'],
            items: [
              {
                headline: 'LIC-2026-005',
                summary: 'Desierta',
                body_paragraphs: ['estado_resolucion: desierta'],
              },
            ],
            metadata: { provider: 'ANTHROPIC' },
          },
        });
        const noCodeFlowId = await seedFlow((id) =>
          shieldedSchema(
            id,
            'Cierre JSON sin expediente',
            closingShield,
            transfer,
          ),
        );
        const noCodeExecutionId = await seedExecution(noCodeFlowId, 'escudo', {
          llm_response: {
            headline: '',
            summary: '',
            body_paragraphs: ['fecha_cierre: 2026-09-21T14:00'],
            items: [],
          },
        });

        // 2. Act ⚙️
        await resume(executionId);
        const done = await readExecution(executionId);
        await resume(noCodeExecutionId);
        const paused = await readExecution(noCodeExecutionId);

        // 3. Assert 🎯: los dos movidos, el tercero quieto; y sin expediente el
        //    flujo se para EN EL ESCUDO, sin tocar Drupal una segunda vez.
        expect(done.currentState).toBe(ExecutionState.EXITOSO);
        const [closed] = portal.patchedHtml(CLOSED_TENDERS_UUID);
        const [open] = portal.patchedHtml(OPEN_TENDERS_UUID);
        expect(closed).toContain('LIC-2026-004');
        expect(closed).toContain('LIC-2026-005');
        expect(open).toContain('LIC-2026-006');
        expect(done.contextPayload.validated_drupal_json).toMatchObject({
          validated_json: {
            headline: 'LIC-2026-004',
            body_paragraphs: ['fecha_cierre: 2026-09-21T14:00'],
          },
        });
        expect(paused.currentState).not.toBe(ExecutionState.EXITOSO);
        expect(portal.patchedHtml(CLOSED_TENDERS_UUID)).toHaveLength(1);
        expect(
          (await readNodeLogs(noCodeExecutionId)).map(
            (log) => log.codigo_error,
          ),
        ).toContain('ERR_POST_IA_SCHEMA_MISMATCH');
      },
      CASE_TIMEOUT_MS,
    );

    it(
      '8.4 Titulos (N>1): deberia repartir los paneles de ESIC, UAM, UPM y URJC en sus acordeones',
      async () => {
        // 1. Arrange 📐
        portal.pages.set(
          TITLES_UUID,
          '<div id="accordion">' +
            ['ESIC', 'UAM', 'UPM', 'URJC']
              .map((code) => `<div id="accordion${code}"></div>`)
              .join('') +
            '</div>',
        );
        const flowId = await seedFlow((id) =>
          shieldedSchema(
            id,
            'Titulos en lote',
            { contentMode: 'HTML', sourceField: 'filled_markup' },
            {
              operationMode: DrupalOperationMode.APPEND_HTML_BLOCK,
              bundle: 'node--page',
              targetNodeUuid: TITLES_UUID,
              containerSelector: '#accordion',
              insertPosition: 'APPEND',
            },
          ),
        );
        const executionId = await seedExecution(flowId, 'escudo', {
          llm_response: {
            headline: 'ESIC',
            summary: '',
            body_paragraphs: [],
            filled_markup: universityPanel('ESIC1', '#accordionESIC'),
            items: ['UAM', 'UPM', 'URJC'].map((code) => ({
              headline: code,
              summary: '',
              body_paragraphs: [],
              filled_markup: universityPanel(`${code}1`, `#accordion${code}`),
            })),
          },
        });

        // 2. Act ⚙️
        await resume(executionId);
        const done = await readExecution(executionId);

        // 3. Assert 🎯: un solo PATCH y cada panel dentro de su universidad.
        expect(done.currentState).toBe(ExecutionState.EXITOSO);
        const patches = portal.patchedHtml(TITLES_UUID);
        expect(patches).toHaveLength(1);
        const $ = cheerio.load(
          patches[0] ?? '',
          { xml: { xmlMode: false } },
          false,
        );
        for (const code of ['ESIC', 'UAM', 'UPM', 'URJC']) {
          expect($(`#accordion${code} .panel-comite-codigo`).text()).toBe(
            `${code}1`,
          );
        }
      },
      CASE_TIMEOUT_MS,
    );

    it(
      '8.5 Innodays (N=2): deberia sustituir los dos enlaces con un solo PATCH',
      async () => {
        // 1. Arrange 📐
        const html =
          '<table><tr><td>Agrifood</td><td><a href="/old-agrifood.pdf">PDF</a></td></tr>' +
          '<tr><td>Salud</td><td><a href="/old-salud.pdf">PDF</a></td></tr>' +
          '<tr><td>Energia</td><td><a href="/old-energia.pdf">PDF</a></td></tr></table>';
        portal.pages.set(INNODAYS_UUID, html);
        const flowId = await seedFlow((id) =>
          shieldedSchema(
            id,
            'Innodays en lote',
            { contentMode: 'TEXT', sourceFields: ['headline', 'summary'] },
            {
              operationMode: DrupalOperationMode.UPDATE_LINK_SOURCE,
              bundle: 'node--page',
              targetNodeUuid: INNODAYS_UUID,
              linkSelector:
                "table tr:contains('{{validated_drupal_json.validated_fields.headline}}') a",
              linkAttribute: 'href',
              linkValueTemplate:
                '{{validated_drupal_json.validated_fields.summary}}',
            },
          ),
        );
        const executionId = await seedExecution(flowId, 'escudo', {
          llm_response: {
            headline: 'Agrifood',
            summary: 'https://www.madrimasd.org/innodays/agrifood-2026.pdf',
            body_paragraphs: [],
            items: [
              {
                headline: 'Salud',
                summary: 'https://www.madrimasd.org/innodays/salud-2026.pdf',
                body_paragraphs: [],
              },
            ],
          },
        });

        // 2. Act ⚙️
        await resume(executionId);
        const done = await readExecution(executionId);

        // 3. Assert 🎯: dos enlaces nuevos, el tercero intacto y un PATCH.
        expect(done.currentState).toBe(ExecutionState.EXITOSO);
        expect(portal.patchedHtml(INNODAYS_UUID)).toHaveLength(1);
        expect(portal.pages.get(INNODAYS_UUID)).toBe(
          html
            .replace(
              'href="/old-agrifood.pdf"',
              'href="https://www.madrimasd.org/innodays/agrifood-2026.pdf"',
            )
            .replace(
              'href="/old-salud.pdf"',
              'href="https://www.madrimasd.org/innodays/salud-2026.pdf"',
            ),
        );
        expect(done.contextPayload.http_result).toMatchObject({
          total_updated: 2,
        });
      },
      CASE_TIMEOUT_MS,
    );
  });
});
