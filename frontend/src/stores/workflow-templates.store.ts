import { defineStore, acceptHMRUpdate } from 'pinia';
import { computed, ref } from 'vue';

import * as fsmService from '@services/fsm.service';
import * as workflowTemplatesService from '@services/workflow-templates.service';

import { assemblePipelineSchema, disassemblePipelineSchema } from '@/utils/pipeline-assembler';

import type { AssemblerStep } from '@/utils/pipeline-assembler';
import type {
  AssembledPipelineSchema,
  CreateWorkflowTemplatePayload,
  ValidateSchemaResult,
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

  /**
   * Secuencia de nodos que compone el ensamblador, EN ORDEN DE EJECUCION.
   *
   * Es la segunda cara del mismo grafo que `activeDraft.schemaText`, y la
   * sincronizacion es de UNA SOLA DIRECCION: la secuencia manda sobre el texto,
   * nunca al reves. Un `watch` sobre el texto que reconstruyera la secuencia
   * pelearia con el editor en cada pulsacion —el JSON pasa por estados
   * intermedios que no parsean— y el cursor saltaria solo.
   *
   * El texto sigue siendo editable a mano; lo que se pierde al tocar el selector
   * despues es la topologia escrita a mano, no los `params`, que se reinyectan
   * por `nodeId` en `rebuildSchemaFromSequence`.
   */
  const sequence = ref<AssemblerStep[]>([]);

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

    // La secuencia se DERIVA del grafo que se acaba de cargar, recorriendolo
    // desde `entrypoint`. Sin esto, editar una plantilla existente mostraria el
    // selector vacio junto a un JSON lleno, y el primer cambio en el selector
    // borraria la topologia guardada.
    sequence.value = readSequenceFrom(activeDraft.value.schemaText);
  };

  const patchDraft = (patch: Partial<WorkflowTemplateDraft>): void => {
    activeDraft.value = { ...activeDraft.value, ...patch };
  };

  /**
   * Lee la secuencia de un documento JSON, o `[]` si no es un grafo legible.
   *
   * Tolera el texto invalido a proposito y sin propagar el error: se invoca al
   * ABRIR el dialogo, y un grafo corrupto en la base de datos no debe impedir
   * abrir el editor —que es justamente donde se arregla.
   */
  const readSequenceFrom = (schemaText: string): AssemblerStep[] => {
    try {
      const parsed = JSON.parse(schemaText) as AssembledPipelineSchema;
      return disassemblePipelineSchema(parsed);
    } catch {
      return [];
    }
  };

  /**
   * Reescribe `schemaText` a partir de la secuencia actual.
   *
   * Conserva `flowId`, `name` y `version` del documento vigente en vez de
   * regenerarlos: son metadatos que el operador puede haber ajustado a mano en
   * el editor, y el selector solo es dueno de la TOPOLOGIA.
   *
   * Se reindenta a dos espacios, igual que `initDraft`.
   */
  const rebuildSchemaFromSequence = (): void => {
    let current: Partial<AssembledPipelineSchema>;

    try {
      current = JSON.parse(activeDraft.value.schemaText) as AssembledPipelineSchema;
    } catch {
      // Un JSON roto no bloquea el ensamblador: se regenera desde cero, que es
      // exactamente la via por la que el operador sale de un documento invalido.
      current = {};
    }

    const schema = assemblePipelineSchema(sequence.value, {
      flowId: current.flowId ?? 'plantilla-nueva',
      name: current.name ?? activeDraft.value.name.trim(),
      ...(current.version !== undefined ? { version: current.version } : {}),
    });

    patchDraft({ schemaText: JSON.stringify(schema, null, 2) });
  };

  /**
   * Sustituye la secuencia completa y regenera el grafo.
   *
   * Recibe la secuencia entera y no una operacion (anadir / quitar / mover)
   * porque el componente ya la manipula como arreglo: exponer aqui las tres
   * operaciones obligaria a duplicar en el store una logica de lista que Vue ya
   * resuelve, y a mantener las dos versiones de acuerdo.
   */
  const setSequence = (steps: AssemblerStep[]): void => {
    sequence.value = steps;
    rebuildSchemaFromSequence();
  };

  /** Reemplaza los `params` de un nodo concreto y regenera el grafo. */
  const patchStepParams = (nodeId: string, params: Record<string, unknown>): void => {
    setSequence(
      sequence.value.map((step) => (step.nodeId === nodeId ? { ...step, params } : step)),
    );
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

  /**
   * Valida el grafo del borrador contra el motor, sin persistirlo.
   *
   * El JSON se parsea AQUI por el mismo motivo que en `saveDraft`: el store es
   * el dueno del borrador, y el componente no debe conocer que `schemaText` es
   * texto de un objeto.
   *
   * No captura el error del servicio (§2.1): el componente necesita el
   * `AxiosError` intacto para sacarle los `issues` con `extractApiIssues` y
   * pintarlos en el editor.
   *
   * @throws Error Si el JSON del borrador no parsea.
   */
  const validateDraftSchema = async (): Promise<ValidateSchemaResult> => {
    if (schemaSyntaxError.value !== null) {
      throw new Error(`El esquema no es un JSON valido: ${schemaSyntaxError.value}`);
    }

    const pipelineSchema = JSON.parse(activeDraft.value.schemaText) as Record<string, unknown>;

    return fsmService.validatePipelineSchema(pipelineSchema);
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
    sequence.value = [];
  };

  return {
    templates,
    isLoading,
    selectedTemplate,
    activeDraft,
    activeTemplates,
    schemaSyntaxError,
    isDraftValid,
    sequence,
    initDraft,
    patchDraft,
    setSequence,
    patchStepParams,
    rebuildSchemaFromSequence,
    fetchTemplates,
    loadForEdit,
    saveDraft,
    validateDraftSchema,
    setActive,
    resetDraft,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useWorkflowTemplatesStore, import.meta.hot));
}
