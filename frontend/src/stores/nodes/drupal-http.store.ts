import { defineStore, acceptHMRUpdate } from 'pinia';
import { computed, ref } from 'vue';

import {
  DEFAULT_DRUPAL_ATTACHMENT_FIELD,
  DEFAULT_DRUPAL_ATTACHMENT_INDEX,
  DEFAULT_DRUPAL_ATTACHMENT_NAMESPACE,
  DEFAULT_DRUPAL_BODY_FIELD,
  DEFAULT_DRUPAL_BODY_FORMAT,
  DEFAULT_DRUPAL_BUNDLE,
  DEFAULT_DRUPAL_FILE_FIELD_NAME,
  DEFAULT_DRUPAL_INSERT_POSITION,
  DEFAULT_DRUPAL_MODE,
  DEFAULT_DRUPAL_SOURCE_FIELD,
  DEFAULT_DRUPAL_SOURCE_NAMESPACE,
  DRUPAL_BUNDLE_PATTERN,
  DRUPAL_FIELD_NAME_PATTERN,
  DRUPAL_INSERT_POSITIONS,
  DRUPAL_SANDBOX_PRESETS,
  DrupalOperationMode,
  MAX_DRUPAL_ATTACHMENT_INDEX,
  MAX_DRUPAL_SELECTOR_LENGTH,
  MAX_DRUPAL_SUMMARY_LENGTH,
  MAX_DRUPAL_TITLE_LENGTH,
  UUID_V4_PATTERN,
} from '@/types/nodes/drupal-http.types';
import { NodeType, OUTPUT_NAMESPACE_PATTERN } from '@/types/pipeline';

import type { HydratableNode, UpstreamNamespace } from '@stores/nodes/node-store-registry';

import type {
  DrupalHttpNodeConfig,
  DrupalInsertPosition,
  DrupalSandboxPresetKey,
} from '@/types/nodes/drupal-http.types';

/** Prefijo del id de Pinia; el sufijo es el `nodeId` del `pipeline_schema`. */
const STORE_ID_PREFIX = 'drupalHttpNode';

/**
 * Params que cada modo necesita para EJECUTARSE.
 *
 * Calco de `getIncompleteParams` (backend), que es lo que consulta
 * `assertActivatable`. Se declara como tabla y no como una cadena de `if` para
 * que anadir un modo sea anadir una fila, y para que la divergencia con el
 * backend se vea de un vistazo al comparar los dos bloques.
 *
 * `bundle` NO esta en ninguna fila a proposito, aunque sea imprescindible para
 * componer la peticion: tiene valor por defecto no vacio, de modo que exigirlo
 * seria una condicion que no puede fallar nunca. Lo que si se valida es su
 * FORMATO, mas abajo.
 */
const REQUIRED_PARAMS_BY_MODE: Readonly<
  Record<DrupalOperationMode, readonly (keyof DrupalHttpNodeConfig)[]>
> = {
  [DrupalOperationMode.CREATE_NODE]: ['titleTemplate'],
  [DrupalOperationMode.APPEND_HTML_BLOCK]: ['targetNodeUuid'],
  [DrupalOperationMode.TRANSFER_HTML_BLOCK]: [
    'targetNodeUuid',
    'destinationNodeUuid',
    'itemSelector',
  ],
  [DrupalOperationMode.UPLOAD_ATTACHMENT]: ['targetNodeUuid'],
};

/**
 * Namespace del contexto que cada modo necesita aguas arriba.
 *
 * Replica de `getRequiredNamespaces` (backend), que alimenta la regla 7 del
 * validador de topologia. `TRANSFER_HTML_BLOCK` no figura porque no lee nada
 * del contexto: el bloque que mueve sale del DOM remoto.
 */
const REQUIRED_CONTEXT_FIELD_BY_MODE: Readonly<
  Partial<Record<DrupalOperationMode, keyof DrupalHttpNodeConfig>>
> = {
  [DrupalOperationMode.CREATE_NODE]: 'sourceNamespace',
  [DrupalOperationMode.APPEND_HTML_BLOCK]: 'sourceNamespace',
  [DrupalOperationMode.UPLOAD_ATTACHMENT]: 'attachmentNamespace',
};

