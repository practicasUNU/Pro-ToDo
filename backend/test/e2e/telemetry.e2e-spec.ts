// ---------------------------------------------------------------------------
// AISLAMIENTO. Va ANTES de cualquier import de la aplicacion, y no es opcional:
// `ConfigModule` no sobrescribe lo que ya esta en `process.env`, asi que esto
// gana sobre `backend/.env` (ver `executions-resume.e2e-spec.ts`).
//
// Las claves de proveedor son FICTICIAS a proposito. El catalogo solo considera
// usable un proveedor con credencial, asi que hacen falta para que los nodos
// no degraden al simulador; y si una ruta escapara al doble de
// `HttpClientService`, una clave falsa garantiza un 401 en vez de una
// inferencia facturada con la clave real del `.env`.
// ---------------------------------------------------------------------------
process.env.IMAP_POLLING_ENABLED = 'false';
process.env.CRON_SCHEDULING_ENABLED = 'false';
process.env.INBOUND_RESUME_ENABLED = 'false';
process.env.DB_NAME = process.env.E2E_DB_NAME ?? '<nombre_bd_test>';
process.env.GEMINI_API_KEY = 'e2e-clave-ficticia-gemini';
process.env.ANTHROPIC_API_KEY = 'e2e-clave-ficticia-anthropic';

import { ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { generateDevJwt } from '@common/utils/dev-jwt.util';
import { HttpClientService } from '@core/http/http-client.service';
import { ExecutionState } from '@core/fsm/types/fsm.enums';
import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { UserRole } from '@modules/users/enums/user-role.enum';

import { AppModule } from '../../src/app.module';

import type { INestApplication } from '@nestjs/common';
import type { AxiosRequestConfig } from 'axios';
import type { Response } from 'superagent';
import type { App } from 'supertest/types';
import type { PipelineSchemaDto } from '@core/fsm/dto/pipeline-schema.dto';

/** Arrancar Nest y conectar con PostgreSQL excede el timeout por defecto. */
const BOOTSTRAP_TIMEOUT_MS = 30_000;

/** Identidad del token de pruebas. `JwtStrategy` no consulta `usuarios`. */
const TEST_USER_ID = '00000000-0000-0000-0000-0000000000e2';
const TEST_USER_EMAIL = 'e2e-telemetria@unuware.com';

const E2E_FLOW_PREFIX = '[E2E telemetria]';

const OCR_NODE_ID = 'nodo_ocr';
const LLM_NODE_ID = 'nodo_ia';

/** Modelo de Gemini SIN fila en `precios_modelos_ia`: cae en la tarifa '*'. */
const UNPRICED_GEMINI_MODEL = 'gemini-9-experimental';

/** Contadores que devuelven los dobles de cada proveedor. */
const GEMINI_USAGE = { prompt: 2_000, completion: 300, thoughts: 100 };
const ANTHROPIC_USAGE = { input: 1_000, output: 500 };

/** Contrato formal que ambos proveedores devuelven como texto JSON. */
const CONTRACT = JSON.stringify({
  headline: 'Titular de prueba',
  summary: 'Resumen de prueba',
  body_paragraphs: ['Texto transcrito del documento escaneado.'],
});

/** Respuesta canned de `generateContent` (Gemini), con razonamiento aparte. */
const geminiResponse = {
  candidates: [
    { content: { parts: [{ text: CONTRACT }] }, finishReason: 'STOP' },
  ],
  usageMetadata: {
    promptTokenCount: GEMINI_USAGE.prompt,
    candidatesTokenCount: GEMINI_USAGE.completion,
    thoughtsTokenCount: GEMINI_USAGE.thoughts,
  },
};

/** Respuesta canned de la Messages API (Anthropic). */
const anthropicResponse = {
  content: [{ type: 'text', text: CONTRACT }],
  usage: {
    input_tokens: ANTHROPIC_USAGE.input,
    output_tokens: ANTHROPIC_USAGE.output,
  },
  stop_reason: 'end_turn',
};

/** Correo simulado con un escaneo: lo que el OCR necesita para trabajar. */
const MOCK_DATA = {
  raw_email: {
    subject: 'Nota de prensa escaneada',
    attachments: [
      {
        filename: 'escaneo.png',
        contentType: 'image/png',
        contentBase64: 'iVBORw0KGgo=',
      },
    ],
  },
};

/** disparo (omitido en execute-test) -> PROCESADOR_OCR -> PROCESADOR_IA. */
const buildSchema = (flowId: string, ocrModel: string): PipelineSchemaDto => ({
  flowId,
  name: 'Pipeline de telemetria e2e',
  version: '1.0.0',
  entrypoint: 'nodo_trigger',
  nodes: {
    nodo_trigger: {
      nodeId: 'nodo_trigger',
      nodeType: NodeType.TRIGGER_IMAP,
      outputNamespace: 'raw_email',
      nextStep: OCR_NODE_ID,
      onErrorStep: null,
      params: {},
    },
    [OCR_NODE_ID]: {
      nodeId: OCR_NODE_ID,
      nodeType: NodeType.PROCESADOR_OCR,
      outputNamespace: 'ocr_result',
      nextStep: LLM_NODE_ID,
      onErrorStep: null,
      params: { provider: 'GEMINI', model: ocrModel, maxRetries: 0 },
    },
    [LLM_NODE_ID]: {
      nodeId: LLM_NODE_ID,
      nodeType: NodeType.PROCESADOR_IA,
      outputNamespace: 'llm_response',
      nextStep: null,
      onErrorStep: null,
      params: {
        provider: 'ANTHROPIC',
        model: 'claude-sonnet-5-5',
        inlinePrompt: 'Redacta una noticia breve con el texto recibido.',
        maxRetries: 0,
      },
    },
  },
});

/** Fila de `telemetria_tokens_ia` tal como sale de `pg` (NUMERIC = texto). */
interface TelemetryRow {
  nodo_id: string;
  proveedor_ia: string;
  modelo_ia: string;
  tokens_prompt: number;
  tokens_completacion: number;
  tokens_razonamiento: number;
  tokens_totales: number;
  tarifa_prompt_usd: string;
  tarifa_completacion_usd: string;
  tarifa_razonamiento_usd: string;
  costo_estimado_usd: string;
  es_estimado: boolean;
  flujo_id: string;
}

/** Coste esperado en USD con tarifas por millon de tokens. */
const expectedCost = (
  tokens: readonly [number, number, number],
  rates: readonly [number, number, number],
): number =>
  Math.round(
    ((tokens[0] * rates[0] + tokens[1] * rates[1] + tokens[2] * rates[2]) /
      1_000_000) *
      1_000_000,
  ) / 1_000_000;

/** Cuerpo binario de una descarga como Buffer. */
const binaryParser = (
  response: Response,
  callback: (error: Error | null, body: Buffer) => void,
): void => {
  // En Node, la respuesta de superagent ES el flujo HTTP entrante: sus tipos
  // solo describen la vista ya parseada, de ahi la conversion.
  const stream = response as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  stream.on('end', () => callback(null, Buffer.concat(chunks)));
};

describe('Telemetria de tokens de IA (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let token: string;
  let creatorId: string;

  /** Flujos sembrados por esta suite, para borrarlos por id en el teardown. */
  const seededFlowIds: string[] = [];

  const httpServer = (): App => app.getHttpServer() as App;

  /** Siembra un flujo INACTIVO con el pipeline OCR -> IA. */
  const seedFlow = async (ocrModel: string): Promise<string> => {
    const rows = await dataSource.query<Array<{ id_flujo: string }>>(
      `INSERT INTO flujos (nombre, descripcion, status, id_usuario_creador)
       VALUES ($1, $2, 'INACTIVO', $3)
       RETURNING id_flujo`,
      [
        `${E2E_FLOW_PREFIX} ${Date.now()}-${seededFlowIds.length}`,
        'Flujo sembrado por la suite de telemetria.',
        creatorId,
      ],
    );
    const [{ id_flujo: flowId }] = rows;
    seededFlowIds.push(flowId);

    await dataSource.query(
      `UPDATE flujos SET configuracion_pipeline = $1 WHERE id_flujo = $2`,
      [JSON.stringify(buildSchema(flowId, ocrModel)), flowId],
    );

    return flowId;
  };

  /** Dispara el flujo por el Camino B y devuelve la ejecucion resultante. */
  const runFlow = async (
    flowId: string,
  ): Promise<{ executionId: string; status: ExecutionState }> => {
    const response = await request(httpServer())
      .post(`/api/workflows/${flowId}/execute-test`)
      .set('Authorization', `Bearer ${token}`)
      .send({ mockData: MOCK_DATA })
      .expect(200);

    return response.body as { executionId: string; status: ExecutionState };
  };

  const telemetryOf = (executionId: string): Promise<TelemetryRow[]> =>
    dataSource.query<TelemetryRow[]>(
      `SELECT * FROM telemetria_tokens_ia WHERE ejecucion_id = $1 ORDER BY creado_en, nodo_id`,
      [executionId],
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    // Igual que `main.ts`: sin esto las rutas colgarian de la raiz y los DTO no
    // se validarian.
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true }),
    );
    await app.init();

    dataSource = app.get(DataSource);
    token = generateDevJwt(app.get(JwtService), {
      userId: TEST_USER_ID,
      email: TEST_USER_EMAIL,
      role: UserRole.EDITOR,
    });

    // UNICA frontera con la red. Los proveedores reales se ejecutan enteros
    // —construccion de la peticion, parseo, mapeo del `usage`— y solo la
    // llamada HTTP devuelve una respuesta preparada. Asi la prueba cubre el
    // camino real del consumo hasta la fila de PostgreSQL.
    jest
      .spyOn(app.get(HttpClientService), 'request')
      .mockImplementation((config: AxiosRequestConfig) => {
        const url = config.url ?? '';

        if (url.includes('generativelanguage.googleapis.com')) {
          return Promise.resolve({ data: geminiResponse as never });
        }

        if (url.includes('api.anthropic.com')) {
          return Promise.resolve({ data: anthropicResponse as never });
        }

        throw new Error(`Peticion saliente inesperada en la suite e2e: ${url}`);
      });

    const admins = await dataSource.query<Array<{ id_usuario: string }>>(
      `SELECT id_usuario FROM usuarios WHERE rol = 'ADMIN' AND activo = TRUE LIMIT 1`,
    );

    if (admins.length === 0) {
      throw new Error(
        'No hay ningun usuario ADMIN activo en la base de pruebas: ejecuta `npm run test:bootstrap`.',
      );
    }

    creatorId = admins[0].id_usuario;

    const pricing = await dataSource.query<Array<{ total: string }>>(
      `SELECT count(*)::text AS total FROM precios_modelos_ia WHERE proveedor_ia = 'GEMINI'`,
    );

    if (Number(pricing[0]?.total ?? '0') === 0) {
      throw new Error(
        'La base de pruebas no tiene las tarifas de Gemini: ejecuta `npm run test:migrate` (migraciones 045 y 046).',
      );
    }
  }, BOOTSTRAP_TIMEOUT_MS);

  afterAll(async () => {
    if (seededFlowIds.length > 0) {
      // Por id, nunca por patron: ejecuciones y telemetria caen en cascada.
      await dataSource.query(`DELETE FROM flujos WHERE id_flujo = ANY($1)`, [
        seededFlowIds,
      ]);
    }

    jest.restoreAllMocks();
    await app.close();
  });

  describe('1. Registro de cada inferencia', () => {
    let flowId: string;
    let executionId: string;
    let rows: TelemetryRow[];

    beforeAll(async () => {
      flowId = await seedFlow('gemini-3.6-flash');
      const execution = await runFlow(flowId);
      executionId = execution.executionId;

      expect(execution.status).toBe(ExecutionState.EXITOSO);
      rows = await telemetryOf(executionId);
    }, BOOTSTRAP_TIMEOUT_MS);

    it('1.1 deberia insertar una fila por cada nodo de IA', () => {
      // 3. Assert 🎯
      expect(rows.map((row) => row.nodo_id).sort()).toEqual(
        [LLM_NODE_ID, OCR_NODE_ID].sort(),
      );
      expect(rows.every((row) => row.flujo_id === flowId)).toBe(true);
    });

    it('1.2 PROCESADOR_OCR deberia registrar tokens, razonamiento y tarifas de Gemini', () => {
      // 1. Arrange 📐
      const row = rows.find((candidate) => candidate.nodo_id === OCR_NODE_ID);

      // 3. Assert 🎯: tarifas sembradas por la 046 (0.075 / 0.30 / 0.30).
      expect(row).toMatchObject({
        proveedor_ia: 'GEMINI',
        modelo_ia: 'gemini-3.6-flash',
        tokens_prompt: GEMINI_USAGE.prompt,
        tokens_completacion: GEMINI_USAGE.completion,
        tokens_razonamiento: GEMINI_USAGE.thoughts,
        tokens_totales:
          GEMINI_USAGE.prompt + GEMINI_USAGE.completion + GEMINI_USAGE.thoughts,
        es_estimado: false,
      });
      expect(Number(row?.tarifa_prompt_usd)).toBe(0.075);
      expect(Number(row?.tarifa_completacion_usd)).toBe(0.3);
      expect(Number(row?.tarifa_razonamiento_usd)).toBe(0.3);
      expect(Number(row?.costo_estimado_usd)).toBe(
        expectedCost(
          [GEMINI_USAGE.prompt, GEMINI_USAGE.completion, GEMINI_USAGE.thoughts],
          [0.075, 0.3, 0.3],
        ),
      );
    });

    it('1.3 PROCESADOR_IA deberia registrar tokens y tarifas de Anthropic', () => {
      // 1. Arrange 📐
      const row = rows.find((candidate) => candidate.nodo_id === LLM_NODE_ID);

      // 3. Assert 🎯: el thinking de Claude va dentro de `output_tokens`.
      expect(row).toMatchObject({
        proveedor_ia: 'ANTHROPIC',
        modelo_ia: 'claude-sonnet-5-5',
        tokens_prompt: ANTHROPIC_USAGE.input,
        tokens_completacion: ANTHROPIC_USAGE.output,
        tokens_razonamiento: 0,
        es_estimado: false,
      });
      expect(Number(row?.tarifa_prompt_usd)).toBe(2);
      expect(Number(row?.tarifa_completacion_usd)).toBe(10);
      expect(Number(row?.costo_estimado_usd)).toBe(
        expectedCost(
          [ANTHROPIC_USAGE.input, ANTHROPIC_USAGE.output, 0],
          [2, 10, 10],
        ),
      );
    });

    it('1.4 deberia publicar las mismas metricas en el namespace del nodo', async () => {
      // 2. Act ⚙️
      const response = await request(httpServer())
        .get(`/api/executions/${executionId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      // 3. Assert 🎯
      const { context } = response.body as {
        context: Record<string, { metadata?: Record<string, unknown> }>;
      };
      expect(context.ocr_result?.metadata).toMatchObject({
        tokensReasoning: GEMINI_USAGE.thoughts,
        totalTokens:
          GEMINI_USAGE.prompt + GEMINI_USAGE.completion + GEMINI_USAGE.thoughts,
      });
      expect(context.llm_response?.metadata).toMatchObject({
        totalTokens: ANTHROPIC_USAGE.input + ANTHROPIC_USAGE.output,
        estimatedCostUSD: expectedCost(
          [ANTHROPIC_USAGE.input, ANTHROPIC_USAGE.output, 0],
          [2, 10, 10],
        ),
      });
    });
  });

  describe('2. Modelo sin tarifa propia', () => {
    it(
      '2.1 deberia aplicar la tarifa generica de Gemini y marcar es_estimado',
      async () => {
        // 1. Arrange 📐
        const flowId = await seedFlow(UNPRICED_GEMINI_MODEL);

        // 2. Act ⚙️
        const { executionId } = await runFlow(flowId);
        const rows = await telemetryOf(executionId);
        const row = rows.find((candidate) => candidate.nodo_id === OCR_NODE_ID);

        // 3. Assert 🎯: comodin '*' de la 046 (0.10 / 0.40 / 0.40).
        expect(row?.modelo_ia).toBe(UNPRICED_GEMINI_MODEL);
        expect(row?.es_estimado).toBe(true);
        expect(Number(row?.tarifa_prompt_usd)).toBe(0.1);
        expect(Number(row?.tarifa_completacion_usd)).toBe(0.4);
        expect(Number(row?.costo_estimado_usd)).toBe(
          expectedCost(
            [
              GEMINI_USAGE.prompt,
              GEMINI_USAGE.completion,
              GEMINI_USAGE.thoughts,
            ],
            [0.1, 0.4, 0.4],
          ),
        );
      },
      BOOTSTRAP_TIMEOUT_MS,
    );
  });

  describe('3. Agregados y exportaciones', () => {
    it(
      '3.1 summary y breakdown deberian reflejar el consumo del flujo',
      async () => {
        // 1. Arrange 📐
        const flowId = await seedFlow('gemini-3.6-flash');
        await runFlow(flowId);

        // 2. Act ⚙️
        const summary = await request(httpServer())
          .get('/api/telemetry/summary')
          .query({ flowId })
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        const breakdown = await request(httpServer())
          .get('/api/telemetry/breakdown-by-model')
          .query({ flowId })
          .set('Authorization', `Bearer ${token}`)
          .expect(200);

        // 3. Assert 🎯
        expect(summary.body).toMatchObject({
          aiInvocations: 2,
          estimatedInvocations: 0,
          totalTokens:
            GEMINI_USAGE.prompt +
            GEMINI_USAGE.completion +
            GEMINI_USAGE.thoughts +
            ANTHROPIC_USAGE.input +
            ANTHROPIC_USAGE.output,
          executionsTotal: 1,
          executionsSucceeded: 1,
          successRate: 1,
        });
        expect(
          (breakdown.body as Array<{ aiModel: string }>).map(
            (row) => row.aiModel,
          ),
        ).toEqual(['claude-sonnet-5-5', 'gemini-3.6-flash']);
      },
      BOOTSTRAP_TIMEOUT_MS,
    );

    it('3.2 deberia descargar el CSV con sus cabeceras de adjunto', async () => {
      // 2. Act ⚙️
      const response = await request(httpServer())
        .get('/api/telemetry/export/csv')
        .set('Authorization', `Bearer ${token}`)
        .buffer(true)
        .parse(binaryParser)
        .expect(200);

      // 3. Assert 🎯
      expect(response.headers['content-type']).toContain('text/csv');
      expect(response.headers['content-disposition']).toBe(
        'attachment; filename=informe-telemetria.csv',
      );
      expect((response.body as Buffer).toString('utf8')).toContain(
        'claude-sonnet-5-5',
      );
    });

    it(
      '3.3 deberia generar un PDF real con Chromium',
      async () => {
        // 2. Act ⚙️
        const response = await request(httpServer())
          .get('/api/telemetry/export/pdf')
          .set('Authorization', `Bearer ${token}`)
          .buffer(true)
          .parse(binaryParser)
          .expect(200);

        // 3. Assert 🎯
        expect(response.headers['content-type']).toBe('application/pdf');
        expect(response.headers['content-disposition']).toBe(
          'attachment; filename=informe-telemetria.pdf',
        );
        expect((response.body as Buffer).subarray(0, 4).toString()).toBe(
          '%PDF',
        );
      },
      BOOTSTRAP_TIMEOUT_MS,
    );
  });

  describe('4. Asistente de prompts (migracion 049)', () => {
    /** Inicio de la seccion, para borrar solo las filas que crea. */
    const startedAt = new Date().toISOString();

    afterAll(async () => {
      await dataSource.query(
        `DELETE FROM telemetria_tokens_ia
          WHERE origen_operacion = 'PROMPT_OPTIMIZATION'
            AND usuario_id = $1 AND creado_en >= CAST($2 AS timestamptz)`,
        [creatorId, startedAt],
      );
    });

    it('4.1 deberia registrar el consumo con origen y usuario, sin ejecucion', async () => {
      // 1. Arrange 📐: un usuario REAL, porque `usuario_id` tiene FK.
      const userToken = generateDevJwt(app.get(JwtService), {
        userId: creatorId,
        email: 'e2e-prompts@unuware.com',
        role: UserRole.EDITOR,
      });

      // 2. Act ⚙️
      const response = await request(httpServer())
        .post('/api/prompts/optimize')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          draftPrompt: 'Resume el correo.',
          targetFormat: 'text',
          model: 'gemini-3.6-flash',
        })
        .expect(200);

      // 3. Assert 🎯
      const body = response.body as {
        optimizedPrompt: string;
        telemetry: { tokensPrompt: number; estimatedCostUSD: number };
      };
      expect(body.optimizedPrompt).toBe('Resumen de prueba');
      expect(body.telemetry.tokensPrompt).toBe(GEMINI_USAGE.prompt);

      const rows = await dataSource.query<
        Array<TelemetryRow & { origen_operacion: string; ejecucion_id: null }>
      >(
        `SELECT * FROM telemetria_tokens_ia
          WHERE origen_operacion = 'PROMPT_OPTIMIZATION' AND usuario_id = $1
            AND creado_en >= CAST($2 AS timestamptz)`,
        [creatorId, startedAt],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        ejecucion_id: null,
        flujo_id: null,
        nodo_id: null,
        tokens_prompt: GEMINI_USAGE.prompt,
        tokens_razonamiento: GEMINI_USAGE.thoughts,
      });
      expect(Number(rows[0].costo_estimado_usd)).toBeCloseTo(
        body.telemetry.estimatedCostUSD,
        6,
      );
    });

    it('4.2 el CHECK deberia impedir una fila de flujo sin ejecucion', async () => {
      // 2. Act ⚙️ + 3. Assert 🎯
      await expect(
        dataSource.query(
          `INSERT INTO telemetria_tokens_ia (proveedor_ia, modelo_ia) VALUES ('GEMINI', 'x')`,
        ),
      ).rejects.toThrow(/chk_telemetria_origen_coherente/);
    });
  });
});
