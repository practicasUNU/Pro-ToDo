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

/** Prompts que rellenan una PLANTILLA BASE (flujos con mapeador). */
const TEMPLATED_PROMPTS: readonly string[] = [
  'NOTIWEB_DEFAULT',
  'LICITACION_APERTURA_DEFAULT',
  'VERIFICADOR_TITULOS_DEFAULT',
];

/** Prompts sin plantilla: solo devuelven campos de texto. */
const PLAIN_TEXT_PROMPTS: readonly string[] = [
  'LICITACION_CIERRE_DEFAULT',
  'INNODAYS_ENLACE_DEFAULT',
  'INNOBAR_ENLACE_DEFAULT',
];

/**
 * Prompts que ofrecen el OCR: todos los que leen el correo. Los que citan
 * adjuntos lo llevan junto a ellos; Innodays e Innobar, tras el correo.
 */
const DOCUMENT_PROMPTS: readonly string[] = [
  'NOTIWEB_DEFAULT',
  'LICITACION_APERTURA_DEFAULT',
  'LICITACION_CIERRE_DEFAULT',
  'VERIFICADOR_TITULOS_DEFAULT',
  'INNODAYS_ENLACE_DEFAULT',
  'INNOBAR_ENLACE_DEFAULT',
];

/** Marcador obligatorio `{{*ns.campo}}`; el grupo 1 es la ruta. */
const MANDATORY_MARKER = /\{\{\s*\*\s*([a-z_]+\.[a-z_]+)\s*\}\}/g;