/** Lee una cadena de los `params` crudos del esquema. */
const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * Lee una cadena NULABLE: la ausencia y la cadena vacia son lo mismo.
 *
 * El backend resuelve estos campos con `trimmedOrNull`, de modo que un `"  "`
 * guardado por SQL directo no cuenta como valor declarado. Se replica aqui para
 * que la interfaz no muestre como configurado lo que el motor vera vacio.
 */
const asNullableText = (value: unknown): string | null => {
  const text = typeof value === 'string' ? value.trim() : '';

  return text === '' ? null : text;
};

/** Lee un booleano; cualquier otra cosa cae al defecto indicado. */
const asBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

/**
 * Lee un entero dentro de rango; cualquier otra cosa cae al defecto.
 *
 * La columna es `jsonb` y pudo escribirse por SQL directo: un `"3"` o un `-1`
 * dejarian el control numerico en un estado que el DTO rechaza al guardar, y el
 * operador no sabria de donde salio.
 */
const asInteger = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;

/** Lee un valor de una lista cerrada; lo que no este en ella cae al defecto. */
const asEnum = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === 'string' && allowed.includes(value as T) ? (value as T) : fallback;

/** Configuracion inicial; se reutiliza en `resetConfig`. */
const buildInitialConfig = (): DrupalHttpNodeConfig => ({
  operationMode: DEFAULT_DRUPAL_MODE,
  bundle: DEFAULT_DRUPAL_BUNDLE,
  sourceNamespace: DEFAULT_DRUPAL_SOURCE_NAMESPACE,
  sourceField: DEFAULT_DRUPAL_SOURCE_FIELD,
  titleTemplate: null,
  summaryTemplate: null,
  bodyFieldName: DEFAULT_DRUPAL_BODY_FIELD,
  bodyFormat: DEFAULT_DRUPAL_BODY_FORMAT,
  publishStatus: true,
  targetNodeUuid: null,
  destinationNodeUuid: null,
  containerSelector: null,
  itemSelector: null,
  insertPosition: DEFAULT_DRUPAL_INSERT_POSITION,
  attachmentNamespace: DEFAULT_DRUPAL_ATTACHMENT_NAMESPACE,
  attachmentField: DEFAULT_DRUPAL_ATTACHMENT_FIELD,
  attachmentIndex: DEFAULT_DRUPAL_ATTACHMENT_INDEX,
  fileFieldName: DEFAULT_DRUPAL_FILE_FIELD_NAME,
});

