import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useWorkflowTemplatesStore } from './workflow-templates.store';

import { NodeType } from '@/types/pipeline';
import {
  MULTIMODAL_FALLBACK_CODE,
  SHARED_ALERT_NODE_ID,
  SHARED_OCR_NODE_ID,
} from '@/types/nodes/error-branch.types';

import type {
  AssembledPipelineSchema,
  WorkflowTemplateDetail,
  WorkflowTemplateSummary,
} from '@/types/pipeline';

// Sin esto se cargaria `@boot/axios`, que necesita entorno de navegador.
vi.mock('@services/workflow-templates.service', () => ({
  fetchWorkflowTemplates: vi.fn(),
  fetchWorkflowTemplate: vi.fn(),
  createWorkflowTemplate: vi.fn(),
  updateWorkflowTemplate: vi.fn(),
  deactivateWorkflowTemplate: vi.fn(),
}));
vi.mock('@services/fsm.service', () => ({
  validatePipelineSchema: vi.fn(),
}));

const service = await import('@services/workflow-templates.service');
const fetchWorkflowTemplates = vi.mocked(service.fetchWorkflowTemplates);
const fetchWorkflowTemplate = vi.mocked(service.fetchWorkflowTemplate);
const createWorkflowTemplate = vi.mocked(service.createWorkflowTemplate);
const updateWorkflowTemplate = vi.mocked(service.updateWorkflowTemplate);
const deactivateWorkflowTemplate = vi.mocked(service.deactivateWorkflowTemplate);

const fsmService = await import('@services/fsm.service');
const validatePipelineSchema = vi.mocked(fsmService.validatePipelineSchema);

const TEMPLATE_ID = 'b3f1c2d4-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const OTHER_TEMPLATE_ID = 'c4a2d3e5-6f7b-4c8d-9e0f-1a2b3c4d5e6f';

const SCHEMA = {
  flowId: 'plantilla-notiweb',
  name: 'Notiweb - correo a CMS',
  version: '1.0.0',
  entrypoint: 'trigger_imap',
  nodes: {
    trigger_imap: {
      nodeId: 'trigger_imap',
      nodeType: 'TRIGGER_IMAP',
      outputNamespace: 'raw_email',
      nextStep: null,
      onErrorStep: null,
      params: {},
    },
  },
};

const buildSummary = (
  overrides: Partial<WorkflowTemplateSummary> = {},
): WorkflowTemplateSummary => ({
  id: TEMPLATE_ID,
  name: 'Notiweb - correo a CMS',
  description: 'Ingesta por correo y publicacion en el CMS',
  active: true,
  topology: [
    { nodeId: 'trigger_imap', nodeType: NodeType.TRIGGER_IMAP, outputNamespace: 'raw_email' },
  ],
  ...overrides,
});

const buildDetail = (overrides: Partial<WorkflowTemplateDetail> = {}): WorkflowTemplateDetail => ({
  ...buildSummary(),
  pipelineSchema: SCHEMA,
  ...overrides,
});