interface BlueprintRow {
  readonly nombre: string;
  readonly configuracion_pipeline: {
    readonly flowId: string;
    readonly nodes: Record<
      string,
      {
        readonly nodeType: NodeType;
        readonly nextStep: string | null;
        readonly onErrorStep:
          | string
          | { readonly targetNode: string; readonly catchErrors?: string[] }
          | null;
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
    const { DESTINO_ACENS } = NodeType;
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
      // Destino tras destino (regla 11): la campana del boletin con el mismo
      // marcado validado que se publico.
      DESTINO_ACENS,
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

  describe('11. Prompts maestros enriquecidos (paso 5b)', () => {
    let promptsByCode: ReadonlyMap<string, string>;

    beforeAll(async () => {
      const rows = await dataSource.query<
        { codigo: string; texto_prompt: string }[]
      >(
        'SELECT codigo, texto_prompt FROM plantillas_prompts_ia WHERE codigo = ANY($1)',
        [[...TEMPLATED_PROMPTS, ...PLAIN_TEXT_PROMPTS]],
      );
      promptsByCode = new Map(
        rows.map((row) => [row.codigo, row.texto_prompt]),
      );
    });

    const promptOf = (code: string): string => {
      const text = promptsByCode.get(code);

      if (text === undefined) {
        throw new Error(`No se sembro el prompt ${code}.`);
      }

      return text;
    };

    it('11.1 deberia llevar la directiva de polivalencia adecuada a cada prompt', () => {
      // 3. Assert 🎯: donde hay PLANTILLA BASE, la que prohibe volcar
      //    Markdown en "filled_markup" (apertura trae su propia redaccion,
      //    "RESTRICCIÓN DE MARKDOWN"); donde no la hay, la de texto plano.
      for (const code of TEMPLATED_PROMPTS) {
        expect(promptOf(code)).toMatch(
          /DIRECTIVA DE POLIVALENCIA Y (ESTRUCTURACIÓN HTML|RESTRICCIÓN DE MARKDOWN)/,
        );
        expect(promptOf(code)).toContain('"filled_markup"');
      }
      for (const code of PLAIN_TEXT_PROMPTS) {
        expect(promptOf(code)).toContain(
          'DIRECTIVA DE POLIVALENCIA Y ESTRUCTURACIÓN DE TEXTO',
        );
        expect(promptOf(code)).not.toContain('"filled_markup"');
      }
    });

    it('11.2 deberia blindar la extraccion de apertura y el rotulo bibliografico de Notiweb', () => {
      // 3. Assert 🎯: titulo formal y nunca el asunto, expediente e importes
      //    en sus ranuras, y ningun dato estimado.
      const apertura = promptOf('LICITACION_APERTURA_DEFAULT');

      expect(apertura).toContain(
        'REGLAS DE EXTRACCIÓN Y TITULACIÓN OBLIGATORIAS',
      );
      expect(apertura).toContain('NUNCA el asunto del correo');
      expect(apertura).toContain('<h3 class="licitacion-title">');
      expect(apertura).toContain('data-expediente="S_2026_015"');
      for (const slot of ['base-imponible', 'iva', 'total']) {
        expect(apertura).toContain(`<span class="${slot}">`);
      }
      expect(apertura).toContain(
        'NUNCA lo calcules, lo deduzcas ni lo estimes',
      );
      expect(apertura).not.toContain('QUIDA');
      expect(promptOf('NOTIWEB_DEFAULT')).toContain(
        '<h2>Referencia bibliográfica</h2>, seguido de uno o varios párrafos <p class="notiweb-referencia">',
      );
    });

    it('11.3 deberia ofrecer el OCR como opcional, una sola vez, en todos los prompts del correo', () => {
      // 3. Assert 🎯: una sola vez, para no repetir material en el prompt.
      for (const code of DOCUMENT_PROMPTS) {
        expect(promptOf(code).split('{{ocr_result.clean_body}}')).toHaveLength(
          2,
        );
      }
    });

    it('11.4 deberia marcar como obligatorias solo la directiva y la plantilla base', () => {
      // 3. Assert 🎯
      for (const code of [...TEMPLATED_PROMPTS, ...PLAIN_TEXT_PROMPTS]) {
        const mandatory = new Set(
          [...promptOf(code).matchAll(MANDATORY_MARKER)].map(
            (match) => match[1],
          ),
        );
        const expected = TEMPLATED_PROMPTS.includes(code)
          ? ['parsed_email.clean_body', 'rendered_html.compiled_markup']
          : ['parsed_email.clean_body'];

        expect([...mandatory].sort()).toEqual(expected);
      }
    });
  });

  it('12. deberia exigir la ranura h3.licitacion-title en el escudo del maestro de apertura', () => {
    // 3. Assert 🎯
    const escudo:
      BlueprintRow['configuracion_pipeline']['nodes'][string] | undefined =
      blueprintBySlug('wf-licitacion-abrir').configuracion_pipeline.nodes[
        'escudo'
      ];

    expect(escudo?.params.requiredSelectors).toEqual(['h3.licitacion-title']);
  });

  describe('13. Cardinalidad 1 a N', () => {
    it('13.1 deberia pedir un lote (MULTIPLE) al PROCESADOR_IA de los cinco maestros', () => {
      // 3. Assert 🎯
      for (const slug of MASTER_SLUGS) {
        const processors = Object.values(
          blueprintBySlug(slug).configuracion_pipeline.nodes,
        ).filter((entry) => entry.nodeType === NodeType.PROCESADOR_IA);

        expect(processors).toHaveLength(1);
        expect(processors[0]?.params.outputCardinality).toBe('MULTIPLE');
      }
    });

    it('13.2 deberia llevar la regla de cardinalidad asimetrica en los seis prompts', async () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const rows = await dataSource.query<
        { codigo: string; texto_prompt: string }[]
      >(
        'SELECT codigo, texto_prompt FROM plantillas_prompts_ia WHERE codigo = ANY($1)',
        [[...TEMPLATED_PROMPTS, ...PLAIN_TEXT_PROMPTS]],
      );

      // 3. Assert 🎯: una vez cada uno, con el reparto raiz = primero.
      expect(rows).toHaveLength(6);
      for (const row of rows) {
        expect(
          row.texto_prompt.split('REGLA DE CARDINALIDAD FLEXIBLE'),
        ).toHaveLength(2);
        expect(row.texto_prompt).toContain('el PRIMER elemento');
      }
    });

    it('13.3 deberia cerrar Notiweb con la campana de Acens sobre el marcado validado', () => {
      // 3. Assert 🎯
      const { nodes } = blueprintBySlug(
        'wf-notiweb-madridmasd',
      ).configuracion_pipeline;

      expect(nodes['destino_drupal']?.nextStep).toBe('campana_acens');
      expect(nodes['campana_acens']).toMatchObject({
        nodeType: NodeType.DESTINO_ACENS,
        nextStep: null,
        params: {
          operation: 'CREATE_CAMPAIGN',
          contentNamespace: 'validated_drupal_json',
        },
      });
    });

    it('13.4 deberia describir el modo campana de DESTINO_ACENS en el catalogo', async () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const [row] = await dataSource.query<{ descripcion: string }[]>(
        "SELECT descripcion FROM nodos WHERE codigo = 'DESTINO_ACENS'",
      );

      // 3. Assert 🎯
      expect(row?.descripcion).toContain('CREATE_CAMPAIGN');
    });
  });

