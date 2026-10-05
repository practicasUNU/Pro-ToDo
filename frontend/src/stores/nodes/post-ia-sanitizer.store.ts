import { defineStore, acceptHMRUpdate } from 'pinia';
import { computed, ref } from 'vue';

import {
  DEFAULT_POST_IA_SOURCE_FIELD,
  DEFAULT_POST_IA_SOURCE_NAMESPACE,
  HTML_TAG_PATTERN,
  MAX_ALLOWED_TAGS,
  MAX_REQUIRED_SELECTORS,
  MAX_SELECTOR_LENGTH,
  SANITIZER_ALLOWED_TAGS,
} from '@/types/nodes/post-ia-sanitizer.types';

import type { HydratableNode, UpstreamNamespace } from '@stores/nodes/node-store-registry';

import type { PostIaSanitizerNodeConfig } from '@/types/nodes/post-ia-sanitizer.types';

/** Prefijo del id de Pinia; el sufijo es el `nodeId` del `pipeline_schema`. */
const STORE_ID_PREFIX = 'postIaSanitizerNode';

/**
 * Clave del campo que publica el MAPEADOR_PLANTILLA.
 *
 * Se usa para detectar si hay una plantilla base en el flujo, y por el CAMPO y
 * no por el namespace: `outputNamespace` es propiedad del nodo y no de su tipo,
 * exactamente igual que en `BASE_TEMPLATE_MARKER_PATTERN` del backend.
 */
const BASE_TEMPLATE_FIELD = 'compiled_markup';

/** Lee una cadena de los `params` crudos del esquema. */
const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * Lee un arreglo de cadenas de los `params` crudos.
 *
 * La columna es `jsonb` y pudo escribirse por SQL directo, asi que se filtra en
 * vez de confiar: un `null` dentro del arreglo dejaria un chip vacio imposible
 * de borrar desde la interfaz.
 */
const asStringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

/** Configuracion inicial; se reutiliza en `resetConfig`. */
const buildInitialConfig = (): PostIaSanitizerNodeConfig => ({
  sourceNamespace: DEFAULT_POST_IA_SOURCE_NAMESPACE,
  sourceField: DEFAULT_POST_IA_SOURCE_FIELD,
  requiredSelectors: [],
  allowedTags: [],
});

