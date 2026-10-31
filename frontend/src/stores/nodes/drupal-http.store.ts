import { defineStore, acceptHMRUpdate } from 'pinia';
import { computed, ref } from 'vue';

import {
  DEFAULT_DRUPAL_ATTACHMENT_FIELD,
  DEFAULT_DRUPAL_ATTACHMENT_INDEX,
  DEFAULT_DRUPAL_ATTACHMENT_LIST_SELECTOR,
  DEFAULT_DRUPAL_ATTACHMENT_NAMESPACE,
  DEFAULT_DRUPAL_BODY_FIELD,
  DEFAULT_DRUPAL_BODY_FORMAT,
  DEFAULT_DRUPAL_BUNDLE,
  DEFAULT_DRUPAL_FILE_FIELD_NAME,
  DEFAULT_DRUPAL_INSERT_POSITION,
  DEFAULT_DRUPAL_IS_SANDBOX,
  DEFAULT_DRUPAL_LINK_ATTRIBUTE,
  DEFAULT_DRUPAL_MODE,
  DEFAULT_DRUPAL_NEWS_ORDER,
  DEFAULT_DRUPAL_SOURCE_FIELD,
  DEFAULT_DRUPAL_SOURCE_NAMESPACE,
  DEFAULT_DRUPAL_UPLOAD_ATTACHMENT,
  DRUPAL_BUNDLE_PATTERN,
  DRUPAL_FIELD_NAME_PATTERN,
  DRUPAL_INSERT_POSITIONS,
  DRUPAL_LINK_ATTRIBUTES,
  DRUPAL_PRESETS,
  DrupalOperationMode,
  MAX_DRUPAL_ATTACHMENT_INDEX,
  MAX_DRUPAL_AUTHOR_LENGTH,
  MAX_DRUPAL_DATE_TEMPLATE_LENGTH,
  MAX_DRUPAL_LINK_TEMPLATE_LENGTH,
  MAX_DRUPAL_NEWS_ORDER,
  MAX_DRUPAL_SELECTOR_LENGTH,
  MAX_DRUPAL_SUMMARY_LENGTH,
  MAX_DRUPAL_TITLE_LENGTH,
  UUID_V4_PATTERN,
  toDrupalEnvironment,
} from '@/types/nodes/drupal-http.types';
import { NodeType, OUTPUT_NAMESPACE_PATTERN } from '@/types/pipeline';

import type { HydratableNode, UpstreamNamespace } from '@stores/nodes/node-store-registry';

