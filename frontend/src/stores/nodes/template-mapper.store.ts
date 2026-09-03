import { defineStore, acceptHMRUpdate } from 'pinia';
import { computed, ref } from 'vue';

import * as templateMapperService from '@services/nodes/template-mapper.service';

import { OUTPUT_NAMESPACE_PATTERN } from '@/types/pipeline';

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

// Estado reactivo del nodo MAPEADOR_PLANTILLA (regla frontend-quasar.md §3.1).
// No conoce Axios ni rutas: delega en su servicio y expone `isConfigValid`, que
// es lo unico que el asistente consulta para habilitar el avance.
export const useTemplateMapperStore = defineStore('templateMapperNode', () => {
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
    loadTemplates,
    setTemplateId,
    setAvailableUpstreamNamespaces,
    setOutputNamespace,
    loadPreview,
    resetConfig,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useTemplateMapperStore, import.meta.hot));
}
