import { defineStore, acceptHMRUpdate } from 'pinia';
import { computed, ref } from 'vue';

import * as templateMapperService from '@services/nodes/template-mapper.service';

import { OUTPUT_NAMESPACE_PATTERN } from '@/types/pipeline';

import type { HydratableNode } from '@stores/nodes/node-store-registry';

import type { HtmlTemplate } from '@/types/html-template';

/** Namespace por defecto, el mismo que asume `TemplateMapperStrategy`. */
const DEFAULT_OUTPUT_NAMESPACE = 'rendered_html';

/**
 * Namespaces que se asume que los nodos previos dejaran en el contexto.
 *
 * PROVISIONAL: la fuente real son los `outputNamespace` de los nodos anteriores
 * del `pipeline_schema`, que el asistente (PROT-12) inyectara con
 * `setAvailableUpstreamNamespaces`. Hasta entonces, el banco de pruebas los
 * manipula a mano.
 */
const DEFAULT_UPSTREAM_NAMESPACES = ['parsed_email', 'scraped_web', 'llm_response'];

/** `params` que el nodo aporta al `pipeline_schema`. */
export interface TemplateMapperConfig {
  templateId: string | null;
  outputNamespace: string;
}

/** Prefijo del id de Pinia; el sufijo es el `nodeId` del `pipeline_schema`. */
const STORE_ID_PREFIX = 'templateMapperNode';

// Estado reactivo del nodo MAPEADOR_PLANTILLA (regla frontend-quasar.md §3.1).
// No conoce Axios ni rutas: delega en su servicio y expone `isConfigValid`, que
// es lo unico que el asistente consulta para habilitar el avance.
//
// El cuerpo se declara aparte y NO recibe el `nodeId`: este estado no sabe en
// que posicion del grafo esta ni como se llama su nodo. El `nodeId` solo decide
// CUANTAS instancias hay, y eso se resuelve en el id de Pinia (ver
// `useTemplateMapperStore`), no dentro del estado.
const templateMapperSetup = () => {
  const config = ref<TemplateMapperConfig>({
    templateId: null,
    outputNamespace: DEFAULT_OUTPUT_NAMESPACE,
  });

  const availableTemplates = ref<HtmlTemplate[]>([]);
  const availableUpstreamNamespaces = ref<string[]>([...DEFAULT_UPSTREAM_NAMESPACES]);
  const previewResult = ref<string | null>(null);
  const isLoading = ref(false);

  const selectedTemplate = computed<HtmlTemplate | null>(
    () =>
      availableTemplates.value.find((template) => template.id === config.value.templateId) ?? null,
  );

  /** Variables que la plantilla elegida exige al contexto. */
  const requiredVariables = computed<string[]>(
    () => selectedTemplate.value?.requiredVariables ?? [],
  );

  /**
   * Variables cuya raiz ningun nodo previo del flujo produce.
   *
   * Es el contrato entre la plantilla y el pipeline: si la plantilla interpola
   * `{{scraped_web.headline}}` y ningun nodo anterior escribe `scraped_web`, la
   * ejecucion fallaria con un GRAVE y el flujo quedaria PAUSADO. Detectarlo al
   * configurar es la diferencia entre corregirlo ahora o descubrirlo en
   * produccion.
   */
  const missingRequiredVariables = computed<string[]>(() =>
    requiredVariables.value.filter((path) => {
      // Con `noUncheckedIndexedAccess`, desestructurar da `string | undefined`.
      const [root] = path.split('.');

      return root === undefined || !availableUpstreamNamespaces.value.includes(root);
    }),
  );

  /**
   * Contrato uniforme del nodo. Exige tres cosas:
   *
   * 1. Plantilla elegida.
   * 2. Un `outputNamespace` que el backend vaya a aceptar: validarlo aqui evita
   *    un 400 al guardar el flujo entero por un guion en el namespace.
   * 3. Que el flujo suministre TODOS los namespaces que la plantilla exige
   *    (Poka-Yoke): no se puede avanzar con un contrato que se sabe roto.
   */
  const isConfigValid = computed<boolean>(
    () =>
      config.value.templateId !== null &&
      OUTPUT_NAMESPACE_PATTERN.test(config.value.outputNamespace) &&
      missingRequiredVariables.value.length === 0,
  );

  const loadTemplates = async (): Promise<void> => {
    isLoading.value = true;

    try {
      availableTemplates.value = await templateMapperService.fetchSelectableTemplates();
    } finally {
      isLoading.value = false;
    }
  };

  const setTemplateId = (templateId: string | null): void => {
    config.value = { ...config.value, templateId };
    // La vista previa pertenece a la plantilla anterior: conservarla mostraria
    // un markup que ya no corresponde a la seleccion.
    previewResult.value = null;
  };

  /**
   * Declara que namespaces aportan los nodos previos.
   *
   * Hoy lo llama el banco de pruebas; manana lo hara el asistente leyendo los
   * `outputNamespace` de los nodos anteriores del `pipeline_schema`.
   */
  const setAvailableUpstreamNamespaces = (namespaces: string[]): void => {
    availableUpstreamNamespaces.value = [...namespaces];
  };

  const setOutputNamespace = (outputNamespace: string): void => {
    config.value = { ...config.value, outputNamespace };
  };

  const loadPreview = async (): Promise<void> => {
    const { templateId } = config.value;

    if (templateId === null) return;

    isLoading.value = true;

    try {
      const { compiledMarkup } = await templateMapperService.compilePreview(templateId);
      previewResult.value = compiledMarkup;
    } finally {
      isLoading.value = false;
    }
  };

  /**
   * `params` del nodo para el `pipeline_schema`.
   *
   * Solo `templateId`: es lo unico que `TemplateMapperStrategy` lee de sus
   * `params`. El `outputNamespace` que este store guarda sirve a la interfaz,
   * pero en el esquema es propiedad del NODO, y el agregador lo toma de la
   * topologia; publicarlo tambien aqui crearia dos fuentes de verdad dentro del
   * mismo JSON.
   */
  const toNodeParams = (): Record<string, unknown> => ({
    templateId: config.value.templateId,
  });

  /**
   * Carga la configuracion de un nodo ya guardado en el `pipeline_schema`.
   *
   * Reutiliza los setters existentes en vez de escribir `config` directamente,
   * para no saltarse lo que cada uno protege: `setTemplateId` descarta la vista
   * previa, que pertenecia a la plantilla anterior.
   *
   * `outputNamespace` sale del NODO y no de sus `params`, que es donde vive en el
   * esquema (ver `toNodeParams`). Si viniera vacio se conserva el valor por
   * defecto: un namespace en blanco no pasaria `OUTPUT_NAMESPACE_PATTERN` y
   * dejaria el paso invalido sin que el operador entienda por que.
   */
  const hydrateFromNode = (node: HydratableNode): void => {
    const templateId = node.params.templateId;

    setTemplateId(typeof templateId === 'string' ? templateId : null);

    if (node.outputNamespace !== '') {
      setOutputNamespace(node.outputNamespace);
    }
  };

  const resetConfig = (): void => {
    config.value = {
      templateId: null,
      outputNamespace: DEFAULT_OUTPUT_NAMESPACE,
    };
    previewResult.value = null;
  };

  return {
    config,
    availableTemplates,
    previewResult,
    isLoading,
    availableUpstreamNamespaces,
    selectedTemplate,
    isConfigValid,
    requiredVariables,
    missingRequiredVariables,
    toNodeParams,
    loadTemplates,
    setTemplateId,
    setAvailableUpstreamNamespaces,
    setOutputNamespace,
    hydrateFromNode,
    loadPreview,
    resetConfig,
  };
};

