// ---------------------------------------------------------------------------
// AISLAMIENTO. Va ANTES de cualquier import de la aplicacion, y no es opcional:
// montar `AppModule` ejecuta los `onModuleInit`, que con el `.env` de
// desarrollo abririan el buzon real, programarian los cron y atenderian
// ordenes por correo. Ver `fsm-canvas-execution.e2e-spec.ts`.
// ---------------------------------------------------------------------------
process.env.IMAP_POLLING_ENABLED = 'false';
process.env.CRON_SCHEDULING_ENABLED = 'false';
process.env.INBOUND_RESUME_ENABLED = 'false';
// La base sale de `DB_NAME` del entorno y la valida `test/helpers/e2e-database.guard.ts`.

import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { PipelineValidatorService } from '@core/fsm/services/pipeline-validator.service';
import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { PROMPT_OCR_MULTIMODAL } from '@modules/nodes/dto/ocr-processor-config.dto';

import { AppModule } from './../src/app.module';

import type { INestApplication } from '@nestjs/common';

/**
 * Integridad de la siembra maestra (migracion 069) sobre la base de pruebas.
 *
 * Es de SOLO LECTURA: comprueba que lo sembrado existe y que encaja entre si,
 * no crea nada, y por eso no necesita limpieza. Lo que se mide es lo que haria
 * fallar a un operador al instanciar un maestro: un prompt o una plantilla que
 * el blueprint cita y no existe, o un grafo que el validador rechazaria.
 */

/** Arrancar Nest y conectar con PostgreSQL excede el timeout por defecto. */
const BOOTSTRAP_TIMEOUT_MS = 30_000;

const ADMIN_EMAIL = 'practicas@unuware.com';

/** Los cinco maestros, por el slug que llevan en `flowId`. */
const MASTER_SLUGS = [
  'wf-notiweb-madridmasd',
  'wf-licitacion-abrir',
  'wf-licitacion-cerrar',
  'wf-innodays-sync',
  'wf-titulos-verificacion',
] as const;

/** Proveedores de pago: cada uno necesita al menos una tarifa vigente. */
const PAID_PROVIDERS = ['ANTHROPIC', 'OPENAI', 'GEMINI'] as const;

interface BlueprintRow {
  readonly nombre: string;
  readonly configuracion_pipeline: {
    readonly flowId: string;
    readonly nodes: Record<
      string,
      {
        readonly nodeType: NodeType;
        readonly nextStep: string | null;
        readonly params: Record<string, unknown>;
      }
    >;
  };
}

