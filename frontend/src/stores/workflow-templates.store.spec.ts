import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useWorkflowTemplatesStore } from './workflow-templates.store';

import { NodeType } from '@/types/pipeline';

import type { WorkflowTemplateDetail, WorkflowTemplateSummary } from '@/types/pipeline';

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

    it('2.4 deberia declararse valido con nombre y JSON correcto', () => {
      // 1. Arrange
      const store = useWorkflowTemplatesStore();
      store.initDraft();

      // 2. Act
      store.patchDraft({ name: 'Notiweb' });

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
  });
});