// Estado reactivo del nodo ESCUDO_POST_IA (regla frontend-quasar.md §3.1).
//
// SIN capa de servicios, como el disparador Cron y la alerta SMTP, y por el
// mismo motivo: no hay nada que preguntarle al backend. `@Controller('nodos')`
// expone UNA ruta, `GET /api/nodos`, y es de solo lectura; no existe ningun
// endpoint que valide los `params` de un nodo suelto. Un
// `post-ia-sanitizer.service.ts` que no conociera ninguna ruta contradiria su
// propia definicion (`frontend-architecture.md` §2.1), y uno que inventara una
// seria un 404 en produccion. La validez se resuelve entera en el cliente, y la
// de verdad la hace `paramsSchema` al guardar el esquema.
const postIaSanitizerSetup = () => {
  const config = ref<PostIaSanitizerNodeConfig>(buildInitialConfig());

  /** Namespaces que publican los pasos ANTERIORES, con sus campos. */
  const availableUpstreamContext = ref<UpstreamNamespace[]>([]);

  /**
   * Opciones del selector de namespace de origen.
   *
   * CERRADO y no texto libre (Poka-Yoke, `frontend-quasar.md` §4): el namespace
   * acaba siendo la raiz de una lectura del contexto, y un nombre tecleado a
   * mano que no exista produce `ERR_POST_IA_MISSING_PAYLOAD` en ejecucion, con
   * el flujo ya PAUSADO. Lo que se ofrece es lo que de verdad hay delante.
   */
  const namespaceOptions = computed<readonly string[]>(() =>
    availableUpstreamContext.value.map((entry) => entry.namespace),
  );

  /** Entrada del contexto que corresponde al namespace elegido, si existe. */
  const selectedNamespace = computed<UpstreamNamespace | undefined>(() =>
    availableUpstreamContext.value.find(
      (entry) => entry.namespace === config.value.sourceNamespace,
    ),
  );

  /**
   * Campos que publica el namespace elegido.
   *
   * Salen del catalogo de nodos, que los declara la estrategia que construye el
   * payload. Vacio significa "todavia no hay nada que ofrecer" —el catalogo no
   * ha cargado, o el tipo no declara campos—, nunca un error.
   */
  const fieldOptions = computed<readonly string[]>(() =>
    (selectedNamespace.value?.fields ?? []).map((field) => field.name),
  );

  /**
   * El origen elegido ya no lo produce ningun paso anterior.
   *
   * Se distingue de "no hay contexto todavia" a proposito: con el contexto
   * vacio no se puede afirmar nada, y pintar un aviso mientras carga el catalogo
   * seria una falsa alarma en cada apertura del asistente.
   */
  const hasStaleSource = computed<boolean>(() => {
    if (availableUpstreamContext.value.length === 0) return false;

    if (selectedNamespace.value === undefined) return true;

    return fieldOptions.value.length > 0 && !fieldOptions.value.includes(config.value.sourceField);
  });

  /**
   * Hay un MAPEADOR_PLANTILLA por delante.
   *
   * Importa porque el `PROCESADOR_IA` solo rellena `filled_markup` cuando su
   * prompt cita una plantilla base (ver `BASE_TEMPLATE_MARKER_PATTERN` en el
   * backend). Sin mapeador delante, el escudo no tendra markup que auditar y
   * fallara con `ERR_POST_IA_EMPTY_HTML` en la primera ejecucion.
   *
   * Se busca por el CAMPO y no por el tipo de nodo ni por el namespace: el
   * `outputNamespace` lo elige el esquema, y preguntar por `compiled_markup` es
   * preguntar por lo unico que de verdad identifica una plantilla base.
   */
  const hasBaseTemplateUpstream = computed<boolean>(() =>
    availableUpstreamContext.value.some((entry) =>
      entry.fields.some((field) => field.name === BASE_TEMPLATE_FIELD),
    ),
  );

  /** Selectores que superan el limite de longitud del DTO. */
  const oversizedSelectors = computed<readonly string[]>(() =>
    config.value.requiredSelectors.filter((selector) => selector.length > MAX_SELECTOR_LENGTH),
  );

  /** Etiquetas pedidas que la lista blanca global no admite. */
  const unsupportedTags = computed<readonly string[]>(() =>
    config.value.allowedTags.filter(
      (tag) => !HTML_TAG_PATTERN.test(tag) || !SANITIZER_ALLOWED_TAGS.includes(tag),
    ),
  );

  /**
   * Unico dato que el anfitrion consulta para habilitar "Siguiente".
   *
   * Replica el criterio del backend: el DTO admite todos los campos ausentes
   * —una plantilla de flujo se guarda con `params: {}`— pero rechaza con un 400
   * sobre el esquema ENTERO cualquier valor mal formado. Comprobarlo aqui es la
   * diferencia entre una regla de campo y un error de guardado que no nombra el
   * control que lo causa.
   *
   * `requiredSelectors` vacio es VALIDO: significa "no exijo ninguna ranura", y
   * el escudo sigue saneando y rechazando marcadores residuales.
   */
  const isConfigValid = computed<boolean>(
    () =>
      config.value.sourceNamespace.trim() !== '' &&
      config.value.sourceField.trim() !== '' &&
      config.value.requiredSelectors.length <= MAX_REQUIRED_SELECTORS &&
      oversizedSelectors.value.length === 0 &&
      config.value.allowedTags.length <= MAX_ALLOWED_TAGS &&
      unsupportedTags.value.length === 0,
  );

  /** Avisos que NO bloquean; lo que debe impedir guardar va en `isConfigValid`. */
  const configWarnings = computed<readonly string[]>(() => {
    const warnings: string[] = [];

    if (hasStaleSource.value) {
      warnings.push(
        `El origen guardado "${config.value.sourceNamespace}.${config.value.sourceField}" ya no lo publica ningun paso anterior del flujo. El escudo fallara con ERR_POST_IA_MISSING_PAYLOAD o ERR_POST_IA_EMPTY_HTML en la primera ejecucion.`,
      );
    }

    if (availableUpstreamContext.value.length > 0 && !hasBaseTemplateUpstream.value) {
      warnings.push(
        'No hay ningun MAPEADOR_PLANTILLA por delante. El PROCESADOR_IA solo rellena el marcado cuando su instruccion cita una plantilla base, asi que sin mapeador este escudo no tendra nada que auditar.',
      );
    }

    if (config.value.requiredSelectors.length === 0) {
      warnings.push(
        'Sin selectores exigidos, el escudo sanea el HTML y rechaza los marcadores sin resolver, pero NO detectara que la IA se haya llevado por delante el titular o el cuerpo.',
      );
    }

    return warnings;
  });

  const updateConfig = (patch: Partial<PostIaSanitizerNodeConfig>): void => {
    config.value = { ...config.value, ...patch };
  };

  /**
   * `params` del nodo para el `pipeline_schema`.
   *
   * LO QUE COINCIDE CON EL DEFECTO SE OMITE, igual que hace el extractor web con
   * sus numericos: el backend resuelve el mismo valor con `??`, y publicarlo
   * ademas aqui dejaria dos sitios que mantener sincronizados sin ganar nada.
   * Las listas vacias tampoco viajan: en el DTO significan lo mismo ausentes.
   */
  const toNodeParams = (): Record<string, unknown> => {
    const params: Record<string, unknown> = {};
    const sourceNamespace = config.value.sourceNamespace.trim();
    const sourceField = config.value.sourceField.trim();

    if (sourceNamespace !== '' && sourceNamespace !== DEFAULT_POST_IA_SOURCE_NAMESPACE) {
      params.sourceNamespace = sourceNamespace;
    }

    if (sourceField !== '' && sourceField !== DEFAULT_POST_IA_SOURCE_FIELD) {
      params.sourceField = sourceField;
    }

    if (config.value.requiredSelectors.length > 0) {
      params.requiredSelectors = [...config.value.requiredSelectors];
    }

    if (config.value.allowedTags.length > 0) {
      params.allowedTags = [...config.value.allowedTags];
    }

    return params;
  };

  /** Declara los namespaces anteriores CON los campos que publica cada uno. */
  const setAvailableUpstreamContext = (context: UpstreamNamespace[]): void => {
    availableUpstreamContext.value = [...context];
  };

  /**
   * Carga la configuracion de un nodo ya guardado en el `pipeline_schema`.
   *
   * Contrato de ida y vuelta: `hydrateFromNode(n)` seguido de `toNodeParams()`
   * debe reproducir `n.params`. Los dos campos de origen se reponen con su
   * DEFECTO cuando faltan —y no con `''`— porque es lo que hace el backend al
   * resolver la config: un nodo guardado sin ellos corre contra
   * `llm_response.filled_markup`, y mostrarlo en blanco mentiria sobre de donde
   * lee. `toNodeParams` vuelve a omitirlos por ser iguales al defecto, de modo
   * que la ida y vuelta se cierra igualmente.
   */
  const hydrateFromNode = (node: HydratableNode): void => {
    const { params } = node;

    config.value = {
      sourceNamespace: asText(params.sourceNamespace) || DEFAULT_POST_IA_SOURCE_NAMESPACE,
      sourceField: asText(params.sourceField) || DEFAULT_POST_IA_SOURCE_FIELD,
      requiredSelectors: asStringList(params.requiredSelectors),
      allowedTags: asStringList(params.allowedTags),
    };
  };

  const resetConfig = (): void => {
    config.value = buildInitialConfig();
    availableUpstreamContext.value = [];
  };

  return {
    config,
    availableUpstreamContext,
    namespaceOptions,
    fieldOptions,
    hasStaleSource,
    hasBaseTemplateUpstream,
    oversizedSelectors,
    unsupportedTags,
    isConfigValid,
    configWarnings,
    updateConfig,
    setAvailableUpstreamContext,
    toNodeParams,
    hydrateFromNode,
    resetConfig,
  };
};

