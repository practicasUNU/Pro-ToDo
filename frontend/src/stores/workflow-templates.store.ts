import { defineStore, acceptHMRUpdate } from 'pinia';
import { computed, ref } from 'vue';

import * as workflowTemplatesService from '@services/workflow-templates.service';

import type {
  CreateWorkflowTemplatePayload,
  WorkflowTemplateDetail,
  WorkflowTemplateSummary,
} from '@/types/pipeline';

/**
 * Buffer de edicion del editor de plantillas.
 *
 * `pipelineSchema` viaja como TEXTO y no como objeto: el editor administrativo
 * es un area de codigo JSON, y mantener aqui el objeto parseado obligaria a
 * reserializarlo en cada tecla —perdiendo el formato del autor— o a rechazar el
 * borrador mientras el JSON esta a medio escribir. Se parsea una sola vez, al
 * guardar.
 *
 * `description` es opcional y NUNCA se asigna como `undefined` explicito:
 * `exactOptionalPropertyTypes` lo prohibe, asi que la clave se omite.
 */
export interface WorkflowTemplateDraft {
  name: string;
  description?: string;
  schemaText: string;
  active: boolean;
}

/** Esqueleto que el editor ofrece al crear, para no arrancar de una hoja vacia. */
const BLANK_SCHEMA_TEXT = JSON.stringify(
  {
    flowId: 'plantilla-nueva',
    name: 'Plantilla nueva',
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
  },
  null,
  2,
);

