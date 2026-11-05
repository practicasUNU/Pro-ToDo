import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { TemplatesService } from '@modules/templates/templates.service';
import { Workflow } from '@modules/workflows/entities/workflow.entity';

import { AppModule } from '../../app.module';

import type { PipelineSchema } from '@core/fsm/types/pipeline-schema.types';
import type { HtmlTemplate } from '@modules/templates/entities/html-template.entity';
import type { Repository } from 'typeorm';

/**
 * Fixture del despacho manual (Camino B).
 *
 *   npm run seed:fsm-runner
 *
 * Deja en la base un flujo de un solo nodo MAPEADOR_PLANTILLA listo para
 * disparar con `POST /api/workflows/:id/execute-test`, e imprime el `curl` exacto
 * con el UUID ya sustituido.
 *
 * IDEMPOTENTE: cada paso busca antes de insertar, asi que ejecutarlo dos veces
 * no duplica ni la plantilla ni el flujo. El identificador del flujo es una
 * CONSTANTE (`TEST_FLOW_ID`) y no un UUID aleatorio: `id_flujo` es de tipo UUID
 * y el endpoint lo valida con `ParseUUIDPipe`, asi que un identificador legible
 * tipo "wf-test-template-e2e" seria rechazado con un 400 antes de llegar al
 * servicio. Fijarlo permite guardar el `curl` en la documentacion sin tener que
 * releer la base tras cada siembra.
 *
 * Vive bajo `seeds/`, excluido de `tsconfig.build.json`: es andamiaje de
 * desarrollo y no debe viajar a `dist/`.
 */
const logger = new Logger('SeedFsmRunner');

/**
 * Constantes del fixture, deliberadamente NO exportadas.
 *
 * Este archivo se autoejecuta (`main()` al final), asi que importar una de sus
 * constantes desde otro modulo resembraria la base como efecto colateral. Lo
 * que otro codigo necesite compartir va a un `*.fixture.ts` aparte, como ya
 * hace `dummy-pipeline.fixture.ts` frente a `run-dummy-e2e.ts`.
 */

/** UUID fijo del flujo de pruebas. Version 4 valida, escrita a mano. */
const TEST_FLOW_ID = '11111111-2222-4333-8444-555555555555';

/** Nombre de la plantilla del fixture; sirve de clave de idempotencia. */
const TEST_TEMPLATE_NAME = '[E2E] Noticia institucional';

/** Nombre del flujo del fixture. */
const TEST_FLOW_NAME = '[E2E] Mapeador de plantilla';

/** `nodeId` del unico nodo del pipeline. */
const MAPPER_NODE_ID = 'nodo_mapeador';

/**
 * Plantilla ESQUELETO del fixture.
 *
 * Deliberadamente SIN marcadores. El nodo ya no interpola: entrega el esqueleto
 * saneado para que un `PROCESADOR_IA` posterior lo rellene, y una plantilla con
 * `{{...}}` caeria en la guarda `ERR_TEMPLATE_PENDING_VARS` — que es justo lo
 * que impide publicar llaves literales en el articulo final.
 *
 * Las ranuras se nombran por CLASE y no por marcador porque `TemplatesService`
 * rechaza al guardar cualquier marcador que no sea un `{{namespace.campo}}` de
 * la lista blanca: un hueco a rellenar solo es expresable como posicion del DOM.
 * Esas mismas clases son las que el nodo exige en `requiredSelectors`, de modo
 * que el fixture ejercita el contrato estructural de punta a punta.
 *
 * Todo el markup cabe en la lista blanca del saneador, de modo que
 * `TemplatesService.create()` no lo rechaza.
 */
const TEST_TEMPLATE_HTML = `<h1 class="titular"></h1>
<p class="entradilla"></p>
<div class="cuerpo"></div>`;

/**
 * Contrato estructural que el nodo exige sobre la plantilla ya saneada.
 *
 * Coincide con las tres ranuras de `TEST_TEMPLATE_HTML`: si alguien edita la
 * plantilla y se lleva una por delante, la siembra falla con
 * `ERR_TEMPLATE_STRUCTURE` en vez de sembrar un flujo que publicaria un hueco.
 */
const TEST_REQUIRED_SELECTORS = ['h1.titular', 'p.entradilla', 'div.cuerpo'];

/**
 * Pipeline de un solo nodo: entra la plantilla del gestor, sale el esqueleto.
 *
 * El `mockData` del despacho manual se conserva aunque este nodo YA NO lea el
 * contexto: sirve precisamente para comprobarlo. Si el markup resultante
 * contuviera cualquier rastro de esos valores, la inyeccion estaria compilando
 * por detras.
 */
const buildTestSchema = (templateId: string): PipelineSchema => ({
  flowId: TEST_FLOW_ID,
  name: 'Pipeline de verificacion del mapeador de plantillas',
  version: '1.0.0',
  entrypoint: MAPPER_NODE_ID,
  nodes: {
    [MAPPER_NODE_ID]: {
      nodeId: MAPPER_NODE_ID,
      nodeType: NodeType.MAPEADOR_PLANTILLA,
      outputNamespace: 'rendered_html',
      nextStep: null,
      onErrorStep: null,
      params: { templateId, requiredSelectors: TEST_REQUIRED_SELECTORS },
    },
  },
});