// Estado reactivo del nodo DESTINO_DRUPAL (regla frontend-quasar.md §3.1).
//
// SIN capa de servicios, como TRIGGER_CRON, DESTINO_SMTP y ESCUDO_POST_IA, y
// por el mismo motivo: no hay nada que preguntarle al backend.
// `@Controller('nodos')` expone UNA ruta, `GET /api/nodos`, de solo lectura, y
// no existe ningun endpoint que valide los `params` de un nodo suelto. La
// validacion de verdad la hace `paramsSchema` al guardar el esquema; lo de aqui
// es el espejo en diseno que evita llegar alli con un 400.
const drupalHttpSetup = () => {
  const config = ref<DrupalHttpNodeConfig>(buildInitialConfig());

  /** Namespaces que publican los pasos ANTERIORES, con sus campos. */
  const availableUpstreamContext = ref<UpstreamNamespace[]>([]);

  /**
   * Opciones del selector de namespace de origen.
   *
   * CERRADO y no texto libre (Poka-Yoke, `frontend-quasar.md` §4): un nombre
   * tecleado a mano que ningun paso publique es un 400 al guardar por la regla
   * 7, con el mensaje apuntando al esquema entero y no al campo.
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

  /** Campos que publica el namespace de origen elegido. */
  const fieldOptions = computed<readonly string[]>(() =>
    (selectedNamespace.value?.fields ?? []).map((field) => field.name),
  );

  /** Lo mismo para el namespace del que salen los adjuntos. */
  const attachmentFieldOptions = computed<readonly string[]>(
    () =>
      availableUpstreamContext.value
        .find((entry) => entry.namespace === config.value.attachmentNamespace)
        ?.fields.map((field) => field.name) ?? [],
  );

  /**
   * Params que el modo activo exige y siguen sin valor.
   *
   * Se expone ademas de consumirse en `isConfigValid` para que la interfaz
   * pueda senalar el campo concreto: "faltan campos" sin decir cual es
   * exactamente lo que el asistente existe para evitar.
   */
  const missingRequiredParams = computed<readonly string[]>(() =>
    REQUIRED_PARAMS_BY_MODE[config.value.operationMode].filter(
      (key) => asNullableText(config.value[key]) === null,
    ),
  );

  /**
   * Campos cuyo FORMATO el DTO rechazaria con un 400.
   *
   * Van en `isConfigValid` y no en un aviso porque el fallo es seguro y
   * conocido de antemano: el patron esta replicado de `class-validator`. Vale la
   * pena distinguirlos de los que faltan —el operador escribio algo, y lo que
   * necesita saber es que esta mal, no que esta vacio.
   */
  const malformedParams = computed<readonly string[]>(() => {
    const { value: current } = config;
    const malformed: string[] = [];

    if (!DRUPAL_BUNDLE_PATTERN.test(current.bundle)) malformed.push('bundle');

    if (!OUTPUT_NAMESPACE_PATTERN.test(current.sourceNamespace)) {
      malformed.push('sourceNamespace');
    }

    if (!OUTPUT_NAMESPACE_PATTERN.test(current.attachmentNamespace)) {
      malformed.push('attachmentNamespace');
    }

    (
      [
        ['sourceField', current.sourceField],
        ['bodyFieldName', current.bodyFieldName],
        ['bodyFormat', current.bodyFormat],
        ['attachmentField', current.attachmentField],
        ['fileFieldName', current.fileFieldName],
      ] as const
    ).forEach(([key, value]) => {
      if (!DRUPAL_FIELD_NAME_PATTERN.test(value)) malformed.push(key);
    });

    (
      [
        ['targetNodeUuid', current.targetNodeUuid],
        ['destinationNodeUuid', current.destinationNodeUuid],
      ] as const
    ).forEach(([key, value]) => {
      if (value !== null && !UUID_V4_PATTERN.test(value)) malformed.push(key);
    });

    (
      [
        ['titleTemplate', current.titleTemplate, MAX_DRUPAL_TITLE_LENGTH],
        ['summaryTemplate', current.summaryTemplate, MAX_DRUPAL_SUMMARY_LENGTH],
        ['containerSelector', current.containerSelector, MAX_DRUPAL_SELECTOR_LENGTH],
        ['itemSelector', current.itemSelector, MAX_DRUPAL_SELECTOR_LENGTH],
      ] as const
    ).forEach(([key, value, limit]) => {
      if (value !== null && value.length > limit) malformed.push(key);
    });

    if (
      !Number.isInteger(current.attachmentIndex) ||
      current.attachmentIndex < 0 ||
      current.attachmentIndex > MAX_DRUPAL_ATTACHMENT_INDEX
    ) {
      malformed.push('attachmentIndex');
    }

    return malformed;
  });

  /**
   * Contrato uniforme del nodo (§3.1): lo unico que el asistente consulta.
   *
   * Dos familias, y ninguna mira aguas arriba: lo que el modo activo exige
   * —calco de `getIncompleteParams`— y lo que el DTO rechazaria por formato.
   * Que el contexto publique o no el namespace elegido es un aviso y no un
   * bloqueo; el porque esta en `configWarnings`.
   */
  const isConfigValid = computed<boolean>(
    () => missingRequiredParams.value.length === 0 && malformedParams.value.length === 0,
  );

  /** Avisos no bloqueantes del paso (contrato de `NodeConfigStore`). */
  const configWarnings = computed<readonly string[]>(() => {
    const warnings: string[] = [];

    // 1. Espejo en diseno de la regla 7 del validador de topologia. Avisa y no
    //    bloquea porque `availableUpstreamContext` llega VACIO hasta que carga
    //    `GET /api/nodos`: invalidar el paso sobre un contexto que todavia no
    //    existe lo dejaria en rojo en cada apertura del asistente, sin que el
    //    operador pudiera hacer nada. Con el contexto ya cargado, en cambio, la
    //    ausencia del namespace es un hecho, y el aviso lo NOMBRA —que es justo
    //    lo que el 400 de `ERR_MISSING_UPSTREAM_CONTEXT` no deja legible.
    const requiredField = REQUIRED_CONTEXT_FIELD_BY_MODE[config.value.operationMode];

    if (requiredField !== undefined && availableUpstreamContext.value.length > 0) {
      const required = String(config.value[requiredField]);

      if (!namespaceOptions.value.includes(required)) {
        warnings.push(
          `Ningun paso anterior publica el namespace "${required}". El flujo se rechazara al ` +
            'guardar con ERR_MISSING_UPSTREAM_CONTEXT: coloca delante el nodo que lo produce ' +
            'o elige otro origen.',
        );
      }
    }

    // 2. Advertencia topologica del propio DTO: el motor LIBERA los bytes de
    //    los adjuntos en cuanto cualquier nodo publica texto aprovechable, asi
    //    que un parser por delante deja el inventario con `contentBase64` a
    //    `null`. No se puede afirmar que falle —depende de que publique el
    //    parser en ejecucion—, de modo que avisa en vez de bloquear.
    if (
      config.value.operationMode === DrupalOperationMode.UPLOAD_ATTACHMENT &&
      availableUpstreamContext.value.some(({ nodeType }) => nodeType === NodeType.PARSER_PRE_IA)
    ) {
      warnings.push(
        'Hay un PARSER_PRE_IA antes de este paso: el motor libera los bytes de los adjuntos en ' +
          'cuanto un nodo publica texto, y la subida fallara con ERR_DRUPAL_MISSING_PAYLOAD. ' +
          'Coloca la subida ANTES del parser.',
      );
    }

    return warnings;
  });

  /** Aplica un parche parcial conservando la inmutabilidad de `config`. */
  const updateConfig = (patch: Partial<DrupalHttpNodeConfig>): void => {
    config.value = { ...config.value, ...patch };
  };

  /**
   * Carga uno de los destinos operativos confirmados en produccion.
   *
   * Escribe los SIETE campos del destino en UNA sola llamada, y las dos cosas
   * importan:
   *
   * - De una en una no significan nada. El UUID de la agregadora de
   *   licitaciones solo tiene sentido con `node--page` y un modo que mute HTML,
   *   y un `TRANSFER_HTML_BLOCK` sin `itemSelector` no es media configuracion:
   *   es una que falla en ejecucion.
   * - Los campos que el preset NO usa se escriben igualmente, con su valor
   *   nulo. Si solo se parchearan los que aplican, pasar de «cerrar licitacion»
   *   a «abrir licitacion» dejaria el `itemSelector` del traslado colgado en una
   *   configuracion que ya no lo lee, y reaparecería al volver al otro modo.
   *
   * Una sola llamada a `updateConfig` y no siete: cada una reemplaza el objeto
   * entero y volveria a disparar los `computed` de validacion, que recorren los
   * parametros del modo activo.
   */
  const applyPreset = (presetKey: DrupalSandboxPresetKey): void => {
    const preset = DRUPAL_SANDBOX_PRESETS[presetKey];

    updateConfig({
      operationMode: preset.operationMode,
      bundle: preset.bundle,
      targetNodeUuid: preset.targetNodeUuid,
      destinationNodeUuid: preset.destinationNodeUuid,
      containerSelector: preset.containerSelector,
      itemSelector: preset.itemSelector,
      insertPosition: preset.insertPosition,
    });
  };

  // Atajos nominales. El componente invoca estos y no `applyPreset('...')` con
  // una cadena, para que renombrar una clave del catalogo sea un error de
  // compilacion y no un boton que deja de hacer nada.
  const applyAbrirLicitacionPreset = (): void => {
    applyPreset('ABRIR_LICITACION');
  };

  const applyCerrarLicitacionPreset = (): void => {
    applyPreset('CERRAR_LICITACION');
  };

  const applyVerificacionTitulosPreset = (): void => {
    applyPreset('VERIFICACION_TITULOS');
  };

  /** Se COPIA el arreglo: el anfitrion reconstruye el suyo en cada sincronizacion. */
  const setAvailableUpstreamContext = (context: UpstreamNamespace[]): void => {
    availableUpstreamContext.value = [...context];
  };

  /**
   * `params` del nodo para el `pipeline_schema`.
   *
   * Se OMITE lo que vale `null` y lo que coincide con el defecto del backend,
   * igual que en `post-ia-sanitizer.store.ts`: un flujo recien creado no debe
   * escribir dieciocho claves que nadie ha tocado, y el motor repone el mismo
   * valor al resolver el DTO.
   *
   * EXCEPCION: `operationMode` viaja SIEMPRE. Es el discriminador del que
   * depende la lectura de todo lo demas —que params son obligatorios, que
   * namespace se exige aguas arriba, que codigos de error puede emitir el
   * nodo—, y dejarlo implicito convierte la decision mas importante del
   * formulario en algo que hay que deducir de un defecto.
   *
   * Se publica lo que esta configurado AUNQUE no lo use el modo activo: el DTO
   * declara los dieciocho, asi que no hay riesgo de `forbidNonWhitelisted`, y
   * borrarlos al cambiar de modo perderia el trabajo del operador si vuelve.
   *
   * CAVEAT de la ida y vuelta: la invariante «`hydrateFromNode(n)` seguido de
   * `toNodeParams()` reproduce `n.params`» se cumple para todo `n.params`
   * salido de este mismo metodo, pero no para uno escrito a mano que declare un
   * valor IGUAL al defecto; ese se pierde al volver. No cambia el esquema
   * efectivo, porque el backend lo repone.
   */
  const toNodeParams = (): Record<string, unknown> => {
    const { value: current } = config;
    const params: Record<string, unknown> = { operationMode: current.operationMode };

    const putDefaulted = (key: string, value: string, fallback: string): void => {
      const trimmed = value.trim();

      if (trimmed !== '' && trimmed !== fallback) params[key] = trimmed;
    };

    const putNullable = (key: string, value: string | null): void => {
      const trimmed = value?.trim() ?? '';

      if (trimmed !== '') params[key] = trimmed;
    };

    putDefaulted('bundle', current.bundle, DEFAULT_DRUPAL_BUNDLE);
    putDefaulted('sourceNamespace', current.sourceNamespace, DEFAULT_DRUPAL_SOURCE_NAMESPACE);
    putDefaulted('sourceField', current.sourceField, DEFAULT_DRUPAL_SOURCE_FIELD);
    putDefaulted('bodyFieldName', current.bodyFieldName, DEFAULT_DRUPAL_BODY_FIELD);
    putDefaulted('bodyFormat', current.bodyFormat, DEFAULT_DRUPAL_BODY_FORMAT);
    putDefaulted(
      'attachmentNamespace',
      current.attachmentNamespace,
      DEFAULT_DRUPAL_ATTACHMENT_NAMESPACE,
    );
    putDefaulted('attachmentField', current.attachmentField, DEFAULT_DRUPAL_ATTACHMENT_FIELD);
    putDefaulted('fileFieldName', current.fileFieldName, DEFAULT_DRUPAL_FILE_FIELD_NAME);

    putNullable('titleTemplate', current.titleTemplate);
    putNullable('summaryTemplate', current.summaryTemplate);
    putNullable('targetNodeUuid', current.targetNodeUuid);
    putNullable('destinationNodeUuid', current.destinationNodeUuid);
    putNullable('containerSelector', current.containerSelector);
    putNullable('itemSelector', current.itemSelector);

    if (current.insertPosition !== DEFAULT_DRUPAL_INSERT_POSITION) {
      params.insertPosition = current.insertPosition;
    }

    if (current.attachmentIndex !== DEFAULT_DRUPAL_ATTACHMENT_INDEX) {
      params.attachmentIndex = current.attachmentIndex;
    }

    // `publishStatus` se publica solo cuando es `false`, que es la decision
    // deliberada: el `true` es el defecto y significa "no he dicho nada".
    if (!current.publishStatus) params.publishStatus = false;

    return params;
  };

  /**
   * Carga la configuracion de un nodo ya guardado en el `pipeline_schema`.
   *
   * Lee de forma defensiva: la columna es `jsonb` y pudo escribirse por SQL
   * directo, asi que un tipo inesperado cae al defecto en vez de dejar un
   * control de Quasar descontrolado.
   */
  const hydrateFromNode = (node: HydratableNode): void => {
    const { params } = node;

    config.value = {
      operationMode: asEnum(
        params.operationMode,
        Object.values(DrupalOperationMode),
        DEFAULT_DRUPAL_MODE,
      ),
      bundle: asText(params.bundle).trim() || DEFAULT_DRUPAL_BUNDLE,
      sourceNamespace: asText(params.sourceNamespace).trim() || DEFAULT_DRUPAL_SOURCE_NAMESPACE,
      sourceField: asText(params.sourceField).trim() || DEFAULT_DRUPAL_SOURCE_FIELD,
      titleTemplate: asNullableText(params.titleTemplate),
      summaryTemplate: asNullableText(params.summaryTemplate),
      bodyFieldName: asText(params.bodyFieldName).trim() || DEFAULT_DRUPAL_BODY_FIELD,
      bodyFormat: asText(params.bodyFormat).trim() || DEFAULT_DRUPAL_BODY_FORMAT,
      publishStatus: asBoolean(params.publishStatus, true),
      targetNodeUuid: asNullableText(params.targetNodeUuid),
      destinationNodeUuid: asNullableText(params.destinationNodeUuid),
      containerSelector: asNullableText(params.containerSelector),
      itemSelector: asNullableText(params.itemSelector),
      insertPosition: asEnum<DrupalInsertPosition>(
        params.insertPosition,
        DRUPAL_INSERT_POSITIONS,
        DEFAULT_DRUPAL_INSERT_POSITION,
      ),
      attachmentNamespace:
        asText(params.attachmentNamespace).trim() || DEFAULT_DRUPAL_ATTACHMENT_NAMESPACE,
      attachmentField: asText(params.attachmentField).trim() || DEFAULT_DRUPAL_ATTACHMENT_FIELD,
      attachmentIndex: asInteger(
        params.attachmentIndex,
        DEFAULT_DRUPAL_ATTACHMENT_INDEX,
        0,
        MAX_DRUPAL_ATTACHMENT_INDEX,
      ),
      fileFieldName: asText(params.fileFieldName).trim() || DEFAULT_DRUPAL_FILE_FIELD_NAME,
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
    attachmentFieldOptions,
    missingRequiredParams,
    malformedParams,
    isConfigValid,
    configWarnings,
    updateConfig,
    applyPreset,
    applyAbrirLicitacionPreset,
    applyCerrarLicitacionPreset,
    applyVerificacionTitulosPreset,
    setAvailableUpstreamContext,
    toNodeParams,
    hydrateFromNode,
    resetConfig,
  };
};

/**
 * Definicion de Pinia para UN nodo concreto.
 *
 * El id lleva el `nodeId` dentro por el mismo motivo que en los demas nodos: un
 * flujo puede publicar en dos sitios —crear la noticia y, ademas, mover su
 * licitacion a la pagina de cerradas— y con un id fijo los dos pasos
 * compartirian una sola instancia.
 */
const buildDrupalHttpStore = (nodeId: string) =>
  defineStore(`${STORE_ID_PREFIX}:${nodeId}`, drupalHttpSetup);

/** Instancia del store, para tipar helpers y consumidores sin `any`. */
export type DrupalHttpStore = ReturnType<ReturnType<typeof buildDrupalHttpStore>>;

/** Definiciones ya creadas, indexadas por `nodeId`. */
const definitions = new Map<string, ReturnType<typeof buildDrupalHttpStore>>();

/** Store del nodo DESTINO_DRUPAL identificado por `nodeId`. */
export const useDrupalHttpStore = (nodeId: string): DrupalHttpStore => {
  const cached = definitions.get(nodeId);

  if (cached !== undefined) return cached();

  const definition = buildDrupalHttpStore(nodeId);
  definitions.set(nodeId, definition);

  if (import.meta.hot) {
    import.meta.hot.accept(acceptHMRUpdate(definition, import.meta.hot));
  }

  return definition();
};