  describe('14. Contingencias y prompts blindados (pasos 5d y 6d-6e)', () => {
    /** Tipos que deben avisar por correo cuando fallan. */
    const ALERTED_TYPES: ReadonlySet<NodeType> = new Set([
      NodeType.EXTRACTOR_WEB,
      NodeType.MAPEADOR_PLANTILLA,
      NodeType.PROCESADOR_IA,
      NodeType.ESCUDO_POST_IA,
      NodeType.DESTINO_DRUPAL,
      NodeType.DESTINO_ACENS,
      NodeType.PROCESADOR_OCR,
    ]);

    it('14.1 deberia declarar un unico alerta_smtp (DESTINO_SMTP) terminal en los cinco maestros', () => {
      // 3. Assert 🎯
      for (const slug of MASTER_SLUGS) {
        const { nodes } = blueprintBySlug(slug).configuracion_pipeline;
        const smtpNodes = Object.values(nodes).filter(
          (entry) => entry.nodeType === NodeType.DESTINO_SMTP,
        );

        expect(smtpNodes).toHaveLength(1);
        expect(nodes['alerta_smtp']).toMatchObject({
          nodeType: NodeType.DESTINO_SMTP,
          nextStep: null,
          onErrorStep: null,
        });
      }
    });

    it('14.2 deberia enrutar a alerta_smtp el fallo de cada nodo de procesamiento y destino', () => {
      // 3. Assert 🎯
      for (const slug of MASTER_SLUGS) {
        const { nodes } = blueprintBySlug(slug).configuracion_pipeline;
        const alerted = Object.entries(nodes).filter(([, entry]) =>
          ALERTED_TYPES.has(entry.nodeType),
        );

        expect(alerted.length).toBeGreaterThan(0);
        for (const [key, entry] of alerted) {
          expect({ slug, key, onErrorStep: entry.onErrorStep }).toEqual({
            slug,
            key,
            onErrorStep: 'alerta_smtp',
          });
        }
      }
    });

    it('14.3 deberia desviar SOLO los escaneos del parser al satelite ocr_ia', () => {
      // 3. Assert 🎯
      for (const slug of MASTER_SLUGS) {
        const { nodes } = blueprintBySlug(slug).configuracion_pipeline;
        const parser = nodes['parser'];

        expect(parser?.onErrorStep).toEqual({
          targetNode: 'ocr_ia',
          catchErrors: ['ERR_PARSER_UNEXTRACTABLE_MEDIA'],
        });
        expect(parser?.params.failOnUnextractableMedia).toBe(true);
        expect(nodes['ocr']).toBeUndefined();
        expect(nodes['ocr_ia']).toMatchObject({
          nodeType: NodeType.PROCESADOR_OCR,
          outputNamespace: 'ocr_result',
          // Se reincorpora en el paso nominal que sigue al parser.
          nextStep: parser?.nextStep,
          onErrorStep: 'alerta_smtp',
        });
      }
    });

    it('14.4 deberia exigir el encabezado del panel en el escudo del maestro de titulos', () => {
      // 3. Assert 🎯
      const escudo = blueprintBySlug('wf-titulos-verificacion')
        .configuracion_pipeline.nodes['escudo'];

      expect(escudo?.params.requiredSelectors).toEqual([
        '.panel-title',
        '.panel-comite-codigo',
        '.panel-facultad-nombre',
      ]);
    });

    it('14.5 deberia consolidar los prompts de Notiweb y de titulos una sola vez', async () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const rows = await dataSource.query<
        { codigo: string; texto_prompt: string }[]
      >(
        'SELECT codigo, texto_prompt FROM plantillas_prompts_ia WHERE codigo = ANY($1)',
        [['NOTIWEB_DEFAULT', 'VERIFICADOR_TITULOS_DEFAULT']],
      );
      const textOf = (code: string): string =>
        rows.find((row) => row.codigo === code)?.texto_prompt ?? '';

      // 3. Assert 🎯: Notiweb, secciones y extension segun la cardinalidad.
      const notiweb = textOf('NOTIWEB_DEFAULT');
      expect(
        notiweb.split(
          'DETECCIÓN DE LOTE, FUENTES MIXTAS Y EXTENSIÓN (NOTIWEB)',
        ),
      ).toHaveLength(2);
      expect(notiweb).toContain('ENTRE 3 Y 4 SECCIONES TEMÁTICAS');
      expect(notiweb).toContain('ENTRE 12 Y 14 PÁRRAFOS');
      expect(notiweb).toContain('MÍNIMO DE 4 PÁRRAFOS');
      expect(notiweb).toContain('Título, su Fuente y su Entradilla');
      expect(notiweb).toContain('"Blog del día"');
      expect(notiweb).toContain(
        '<hr /><h2>Referencia bibliográfica</h2><p class="notiweb-referencia">',
      );
      expect(notiweb).toContain('APA 7');
      // Ninguna version anterior del bloque ni de las reglas sobrevive.
      expect(notiweb).not.toContain(
        'DESARROLLO MÍNIMO Y CIERRE DE CADA NOTICIA',
      );
      expect(notiweb).not.toContain(
        'DETECCIÓN DE LOTE Y FUENTES MIXTAS (NOTIWEB)',
      );
      expect(notiweb).not.toContain('AL MENOS DOS encabezados');
      expect(notiweb).not.toMatch(/M[IÍ]NIMO DE 3|M[AÁ]XIMO DE 4/i);
      expect(notiweb).not.toContain('Elimina del marcado el <hr>');

      // Titulos: respaldos, identificador UFV de ESIC y no inventar.
      const titulos = textOf('VERIFICADOR_TITULOS_DEFAULT');
      expect(
        titulos.split(
          'ENCABEZADO DEL PANEL E IDENTIFICADORES (VERIFICACIÓN DE TÍTULOS)',
        ),
      ).toHaveLength(2);
      expect(titulos).not.toContain('CONTRATO DE PANEL');
      expect(titulos).not.toContain('RESPALDO DEL ENCABEZADO DEL PANEL (');
      expect(titulos).toContain(
        'Para comités de ESIC, asigna SIEMPRE el identificador UFV',
      );
      expect(titulos).toContain('href="#collapseUFV1"');
      expect(titulos).toContain('id="collapseUFV1"');
      expect(titulos).not.toContain('href="#collapseESIC1"');
      expect(titulos).toContain('usa las siglas de la universidad');
      expect(titulos).toContain('usa la titulación principal evaluada');
      expect(titulos).toContain('SIN DATOS, NO INVENTES');
      expect(titulos).toContain('<h5 class="panel-title">');
      expect(titulos).not.toContain('<h4 class="panel-title">');
      expect(titulos).not.toContain(
        'Devuelve unica y exclusivamente el marcado HTML',
      );
      expect(titulos).toContain('Cardinalidad tolerante 1 a N');
    });

    it('14.6 deberia dar al nodo de redaccion de Notiweb el presupuesto de generacion extensa', () => {
      // 3. Assert 🎯: 12 a 14 parrafos mas el lote no caben en el tope por
      //    defecto, y el validador de autoria (prueba 6) admite los 180 s.
      const redaccion = blueprintBySlug('wf-notiweb-madridmasd')
        .configuracion_pipeline.nodes['redaccion_ia'];

      expect(redaccion?.params).toMatchObject({
        maxTokens: 32_768,
        timeoutMs: 180_000,
        outputCardinality: 'MULTIPLE',
      });
    });

    it('14.7 deberia exigir la eliminacion de prefijos del nombre en Innodays e Innobar', async () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const rows = await dataSource.query<
        { codigo: string; texto_prompt: string }[]
      >(
        'SELECT codigo, texto_prompt FROM plantillas_prompts_ia WHERE codigo = ANY($1)',
        [['INNODAYS_ENLACE_DEFAULT', 'INNOBAR_ENLACE_DEFAULT']],
      );

      // 3. Assert 🎯: la fila de Drupal se localiza por la denominacion
      //    tematica, asi que ambos prompts la exigen sin prefijos de formato,
      //    con la clausula una sola vez y la regla en "Reglas".
      expect(rows).toHaveLength(2);
      for (const { texto_prompt: text } of rows) {
        expect(
          text.split(
            'NORMALIZACIÓN DEL NOMBRE DEL EVENTO (INNODAYS E INNOBAR):',
          ),
        ).toHaveLength(2);
        expect(text).toContain(
          'ELIMINA SIEMPRE los prefijos de formato o de categoría',
        );
        expect(text).toContain('Elimina SIEMPRE del nombre');
        expect(text).toContain('SOLO la denominacion tematica canonica');
        for (const prefix of [
          '"InnoBar de"',
          '"InnoDays de"',
          '"Jornada de"',
          '"Encuentro sectorial de"',
        ]) {
          expect(text).toContain(prefix);
        }
        // La version que pedia el nombre literal ya no sobrevive.
        expect(text).not.toContain('EXACTAMENTE como figura en el correo');
        expect(text).not.toContain('se busca por ese texto literal');
      }
    });
  });
});