/**
 * Definicion de Pinia para UN nodo concreto.
 *
 * El id lleva el `nodeId` dentro a proposito: un flujo puede mapear dos
 * plantillas distintas en dos pasos, y con un id fijo compartirian una sola
 * instancia — elegir la plantilla del segundo nodo borraria la del primero y el
 * esquema ensamblado saldria con el mismo `templateId` duplicado en ambos. La
 * identidad del estado tiene que ser la del nodo, no la del tipo.
 */
const buildTemplateMapperStore = (nodeId: string) =>
  defineStore(`${STORE_ID_PREFIX}:${nodeId}`, templateMapperSetup);

/** Instancia del store, para tipar helpers y consumidores sin `any`. */
export type TemplateMapperStore = ReturnType<ReturnType<typeof buildTemplateMapperStore>>;

/**
 * Definiciones ya creadas, indexadas por `nodeId`.
 *
 * Se memoiza la DEFINICION, no la instancia: de la instancia ya se encarga Pinia,
 * que cachea por id en la instancia activa. Lo que hay que evitar es reconstruir
 * la definicion en cada render, porque eso descarta la identidad referencial del
 * hook y hace trabajo por nada en cada paso del asistente.
 */
const definitions = new Map<string, ReturnType<typeof buildTemplateMapperStore>>();

/**
 * Store del nodo MAPEADOR_PLANTILLA identificado por `nodeId`.
 *
 * Cada nodo del pipeline recibe su propia instancia, aislada de los demas. Como
 * contrapartida, dos nodos mapeadores en el mismo flujo piden el catalogo de
 * plantillas una vez cada uno: una peticion por nodo montado contra un catalogo
 * pequeno, y el precio de que cada nodo tenga su propia seleccion.
 */
export const useTemplateMapperStore = (nodeId: string): TemplateMapperStore => {
  const cached = definitions.get(nodeId);

  if (cached !== undefined) return cached();

  const definition = buildTemplateMapperStore(nodeId);
  definitions.set(nodeId, definition);

  // Con ids dinamicos no hay una definicion unica que declarar al cargar el
  // modulo, asi que el HMR se arma sobre cada definicion nueva. Vite conserva un
  // solo callback self-accept por modulo: hot-recarga el ultimo nodo creado, que
  // en la practica es el que se esta configurando.
  if (import.meta.hot) {
    import.meta.hot.accept(acceptHMRUpdate(definition, import.meta.hot));
  }

  return definition();
};