// Logica de negocio y estado compartido del catalogo de plantillas de flujo.
// Esta capa no conoce Axios ni rutas (`frontend-architecture.md` §2.1): invoca
// al servicio y muta el estado de forma inmutable con su resultado.
export const useWorkflowTemplatesStore = defineStore('workflowTemplates', () => {
  const templates = ref<WorkflowTemplateSummary[]>([]);
  const isLoading = ref(false);

  /** Plantilla abierta en el editor, con su grafo completo. */
  const selectedTemplate = ref<WorkflowTemplateDetail | null>(null);

  const activeDraft = ref<WorkflowTemplateDraft>({
    name: '',
    schemaText: BLANK_SCHEMA_TEXT,
    active: true,
  });

  /** Solo las disponibles, que son las que el asistente puede instanciar. */
  const activeTemplates = computed<WorkflowTemplateSummary[]>(() =>
    templates.value.filter((template) => template.active),
  );

  /**
   * Error de sintaxis del JSON del borrador, o `null` si parsea.
   *
   * Es validacion de FORMA, no de contenido: que el JSON sea parseable no
   * significa que el grafo sea coherente. De eso manda el backend con
   * `PipelineValidatorService`, que es la unica autoridad sobre la topologia.
   * Detectar aqui el JSON roto solo evita gastar una peticion en un 400 seguro.
   */
  const schemaSyntaxError = computed<string | null>(() => {
    try {
      const parsed: unknown = JSON.parse(activeDraft.value.schemaText);

      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return 'El esquema debe ser un objeto JSON.';
      }

      return null;
    } catch (error) {
      return error instanceof Error ? error.message : 'JSON invalido.';
    }
  });

  const isDraftValid = computed<boolean>(
    () => activeDraft.value.name.trim().length > 0 && schemaSyntaxError.value === null,
  );

  /**
   * Carga el borrador para editar una plantilla, o lo deja en blanco para crear.
   *
   * @param template Plantilla a editar; omitida para un alta.
   */
  const initDraft = (template?: WorkflowTemplateDetail): void => {
    activeDraft.value = {
      name: template?.name ?? '',
      // Se reindenta a proposito: el backend guarda el jsonb sin formato, y sin
      // esto el editor mostraria el grafo entero en una sola linea.
      schemaText:
        template === undefined
          ? BLANK_SCHEMA_TEXT
          : JSON.stringify(template.pipelineSchema, null, 2),
      active: template?.active ?? true,
      // `exactOptionalPropertyTypes`: la clave se OMITE en vez de asignarse como
      // `undefined`. La entidad la trae como `string | null`.
      ...(template?.description ? { description: template.description } : {}),
    };
    selectedTemplate.value = template ?? null;
  };

  const patchDraft = (patch: Partial<WorkflowTemplateDraft>): void => {
    activeDraft.value = { ...activeDraft.value, ...patch };
  };

  const fetchTemplates = async (includeInactive = false): Promise<void> => {
    isLoading.value = true;

    try {
      templates.value = await workflowTemplatesService.fetchWorkflowTemplates(includeInactive);
    } finally {
      isLoading.value = false;
    }
  };

  /** Trae el grafo completo y lo abre en el editor. */
  const loadForEdit = async (id: string): Promise<WorkflowTemplateDetail> => {
    isLoading.value = true;

    try {
      const detail = await workflowTemplatesService.fetchWorkflowTemplate(id);
      initDraft(detail);
      return detail;
    } finally {
      isLoading.value = false;
    }
  };

  /**
   * Persiste el borrador: alta si no hay plantilla seleccionada, edicion si la hay.
   *
   * El JSON se parsea AQUI y no en el componente: el store es el dueno del
   * borrador, y el componente no debe conocer que `schemaText` es texto de un
   * objeto. No se captura el error del servicio (§2.1).
   *
   * @throws Error Si el JSON del borrador no parsea.
   */
  const saveDraft = async (): Promise<WorkflowTemplateDetail> => {
    if (schemaSyntaxError.value !== null) {
      throw new Error(`El esquema no es un JSON valido: ${schemaSyntaxError.value}`);
    }

    const pipelineSchema = JSON.parse(activeDraft.value.schemaText) as Record<string, unknown>;
    const description = activeDraft.value.description?.trim();

    const payload: CreateWorkflowTemplatePayload = {
      name: activeDraft.value.name.trim(),
      pipelineSchema,
      active: activeDraft.value.active,
      ...(description !== undefined && description !== '' ? { description } : {}),
    };

    isLoading.value = true;

    try {
      const editedId = selectedTemplate.value?.id;

      const saved =
        editedId === undefined
          ? await workflowTemplatesService.createWorkflowTemplate(payload)
          : await workflowTemplatesService.updateWorkflowTemplate(editedId, payload);

      upsert(saved);
      return saved;
    } finally {
      isLoading.value = false;
    }
  };

  /** Cambia la disponibilidad sin abrir el editor, desde el toggle de la tabla. */
  const setActive = async (id: string, active: boolean): Promise<WorkflowTemplateDetail> => {
    isLoading.value = true;

    try {
      const updated: WorkflowTemplateDetail = active
        ? await workflowTemplatesService.updateWorkflowTemplate(id, { active: true })
        : await workflowTemplatesService.deactivateWorkflowTemplate(id);

      upsert(updated);
      return updated;
    } finally {
      isLoading.value = false;
    }
  };

  /**
   * Inserta o reemplaza la plantilla en la coleccion, de forma inmutable.
   *
   * Se conserva en la lista aunque quede inactiva: la tabla administrativa
   * muestra ambos estados y retirarla de la coleccion la haria desaparecer de la
   * vista en la que el operador acaba de pulsar.
   */
  const upsert = (template: WorkflowTemplateSummary): void => {
    const exists = templates.value.some((candidate) => candidate.id === template.id);

    templates.value = exists
      ? templates.value.map((candidate) => (candidate.id === template.id ? template : candidate))
      : [...templates.value, template];
  };

  const resetDraft = (): void => {
    activeDraft.value = { name: '', schemaText: BLANK_SCHEMA_TEXT, active: true };
    selectedTemplate.value = null;
  };

  return {
    templates,
    isLoading,
    selectedTemplate,
    activeDraft,
    activeTemplates,
    schemaSyntaxError,
    isDraftValid,
    initDraft,
    patchDraft,
    fetchTemplates,
    loadForEdit,
    saveDraft,
    setActive,
    resetDraft,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useWorkflowTemplatesStore, import.meta.hot));
}
