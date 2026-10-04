import { defineStore, acceptHMRUpdate } from 'pinia';
import { computed, ref } from 'vue';

import * as templateMapperService from '@services/nodes/template-mapper.service';

import { NodeType, OUTPUT_NAMESPACE_PATTERN } from '@/types/pipeline';

import type { HydratableNode, UpstreamNamespace } from '@stores/nodes/node-store-registry';

import type { HtmlTemplate } from '@/types/html-template';

/** Namespace por defecto, el mismo que asume `TemplateMapperStrategy`. */
const DEFAULT_OUTPUT_NAMESPACE = 'rendered_html';

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

  /**
   * Namespaces anteriores CON su inventario de campos.
   *
   * Sobrevive al cambio de semantica aunque el nodo ya no interpole, por dos
   * usos concretos: alimenta `:upstream-context` de `TemplateEditorDialog` —que
   * es superficie de AUTORIA, donde explorar las variables del flujo si tiene
   * sentido al escribir el HTML base— y permite detectar que el PROCESADOR_IA
   * va por delante de este nodo, que es el aviso de orden topologico.
   *
   * El canal de solo-NOMBRES (`setAvailableUpstreamNamespaces`) desaparecio con
   * el contrato que lo justificaba; el metodo es opcional en `NodeConfigStore`,
   * asi que dejar de implementarlo no rompe a ningun anfitrion.
   */
  const availableUpstreamContext = ref<UpstreamNamespace[]>([]);

  const isLoading = ref(false);

  const selectedTemplate = computed<HtmlTemplate | null>(
    () =>
      availableTemplates.value.find((template) => template.id === config.value.templateId) ?? null,
  );

  /**
   * Avisos no bloqueantes del paso (contrato de `NodeConfigStore`).
   *
   * Aqui aterriza, reformulado, lo unico que sobrevive del antiguo "contrato
   * plantilla <-> topologia". Aquel preguntaba "¿el flujo publica
   * `parsed_email.clean_title`?", y esa pregunta dejo de significar nada: el
   * nodo no lee el contexto. Lo que SI sigue siendo cierto —y ahora es un
   * fallo real en ejecucion— es que una plantilla con marcadores ya no
   * encuentra quien los sustituya.
   */
  const configWarnings = computed<readonly string[]>(() => {
    const warnings: string[] = [];
    const markers = selectedTemplate.value?.requiredVariables ?? [];

    // 1. Espejo en diseno de la guarda `ERR_TEMPLATE_PENDING_VARS` del backend.
    //    Se redacta con el codigo del motor a proposito: quien lo lea aqui y
    //    luego lo vea en la trazabilidad reconoce el mismo problema.
    if (markers.length > 0) {
      warnings.push(
        `Esta plantilla declara marcadores que este nodo ya no compila (${markers.join(', ')}). ` +
          'El flujo fallara en este paso con ERR_TEMPLATE_PENDING_VARS: usa una plantilla base ' +
          'con los huecos vacios para que los rellene el PROCESADOR_IA.',
      );
    }

    // 2. Orden invertido. El relleno lo hace una inferencia POSTERIOR, asi que
    //    tener la IA aguas arriba significa que nadie rellenara la plantilla.
    if (
      availableUpstreamContext.value.some(({ nodeType }) => nodeType === NodeType.PROCESADOR_IA)
    ) {
      warnings.push(
        'El PROCESADOR_IA de este flujo esta ANTES de este nodo: la plantilla base se inyectaria ' +
          'sin que nadie la rellene. Coloca el mapeador delante de la inferencia.',
      );
    }

    return warnings;
  });

  /**
   * Contrato uniforme del nodo. Exige dos cosas, y ninguna mira aguas arriba:
   *
   * 1. Plantilla elegida.
   * 2. Un `outputNamespace` que el backend vaya a aceptar: validarlo aqui evita
   *    un 400 al guardar el flujo entero por un guion en el namespace.
   *
   * Cae la tercera clausula historica —"que el flujo resuelva TODAS las
   * variables que la plantilla exige"—. El nodo ya no interpola: lo que la
   * plantilla pidiera al contexto dejo de ser una precondicion suya, y
   * mantenerlo bloquearia pasos perfectamente ejecutables. De una plantilla con
   * marcadores avisa `configWarnings`, sin invalidar el paso.
   */
  const isConfigValid = computed<boolean>(
    () =>
      config.value.templateId !== null &&
      OUTPUT_NAMESPACE_PATTERN.test(config.value.outputNamespace),
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
  };

  /**
   * Canal rico: los namespaces anteriores CON el inventario de cada uno.
   *
   * Se copia el arreglo en vez de guardar la referencia: el anfitrion
   * reconstruye el suyo en cada sincronizacion.
   */
  const setAvailableUpstreamContext = (context: UpstreamNamespace[]): void => {
    availableUpstreamContext.value = [...context];
  };

  const setOutputNamespace = (outputNamespace: string): void => {
    config.value = { ...config.value, outputNamespace };
  };

  /**
   * `params` del nodo para el `pipeline_schema`.
   *
   * Solo `templateId`: es lo unico que este store gobierna de los `params` que
   * `TemplateMapperStrategy` lee. `allowedTags` y `requiredSelectors` existen en
   * el DTO del backend pero el asistente aun no los expone, asi que publicarlos
   * vacios desde aqui escribiria en el esquema una decision que nadie ha tomado.
   *
   * El `outputNamespace` que este store guarda sirve a la interfaz, pero en el
   * esquema es propiedad del NODO, y el agregador lo toma de la topologia;
   * publicarlo tambien aqui crearia dos fuentes de verdad dentro del mismo JSON.
   */
  const toNodeParams = (): Record<string, unknown> => ({
    templateId: config.value.templateId,
  });

  /**
   * Carga la configuracion de un nodo ya guardado en el `pipeline_schema`.
   *
   * Reutiliza los setters existentes en vez de escribir `config` directamente,
   * para no saltarse lo que cada uno protege.
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
  };

  return {
    config,
    availableTemplates,
    isLoading,
    availableUpstreamContext,
    selectedTemplate,
    isConfigValid,
    configWarnings,
    toNodeParams,
    loadTemplates,
    setTemplateId,
    setAvailableUpstreamContext,
    setOutputNamespace,
    hydrateFromNode,
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
