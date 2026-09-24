import { defineStore, acceptHMRUpdate } from 'pinia';
import { computed, ref } from 'vue';

import * as templateMapperService from '@services/nodes/template-mapper.service';

import { OUTPUT_NAMESPACE_PATTERN } from '@/types/pipeline';

import type { HydratableNode, UpstreamNamespace } from '@stores/nodes/node-store-registry';

import type { HtmlTemplate } from '@/types/html-template';

/** Namespace por defecto, el mismo que asume `TemplateMapperStrategy`. */
const DEFAULT_OUTPUT_NAMESPACE = 'rendered_html';

/**
 * Opcion del selector de variables interpolables.
 *
 * `value` es el marcador listo para pegar en la plantilla; `label` lo que el
 * operador lee; `group` la cabecera con la que QSelect agrupa las opciones por
 * el paso que las produce.
 */
export interface InterpolationVariableOption {
  readonly label: string;
  readonly value: string;
  readonly group: string;
}

/** Marcador Handlebars de un campo, tal y como se interpola. */
export const variableTemplateFor = (namespace: string, field: string): string =>
  `{{${namespace}.${field}}}`;

/**
 * Cuantos segmentos de una ruta requerida pertenecen al inventario del nodo.
 *
 * DOS: `llm_response.articles` es lo que el nodo publica, y `.0.title` es la
 * forma de DENTRO de ese objeto, que ninguna estrategia declara campo a campo.
 * Comparar la ruta entera contra `outputFields` daria por ausente toda variable
 * que navegue una estructura anidada, que son legitimas.
 */