/**
 * Definicion de Pinia para UN nodo concreto.
 *
 * El id lleva el `nodeId` dentro por el mismo motivo que en los demas nodos: dos
 * escudos en el mismo flujo —uno tras la redaccion y otro tras un reintento con
 * vision— tendrian cada uno sus selectores, y con un id fijo compartirian una
 * sola instancia.
 */
const buildPostIaSanitizerStore = (nodeId: string) =>
  defineStore(`${STORE_ID_PREFIX}:${nodeId}`, postIaSanitizerSetup);

/** Instancia del store, para tipar helpers y consumidores sin `any`. */
export type PostIaSanitizerStore = ReturnType<ReturnType<typeof buildPostIaSanitizerStore>>;

/** Definiciones ya creadas, indexadas por `nodeId`. */
const definitions = new Map<string, ReturnType<typeof buildPostIaSanitizerStore>>();

/** Store del nodo ESCUDO_POST_IA identificado por `nodeId`. */
export const usePostIaSanitizerStore = (nodeId: string): PostIaSanitizerStore => {
  const cached = definitions.get(nodeId);

  if (cached !== undefined) return cached();

  const definition = buildPostIaSanitizerStore(nodeId);
  definitions.set(nodeId, definition);

  if (import.meta.hot) {
    import.meta.hot.accept(acceptHMRUpdate(definition, import.meta.hot));
  }

  return definition();
};
