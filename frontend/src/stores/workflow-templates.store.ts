import { defineStore, acceptHMRUpdate } from 'pinia';
import { computed, ref } from 'vue';

import * as fsmService from '@services/fsm.service';
import * as workflowTemplatesService from '@services/workflow-templates.service';

import {
  assemblePipelineSchema,
  collectErrorSatellites,
  disassemblePipelineSchema,
  errorRouteTarget,
} from '@/utils/pipeline-assembler';
import { withBaseParamDefaults } from '@/utils/node-base-params';

import {
  DEFAULT_OUTPUT_NAMESPACE_BY_NODE_TYPE,
  NodeType,
  TRIGGER_NODE_TYPES,
} from '@/types/pipeline';
import {
  ERROR_BRANCH_ACTIONS,
  MULTIMODAL_FALLBACK_CODE,
  SHARED_ALERT_NODE_ID,
} from '@/types/nodes/error-branch.types';

import type { AssemblerStep } from '@/utils/pipeline-assembler';
import type { ErrorBranchAction } from '@/types/nodes/error-branch.types';
import type {
  AssembledPipelineSchema,
  SelectiveErrorFallback,
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

/**
 * Esqueleto que el editor ofrece al crear.
 *
 * SIN nodos a proposito. Antes traia un `trigger_imap` de muestra, y eso era
 * incoherente con un constructor topologico: el operador veia en la secuencia
 * una tarjeta que no habia anadido, y la guarda de "al menos un nodo" no se
 * activaba nunca en un alta porque el esqueleto ya cumplia.
 *
 * `assemblePipelineSchema` contempla la secuencia vacia, asi que anadir el
 * primer nodo regenera el documento con su `entrypoint` correcto.
 */
const BLANK_SCHEMA_TEXT = JSON.stringify(
  {
    flowId: 'plantilla-nueva',
    name: 'Plantilla nueva',
    version: '1.0.0',
    entrypoint: '',
    nodes: {},
  },
  null,
  2,
);

/**
 * Unico texto de la regla Poka-Yoke del Entry Point.
 *
 * Replica el mensaje que emite la regla 9 del validador de topologia del
 * backend, que es quien manda: la UI solo se adelanta para ahorrar el viaje.
 */
const ENTRY_POINT_MESSAGE =
  'El nodo inicial (Entry Point) debe ser un disparador de categoria TRIGGER';

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

  /**
   * Nodos alcanzables SOLO por una ruta de error (`onErrorStep`).
   *
   * Viven APARTE de `sequence` y no al final de ella porque el encadenado de
   * `assemblePipelineSchema` es posicional: un nodo de alerta metido entre los
   * pasos heredaria un `nextStep` y acabaria ejecutandose en el camino feliz, en
   * cada pasada y no solo cuando algo falla.
   *
   * Sin este estado, `rebuildSchemaFromSequence` reensamblaba con la lista de
   * satelites vacia y BORRABA el nodo destino del mapa en cuanto el operador
   * tocaba el selector: el esquema salia con una ruta apuntando a un nodo
   * inexistente y el backend lo rechazaba con su regla 3.
   */
  const satellites = ref<AssemblerStep[]>([]);

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

  /**
   * Nodos del documento vigente, o 0 si no es un grafo legible.
   *
   * Se cuenta sobre el TEXTO y no sobre `sequence`: el editor JSON de la derecha
   * es editable a mano y su sincronizacion con la secuencia es de una sola
   * direccion, asi que `sequence` puede quedar desfasada mientras el documento
   * que se va a enviar ya tiene nodos. Se cuenta lo que se envia.
   */
  const schemaNodeCount = computed<number>(() => {
    try {
      const parsed: unknown = JSON.parse(activeDraft.value.schemaText);

      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return 0;
      }

      const { nodes } = parsed as { nodes?: unknown };

      return typeof nodes === 'object' && nodes !== null && !Array.isArray(nodes)
        ? Object.keys(nodes).length
        : 0;
    } catch {
      return 0;
    }
  });

  /**
   * Motivo por el que el Entry Point no es valido, o `null` si lo es.
   *
   * Se deriva del TEXTO por el mismo motivo que `schemaNodeCount`: el editor JSON
   * es editable a mano y `sequence` puede quedar desfasada, asi que se juzga lo
   * que se va a enviar.
   *
   * Ante cualquier documento que no se pueda leer devuelve `null` y deja pasar:
   * el JSON roto o el grafo a medio escribir ya los cubren `schemaSyntaxError` y
   * `schemaNodeCount`, y la autoridad final sigue siendo el backend.
   */
  const entryPointIssue = computed<string | null>(() => {
    let parsed: unknown;

    try {
      parsed = JSON.parse(activeDraft.value.schemaText);
    } catch {
      return null;
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }

    const { entrypoint, nodes } = parsed as { entrypoint?: unknown; nodes?: unknown };

    if (typeof entrypoint !== 'string' || entrypoint.length === 0) return null;
    if (typeof nodes !== 'object' || nodes === null || Array.isArray(nodes)) return null;

    const entryNode = (nodes as Record<string, { nodeType?: unknown }>)[entrypoint];

    if (entryNode === undefined || typeof entryNode.nodeType !== 'string') return null;

    return TRIGGER_NODE_TYPES.has(entryNode.nodeType) ? null : ENTRY_POINT_MESSAGE;
  });

  /**
   * Condiciones minimas para intentar el guardado.
   *
   * Las tres son de FORMA, no de negocio: un nombre, un documento parseable y al
   * menos un nodo. La configuracion de cada nodo no se juzga aqui —una plantilla
   * es una topologia— y de eso se encarga el asistente al instanciar el flujo.
   *
   * La guarda de sintaxis se conserva pese a que `schemaNodeCount` ya la implica:
   * sin ella, un JSON roto dejaria el boton habilitado para que `saveDraft`
   * lanzase despues, cambiando un boton deshabilitado con motivo por un aviso de
   * error. Explicita se lee mejor de lo que cuesta.
   */
  const isDraftValid = computed<boolean>(
    () =>
      activeDraft.value.name.trim().length > 0 &&
      schemaSyntaxError.value === null &&
      schemaNodeCount.value > 0 &&
      entryPointIssue.value === null,
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
    satellites.value = readSatellitesFrom(activeDraft.value.schemaText, sequence.value);
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
   * Lee los nodos que solo alcanza una ruta de error, o `[]` si no se puede.
   *
   * Hermano de `readSequenceFrom` y con su misma tolerancia al texto invalido:
   * se invoca al ABRIR el dialogo, y un grafo corrupto debe poder abrirse, que
   * es justamente donde se arregla.
   *
   * @param schemaText Documento vigente.
   * @param activeSteps Lo que devolvio `readSequenceFrom` sobre el mismo texto.
   */
  const readSatellitesFrom = (
    schemaText: string,
    activeSteps: readonly AssemblerStep[],
  ): AssemblerStep[] => {
    try {
      const parsed = JSON.parse(schemaText) as AssembledPipelineSchema;
      return collectErrorSatellites(parsed, activeSteps);
    } catch {
      return [];
    }
  };

  /**
   * Reescribe `schemaText` a partir de la secuencia actual.
   *
   * Conserva `flowId`, `name`, `version` y `executionPolicy` del documento
   * vigente en vez de regenerarlos: son metadatos que el operador ajusto por su
   * cuenta, y el selector solo es dueno de la TOPOLOGIA. Un campo raiz que no se
   * propague aqui desaparece en cuanto se anade o se mueve un nodo, y en
   * silencio: el operador marcaria la politica, reordenaria la secuencia y la
   * perderia sin que nada se lo dijera.
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

    const schema = assemblePipelineSchema(
      sequence.value,
      {
        flowId: current.flowId ?? 'plantilla-nueva',
        name: current.name ?? activeDraft.value.name.trim(),
        ...(current.version !== undefined ? { version: current.version } : {}),
        ...(current.executionPolicy !== undefined
          ? { executionPolicy: current.executionPolicy }
          : {}),
      },
      satellites.value,
    );

    patchDraft({ schemaText: JSON.stringify(schema, null, 2) });
  };

  /**
   * Politica declarada por el documento vigente.
   *
   * Se lee del `schemaText` y no de un `ref` aparte a proposito: el texto es la
   * unica fuente de verdad del borrador —el operador puede editarlo a mano en el
   * panel JSON— y un espejo reactivo se desincronizaria en cuanto lo hiciera.
   */
  const stopOnFirstSuccess = computed<boolean>(() => {
    try {
      const parsed = JSON.parse(activeDraft.value.schemaText) as Partial<AssembledPipelineSchema>;

      return parsed.executionPolicy?.stopOnFirstSuccess === true;
    } catch {
      // Documento a medio escribir: sin politica legible, el control se muestra
      // apagado en vez de romper el editor.
      return false;
    }
  });

  /**
   * Conmuta la politica reescribiendo el documento.
   *
   * Al desmarcar se ELIMINA `executionPolicy` en vez de dejar
   * `{ stopOnFirstSuccess: false }`: el esquema declara lo que el flujo hace, y
   * una politica presente que no hace nada es ruido que ademas habria que
   * mantener sincronizado con el default del backend.
   */
  const setStopOnFirstSuccess = (enabled: boolean): void => {
    let current: Partial<AssembledPipelineSchema>;

    try {
      current = JSON.parse(activeDraft.value.schemaText) as AssembledPipelineSchema;
    } catch {
      // Con el JSON roto no hay documento sobre el que fijar la politica; el
      // control queda apagado y el operador arregla antes el texto.
      return;
    }

    // Se reconstruye SIN la clave en vez de asignarle `false`: el esquema
    // declara lo que el flujo hace, y una politica presente que no hace nada
    // seria ruido que ademas habria que mantener a la par del default del
    // backend.
    const rest: Record<string, unknown> = { ...current };
    delete rest.executionPolicy;

    const schema = enabled ? { ...rest, executionPolicy: { stopOnFirstSuccess: true } } : rest;

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

  /**
   * Nodo de la secuencia que puede atender un desvio de vision, o `null`.
   *
   * El fallback multimodal apunta al `PROCESADOR_IA` que la topologia YA tiene y
   * nunca crea uno nuevo: un segundo nodo de IA chocaria con el existente en el
   * namespace `llm_response`, que la regla 5 del validador declara unico.
   */
  const visionTargetNodeId = computed<string | null>(
    () => sequence.value.find((step) => step.nodeType === NodeType.PROCESADOR_IA)?.nodeId ?? null,
  );

  /**
   * Accion de contingencia declarada por un paso, o `null` si no tiene ruta.
   *
   * Se deriva de la SECUENCIA —donde vive `onErrorStep`— y se resuelve por el
   * tipo del nodo destino, no por su identificador: la forma de la ruta dice a
   * donde va, y quien decide que significa eso es el catalogo de acciones.
   */
  const errorBranchOf = (nodeId: string): ErrorBranchAction | null => {
    const step = sequence.value.find((candidate) => candidate.nodeId === nodeId);

    if (step === undefined) return null;

    const targetNode = errorRouteTarget(step.onErrorStep);

    if (targetNode === null) return null;

    const targetType =
      targetNode === SHARED_ALERT_NODE_ID
        ? NodeType.DESTINO_SMTP
        : (sequence.value.find((candidate) => candidate.nodeId === targetNode)?.nodeType ??
          satellites.value.find((candidate) => candidate.nodeId === targetNode)?.nodeType ??
          null);

    if (targetType === null) return null;

    return (
      (Object.keys(ERROR_BRANCH_ACTIONS) as ErrorBranchAction[]).find(
        (action) => ERROR_BRANCH_ACTIONS[action].targetNodeType === targetType,
      ) ?? null
    );
  };

  /**
   * Ruta en la forma que espera el motor, o `null` si la accion no es aplicable.
   *
   * La CADENA y no un objeto con un codigo comodin para la alerta: es la unica
   * forma que el motor trata como "atrapa cualquier fallo". El fallback de
   * vision usa la forma selectiva porque solo debe dispararse ante el codigo del
   * parser; un respaldo incondicional hacia la IA mandaria alli tambien los
   * fallos de configuracion, que no es lo que nadie quiso decir.
   */
  const buildErrorRoute = (action: ErrorBranchAction): string | SelectiveErrorFallback | null => {
    if (action === 'ALERTA_SMTP') return SHARED_ALERT_NODE_ID;

    const targetNode = visionTargetNodeId.value;

    return targetNode === null ? null : { targetNode, catchErrors: [MULTIMODAL_FALLBACK_CODE] };
  };

  /**
   * Reconcilia el satelite de alerta con las rutas vigentes.
   *
   * UNO POR FLUJO, compartido por todas las ramas: la regla 5 del validador
   * prohibe que dos nodos escriban en `smtp_result`, asi que un satelite por
   * paso devolveria un 400 en cuanto hubiera dos rutas.
   *
   * Los `params` se siembran con los defaults del tipo y NADA mas: los
   * destinatarios son configuracion de OPERACION y se piden en el asistente, al
   * instanciar el flujo. Una plantilla que los llevara dentro impondria los
   * mismos a todos los flujos que partieran de ella.
   *
   * @param steps Secuencia ya actualizada sobre la que juzgar.
   */
  const reconcileAlertSatellite = (steps: readonly AssemblerStep[]): void => {
    const isReferenced = steps.some(
      (step) => errorRouteTarget(step.onErrorStep) === SHARED_ALERT_NODE_ID,
    );
    const exists = satellites.value.some((satellite) => satellite.nodeId === SHARED_ALERT_NODE_ID);

    if (isReferenced && !exists) {
      satellites.value = [
        ...satellites.value,
        {
          nodeId: SHARED_ALERT_NODE_ID,
          nodeType: NodeType.DESTINO_SMTP,
          outputNamespace: DEFAULT_OUTPUT_NAMESPACE_BY_NODE_TYPE[NodeType.DESTINO_SMTP],
          params: withBaseParamDefaults(NodeType.DESTINO_SMTP, {}),
          onErrorStep: null,
        },
      ];
      return;
    }

    // Se retira solo el satelite que ESTE store provisiona. Otro nodo suelto que
    // el operador escribiera a mano en el panel JSON no es asunto del selector.
    if (!isReferenced && exists) {
      satellites.value = satellites.value.filter(
        (satellite) => satellite.nodeId !== SHARED_ALERT_NODE_ID,
      );
    }
  };

  /**
   * Declara —o retira— la ruta de contingencia de un paso.
   *
   * Es la UNICA via por la que se escribe `onErrorStep`: el asistente solo lee
   * estas rutas, porque la topologia es propiedad de la plantilla y una
   * instancia no debe poder inventarse una que su plantilla no declara.
   *
   * @param nodeId Paso que se desviaria.
   * @param action Accion de respaldo, o `null` para quitar la ruta.
   */
  const setStepErrorBranch = (nodeId: string, action: ErrorBranchAction | null): void => {
    const route = action === null ? null : buildErrorRoute(action);

    const steps = sequence.value.map<AssemblerStep>((step) =>
      step.nodeId === nodeId ? { ...step, onErrorStep: route } : step,
    );

    // ANTES de reensamblar: `rebuildSchemaFromSequence` lee `satellites.value`,
    // asi que provisionar el nodo despues lo dejaria fuera del documento hasta
    // el siguiente cambio del selector.
    reconcileAlertSatellite(steps);
    setSequence(steps);
  };

  /**
   * Si TODO paso desviable declara ya una ruta de contingencia.
   *
   * Se deriva de la secuencia y no de un `ref` aparte, por el mismo motivo que
   * `stopOnFirstSuccess`: el documento es la unica fuente de verdad, y un espejo
   * reactivo se desincronizaria en cuanto alguien editase el JSON a mano.
   *
   * Los `DESTINO_SMTP` quedan fuera del recuento: desviarlos seria mandarlos a
   * si mismos.
   */
  const notifyAllErrors = computed<boolean>(() => {
    const divertible = sequence.value.filter((step) => step.nodeType !== NodeType.DESTINO_SMTP);

    return (
      divertible.length > 0 &&
      divertible.every((step) => errorRouteTarget(step.onErrorStep) !== null)
    );
  });

  /**
   * Conmuta el respaldo por correo de todo el flujo.
   *
   * Al activar NO pisa las rutas ya declaradas: el fallback de vision que el
   * operador eligio para el parser sobrevive, y solo los pasos sin ruta reciben
   * la alerta. Al desactivar se retiran unicamente las rutas de alerta; una de
   * vision es una decision distinta y se quita desde su propio selector.
   */
  const setNotifyAllErrors = (enabled: boolean): void => {
    const steps = sequence.value.map<AssemblerStep>((step) => {
      if (step.nodeType === NodeType.DESTINO_SMTP) return step;

      if (enabled) {
        return errorRouteTarget(step.onErrorStep) === null
          ? { ...step, onErrorStep: SHARED_ALERT_NODE_ID }
          : step;
      }

      return errorRouteTarget(step.onErrorStep) === SHARED_ALERT_NODE_ID
        ? { ...step, onErrorStep: null }
        : step;
    });

    reconcileAlertSatellite(steps);
    setSequence(steps);
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
    satellites.value = [];
  };

  return {
    templates,
    isLoading,
    selectedTemplate,
    activeDraft,
    activeTemplates,
    schemaSyntaxError,
    schemaNodeCount,
    isDraftValid,
    entryPointIssue,
    sequence,
    stopOnFirstSuccess,
    setStopOnFirstSuccess,
    initDraft,
    patchDraft,
    setSequence,
    patchStepParams,
    satellites,
    visionTargetNodeId,
    errorBranchOf,
    setStepErrorBranch,
    notifyAllErrors,
    setNotifyAllErrors,
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