const PUBLISHED_PATH_SEGMENTS = 2;

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
   * Namespaces anteriores, por NOMBRE. Arranca vacio, y eso es deliberado.
   *
   * Antes se sembraba con `['parsed_email', 'scraped_web', 'llm_response']` bajo
   * una nota de PROVISIONAL, a la espera del asistente. El asistente ya existe y
   * empuja los dos canales en `syncUpstreamNamespaces()`, asi que la siembra
   * dejo de ser un apano para convertirse en una mentira: validaba el nodo
   * contra un flujo inventado hasta la primera sincronizacion, y daba por
   * resoluble un `{{parsed_email.x}}` en un flujo que empieza por un cron.
   */
  const availableUpstreamNamespaces = ref<string[]>([]);

  /**
   * Los mismos namespaces CON su inventario de campos.
   *
   * Es el canal que permite pasar de "existe `parsed_email`" a "existe
   * `parsed_email.clean_body`". Convive con el anterior en vez de sustituirlo:
   * un anfitrion sin catalogo cargado entrega nombres y ningun campo, y ese caso
   * tiene que seguir valiendo (ver `missingRequiredVariables`).
   */
  const availableUpstreamContext = ref<UpstreamNamespace[]>([]);

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
   * Opciones deterministas de `{{namespace.campo}}` que el flujo puede resolver.
   *
   * Se componen del inventario que publica cada nodo anterior, nunca de una
   * tabla escrita a mano en el frontend: los campos los declara la estrategia
   * que construye el payload y viajan por el catalogo (`GET /nodos`). Replicar
   * aqui la forma de `ParsedEmailPayload` seria una segunda fuente condenada a
   * discrepar de la primera en cuanto alguien anada una clave.
   *
   * A diferencia del selector del extractor web, NO se filtra por tipo: una
   * plantilla puede interpolar cualquier cosa que sepa convertirse en texto, y
   * el tipo va en la etiqueta para que el operador sepa que esta insertando.
   */
  const variableOptions = computed<InterpolationVariableOption[]>(() =>
    availableUpstreamContext.value.flatMap(({ namespace, nodeType, fields }) =>
      fields.map((field) => ({
        label: `${field.name} (${field.type})`,
        value: variableTemplateFor(namespace, field.name),
        // Sin `nodeType` —`_assets`, o un namespace que no escribe ningun nodo—
        // el grupo se queda en el nombre a secas en vez de mostrar un parentesis
        // vacio.
        group: nodeType === undefined ? namespace : `${namespace} (${nodeType})`,
      })),
    ),
  );

  /** Si algun paso anterior publica al menos un campo interpolable. */
  const hasUpstreamVariables = computed<boolean>(() => variableOptions.value.length > 0);

  /**
   * Rutas `namespace.campo` que el flujo publica de verdad.
   *
   * Solo contiene las de los namespaces cuyo inventario se conoce; los que
   * llegan con `fields` vacio no aportan ninguna, y eso lo tiene en cuenta
   * `missingRequiredVariables`.
   */
  const availableVariablePaths = computed<ReadonlySet<string>>(
    () =>
      new Set(
        availableUpstreamContext.value.flatMap(({ namespace, fields }) =>
          fields.map((field) => `${namespace}.${field.name}`),
        ),
      ),
  );

  /** Namespaces con inventario conocido, para distinguir "vacio" de "ausente". */
  const inventoriedNamespaces = computed<ReadonlySet<string>>(
    () =>
      new Set(
        availableUpstreamContext.value
          .filter(({ fields }) => fields.length > 0)
          .map(({ namespace }) => namespace),
      ),
  );

  /**
   * Variables de la plantilla que este flujo NO puede resolver.
   *
   * Es el contrato entre la plantilla y el pipeline: si la plantilla interpola
   * `{{scraped_web.headline}}` y ningun nodo anterior lo produce, la ejecucion
   * fallaria con un GRAVE y el flujo quedaria PAUSADO. Detectarlo al configurar
   * es la diferencia entre corregirlo ahora o descubrirlo en produccion.
   *
   * Tres reglas, en este orden:
   *
   * 1. Ningun paso anterior escribe ese namespace -> falta. Es el diagnostico
   *    grueso, y el unico que existia hasta ahora.
   * 2. El namespace existe y SE CONOCE su inventario, pero no publica ese campo
   *    -> falta. Es el grano fino que el catalogo hizo posible: antes bastaba
   *    con que `parsed_email` estuviera aguas arriba para dar por buena
   *    `{{parsed_email.no_existe}}`.
   * 3. El namespace existe pero llega con `fields` vacio -> se da por
   *    satisfecha. Un inventario vacio significa "no hay nada que ofrecer
   *    todavia" —catalogo sin cargar, o tipo de nodo que no declara sus
   *    campos—, nunca un error; asi lo fija el contrato de `UpstreamNamespace`.
   *    Tratarlo como fallo marcaria en rojo cada plantilla mientras el catalogo
   *    viaja, y para siempre si la peticion falla.
   */
  const missingRequiredVariables = computed<string[]>(() =>
    requiredVariables.value.filter((path) => {
      // Con `noUncheckedIndexedAccess`, desestructurar da `string | undefined`.
      const [root] = path.split('.');

      if (root === undefined) return true;
      if (!availableUpstreamNamespaces.value.includes(root)) return true;
      if (!inventoriedNamespaces.value.has(root)) return false;

      return !availableVariablePaths.value.has(
        path.split('.').slice(0, PUBLISHED_PATH_SEGMENTS).join('.'),
      );
    }),
  );

  /**
   * Variables ausentes cuyo namespace entero falta del flujo.
   *
   * Se separa de las que fallan por CAMPO porque el arreglo es otro: aqui hay
   * que anadir o reordenar un nodo, alla basta con corregir la plantilla. Un
   * mensaje que funda los dos casos manda al operador a revisar la topologia por
   * una errata.
   */
  const missingUpstreamNamespaces = computed<string[]>(() => [
    ...new Set(
      missingRequiredVariables.value
        .map((path) => path.split('.')[0] ?? path)
        .filter((root) => !availableUpstreamNamespaces.value.includes(root)),
    ),
  ]);

  /** Variables ausentes cuyo namespace SI esta, pero no publica ese campo. */
  const missingUpstreamFields = computed<string[]>(() =>
    missingRequiredVariables.value.filter((path) =>
      availableUpstreamNamespaces.value.includes(path.split('.')[0] ?? path),
    ),
  );

  /**
   * Contrato uniforme del nodo. Exige tres cosas:
   *
   * 1. Plantilla elegida.
   * 2. Un `outputNamespace` que el backend vaya a aceptar: validarlo aqui evita
   *    un 400 al guardar el flujo entero por un guion en el namespace.
   * 3. Que el flujo resuelva TODAS las variables que la plantilla exige
   *    (Poka-Yoke): no se puede avanzar con un contrato que se sabe roto.
   *
   * Lo que NO exige es que haya variables disponibles. Una plantilla estatica
   * —un pie corporativo, un aviso de cabecera— no interpola nada y es
   * perfectamente valida en un flujo que no publique un solo campo; bloquearla
   * seria inventar un requisito que el motor no tiene. De que no haya nada que
   * interpolar avisa `hasUpstreamVariables`, sin invalidar el paso.
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
   * Lo empujan el asistente (`syncUpstreamNamespaces`) y el banco de pruebas.
   * Sigue haciendo falta junto al canal rico: es el que distingue "ese namespace
   * no existe en este flujo" de "existe pero aun no se que publica".
   */
  const setAvailableUpstreamNamespaces = (namespaces: string[]): void => {
    availableUpstreamNamespaces.value = [...namespaces];
  };

  /**
   * Canal rico: los namespaces anteriores CON el inventario de cada uno.
   *
   * Es lo que convierte el diagnostico de grano grueso en uno util —del
   * "falta `parsed_email`" al "`parsed_email` no publica ese campo"— y lo
   * que alimenta el selector de variables. Se copia el arreglo en vez de guardar
   * la referencia: el anfitrion reconstruye el suyo en cada sincronizacion.
   */
  const setAvailableUpstreamContext = (context: UpstreamNamespace[]): void => {
    availableUpstreamContext.value = [...context];
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
    availableUpstreamContext,
    selectedTemplate,
    isConfigValid,
    requiredVariables,
    variableOptions,
    hasUpstreamVariables,
    missingRequiredVariables,
    missingUpstreamNamespaces,
    missingUpstreamFields,
    toNodeParams,
    loadTemplates,
    setTemplateId,
    setAvailableUpstreamNamespaces,
    setAvailableUpstreamContext,
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