describe('Siembra maestra de los cinco pipelines (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let blueprints: BlueprintRow[];

  /** Tipos de nodo en el orden en que los recorre `nextStep` desde la entrada. */
  const orderedTypes = (row: BlueprintRow, entrypoint: string): NodeType[] => {
    const { nodes } = row.configuracion_pipeline;
    const types: NodeType[] = [];
    let cursor: string | null = entrypoint;

    while (cursor !== null && types.length <= Object.keys(nodes).length) {
      const current:
        BlueprintRow['configuracion_pipeline']['nodes'][string] | undefined =
        nodes[cursor];

      if (current === undefined) break;
      types.push(current.nodeType);
      cursor = current.nextStep;
    }

    return types;
  };

  const blueprintBySlug = (slug: string): BlueprintRow => {
    const row = blueprints.find(
      (entry) => entry.configuracion_pipeline.flowId === slug,
    );

    if (row === undefined) {
      throw new Error(`No se sembro el maestro ${slug}.`);
    }

    return row;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    dataSource = app.get(DataSource);

    blueprints = await dataSource.query<BlueprintRow[]>(
      `SELECT nombre, configuracion_pipeline
         FROM plantillas_flujo
        WHERE configuracion_pipeline->>'flowId' = ANY($1)`,
      [MASTER_SLUGS],
    );
  }, BOOTSTRAP_TIMEOUT_MS);

  afterAll(async () => {
    await app?.close();
  });

  it('1. deberia existir el ADMIN ancla, activo', async () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const rows = await dataSource.query<{ rol: string; activo: boolean }[]>(
      'SELECT rol::TEXT AS rol, activo FROM usuarios WHERE correo = $1',
      [ADMIN_EMAIL],
    );

    // 3. Assert 🎯
    expect(rows).toEqual([{ rol: 'ADMIN', activo: true }]);
  });

  it('2. deberia tener en el catalogo de nodos exactamente los tipos del enum', async () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const rows = await dataSource.query<{ codigo: string }[]>(
      'SELECT codigo FROM nodos',
    );

    // 3. Assert 🎯
    expect(rows.map((row) => row.codigo).sort()).toEqual(
      Object.values(NodeType).sort(),
    );
  });

  it('3. deberia sembrar los cinco blueprints maestros', () => {
    // 3. Assert 🎯
    expect(
      blueprints.map((row) => row.configuracion_pipeline.flowId).sort(),
    ).toEqual([...MASTER_SLUGS].sort());
  });

  it('4. deberia respetar la topologia canonica de cada maestro', () => {
    // 3. Assert 🎯: el camino nominal, sin la rama de contingencia.
    const { TRIGGER_IMAP, PARSER_PRE_IA, EXTRACTOR_WEB, MAPEADOR_PLANTILLA } =
      NodeType;
    const { PROCESADOR_IA, ESCUDO_POST_IA, PAUSA_FLOW, DESTINO_DRUPAL } =
      NodeType;
    const path = (slug: string): NodeType[] =>
      orderedTypes(blueprintBySlug(slug), 'disparador_imap');

    expect(path('wf-notiweb-madridmasd')).toEqual([
      TRIGGER_IMAP,
      PARSER_PRE_IA,
      EXTRACTOR_WEB,
      MAPEADOR_PLANTILLA,
      PROCESADOR_IA,
      ESCUDO_POST_IA,
      PAUSA_FLOW,
      DESTINO_DRUPAL,
    ]);
    for (const slug of ['wf-licitacion-abrir', 'wf-titulos-verificacion']) {
      expect(path(slug)).toEqual([
        TRIGGER_IMAP,
        PARSER_PRE_IA,
        MAPEADOR_PLANTILLA,
        PROCESADOR_IA,
        ESCUDO_POST_IA,
        DESTINO_DRUPAL,
      ]);
    }
    // Cierre e Innodays/Innobar: SIN mapeador de plantilla.
    for (const slug of ['wf-licitacion-cerrar', 'wf-innodays-sync']) {
      expect(path(slug)).toEqual([
        TRIGGER_IMAP,
        PARSER_PRE_IA,
        PROCESADOR_IA,
        ESCUDO_POST_IA,
        DESTINO_DRUPAL,
      ]);
    }
  });

  it('5. deberia resolver cada prompt y cada plantilla citados contra filas activas', async () => {
    // 1. Arrange 📐
    const promptCodes = new Set<string>();
    const templateIds = new Set<string>();

    for (const row of blueprints) {
      for (const node of Object.values(row.configuracion_pipeline.nodes)) {
        const { promptCode, templateId } = node.params;

        if (typeof promptCode === 'string') promptCodes.add(promptCode);
        if (typeof templateId === 'string') templateIds.add(templateId);
      }
    }

    // 2. Act ⚙️
    const prompts = await dataSource.query<{ codigo: string }[]>(
      'SELECT codigo FROM plantillas_prompts_ia WHERE activo AND codigo = ANY($1)',
      [[...promptCodes]],
    );
    const templates = await dataSource.query<{ id: string }[]>(
      'SELECT id_plantilla::TEXT AS id FROM plantillas_html WHERE activo AND id_plantilla::TEXT = ANY($1)',
      [[...templateIds]],
    );

    // 3. Assert 🎯
    expect(promptCodes.size).toBe(5);
    expect(templateIds.size).toBe(3);
    expect(prompts.map((row) => row.codigo).sort()).toEqual(
      [...promptCodes].sort(),
    );
    expect(templates).toHaveLength(templateIds.size);
  });

  it('6. deberia pasar cada blueprint por el validador de autoria', async () => {
    // 1. Arrange 📐: el mismo validador y las mismas reglas que aplica
    //    `WorkflowTemplatesService.create` antes de aceptar un maestro.
    const validator = app.get(PipelineValidatorService);

    // 2. Act ⚙️ + 3. Assert 🎯
    for (const row of blueprints) {
      await expect(
        validator.validateSchema(row.configuracion_pipeline, {
          authoring: true,
        }),
      ).resolves.toBeDefined();
    }
  });

  it('7. deberia tener al menos una tarifa vigente por proveedor de pago', async () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const rows = await dataSource.query<{ proveedor_ia: string }[]>(
      'SELECT DISTINCT proveedor_ia FROM precios_modelos_ia WHERE activo',
    );

    // 3. Assert 🎯
    expect(rows.map((row) => row.proveedor_ia)).toEqual(
      expect.arrayContaining([...PAID_PROVIDERS]),
    );
  });

  it('8. deberia dejar NOTIWEB_DEFAULT con encabezados semanticos y la directiva obligatoria', async () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const [row] = await dataSource.query<{ texto_prompt: string }[]>(
      "SELECT texto_prompt FROM plantillas_prompts_ia WHERE codigo = 'NOTIWEB_DEFAULT'",
    );

    // 3. Assert 🎯
    expect(row?.texto_prompt).toContain('<h2>');
    expect(row?.texto_prompt).toContain('{{*parsed_email.clean_body}}');
    expect(row?.texto_prompt).toContain('(2026, 24 de febrero)');
    expect(row?.texto_prompt).not.toContain('sin encabezados');
  });

  it('9. deberia copiar literalmente el prompt OCR por defecto del codigo', async () => {
    // 1. Arrange 📐 + 2. Act ⚙️: si alguien cambia la constante, esta prueba
    //    avisa de que la fila de referencia del catalogo se quedo atras.
    const [row] = await dataSource.query<{ texto_prompt: string }[]>(
      "SELECT texto_prompt FROM plantillas_prompts_ia WHERE codigo = 'PROMPT_OCR_MULTIMODAL'",
    );

    // 3. Assert 🎯
    expect(row?.texto_prompt).toBe(PROMPT_OCR_MULTIMODAL);
  });

  it('10. deberia auditar la siembra a nombre del ADMIN ancla', async () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const rows = await dataSource.query<{ tabla_afectada: string }[]>(
      `SELECT DISTINCT a.tabla_afectada
         FROM audit_eventos a
         JOIN usuarios u ON u.id_usuario = a.usuario_id
        WHERE u.correo = $1
          AND a.datos_nuevos->>'origen' = 'SEED_MASTER_DATA'`,
      [ADMIN_EMAIL],
    );

    // 3. Assert 🎯
    expect(rows.map((row) => row.tabla_afectada)).toContain('plantillas_flujo');
  });
});