import type {
  DrupalHttpNodeConfig,
  DrupalInsertPosition,
  DrupalLinkAttribute,
  DrupalPresetKey,
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
  [DrupalOperationMode.UPDATE_LINK_SOURCE]: ['targetNodeUuid', 'linkSelector', 'linkValueTemplate'],
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
/**
 * En Sandbox no se publica nunca: lo creado queda como borrador.
 *
 * Se aplica en CADA escritura de la configuracion y no solo en el toggle: un
 * preset, una hidratacion o un `updateConfig` con `publishStatus: true` no
 * deben poder colar una publicacion en el entorno de pruebas.
 */
const withSandboxDraft = (next: DrupalHttpNodeConfig): DrupalHttpNodeConfig =>
  next.isSandbox && next.publishStatus ? { ...next, publishStatus: false } : next;

const buildInitialConfig = (): DrupalHttpNodeConfig => ({
  isSandbox: DEFAULT_DRUPAL_IS_SANDBOX,
  operationMode: DEFAULT_DRUPAL_MODE,
  bundle: DEFAULT_DRUPAL_BUNDLE,
  sourceNamespace: DEFAULT_DRUPAL_SOURCE_NAMESPACE,
  sourceField: DEFAULT_DRUPAL_SOURCE_FIELD,
  titleTemplate: null,
  summaryTemplate: null,
  authorTemplate: null,
  dateTemplate: null,
  orderValue: DEFAULT_DRUPAL_NEWS_ORDER,
  newsSourceTermUuid: null,
  newsSectionTermUuid: null,
  newsTypeTermUuid: null,
  bodyFieldName: DEFAULT_DRUPAL_BODY_FIELD,
  bodyFormat: DEFAULT_DRUPAL_BODY_FORMAT,
  // Falso porque el nodo nace en Sandbox, donde no se publica nunca.
  publishStatus: !DEFAULT_DRUPAL_IS_SANDBOX,
  targetNodeUuid: null,
  destinationNodeUuid: null,
  containerSelector: null,
  itemSelector: null,
  targetContainerSelector: null,
  insertPosition: DEFAULT_DRUPAL_INSERT_POSITION,
  expedienteTemplate: null,
  linkSelector: null,
  linkAttribute: DEFAULT_DRUPAL_LINK_ATTRIBUTE,
  linkValueTemplate: null,
  attachmentNamespace: DEFAULT_DRUPAL_ATTACHMENT_NAMESPACE,
  attachmentField: DEFAULT_DRUPAL_ATTACHMENT_FIELD,
  attachmentIndex: DEFAULT_DRUPAL_ATTACHMENT_INDEX,
  fileFieldName: DEFAULT_DRUPAL_FILE_FIELD_NAME,
  uploadAttachment: DEFAULT_DRUPAL_UPLOAD_ATTACHMENT,
  attachmentListSelector: DEFAULT_DRUPAL_ATTACHMENT_LIST_SELECTOR,
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
        ['newsSourceTermUuid', current.newsSourceTermUuid],
        ['newsSectionTermUuid', current.newsSectionTermUuid],
        ['newsTypeTermUuid', current.newsTypeTermUuid],
      ] as const
    ).forEach(([key, value]) => {
      if (value !== null && !UUID_V4_PATTERN.test(value)) malformed.push(key);
    });

    (
      [
        ['titleTemplate', current.titleTemplate, MAX_DRUPAL_TITLE_LENGTH],
        ['summaryTemplate', current.summaryTemplate, MAX_DRUPAL_SUMMARY_LENGTH],
        ['authorTemplate', current.authorTemplate, MAX_DRUPAL_AUTHOR_LENGTH],
        ['dateTemplate', current.dateTemplate, MAX_DRUPAL_DATE_TEMPLATE_LENGTH],
        ['targetContainerSelector', current.targetContainerSelector, MAX_DRUPAL_SELECTOR_LENGTH],
        ['containerSelector', current.containerSelector, MAX_DRUPAL_SELECTOR_LENGTH],
        ['itemSelector', current.itemSelector, MAX_DRUPAL_SELECTOR_LENGTH],
        ['attachmentListSelector', current.attachmentListSelector, MAX_DRUPAL_SELECTOR_LENGTH],
        ['linkSelector', current.linkSelector, MAX_DRUPAL_SELECTOR_LENGTH],
        ['expedienteTemplate', current.expedienteTemplate, MAX_DRUPAL_SELECTOR_LENGTH],
        ['linkValueTemplate', current.linkValueTemplate, MAX_DRUPAL_LINK_TEMPLATE_LENGTH],
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

    if (
      !Number.isInteger(current.orderValue) ||
      current.orderValue < 0 ||
      current.orderValue > MAX_DRUPAL_NEWS_ORDER
    ) {
      malformed.push('orderValue');
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
    //    los adjuntos en cuanto un nodo publica texto de PROCEDENCIA DOCUMENTAL
    //    (`extracted_documents_text`, `extracted_text`), de modo que un parser
    //    que extraiga el contenido de los PDF deja el inventario con
    //    `contentBase64` a `null`. El cuerpo del correo ya no cuenta. No se
    //    puede afirmar que falle —depende de la config del parser en
    //    ejecucion—, de modo que avisa en vez de bloquear.
    //
    //    Cubre las dos formas de subir: el modo dedicado, que va ANTES del
    //    parser, y el APPEND que sube de paso, que es terminal y por tanto solo
    //    funciona si ese parser lleva `skipDocumentExtraction` encendido.
    const subeAdjunto =
      config.value.operationMode === DrupalOperationMode.UPLOAD_ATTACHMENT ||
      (config.value.operationMode === DrupalOperationMode.APPEND_HTML_BLOCK &&
        config.value.uploadAttachment);

    if (
      subeAdjunto &&
      availableUpstreamContext.value.some(({ nodeType }) => nodeType === NodeType.PARSER_PRE_IA)
    ) {
      warnings.push(
        config.value.operationMode === DrupalOperationMode.UPLOAD_ATTACHMENT
          ? 'Hay un PARSER_PRE_IA antes de este paso: si extrae el texto de los adjuntos, el ' +
              'motor libera sus bytes y la subida fallara con ERR_DRUPAL_MISSING_PAYLOAD. ' +
              'Coloca la subida ANTES del parser.'
          : 'Hay un PARSER_PRE_IA antes de este paso. Como este nodo cierra el flujo, la subida ' +
              'solo encontrara el binario si ese parser tiene "skipDocumentExtraction" activado; ' +
              'si no, el bloque se publicara sin enlace al fichero.',
      );
    }

    return warnings;
  });

  /** Aplica un parche parcial conservando la inmutabilidad de `config`. */
  const updateConfig = (patch: Partial<DrupalHttpNodeConfig>): void => {
    config.value = withSandboxDraft({ ...config.value, ...patch });
  };

  /**
   * Preset aplicado por ultima vez, para que el toggle de entorno lo siga.
   *
   * `null` en cuanto se hidrata un nodo guardado: lo que venga del esquema es
   * del operador, y el toggle no debe reescribirlo.
   */
  const activePresetKey = ref<DrupalPresetKey | null>(null);

  /**
   * Carga uno de los destinos operativos en el entorno del toggle.
   *
   * Escribe todos los campos del destino en UNA sola llamada, y las dos cosas
   * importan:
   *
   * - De uno en uno no significan nada. El UUID de la agregadora de
   *   licitaciones solo tiene sentido con `node--page` y un modo que mute HTML,
   *   y un `TRANSFER_HTML_BLOCK` sin `itemSelector` no es media configuracion:
   *   es una que falla en ejecucion.
   * - Los campos que el preset NO usa se escriben igualmente, con su valor
   *   nulo. Si solo se parchearan los que aplican, pasar de «cerrar licitacion»
   *   a «abrir licitacion» dejaria el `itemSelector` del traslado colgado en una
   *   configuracion que ya no lo lee, y reaparecería al volver al otro modo.
   *
   * No toca las plantillas (`titleTemplate`, `linkValueTemplate`): son el
   * mapeo del contenido del flujo, no del destino.
   */
  const applyPreset = (presetKey: DrupalPresetKey): void => {
    const preset = DRUPAL_PRESETS[presetKey];
    const target = preset.environments[toDrupalEnvironment(config.value.isSandbox)];

    updateConfig({
      operationMode: preset.operationMode,
      bundle: preset.bundle,
      targetNodeUuid: target.targetNodeUuid,
      destinationNodeUuid: target.destinationNodeUuid,
      containerSelector: preset.containerSelector,
      itemSelector: preset.itemSelector,
      insertPosition: preset.insertPosition,
      publishStatus: preset.publishStatus,
      linkSelector: preset.linkSelector,
      linkAttribute: preset.linkAttribute,
      targetContainerSelector: preset.targetContainerSelector,
      newsSectionTermUuid: preset.newsSectionTermUuid,
      newsTypeTermUuid: preset.newsTypeTermUuid,
    });
    activePresetKey.value = presetKey;
  };

  /**
   * Cambia de entorno y, si hay un preset aplicado, mueve sus paginas al nuevo.
   *
   * Solo se reescriben las paginas si siguen siendo las del preset en el
   * entorno anterior. Si el operador tecleo otra —el caso normal en Produccion,
   * donde los UUID vienen vacios—, se respeta: el toggle no debe borrar trabajo
   * hecho a mano.
   */
  const setSandbox = (isSandbox: boolean): void => {
    const presetKey = activePresetKey.value;
    const previous =
      presetKey === null
        ? null
        : DRUPAL_PRESETS[presetKey].environments[toDrupalEnvironment(config.value.isSandbox)];

    updateConfig({ isSandbox });

    if (
      presetKey !== null &&
      previous !== null &&
      previous.targetNodeUuid === config.value.targetNodeUuid &&
      previous.destinationNodeUuid === config.value.destinationNodeUuid
    ) {
      const next = DRUPAL_PRESETS[presetKey].environments[toDrupalEnvironment(isSandbox)];

      updateConfig({
        targetNodeUuid: next.targetNodeUuid,
        destinationNodeUuid: next.destinationNodeUuid,
      });
    }
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

  const applyInnodaysPreset = (): void => {
    applyPreset('INNODAYS');
  };

  const applyInnobarPreset = (): void => {
    applyPreset('INNOBAR');
  };

  const applyNotiwebPreset = (): void => {
    applyPreset('NOTIWEB');
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
    // `isSandbox` viaja SIEMPRE, como `operationMode`: el entorno es una
    // decision que tiene que leerse en el esquema guardado, no deducirse de un
    // defecto que cambiaria de significado si cambiara el defecto.
    const params: Record<string, unknown> = {
      isSandbox: current.isSandbox,
      operationMode: current.operationMode,
    };

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
    putDefaulted(
      'attachmentListSelector',
      current.attachmentListSelector,
      DEFAULT_DRUPAL_ATTACHMENT_LIST_SELECTOR,
    );

    putNullable('titleTemplate', current.titleTemplate);
    putNullable('summaryTemplate', current.summaryTemplate);
    putNullable('authorTemplate', current.authorTemplate);
    putNullable('dateTemplate', current.dateTemplate);
    putNullable('newsSourceTermUuid', current.newsSourceTermUuid);
    putNullable('newsSectionTermUuid', current.newsSectionTermUuid);
    putNullable('newsTypeTermUuid', current.newsTypeTermUuid);
    putNullable('targetContainerSelector', current.targetContainerSelector);
    putNullable('targetNodeUuid', current.targetNodeUuid);
    putNullable('destinationNodeUuid', current.destinationNodeUuid);
    putNullable('containerSelector', current.containerSelector);
    putNullable('itemSelector', current.itemSelector);
    putNullable('expedienteTemplate', current.expedienteTemplate);
    putNullable('linkSelector', current.linkSelector);
    putNullable('linkValueTemplate', current.linkValueTemplate);

    if (current.linkAttribute !== DEFAULT_DRUPAL_LINK_ATTRIBUTE) {
      params.linkAttribute = current.linkAttribute;
    }

    if (current.insertPosition !== DEFAULT_DRUPAL_INSERT_POSITION) {
      params.insertPosition = current.insertPosition;
    }

    if (current.attachmentIndex !== DEFAULT_DRUPAL_ATTACHMENT_INDEX) {
      params.attachmentIndex = current.attachmentIndex;
    }

    if (current.orderValue !== DEFAULT_DRUPAL_NEWS_ORDER) {
      params.orderValue = current.orderValue;
    }

    // Simetrico a `publishStatus`: solo viaja cuando se aparta del defecto. Y
    // aqui el defecto es `false`, porque subir un fichero es un efecto externo
    // y esos no se encienden por omision.
    if (current.uploadAttachment !== DEFAULT_DRUPAL_UPLOAD_ATTACHMENT) {
      params.uploadAttachment = current.uploadAttachment;
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

    activePresetKey.value = null;
    config.value = withSandboxDraft({
      isSandbox: asBoolean(params.isSandbox, DEFAULT_DRUPAL_IS_SANDBOX),
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
      authorTemplate: asNullableText(params.authorTemplate),
      dateTemplate: asNullableText(params.dateTemplate),
      orderValue: asInteger(params.orderValue, DEFAULT_DRUPAL_NEWS_ORDER, 0, MAX_DRUPAL_NEWS_ORDER),
      newsSourceTermUuid: asNullableText(params.newsSourceTermUuid),
      newsSectionTermUuid: asNullableText(params.newsSectionTermUuid),
      newsTypeTermUuid: asNullableText(params.newsTypeTermUuid),
      bodyFieldName: asText(params.bodyFieldName).trim() || DEFAULT_DRUPAL_BODY_FIELD,
      bodyFormat: asText(params.bodyFormat).trim() || DEFAULT_DRUPAL_BODY_FORMAT,
      publishStatus: asBoolean(params.publishStatus, true),
      targetNodeUuid: asNullableText(params.targetNodeUuid),
      destinationNodeUuid: asNullableText(params.destinationNodeUuid),
      containerSelector: asNullableText(params.containerSelector),
      itemSelector: asNullableText(params.itemSelector),
      targetContainerSelector: asNullableText(params.targetContainerSelector),
      insertPosition: asEnum<DrupalInsertPosition>(
        params.insertPosition,
        DRUPAL_INSERT_POSITIONS,
        DEFAULT_DRUPAL_INSERT_POSITION,
      ),
      expedienteTemplate: asNullableText(params.expedienteTemplate),
      linkSelector: asNullableText(params.linkSelector),
      linkAttribute: asEnum<DrupalLinkAttribute>(
        params.linkAttribute,
        DRUPAL_LINK_ATTRIBUTES,
        DEFAULT_DRUPAL_LINK_ATTRIBUTE,
      ),
      linkValueTemplate: asNullableText(params.linkValueTemplate),
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
      uploadAttachment: asBoolean(params.uploadAttachment, DEFAULT_DRUPAL_UPLOAD_ATTACHMENT),
      attachmentListSelector:
        asText(params.attachmentListSelector).trim() || DEFAULT_DRUPAL_ATTACHMENT_LIST_SELECTOR,
    });
  };

  const resetConfig = (): void => {
    activePresetKey.value = null;
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
    activePresetKey,
    updateConfig,
    setSandbox,
    applyPreset,
    applyAbrirLicitacionPreset,
    applyCerrarLicitacionPreset,
    applyVerificacionTitulosPreset,
    applyInnodaysPreset,
    applyInnobarPreset,
    applyNotiwebPreset,
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