describe('useWorkflowTemplatesStore · catalogo de plantillas de flujo', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  describe('1. Carga del catalogo', () => {
    it('1.1 deberia omitir las retiradas por defecto', async () => {
      // 1. Arrange
      const store = useWorkflowTemplatesStore();
      fetchWorkflowTemplates.mockResolvedValue([buildSummary()]);

      // 2. Act
      await store.fetchTemplates();

      // 3. Assert: el fallo por omision es no mostrar lo retirado.
      expect(fetchWorkflowTemplates).toHaveBeenCalledWith(false);
    });

    it('1.2 deberia incluir las retiradas cuando se piden', async () => {
      // 1. Arrange
      const store = useWorkflowTemplatesStore();
      fetchWorkflowTemplates.mockResolvedValue([]);

      // 2. Act: la tabla administrativa las necesita, porque es donde se
      //    vuelven a activar.
      await store.fetchTemplates(true);

      // 3. Assert
      expect(fetchWorkflowTemplates).toHaveBeenCalledWith(true);
    });

    it('1.3 deberia exponer solo las disponibles en activeTemplates', async () => {
      // 1. Arrange
      const store = useWorkflowTemplatesStore();
      fetchWorkflowTemplates.mockResolvedValue([
        buildSummary(),
        buildSummary({ id: OTHER_TEMPLATE_ID, active: false }),
      ]);

      // 2. Act
      await store.fetchTemplates(true);

      // 3. Assert
      expect(store.templates).toHaveLength(2);
      expect(store.activeTemplates).toHaveLength(1);
    });

    it('1.4 deberia apagar isLoading aunque el servicio lance', async () => {
      // 1. Arrange
      const store = useWorkflowTemplatesStore();
      fetchWorkflowTemplates.mockRejectedValue(new Error('500 Internal Server Error'));

      // 2. Act & 3. Assert
      await expect(store.fetchTemplates()).rejects.toThrow('500 Internal Server Error');
      expect(store.isLoading).toBe(false);
    });
  });

  describe('2. Borrador del editor', () => {
    it('2.1 deberia arrancar en blanco con un esqueleto de esquema', () => {
      // 1. Arrange & 2. Act
      const store = useWorkflowTemplatesStore();
      store.initDraft();

      // 3. Assert: un editor que abre con una hoja vacia obliga a recordar de
      //    memoria la forma del grafo.
      expect(store.activeDraft.name).toBe('');
      expect(store.activeDraft.active).toBe(true);
      expect(store.schemaSyntaxError).toBeNull();
      expect(store.selectedTemplate).toBeNull();
    });

    it('2.2 deberia reindentar el esquema al abrir para editar', () => {
      // 1. Arrange & 2. Act
      const store = useWorkflowTemplatesStore();
      store.initDraft(buildDetail());

      // 3. Assert: el backend guarda el jsonb sin formato; sin reindentar, el
      //    editor mostraria el grafo entero en una sola linea.
      expect(store.activeDraft.schemaText).toContain('\n');
      expect(store.activeDraft.name).toBe('Notiweb - correo a CMS');
    });

    it('2.3 no deberia declararse valido sin nombre', () => {
      // 1. Arrange & 2. Act
      const store = useWorkflowTemplatesStore();
      store.initDraft();

      // 3. Assert
      expect(store.isDraftValid).toBe(false);
    });

    it('2.4 deberia declararse valido con nombre, JSON correcto y al menos un nodo', () => {
      // 1. Arrange: el esqueleto de alta ya no trae ningun nodo de muestra, asi
      //    que el nombre por si solo no basta.
      const store = useWorkflowTemplatesStore();
      store.initDraft();

      // 2. Act
      store.patchDraft({ name: 'Notiweb', schemaText: JSON.stringify(SCHEMA) });

      // 3. Assert
      expect(store.isDraftValid).toBe(true);
    });

    it('2.5 deberia detectar el JSON roto sin gastar una peticion', () => {
      // 1. Arrange
      const store = useWorkflowTemplatesStore();
      store.initDraft();

      // 2. Act
      store.patchDraft({ name: 'Notiweb', schemaText: '{ "entrypoint": ' });

      // 3. Assert: es validacion de FORMA. La coherencia del grafo la decide el
      //    backend, que es la unica autoridad sobre la topologia.
      expect(store.schemaSyntaxError).not.toBeNull();
      expect(store.isDraftValid).toBe(false);
    });

    it('2.6 deberia rechazar un JSON que no sea objeto', () => {
      // 1. Arrange
      const store = useWorkflowTemplatesStore();
      store.initDraft();

      // 2. Act: parsea, pero un arreglo no es un pipeline_schema.
      store.patchDraft({ name: 'Notiweb', schemaText: '[1, 2, 3]' });

      // 3. Assert
      expect(store.schemaSyntaxError).toBe('El esquema debe ser un objeto JSON.');
    });

    it('2.7 deberia bloquear el guardado si el entry point no es un disparador', () => {
      // 1. Arrange: el mapeador abre el flujo.
      const store = useWorkflowTemplatesStore();
      store.initDraft();

      // 2. Act
      store.patchDraft({
        name: 'Notiweb',
        schemaText: JSON.stringify({
          ...SCHEMA,
          entrypoint: 'mapeador',
          nodes: {
            mapeador: {
              nodeId: 'mapeador',
              nodeType: 'MAPEADOR_PLANTILLA',
              outputNamespace: 'rendered_html',
              nextStep: null,
              onErrorStep: null,
              params: {},
            },
          },
        }),
      });

      // 3. Assert: replica la regla 9 del backend para no gastar un 400 seguro.
      expect(store.entryPointIssue).toBe(
        'El nodo inicial (Entry Point) debe ser un disparador de categoria TRIGGER',
      );
      expect(store.isDraftValid).toBe(false);
    });

    it('2.8 no deberia objetar nada cuando el entry point si es un disparador', () => {
      // 1. Arrange
      const store = useWorkflowTemplatesStore();
      store.initDraft();

      // 2. Act
      store.patchDraft({ name: 'Notiweb', schemaText: JSON.stringify(SCHEMA) });

      // 3. Assert
      expect(store.entryPointIssue).toBeNull();
    });
  });

  describe('2bis. Parametros base por nodo (Poka-Yoke)', () => {
    /** Secuencia minima con un disparador IMAP recien sembrado. */
    const buildImapSequence = () => [
      {
        nodeId: 'trigger_imap',
        nodeType: NodeType.TRIGGER_IMAP,
        outputNamespace: 'raw_email',
        params: { mailbox: 'INBOX', includeAttachments: false },
      },
    ];

    it('2bis.1 deberia reflejar el toggle en el espejo del pipeline_schema', () => {
      // 1. Arrange: el editor JSON crudo desaparecio, asi que el unico modo de
      //    comprobar que el control llega al documento es mirar el texto que
      //    alimenta el visualizador de la derecha.
      const store = useWorkflowTemplatesStore();
      store.initDraft();
      store.setSequence(buildImapSequence());

      // 2. Act: lo que emite `TriggerImapBaseParams` al encender el toggle.
      store.patchStepParams('trigger_imap', {
        mailbox: 'INBOX',
        includeAttachments: true,
      });

      // 3. Assert: booleano REAL en el documento, nunca la cadena "true".
      const schema = JSON.parse(store.activeDraft.schemaText) as {
        nodes: Record<string, { params: Record<string, unknown> }>;
      };
      expect(schema.nodes.trigger_imap?.params).toEqual({
        mailbox: 'INBOX',
        includeAttachments: true,
      });
      expect(store.activeDraft.schemaText).toContain('"includeAttachments": true');
    });

    it('2bis.2 deberia conservar las claves que ningun control gestiona', () => {
      // 1. Arrange: una plantilla con parametros sembrados por el editor JSON
      //    que se retiro. Ya no se pueden editar desde la interfaz, pero
      //    borrarlos al accionar un interruptor seria perdida de datos.
      const store = useWorkflowTemplatesStore();
      store.initDraft();
      store.setSequence([
        {
          ...buildImapSequence()[0]!,
          params: { mailbox: 'Archivadas', markAsRead: false },
        },
      ]);

      // 2. Act: merge sobre lo existente, que es lo que emite el control.
      store.patchStepParams('trigger_imap', {
        mailbox: 'Archivadas',
        markAsRead: false,
        includeAttachments: true,
      });

      // 3. Assert
      const schema = JSON.parse(store.activeDraft.schemaText) as {
        nodes: Record<string, { params: Record<string, unknown> }>;
      };
      expect(schema.nodes.trigger_imap?.params).toEqual({
        mailbox: 'Archivadas',
        markAsRead: false,
        includeAttachments: true,
      });
    });
  });

  describe('3. Guardado del borrador', () => {
    it('3.1 deberia crear cuando no hay plantilla seleccionada', async () => {
      // 1. Arrange
      const store = useWorkflowTemplatesStore();
      store.initDraft();
      store.patchDraft({ name: '  Notiweb  ', description: '  Ingesta  ' });
      createWorkflowTemplate.mockResolvedValue(buildDetail());

      // 2. Act
      await store.saveDraft();

      // 3. Assert: el JSON se parsea AQUI, no en el componente: el store es el
      //    dueno del borrador y el componente no sabe que es texto.
      expect(createWorkflowTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Notiweb',
          description: 'Ingesta',
          active: true,
        }),
      );
      const payload = createWorkflowTemplate.mock.calls[0]?.[0];
      expect(payload?.pipelineSchema).toHaveProperty('entrypoint');
    });

    it('3.2 deberia editar cuando hay plantilla seleccionada', async () => {
      // 1. Arrange
      const store = useWorkflowTemplatesStore();
      store.initDraft(buildDetail());
      store.patchDraft({ name: 'Notiweb v2' });
      updateWorkflowTemplate.mockResolvedValue(buildDetail({ name: 'Notiweb v2' }));

      // 2. Act
      await store.saveDraft();

      // 3. Assert
      expect(updateWorkflowTemplate).toHaveBeenCalledWith(
        TEMPLATE_ID,
        expect.objectContaining({ name: 'Notiweb v2' }),
      );
      expect(createWorkflowTemplate).not.toHaveBeenCalled();
    });

    it('3.3 deberia omitir description cuando llega vacia', async () => {
      // 1. Arrange
      const store = useWorkflowTemplatesStore();
      store.initDraft();
      store.patchDraft({ name: 'Notiweb', description: '   ' });
      createWorkflowTemplate.mockResolvedValue(buildDetail());

      // 2. Act
      await store.saveDraft();

      // 3. Assert: `exactOptionalPropertyTypes` prohibe enviarla como
      //    `undefined`; la clave se omite.
      expect(createWorkflowTemplate.mock.calls[0]?.[0]).not.toHaveProperty('description');
    });

    it('3.4 deberia rechazar el guardado con JSON invalido', async () => {
      // 1. Arrange
      const store = useWorkflowTemplatesStore();
      store.initDraft();
      store.patchDraft({ name: 'Notiweb', schemaText: 'no es json' });

      // 2. Act & 3. Assert
      await expect(store.saveDraft()).rejects.toThrow(/no es un JSON valido/);
      expect(createWorkflowTemplate).not.toHaveBeenCalled();
    });

    it('3.5 deberia insertar la plantilla creada en la coleccion', async () => {
      // 1. Arrange
      const store = useWorkflowTemplatesStore();
      store.initDraft();
      store.patchDraft({ name: 'Notiweb' });
      createWorkflowTemplate.mockResolvedValue(buildDetail());

      // 2. Act
      await store.saveDraft();

      // 3. Assert
      expect(store.templates).toHaveLength(1);
      expect(store.templates[0]?.id).toBe(TEMPLATE_ID);
    });

    it('3.6 deberia reemplazar la plantilla editada sin duplicarla', async () => {
      // 1. Arrange
      const store = useWorkflowTemplatesStore();
      fetchWorkflowTemplates.mockResolvedValue([buildSummary()]);
      await store.fetchTemplates();
      store.initDraft(buildDetail());
      store.patchDraft({ name: 'Notiweb v2' });
      updateWorkflowTemplate.mockResolvedValue(buildDetail({ name: 'Notiweb v2' }));

      // 2. Act
      await store.saveDraft();

      // 3. Assert
      expect(store.templates).toHaveLength(1);
      expect(store.templates[0]?.name).toBe('Notiweb v2');
    });

    it('3.7 deberia conservar el estado de la plantilla al editarla', async () => {
      // 1. Arrange: una plantilla RETIRADA que se abre para corregir su grafo.
      const store = useWorkflowTemplatesStore();
      store.initDraft(buildDetail({ active: false }));
      store.patchDraft({ name: 'Notiweb v2' });
      updateWorkflowTemplate.mockResolvedValue(buildDetail({ active: false }));

      // 2. Act
      await store.saveDraft();

      // 3. Assert: guardar el formulario NO conmuta la disponibilidad. Es la
      //    premisa que permite que el editor no exponga interruptor de estado
      //    —igual que `UserDialog.vue`—: el estado se cambia solo desde la
      //    botonera del catalogo, con su confirmacion.
      expect(updateWorkflowTemplate).toHaveBeenCalledWith(
        TEMPLATE_ID,
        expect.objectContaining({ active: false }),
      );
    });

    it('3.8 deberia publicar por defecto una plantilla nueva', async () => {
      // 1. Arrange
      const store = useWorkflowTemplatesStore();
      store.initDraft();
      store.patchDraft({ name: 'Notiweb' });
      createWorkflowTemplate.mockResolvedValue(buildDetail());

      // 2. Act
      await store.saveDraft();

      // 3. Assert: sin interruptor en el editor, el alta usa el mismo criterio
      //    que el backend. Es seguro porque una plantilla no dispara nada por si
      //    misma: solo queda ofrecida en el selector.
      expect(createWorkflowTemplate).toHaveBeenCalledWith(
        expect.objectContaining({ active: true }),
      );
    });

    it('3.9 deberia apagar isLoading aunque el guardado falle', async () => {
      // 1. Arrange
      const store = useWorkflowTemplatesStore();
      store.initDraft();
      store.patchDraft({ name: 'Notiweb' });
      createWorkflowTemplate.mockRejectedValue(new Error('409 Conflict'));

      // 2. Act & 3. Assert
      await expect(store.saveDraft()).rejects.toThrow('409 Conflict');
      expect(store.isLoading).toBe(false);
    });
  });

  describe('4. Disponibilidad', () => {
    it('4.1 deberia retirar con el borrado logico del backend', async () => {
      // 1. Arrange
      const store = useWorkflowTemplatesStore();
      fetchWorkflowTemplates.mockResolvedValue([buildSummary()]);
      await store.fetchTemplates(true);
      deactivateWorkflowTemplate.mockResolvedValue(buildDetail({ active: false }));

      // 2. Act
      await store.setActive(TEMPLATE_ID, false);

      // 3. Assert: se usa el DELETE, que es el borrado logico del backend.
      expect(deactivateWorkflowTemplate).toHaveBeenCalledWith(TEMPLATE_ID);
      expect(store.templates[0]?.active).toBe(false);
    });

    it('4.2 deberia volver a publicar con el verbo de edicion', async () => {
      // 1. Arrange
      const store = useWorkflowTemplatesStore();
      updateWorkflowTemplate.mockResolvedValue(buildDetail());

      // 2. Act
      await store.setActive(TEMPLATE_ID, true);

      // 3. Assert: no hay endpoint de "reactivar"; un PUT con `active: true` lo
      //    cubre, que es el motivo de que el DTO backend sea PartialType.
      expect(updateWorkflowTemplate).toHaveBeenCalledWith(TEMPLATE_ID, { active: true });
    });

    it('4.3 deberia conservar la plantilla retirada en la coleccion', async () => {
      // 1. Arrange
      const store = useWorkflowTemplatesStore();
      fetchWorkflowTemplates.mockResolvedValue([buildSummary()]);
      await store.fetchTemplates(true);
      deactivateWorkflowTemplate.mockResolvedValue(buildDetail({ active: false }));

      // 2. Act
      await store.setActive(TEMPLATE_ID, false);

      // 3. Assert: retirarla de la coleccion la haria desaparecer de la misma
      //    tabla en la que el operador acaba de pulsar, y esa tabla es el unico
      //    sitio desde el que puede volver a activarla.
      expect(store.templates).toHaveLength(1);
    });
  });

  describe('4bis. Validacion del grafo contra el motor', () => {
    it('4bis.1 deberia enviar el esquema PARSEADO, no el texto', async () => {
      // 1. Arrange
      const store = useWorkflowTemplatesStore();
      store.initDraft();
      validatePipelineSchema.mockResolvedValue({
        success: true,
        schema: SCHEMA,
      } as Awaited<ReturnType<typeof fsmService.validatePipelineSchema>>);

      // 2. Act
      await store.validateDraftSchema();

      // 3. Assert: el store es el dueno del borrador y el unico que sabe que
      // `schemaText` es texto de un objeto.
      const [sent] = validatePipelineSchema.mock.calls[0] ?? [];
      expect(typeof sent).toBe('object');
      expect(sent).toHaveProperty('entrypoint');
    });

    it('4bis.2 NO deberia llamar al backend con un JSON roto', async () => {
      // 1. Arrange
      const store = useWorkflowTemplatesStore();
      store.patchDraft({ schemaText: '{ esto no parsea' });

      // 2. Act & 3. Assert: gastar una peticion en un 400 seguro no aporta
      // nada, y el mensaje del motor de JS es mas preciso que el del servidor.
      await expect(store.validateDraftSchema()).rejects.toThrow('no es un JSON valido');
      expect(validatePipelineSchema).not.toHaveBeenCalled();
    });

    it('4bis.3 deberia propagar el error del servicio sin capturarlo', async () => {
      // 1. Arrange
      const store = useWorkflowTemplatesStore();
      store.initDraft();
      validatePipelineSchema.mockRejectedValue(new Error('400'));

      // 2. Act & 3. Assert: el componente necesita el AxiosError intacto para
      // sacarle los `issues` y pintarlos en el editor (§2.1).
      await expect(store.validateDraftSchema()).rejects.toThrow('400');
    });

    it('4bis.4 NO deberia guardar nada al validar', async () => {
      // 1. Arrange
      const store = useWorkflowTemplatesStore();
      store.initDraft();
      validatePipelineSchema.mockResolvedValue({
        success: true,
        schema: SCHEMA,
      } as Awaited<ReturnType<typeof fsmService.validatePipelineSchema>>);

      // 2. Act
      await store.validateDraftSchema();

      // 3. Assert: validar es una comprobacion, no una escritura.
      expect(createWorkflowTemplate).not.toHaveBeenCalled();
      expect(updateWorkflowTemplate).not.toHaveBeenCalled();
    });
  });

  describe('5. Carga para editar', () => {
    it('5.1 deberia pedir el detalle y abrirlo en el borrador', async () => {
      // 1. Arrange
      const store = useWorkflowTemplatesStore();
      fetchWorkflowTemplate.mockResolvedValue(buildDetail());

      // 2. Act
      await store.loadForEdit(TEMPLATE_ID);

      // 3. Assert: el listado NO trae `pipelineSchema`, asi que editar exige la
      //    peticion de detalle.
      expect(fetchWorkflowTemplate).toHaveBeenCalledWith(TEMPLATE_ID);
      expect(store.activeDraft.schemaText).toContain('entrypoint');
      expect(store.selectedTemplate?.id).toBe(TEMPLATE_ID);
    });

    it('5.2 deberia limpiar la seleccion al resetear', async () => {
      // 1. Arrange
      const store = useWorkflowTemplatesStore();
      fetchWorkflowTemplate.mockResolvedValue(buildDetail());
      await store.loadForEdit(TEMPLATE_ID);

      // 2. Act
      store.resetDraft();

      // 3. Assert: sin esto, el alta siguiente se guardaria como edicion de la
      //    plantilla anterior.
      expect(store.selectedTemplate).toBeNull();
      expect(store.activeDraft.name).toBe('');
    });

    describe('7. executionPolicy del borrador', () => {
      /** Borrador con nombre y un nodo, listo para conmutar la politica. */
      const buildDraftWithNode = (): ReturnType<typeof useWorkflowTemplatesStore> => {
        const store = useWorkflowTemplatesStore();
        store.initDraft();
        store.patchDraft({ name: 'Notiweb' });
        store.setSequence([
          {
            nodeId: 'trigger_cron',
            nodeType: NodeType.TRIGGER_CRON,
            outputNamespace: 'cron_trigger',
            params: {},
          },
        ]);

        return store;
      };

      it('7.1 deberia escribir la politica en el documento al marcarla', () => {
        // 1. Arrange
        const store = buildDraftWithNode();

        // 2. Act
        store.setStopOnFirstSuccess(true);

        // 3. Assert
        expect(store.stopOnFirstSuccess).toBe(true);
        expect(JSON.parse(store.activeDraft.schemaText).executionPolicy).toEqual({
          stopOnFirstSuccess: true,
        });
      });

      it('7.2 deberia ELIMINAR la clave al desmarcarla, no dejarla en false', () => {
        // 1. Arrange
        const store = buildDraftWithNode();
        store.setStopOnFirstSuccess(true);

        // 2. Act
        store.setStopOnFirstSuccess(false);

        // 3. Assert: el esquema declara lo que el flujo HACE; una politica
        //    presente que no hace nada es ruido que ademas habria que mantener
        //    sincronizado con el default del backend.
        expect(store.stopOnFirstSuccess).toBe(false);
        expect(Object.hasOwn(JSON.parse(store.activeDraft.schemaText), 'executionPolicy')).toBe(
          false,
        );
      });

      it('7.3 deberia SOBREVIVIR a reordenar la secuencia', () => {
        // 1. Arrange: el caso que de otro modo la borra en silencio. El selector
        //    reensambla el esquema entero, asi que un campo raiz que no se
        //    propague desaparece en cuanto se anade o se mueve un nodo.
        const store = buildDraftWithNode();
        store.setStopOnFirstSuccess(true);

        // 2. Act
        store.setSequence([
          {
            nodeId: 'trigger_cron',
            nodeType: NodeType.TRIGGER_CRON,
            outputNamespace: 'cron_trigger',
            params: {},
          },
          {
            nodeId: 'nodo_mapeador',
            nodeType: NodeType.MAPEADOR_PLANTILLA,
            outputNamespace: 'rendered_html',
            params: {},
          },
        ]);

        // 3. Assert
        expect(store.schemaNodeCount).toBe(2);
        expect(store.stopOnFirstSuccess).toBe(true);
      });
    });

    describe('8. Rutas de contingencia (onErrorStep)', () => {
      const PARSER_ID = 'nodo_parser';
      const MAPPER_ID = 'nodo_mapeador';
      const IA_ID = 'nodo_ia';

      /** Borrador de cuatro pasos: trigger, parser, IA y mapeador. */
      const buildDraftWithPipeline = (): ReturnType<typeof useWorkflowTemplatesStore> => {
        const store = useWorkflowTemplatesStore();
        store.initDraft();
        store.patchDraft({ name: 'Notiweb' });
        store.setSequence([
          {
            nodeId: 'trigger_imap',
            nodeType: NodeType.TRIGGER_IMAP,
            outputNamespace: 'raw_email',
            params: {},
          },
          {
            nodeId: PARSER_ID,
            nodeType: NodeType.PARSER_PRE_IA,
            outputNamespace: 'parsed_email',
            params: {},
          },
          {
            nodeId: IA_ID,
            nodeType: NodeType.PROCESADOR_IA,
            outputNamespace: 'llm_response',
            params: {},
          },
          {
            nodeId: MAPPER_ID,
            nodeType: NodeType.MAPEADOR_PLANTILLA,
            outputNamespace: 'rendered_html',
            params: {},
          },
        ]);

        return store;
      };

      /** Documento vigente del borrador, ya parseado. */
      const readSchema = (
        store: ReturnType<typeof useWorkflowTemplatesStore>,
      ): AssembledPipelineSchema =>
        JSON.parse(store.activeDraft.schemaText) as AssembledPipelineSchema;

      it('8.1 deberia escribir la forma de CADENA para la alerta', () => {
        // 1. Arrange 📐: es la unica forma que el motor trata como "atrapa
        //    todo". Un `catchErrors` con un comodin inventado se guardaria sin
        //    protestar y no se dispararia jamas.
        const store = buildDraftWithPipeline();

        // 2. Act ⚙️
        store.setStepErrorBranch(MAPPER_ID, 'ALERTA_SMTP');

        // 3. Assert 🎯
        expect(readSchema(store).nodes[MAPPER_ID]?.onErrorStep).toBe(SHARED_ALERT_NODE_ID);
        expect(store.errorBranchOf(MAPPER_ID)).toBe('ALERTA_SMTP');
      });

      it('8.2 deberia provisionar el satelite de alerta como nodo terminal', () => {
        // 1. Arrange 📐: sin el nodo en el mapa, la ruta apunta fuera y el
        //    backend rechaza el esquema con su regla 3.
        const store = buildDraftWithPipeline();

        // 2. Act ⚙️
        store.setStepErrorBranch(MAPPER_ID, 'ALERTA_SMTP');

        // 3. Assert 🎯: terminal y fuera del encadenado; colarlo en la secuencia
        //    lo pondria en el camino feliz, avisando en cada ejecucion correcta.
        const alert = readSchema(store).nodes[SHARED_ALERT_NODE_ID];

        expect(alert?.nodeType).toBe(NodeType.DESTINO_SMTP);
        expect(alert?.outputNamespace).toBe('smtp_result');
        expect(alert?.nextStep).toBeNull();
      });

      it('8.3 deberia escribir la forma SELECTIVA para el fallback de vision', () => {
        // 1. Arrange 📐: un respaldo incondicional hacia la IA mandaria alli
        //    tambien los fallos de configuracion, que no es lo que nadie quiso.
        const store = buildDraftWithPipeline();

        // 2. Act ⚙️
        store.setStepErrorBranch(PARSER_ID, 'VISION_IA');

        // 3. Assert 🎯: apunta al PROCESADOR_IA que la topologia YA tiene; uno
        //    nuevo chocaria con el en `llm_response` (regla 5).
        expect(readSchema(store).nodes[PARSER_ID]?.onErrorStep).toEqual({
          targetNode: SHARED_OCR_NODE_ID,
          catchErrors: [MULTIMODAL_FALLBACK_CODE],
        });
        expect(store.errorBranchOf(PARSER_ID)).toBe('VISION_IA');
      });

      it('8.4 deberia retirar la ruta y su satelite al desactivarla', () => {
        // 1. Arrange 📐
        const store = buildDraftWithPipeline();
        store.setStepErrorBranch(MAPPER_ID, 'ALERTA_SMTP');

        // 2. Act ⚙️
        store.setStepErrorBranch(MAPPER_ID, null);

        // 3. Assert 🎯: un satelite huerfano es un nodo inalcanzable que el
        //    validador rechaza.
        expect(readSchema(store).nodes[MAPPER_ID]?.onErrorStep).toBeNull();
        expect(readSchema(store).nodes[SHARED_ALERT_NODE_ID]).toBeUndefined();
        expect(store.errorBranchOf(MAPPER_ID)).toBeNull();
      });

      it('8.5 deberia SOBREVIVIR a reordenar la secuencia', () => {
        // 1. Arrange 📐: el caso que antes borraba el satelite en silencio.
        //    `rebuildSchemaFromSequence` reensamblaba con la lista vacia, y el
        //    grafo salia con una ruta apuntando a un nodo inexistente.
        const store = buildDraftWithPipeline();
        store.setStepErrorBranch('trigger_imap', 'ALERTA_SMTP');

        // 2. Act ⚙️: quitar el ultimo paso reensambla el documento entero. El
        //    nodo que declara la ruta sigue en la secuencia.
        store.setSequence(store.sequence.slice(0, 3));

        // 3. Assert 🎯
        expect(readSchema(store).nodes[SHARED_ALERT_NODE_ID]?.nodeId).toBe(SHARED_ALERT_NODE_ID);
      });

      it('8.5bis deberia RETIRARLO si se elimina el paso que lo invocaba', () => {
        // 1. Arrange 📐: la ruta se va con el nodo que la declaraba, y un
        //    satelite al que ya no apunta nadie es un nodo inalcanzable que el
        //    validador rechaza.
        const store = buildDraftWithPipeline();
        store.setStepErrorBranch(MAPPER_ID, 'ALERTA_SMTP');

        // 2. Act ⚙️
        store.setSequence(store.sequence.filter((step) => step.nodeId !== MAPPER_ID));

        // 3. Assert 🎯
        expect(readSchema(store).nodes[SHARED_ALERT_NODE_ID]).toBeUndefined();
      });

      it('8.6 deberia conservar una ruta escrita a mano en el panel JSON', () => {
        // 1. Arrange 📐: el editor de la derecha sigue siendo editable, y abrir
        //    una plantilla para tocar un toggle no debe borrar lo que trae.
        const store = useWorkflowTemplatesStore();
        store.initDraft({
          ...buildSummary(),
          pipelineSchema: {
            flowId: 'plantilla',
            name: 'Notiweb',
            version: '1.0.0',
            entrypoint: 'trigger_imap',
            nodes: {
              trigger_imap: {
                nodeId: 'trigger_imap',
                nodeType: NodeType.TRIGGER_IMAP,
                outputNamespace: 'raw_email',
                nextStep: null,
                onErrorStep: SHARED_ALERT_NODE_ID,
                params: {},
              },
              [SHARED_ALERT_NODE_ID]: {
                nodeId: SHARED_ALERT_NODE_ID,
                nodeType: NodeType.DESTINO_SMTP,
                outputNamespace: 'smtp_result',
                nextStep: null,
                onErrorStep: null,
                params: { to: ['guardia@unuware.com'] },
              },
            },
          },
        });

        // 2. Act ⚙️: cualquier cambio del selector reensambla el documento.
        store.setSequence(store.sequence);

        // 3. Assert 🎯
        expect(readSchema(store).nodes.trigger_imap?.onErrorStep).toBe(SHARED_ALERT_NODE_ID);
        expect(readSchema(store).nodes[SHARED_ALERT_NODE_ID]?.params.to).toEqual([
          'guardia@unuware.com',
        ]);
      });

      it('8.7 deberia cubrir con la alerta los pasos sin ruta propia', () => {
        // 1. Arrange 📐
        const store = buildDraftWithPipeline();
        store.setStepErrorBranch(PARSER_ID, 'VISION_IA');

        // 2. Act ⚙️
        store.setNotifyAllErrors(true);

        // 3. Assert 🎯: NO pisa la de vision, que es una decision distinta que
        //    el operador tomo a proposito.
        const { nodes } = readSchema(store);

        expect(nodes[PARSER_ID]?.onErrorStep).toEqual({
          targetNode: SHARED_OCR_NODE_ID,
          catchErrors: [MULTIMODAL_FALLBACK_CODE],
        });
        expect(nodes.trigger_imap?.onErrorStep).toBe(SHARED_ALERT_NODE_ID);
        expect(nodes[MAPPER_ID]?.onErrorStep).toBe(SHARED_ALERT_NODE_ID);
        expect(store.notifyAllErrors).toBe(true);
      });

      it('8.8 NO deberia desviar un nodo de alerta hacia si mismo', () => {
        // 1. Arrange 📐: un DESTINO_SMTP con `onErrorStep` a la alerta seria un
        //    bucle, y el paso terminal del flujo no tiene a donde escalar.
        const store = useWorkflowTemplatesStore();
        store.initDraft();
        store.patchDraft({ name: 'Notiweb' });
        store.setSequence([
          {
            nodeId: 'trigger_imap',
            nodeType: NodeType.TRIGGER_IMAP,
            outputNamespace: 'raw_email',
            params: {},
          },
          {
            nodeId: 'destino_correo',
            nodeType: NodeType.DESTINO_SMTP,
            outputNamespace: 'smtp_result',
            params: {},
          },
        ]);

        // 2. Act ⚙️
        store.setNotifyAllErrors(true);

        // 3. Assert 🎯
        expect(readSchema(store).nodes.destino_correo?.onErrorStep).toBeNull();
        expect(readSchema(store).nodes.trigger_imap?.onErrorStep).toBe(SHARED_ALERT_NODE_ID);
      });

      it('8.9 deberia retirar solo las rutas de alerta al desactivar el global', () => {
        // 1. Arrange 📐
        const store = buildDraftWithPipeline();
        store.setStepErrorBranch(PARSER_ID, 'VISION_IA');
        store.setNotifyAllErrors(true);

        // 2. Act ⚙️
        store.setNotifyAllErrors(false);

        // 3. Assert 🎯: la de vision es una decision propia del operador y se
        //    quita desde su propio selector, no barriendola con el global.
        const { nodes } = readSchema(store);

        expect(nodes.trigger_imap?.onErrorStep).toBeNull();
        expect(nodes[MAPPER_ID]?.onErrorStep).toBeNull();
        expect(nodes[PARSER_ID]?.onErrorStep).toEqual({
          targetNode: SHARED_OCR_NODE_ID,
          catchErrors: [MULTIMODAL_FALLBACK_CODE],
        });
        expect(nodes[SHARED_ALERT_NODE_ID]).toBeUndefined();
      });

      it('8.11 deberia encender `failOnUnextractableMedia` al elegir la vision', () => {
        // 1. Arrange 📐: es la regresion del 400 reportado. La regla 10 delega en
        //    `ParserEmailStrategy.getUnreachableErrorCodes`, que devuelve el
        //    codigo como inalcanzable salvo que este interruptor este en `true`:
        //    la ruta selectiva quedaba desmentida por los propios `params` del
        //    nodo, y `validate-schema` la rechazaba con `params: {}`.
        const store = buildDraftWithPipeline();

        // 2. Act ⚙️
        store.setStepErrorBranch(PARSER_ID, 'VISION_IA');

        // 3. Assert 🎯: la condicion EXACTA que comprueba el backend.
        expect(readSchema(store).nodes[PARSER_ID]?.params.failOnUnextractableMedia).toBe(true);
      });

      it('8.12 deberia ingerir los adjuntos en el disparador aguas arriba', () => {
        // 1. Arrange 📐: `collectVisionAttachments` lee `raw_email.attachments`,
        //    que solo existe si el disparador los ingiere. Sin esto la ruta pasa
        //    la validacion, se dispara en produccion y llama al modelo con cero
        //    adjuntos: un respaldo mudo.
        const store = buildDraftWithPipeline();

        // 2. Act ⚙️
        store.setStepErrorBranch(PARSER_ID, 'VISION_IA');

        // 3. Assert 🎯
        expect(readSchema(store).nodes.trigger_imap?.params.includeAttachments).toBe(true);
        expect(store.hasVisionBranch).toBe(true);
      });

      it('8.13 deberia apagar el interruptor del parser al retirar la vision', () => {
        // 1. Arrange 📐: dejarlo en `true` sin ruta que lo recoja convertiria en
        //    PAUSADO un flujo que hoy atraviesa tranquilamente un correo de solo
        //    imagen. Es la misma semantica reversible de `declareCaughtErrorCodes`.
        const store = buildDraftWithPipeline();
        store.setStepErrorBranch(PARSER_ID, 'VISION_IA');

        // 2. Act ⚙️
        store.setStepErrorBranch(PARSER_ID, null);

        // 3. Assert 🎯
        expect(readSchema(store).nodes[PARSER_ID]?.params.failOnUnextractableMedia).toBe(false);
      });

      it('8.14 NO deberia apagar los adjuntos al retirar la vision', () => {
        // 1. Arrange 📐: ingerir adjuntos es util por si mismo, y apagarlo seria
        //    una perdida silenciosa de algo que el operador pudo querer aparte.
        //    Se revierte lo que se impuso para satisfacer una regla, no lo demas.
        const store = buildDraftWithPipeline();
        store.setStepErrorBranch(PARSER_ID, 'VISION_IA');

        // 2. Act ⚙️
        store.setStepErrorBranch(PARSER_ID, null);

        // 3. Assert 🎯
        expect(readSchema(store).nodes.trigger_imap?.params.includeAttachments).toBe(true);
        expect(store.hasVisionBranch).toBe(false);
      });

      it('8.15 deberia apagarlo tambien al cambiar de vision a alerta', () => {
        // 1. Arrange 📐: el hueco que deja mirar solo el caso `null`. La alerta
        //    usa la forma de cadena, que no atrapa ese codigo, asi que el
        //    interruptor quedaria encendido sin nadie que recogiera el fallo.
        const store = buildDraftWithPipeline();
        store.setStepErrorBranch(PARSER_ID, 'VISION_IA');

        // 2. Act ⚙️
        store.setStepErrorBranch(PARSER_ID, 'ALERTA_SMTP');

        // 3. Assert 🎯
        expect(readSchema(store).nodes[PARSER_ID]?.params.failOnUnextractableMedia).toBe(false);
        expect(readSchema(store).nodes[PARSER_ID]?.onErrorStep).toBe(SHARED_ALERT_NODE_ID);
      });

      it('8.16 NO deberia sembrar claves ajenas al contrato del tipo', () => {
        // 1. Arrange 📐: `failOnUnextractableMedia` solo existe en
        //    `ParserEmailConfigDto`. Escribirlo en un mapeador lo haria rechazar
        //    por `forbidNonWhitelisted`: se cambiaria un 400 por otro.
        const store = buildDraftWithPipeline();

        // 2. Act ⚙️
        store.setStepErrorBranch(MAPPER_ID, 'ALERTA_SMTP');

        // 3. Assert 🎯
        expect(
          Object.hasOwn(
            readSchema(store).nodes[MAPPER_ID]?.params ?? {},
            'failOnUnextractableMedia',
          ),
        ).toBe(false);
      });

      it('8.17 deberia conservar los params que no toca el contrato', () => {
        // 1. Arrange 📐: el operador pudo retocar el buzon a mano en el panel
        //    JSON, y sembrar un interruptor no es motivo para perderlo.
        const store = buildDraftWithPipeline();
        store.patchStepParams('trigger_imap', { mailbox: 'ARCHIVE' });

        // 2. Act ⚙️
        store.setStepErrorBranch(PARSER_ID, 'VISION_IA');

        // 3. Assert 🎯
        expect(readSchema(store).nodes.trigger_imap?.params).toEqual({
          mailbox: 'ARCHIVE',
          includeAttachments: true,
        });
      });

      it('8.18 deberia REINCORPORAR el flujo tras la transcripcion', () => {
        // 1. Arrange 📐: es lo que separa este satelite del de alerta. La alerta
        //    avisa y termina; la transcripcion devuelve el flujo al curso que
        //    llevaba el paso que fallo, o el rescate no publicaria nada.
        const store = buildDraftWithPipeline();

        // 2. Act ⚙️
        store.setStepErrorBranch(PARSER_ID, 'VISION_IA');

        // 3. Assert 🎯: el parser iba a `nodo_ia`, asi que ahi vuelve.
        expect(readSchema(store).nodes[SHARED_OCR_NODE_ID]?.nextStep).toBe(IA_ID);
      });

      it('8.18bis deberia RECALCULAR ese destino al reordenar la secuencia', () => {
        // 1. Arrange 📐: el caso que de otro modo deja el satelite colgando de
        //    un nodo que cambio de sitio, con el grafo apuntando a donde ya no
        //    toca.
        const store = buildDraftWithPipeline();
        store.setStepErrorBranch(PARSER_ID, 'VISION_IA');

        // 2. Act ⚙️: se retira el nodo de IA que seguia al parser.
        store.setSequence(store.sequence.filter((step) => step.nodeId !== IA_ID));

        // 3. Assert 🎯
        expect(readSchema(store).nodes[SHARED_OCR_NODE_ID]?.nextStep).toBe(MAPPER_ID);
      });

      it('8.19 deberia sembrar los defaults del tipo al reensamblar', () => {
        // 1. Arrange 📐: un paso puede llegar con `params: {}` desde un JSON
        //    editado a mano o desde una plantilla anterior al registro de
        //    defaults, y salir sin ellos al guardar.
        const store = buildDraftWithPipeline();

        // 2. Act ⚙️
        const { nodes } = readSchema(store);

        // 3. Assert 🎯
        expect(nodes.trigger_imap?.params).toEqual({ mailbox: 'INBOX', includeAttachments: false });
      });

      it('8.10 deberia PROVISIONAR el satelite de OCR sin depender del grafo', () => {
        // 1. Arrange 📐: antes la vision solo se podia ofrecer si la topologia ya
        //    traia un PROCESADOR_IA al que apuntar, porque un segundo nodo de IA
        //    chocaria con el en `llm_response`. Con `ocr_result` propio no
        //    colisiona con nadie y se auto-aprovisiona como la alerta.
        const store = useWorkflowTemplatesStore();
        store.initDraft();
        store.patchDraft({ name: 'Notiweb' });
        store.setSequence([
          {
            nodeId: PARSER_ID,
            nodeType: NodeType.PARSER_PRE_IA,
            outputNamespace: 'parsed_email',
            params: {},
          },
        ]);

        // 2. Act ⚙️
        store.setStepErrorBranch(PARSER_ID, 'VISION_IA');

        // 3. Assert 🎯
        const satellite = readSchema(store).nodes[SHARED_OCR_NODE_ID];

        expect(satellite?.nodeType).toBe(NodeType.PROCESADOR_OCR);
        expect(satellite?.outputNamespace).toBe('ocr_result');
        expect(store.errorBranchOf(PARSER_ID)).toBe('VISION_IA');
      });

      it('8.20 deberia RETIRAR el satelite de OCR al revocar la vision', () => {
        // 1. Arrange 📐: un satelite huerfano es un nodo inalcanzable que el
        //    validador rechaza.
        const store = buildDraftWithPipeline();
        store.setStepErrorBranch(PARSER_ID, 'VISION_IA');

        // 2. Act ⚙️
        store.setStepErrorBranch(PARSER_ID, null);

        // 3. Assert 🎯
        expect(readSchema(store).nodes[SHARED_OCR_NODE_ID]).toBeUndefined();
        expect(store.errorBranchOf(PARSER_ID)).toBeNull();
      });

      it('8.21 deberia desviar el fallo del satelite de OCR hacia la alerta', () => {
        // 1. Arrange 📐: la transcripcion tambien falla —sin adjuntos, 503 del
        //    proveedor, cero caracteres—. Con `onErrorStep: null` a ciegas el
        //    motor no encontraba ruta y PAUSABA el flujo teniendo al lado la
        //    alerta que el propio borrador acaba de provisionar.
        const store = buildDraftWithPipeline();

        // 2. Act ⚙️: dos ramas, una por satelite.
        store.setStepErrorBranch(PARSER_ID, 'VISION_IA');
        store.setStepErrorBranch(MAPPER_ID, 'ALERTA_SMTP');

        // 3. Assert 🎯: forma de CADENA, la unica que atrapa cualquier codigo.
        const { nodes } = readSchema(store);

        expect(nodes[SHARED_OCR_NODE_ID]?.onErrorStep).toBe(SHARED_ALERT_NODE_ID);
        // La alerta sigue terminal: apuntarse a si misma seria un bucle.
        expect(nodes[SHARED_ALERT_NODE_ID]?.onErrorStep).toBeNull();
      });

      it('8.22 deberia conservar esa ruta al REORDENAR la secuencia', () => {
        // 1. Arrange 📐: `reconcileSatellites` reconstruye el satelite entero en
        //    cada cambio de orden, asi que la ruta tiene que recalcularse con el
        //    o se perderia en el primer uso de las flechas.
        const store = buildDraftWithPipeline();
        store.setStepErrorBranch(PARSER_ID, 'VISION_IA');
        store.setStepErrorBranch(MAPPER_ID, 'ALERTA_SMTP');

        // 2. Act ⚙️: se retira el nodo de IA que seguia al parser.
        store.setSequence(store.sequence.filter((step) => step.nodeId !== IA_ID));

        // 3. Assert 🎯: el destino del rescate se mueve, la ruta de fallo no.
        const { nodes } = readSchema(store);

        expect(nodes[SHARED_OCR_NODE_ID]?.nextStep).toBe(MAPPER_ID);
        expect(nodes[SHARED_OCR_NODE_ID]?.onErrorStep).toBe(SHARED_ALERT_NODE_ID);
      });

      it('8.23 deberia dejar el satelite sin ruta si el flujo no tiene alerta', () => {
        // 1. Arrange 📐: inventar el destino romperia la regla 3 del validador
        //    —todo `onErrorStep` no nulo resuelve a un nodo existente—.
        const store = buildDraftWithPipeline();

        // 2. Act ⚙️
        store.setStepErrorBranch(PARSER_ID, 'VISION_IA');

        // 3. Assert 🎯
        const { nodes } = readSchema(store);

        expect(nodes[SHARED_ALERT_NODE_ID]).toBeUndefined();
        expect(nodes[SHARED_OCR_NODE_ID]?.onErrorStep).toBeNull();
      });
    });

    describe('6. Nodos minimos del borrador', () => {
      it('6.1 no deberia declararse valido con nombre pero sin nodos', () => {
        // 1. Arrange: guardar asi provoca un 400 del validador —`entrypoint` vacio
        //    y `nodes` vacio—, y el operador solo veia el error tras la peticion.
        const store = useWorkflowTemplatesStore();
        store.initDraft();

        // 2. Act
        store.patchDraft({ name: 'Notiweb' });

        // 3. Assert
        expect(store.schemaNodeCount).toBe(0);
        expect(store.isDraftValid).toBe(false);
      });

      it('6.2 deberia declararse valido en cuanto la secuencia aporta un nodo', () => {
        // 1. Arrange
        const store = useWorkflowTemplatesStore();
        store.initDraft();
        store.patchDraft({ name: 'Notiweb' });

        // 2. Act
        store.setSequence([
          {
            nodeId: 'trigger_cron',
            nodeType: NodeType.TRIGGER_CRON,
            outputNamespace: 'cron_trigger',
            params: {},
          },
        ]);

        // 3. Assert
        expect(store.schemaNodeCount).toBe(1);
        expect(store.isDraftValid).toBe(true);
      });

      it('6.3 deberia contar los nodos escritos a mano en el texto', () => {
        // 1. Arrange: el editor JSON es editable directamente y la sincronizacion
        //    con `sequence` es de una sola direccion. Contar sobre `sequence`
        //    dejaria el boton bloqueado con un documento que si tiene nodos.
        const store = useWorkflowTemplatesStore();
        store.initDraft();

        // 2. Act
        store.patchDraft({ name: 'Notiweb', schemaText: JSON.stringify(SCHEMA) });

        // 3. Assert
        expect(store.sequence).toHaveLength(0);
        expect(store.schemaNodeCount).toBe(1);
        expect(store.isDraftValid).toBe(true);
      });

      it('6.4 deberia devolver 0 nodos ante un JSON roto sin lanzar', () => {
        // 1. Arrange
        const store = useWorkflowTemplatesStore();
        store.initDraft();

        // 2. Act
        store.patchDraft({ name: 'Notiweb', schemaText: '{ "nodes": ' });

        // 3. Assert
        expect(store.schemaNodeCount).toBe(0);
      });

      it('6.5 deberia devolver 0 cuando nodes no es un objeto', () => {
        // 1. Arrange
        const store = useWorkflowTemplatesStore();
        store.initDraft();

        // 2. Act
        store.patchDraft({ name: 'Notiweb', schemaText: '{"nodes": []}' });

        // 3. Assert
        expect(store.schemaNodeCount).toBe(0);
      });
    });
  });
});