/**
 * Primer ADMIN activo, autor de la plantilla y del flujo.
 *
 * `flujos.id_usuario_creador` y `plantillas_html.id_usuario_creador` son claves
 * foraneas a `usuarios`: con un UUID inventado, la insercion fallaria por
 * integridad referencial.
 */
const resolveAdminId = async (dataSource: DataSource): Promise<string> => {
  const admins = await dataSource.query<Array<{ id_usuario: string }>>(
    `SELECT id_usuario FROM usuarios WHERE rol = 'ADMIN' AND activo = TRUE LIMIT 1`,
  );

  if (admins.length === 0) {
    throw new Error(
      'No hay ningun usuario ADMIN activo: aplica db/migrations/002-bootstrap-admin.sql.',
    );
  }

  const [{ id_usuario: adminId }] = admins;

  return adminId;
};

/**
 * Obtiene la plantilla del fixture, creandola si falta.
 *
 * Se crea a traves de `TemplatesService.create()` y no por SQL directo a
 * proposito: asi la siembra pasa por la validacion de sintaxis y de namespaces,
 * y `variables_esperadas` queda calculada por el mismo codigo que usa el gestor.
 * Sembrar por SQL dejaria esa columna vacia y el render no comprobaria nada.
 */
const ensureTemplate = async (
  templatesService: TemplatesService,
  adminId: string,
): Promise<HtmlTemplate> => {
  const existing = await templatesService.findAll(false);
  const found = existing.find(({ name }) => name === TEST_TEMPLATE_NAME);

  if (found !== undefined) {
    logger.log(`Plantilla ya existente: ${found.id}`);

    return found;
  }

  const created = await templatesService.create(
    {
      name: TEST_TEMPLATE_NAME,
      description: 'Plantilla del fixture de despacho manual (Camino B).',
      htmlContent: TEST_TEMPLATE_HTML,
    },
    adminId,
  );

  logger.log(
    `Plantilla creada: ${created.id} | variables: ${created.requiredVariables.join(', ')}`,
  );

  return created;
};

/**
 * Obtiene el flujo del fixture, creandolo si falta.
 *
 * Si ya existe se le REESCRIBE el `configuracion_pipeline`: la plantilla pudo
 * cambiar de identificador entre siembras, y un esquema apuntando a una
 * plantilla inexistente dejaria la ejecucion PAUSADA en vez de EXITOSA.
 */
const ensureWorkflow = async (
  workflowRepository: Repository<Workflow>,
  adminId: string,
  templateId: string,
): Promise<Workflow> => {
  const schema = buildTestSchema(templateId);
  const existing = await workflowRepository.findOne({
    where: { id: TEST_FLOW_ID },
  });

  if (existing !== null) {
    existing.pipelineSchema = schema;
    existing.active = true;
    logger.log(
      `Flujo ya existente: se actualiza su esquema (${TEST_FLOW_ID}).`,
    );

    return workflowRepository.save(existing);
  }

  return workflowRepository.save(
    workflowRepository.create({
      id: TEST_FLOW_ID,
      name: TEST_FLOW_NAME,
      description: 'Flujo del fixture de despacho manual (Camino B).',
      active: true,
      pipelineSchema: schema,
      createdById: adminId,
    }),
  );
};

const main = async (): Promise<void> => {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const dataSource = app.get(DataSource);
    const templatesService = app.get(TemplatesService);
    const workflowRepository = app.get<Repository<Workflow>>(
      getRepositoryToken(Workflow),
    );

    const adminId = await resolveAdminId(dataSource);
    const template = await ensureTemplate(templatesService, adminId);
    const workflow = await ensureWorkflow(
      workflowRepository,
      adminId,
      template.id,
    );

    logger.log(`Flujo sembrado: ${workflow.id} ("${workflow.name}")`);

    console.log(`
===== DESPACHO MANUAL LISTO =====

  POST /api/workflows/${workflow.id}/execute-test

  curl -X POST http://localhost:\${PORT}/api/workflows/${workflow.id}/execute-test \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer <JWT_ADMIN>" \\
    -d '{
      "mockData": {
        "parsed_email": {
          "clean_title": "Avance en Computacion Cuantica",
          "description": "Investigadores logran hito algoritmico",
          "clean_body": "Contenido validado de la noticia institucional.",
          "image_path": "/2026/09/laboratorio.jpg"
        }
      }
    }'

  El mockData es deliberadamente IRRELEVANTE para este nodo: ya no interpola.
  Si aparece en el markup, hay una compilacion donde no deberia haberla.

  Inspeccion posterior:
    SELECT estado, paso_actual, contexto_acumulado
      FROM ejecuciones_flujo
     WHERE id_flujo = '${workflow.id}'
     ORDER BY fecha_inicio DESC;
`);
  } finally {
    // Sin esto el proceso queda colgado del pool de conexiones de TypeORM.
    await app.close();
  }
};

main().catch((error: unknown) => {
  logger.error(
    error instanceof Error ? error.message : 'Error desconocido',
    error instanceof Error ? error.stack : undefined,
  );
  process.exitCode = 1;
});
