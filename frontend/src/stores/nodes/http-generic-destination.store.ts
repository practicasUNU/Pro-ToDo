import { defineStore, acceptHMRUpdate } from 'pinia';
import { computed, ref } from 'vue';

import { useCredentialsStore } from '@stores/credentials.store';

import { detectPrivateTarget } from '@/utils/outbound-url';
import { buildUrlOptions } from '@/utils/url-source-options';

import { CredentialAuthType } from '@/types/credential';
import {
  DEFAULT_HTTP_GENERIC_AUTH_TYPE,
  DEFAULT_HTTP_GENERIC_BODY_TYPE,
  DEFAULT_HTTP_GENERIC_METHOD,
  DEFAULT_HTTP_GENERIC_RETRY_ATTEMPTS,
  DEFAULT_HTTP_GENERIC_TIMEOUT_MS,
  FORBIDDEN_HEADER_NAMES,
  HTTP_MARKER_PATTERN,
  HttpGenericAuthType,
  HttpGenericBodyType,
  HttpGenericMethod,
  KEY_VALUE_NAME_PATTERN,
  MAX_BODY_TEMPLATE_LENGTH,
  MAX_HTTP_GENERIC_RETRY_ATTEMPTS,
  MAX_HTTP_GENERIC_TIMEOUT_MS,
  MAX_KEY_VALUE_ENTRIES,
  MAX_KEY_VALUE_VALUE_LENGTH,
  MAX_TARGET_URL_LENGTH,
  MIN_HTTP_GENERIC_TIMEOUT_MS,
  TARGET_URL_PATTERN,
} from '@/types/nodes/http-generic-destination.types';

import type { HydratableNode, UpstreamNamespace } from '@stores/nodes/node-store-registry';

import type { CredentialOption } from '@/types/credential';
import type { TargetUrlOption } from '@/utils/url-source-options';
import type {
  HttpGenericDestinationNodeConfig,
  KeyValueRow,
} from '@/types/nodes/http-generic-destination.types';

/** Prefijo del id de Pinia; el sufijo es el `nodeId` del `pipeline_schema`. */
const STORE_ID_PREFIX = 'httpGenericDestinationNode';

/** Metodos que no llevan cuerpo: espejo de `describeBodyProblem` del backend. */
const BODYLESS_METHODS: ReadonlySet<HttpGenericMethod> = new Set([
  HttpGenericMethod.GET,
  HttpGenericMethod.DELETE,
]);

/** Tipo de credencial que exige cada `authType`: espejo de la estrategia. */
const CREDENTIAL_TYPE_BY_AUTH: Readonly<Record<HttpGenericAuthType, CredentialAuthType | null>> = {
  [HttpGenericAuthType.NONE]: null,
  [HttpGenericAuthType.BEARER_TOKEN]: CredentialAuthType.BEARER_TOKEN,
  [HttpGenericAuthType.BASIC_AUTH]: CredentialAuthType.BASIC_AUTH,
  [HttpGenericAuthType.API_KEY]: CredentialAuthType.API_KEY,
};

/** Lee una cadena NULABLE: la ausencia y la cadena vacia son lo mismo. */
const asNullableText = (value: unknown): string | null => {
  const text = typeof value === 'string' ? value.trim() : '';

  return text === '' ? null : text;
};

/** Lee un entero dentro de rango; cualquier otra cosa cae al defecto. */
const asInteger = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;

/** Lee un valor de una lista cerrada; lo que no este en ella cae al defecto. */
const asEnum = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === 'string' && allowed.includes(value as T) ? (value as T) : fallback;

/** Convierte un `Record` del esquema en filas editables. */
const asRows = (value: unknown): KeyValueRow[] =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.entries(value as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        .map(([name, rowValue]) => ({ name, value: rowValue }))
    : [];

/** Filas a `Record`, descartando las que no tienen nombre. */
const toRecord = (rows: readonly KeyValueRow[]): Record<string, string> =>
  Object.fromEntries(
    rows.filter((row) => row.name.trim() !== '').map((row) => [row.name.trim(), row.value]),
  );

/** Marcadores `{{ns.campo}}` de un texto: pares namespace / primer campo. */
const markersIn = (text: string): Array<{ namespace: string; field: string; token: string }> =>
  [...text.matchAll(HTTP_MARKER_PATTERN)].map((match) => ({
    token: match[0],
    namespace: match[1] ?? '',
    field: match[2] ?? '',
  }));

/** Configuracion inicial; se reutiliza en `resetConfig`. */
const buildInitialConfig = (): HttpGenericDestinationNodeConfig => ({
  targetUrl: null,
  method: DEFAULT_HTTP_GENERIC_METHOD,
  headers: [],
  queryParams: [],
  bodyType: DEFAULT_HTTP_GENERIC_BODY_TYPE,
  bodyTemplate: null,
  authType: DEFAULT_HTTP_GENERIC_AUTH_TYPE,
  credentialId: null,
  timeoutMs: DEFAULT_HTTP_GENERIC_TIMEOUT_MS,
  retryAttempts: DEFAULT_HTTP_GENERIC_RETRY_ATTEMPTS,
});

// Estado reactivo del nodo DESTINO_HTTP_GENERICO (regla frontend-quasar.md §3.1).
//
// SIN servicio propio, como DESTINO_DRUPAL: ningun endpoint valida los `params`
// de un nodo suelto, y la validacion de verdad la hace `paramsSchema` al guardar
// el esquema. Lo UNICO que este nodo pide al backend son las opciones del
// selector de credencial, y las pide el store de dominio de la boveda
// (`useCredentialsStore` -> `credentials.service.ts`), compartido por todos los
// nodos que las necesiten.
const httpGenericDestinationSetup = () => {
  const credentialsStore = useCredentialsStore();

  const config = ref<HttpGenericDestinationNodeConfig>(buildInitialConfig());

  /** Namespaces que publican los pasos ANTERIORES, con sus campos. */
  const availableUpstreamContext = ref<UpstreamNamespace[]>([]);

  /** El metodo no admite cuerpo: el selector de `bodyType` queda fijo en NONE. */
  const isBodyless = computed(() => BODYLESS_METHODS.has(config.value.method));

  /** Lleva credencial. */
  const requiresCredential = computed(() => config.value.authType !== HttpGenericAuthType.NONE);

  /**
   * Opciones CERRADAS del selector de credencial, filtradas por tipo.
   *
   * Filtrar aqui hace imposible elegir una credencial que el backend
   * rechazaria con ERR_HTTP_GENERIC_CREDENTIAL.
   */
  const credentialOptions = computed<readonly CredentialOption[]>(() => {
    const expected = CREDENTIAL_TYPE_BY_AUTH[config.value.authType];

    return expected === null
      ? []
      : credentialsStore.options.filter((option) => option.authType === expected);
  });

  /** La credencial guardada ya no existe o no es del tipo elegido. */
  const isCredentialStale = computed(
    () =>
      requiresCredential.value &&
      config.value.credentialId !== null &&
      credentialsStore.options.length > 0 &&
      !credentialOptions.value.some((option) => option.id === config.value.credentialId),
  );

  /** Textos que admiten marcadores, para auditarlos juntos. */
  const interpolableTexts = computed<readonly string[]>(() => [
    config.value.targetUrl ?? '',
    ...config.value.headers.map((row) => row.value),
    ...config.value.queryParams.map((row) => row.value),
    isBodyless.value ? '' : (config.value.bodyTemplate ?? ''),
  ]);

  /**
   * Marcadores que no resuelve ningun paso anterior.
   *
   * Solo se juzga con el contexto YA cargado: llega vacio hasta que responde
   * `GET /api/nodos`, y bloquear sobre un contexto que aun no existe dejaria el
   * paso en rojo en cada apertura del asistente. Un namespace sin `fields`
   * declarados no permite juzgar el campo, y se da por bueno.
   */
  const unknownMarkers = computed<readonly string[]>(() => {
    if (availableUpstreamContext.value.length === 0) return [];

    const unknown = new Set<string>();

    for (const text of interpolableTexts.value) {
      for (const { namespace, field, token } of markersIn(text)) {
        const upstream = availableUpstreamContext.value.find(
          (entry) => entry.namespace === namespace,
        );
        const fieldKnown =
          upstream !== undefined &&
          (upstream.fields.length === 0 || upstream.fields.some((entry) => entry.name === field));

        if (!fieldKnown) unknown.add(token.replace(/\s+/g, ''));
      }
    }

    return [...unknown];
  });

  /** Lo que falta para EJECUTAR: calco de `getIncompleteParams` del backend. */
  const missingRequiredParams = computed<readonly string[]>(() => {
    const missing: string[] = [];

    if (asNullableText(config.value.targetUrl) === null) missing.push('targetUrl');
    if (requiresCredential.value && config.value.credentialId === null) {
      missing.push('authConfig.credentialId');
    }

    return missing;
  });

  /** Problemas de una lista de filas (cabeceras o parametros). */
  const describeRowsProblem = (
    rows: readonly KeyValueRow[],
    label: string,
    isHeaders: boolean,
  ): string | null => {
    if (rows.length > MAX_KEY_VALUE_ENTRIES) {
      return `${label}: maximo ${MAX_KEY_VALUE_ENTRIES} entradas.`;
    }

    const names = new Set<string>();

    for (const row of rows) {
      const name = row.name.trim();

      if (!KEY_VALUE_NAME_PATTERN.test(name)) {
        return `${label}: "${name}" no es un nombre valido (letras, digitos, ".", "-" y "_").`;
      }

      if (isHeaders && FORBIDDEN_HEADER_NAMES.has(name.toLowerCase())) {
        return `${label}: "${name}" no se puede fijar a mano; la autenticacion va por credencial.`;
      }

      if (names.has(name.toLowerCase())) {
        return `${label}: "${name}" esta repetido.`;
      }

      if (row.value.length > MAX_KEY_VALUE_VALUE_LENGTH || /[\r\n]/.test(row.value)) {
        return `${label}: el valor de "${name}" supera ${MAX_KEY_VALUE_VALUE_LENGTH} caracteres o tiene saltos de linea.`;
      }

      names.add(name.toLowerCase());
    }

    return null;
  };

  /**
   * URLs que publican los pasos anteriores, para el selector cerrado.
   *
   * Sin la opcion "primer enlace elegible" del extractor web: ese criterio lo
   * resuelve aquel nodo, y aqui `{{ns.campo}}` sobre un arreglo interpolaria la
   * lista entera. Se ofrecen solo POSICIONES concretas.
   */
  const urlOptions = computed<readonly TargetUrlOption[]>(() =>
    buildUrlOptions(availableUpstreamContext.value, { includeFirstEligible: false }),
  );

  /**
   * Motivo por el que la URL apunta a la red interna, o `null`.
   *
   * Escudo SSRF en tiempo real: solo IP literales y `localhost`. El backend la
   * vuelve a juzgar al guardar (resolviendo el DNS) y al conectar.
   */
  const privateTargetReason = computed<string | null>(() =>
    detectPrivateTarget(asNullableText(config.value.targetUrl)),
  );

  /** Lo que el DTO rechazaria por formato, mas los marcadores sin origen. */
  const malformedParams = computed<readonly string[]>(() => {
    const problems: string[] = [];
    const { value: current } = config;
    const url = asNullableText(current.targetUrl);

    if (url !== null && (url.length > MAX_TARGET_URL_LENGTH || !TARGET_URL_PATTERN.test(url))) {
      problems.push(
        'La URL de destino debe ser absoluta (http:// o https://) o empezar por una variable, y sin espacios.',
      );
    }

    if (privateTargetReason.value !== null) {
      problems.push(privateTargetReason.value);
    }

    const headersProblem = describeRowsProblem(current.headers, 'Cabeceras', true);
    if (headersProblem !== null) problems.push(headersProblem);

    const queryProblem = describeRowsProblem(current.queryParams, 'Parametros', false);
    if (queryProblem !== null) problems.push(queryProblem);

    if (isBodyless.value && current.bodyType !== HttpGenericBodyType.NONE) {
      problems.push(
        `Un ${current.method} no lleva cuerpo: el tipo de cuerpo debe ser "Sin cuerpo".`,
      );
    }

    const template = current.bodyTemplate ?? '';
    const parsesAsJson =
      current.bodyType === HttpGenericBodyType.JSON ||
      current.bodyType === HttpGenericBodyType.FORM_DATA;

    if (template.length > MAX_BODY_TEMPLATE_LENGTH) {
      problems.push(`El cuerpo no puede superar ${MAX_BODY_TEMPLATE_LENGTH} caracteres.`);
    } else if (parsesAsJson && template.trim() !== '') {
      try {
        const parsed: unknown = JSON.parse(template);
        const isFlatStrings =
          typeof parsed === 'object' &&
          parsed !== null &&
          !Array.isArray(parsed) &&
          Object.values(parsed).every((field) => typeof field === 'string');

        if (current.bodyType === HttpGenericBodyType.FORM_DATA && !isFlatStrings) {
          problems.push(
            'El cuerpo de formulario debe ser un objeto plano de cadenas: {"campo": "valor"}.',
          );
        }
      } catch {
        problems.push(
          'El cuerpo no es JSON valido. Los marcadores {{ns.campo}} van dentro de cadenas.',
        );
      }
    }

    if (unknownMarkers.value.length > 0) {
      problems.push(
        `Ningun paso anterior publica: ${unknownMarkers.value.join(', ')}. Usa el explorador de variables.`,
      );
    }

    return problems;
  });

  const isConfigValid = computed<boolean>(
    () => missingRequiredParams.value.length === 0 && malformedParams.value.length === 0,
  );

  /** Avisos no bloqueantes del paso (contrato de `NodeConfigStore`). */
  const configWarnings = computed<readonly string[]>(() => {
    const warnings: string[] = [];

    if (isCredentialStale.value) {
      warnings.push(
        'La credencial elegida ya no existe en la boveda o no es del tipo de autenticacion seleccionado. Elige otra.',
      );
    }

    if (
      requiresCredential.value &&
      credentialsStore.options.length > 0 &&
      credentialOptions.value.length === 0
    ) {
      warnings.push(
        'No hay ninguna credencial de este tipo en la boveda. Un administrador debe darla de alta en «Credenciales».',
      );
    }

    if (
      config.value.retryAttempts > 0 &&
      (config.value.method === HttpGenericMethod.POST ||
        config.value.method === HttpGenericMethod.PATCH)
    ) {
      warnings.push(
        `Un ${config.value.method} reintentado puede crear el recurso dos veces si el destino no es idempotente.`,
      );
    }

    return warnings;
  });

  /** Aplica un parche parcial conservando la inmutabilidad de `config`. */
  const updateConfig = (patch: Partial<HttpGenericDestinationNodeConfig>): void => {
    const next = { ...config.value, ...patch };

    // Poka-Yoke: un GET/DELETE fija el cuerpo en NONE en vez de dejar que el
    // operador descubra el 400 al guardar.
    if (BODYLESS_METHODS.has(next.method)) next.bodyType = HttpGenericBodyType.NONE;

    // Cambiar a otro tipo de autenticacion invalida la credencial elegida,
    // salvo que el mismo parche traiga ya la nueva.
    if (
      patch.authType !== undefined &&
      patch.authType !== config.value.authType &&
      patch.credentialId === undefined
    ) {
      next.credentialId = null;
    }

    config.value = next;
  };

  /** Carga las opciones de credencial (una sola vez por sesion). */
  const loadCredentialOptions = async (): Promise<void> => {
    await credentialsStore.ensureOptions();
  };

  /** Se COPIA el arreglo: el anfitrion reconstruye el suyo en cada sincronizacion. */
  const setAvailableUpstreamContext = (context: UpstreamNamespace[]): void => {
    availableUpstreamContext.value = [...context];
  };

  /**
   * `params` del nodo para el `pipeline_schema`.
   *
   * Se omite lo que coincide con el defecto del backend, salvo `method`,
   * `bodyType` y `authType`, que viajan SIEMPRE: son los discriminadores de
   * los que depende la lectura del resto, igual que `operationMode` en Drupal.
   */
  const toNodeParams = (): Record<string, unknown> => {
    const { value: current } = config;
    const params: Record<string, unknown> = {
      method: current.method,
      bodyType: current.bodyType,
      authType: current.authType,
    };

    const url = asNullableText(current.targetUrl);
    if (url !== null) params.targetUrl = url;

    const headers = toRecord(current.headers);
    if (Object.keys(headers).length > 0) params.headers = headers;

    const queryParams = toRecord(current.queryParams);
    if (Object.keys(queryParams).length > 0) params.queryParams = queryParams;

    if (
      current.bodyType !== HttpGenericBodyType.NONE &&
      (current.bodyTemplate ?? '').trim() !== ''
    ) {
      params.bodyTemplate = current.bodyTemplate;
    }

    if (current.authType !== HttpGenericAuthType.NONE && current.credentialId !== null) {
      params.authConfig = { credentialId: current.credentialId };
    }

    if (current.timeoutMs !== DEFAULT_HTTP_GENERIC_TIMEOUT_MS) params.timeoutMs = current.timeoutMs;
    if (current.retryAttempts !== DEFAULT_HTTP_GENERIC_RETRY_ATTEMPTS) {
      params.retryAttempts = current.retryAttempts;
    }

    return params;
  };

  /** Carga un nodo ya guardado; lectura defensiva (la columna es `jsonb`). */
  const hydrateFromNode = (node: HydratableNode): void => {
    const { params } = node;
    const authConfig =
      typeof params.authConfig === 'object' && params.authConfig !== null
        ? (params.authConfig as Record<string, unknown>)
        : {};

    config.value = {
      targetUrl: asNullableText(params.targetUrl),
      method: asEnum(params.method, Object.values(HttpGenericMethod), DEFAULT_HTTP_GENERIC_METHOD),
      headers: asRows(params.headers),
      queryParams: asRows(params.queryParams),
      bodyType: asEnum(
        params.bodyType,
        Object.values(HttpGenericBodyType),
        DEFAULT_HTTP_GENERIC_BODY_TYPE,
      ),
      bodyTemplate:
        typeof params.bodyTemplate === 'string' && params.bodyTemplate.trim() !== ''
          ? params.bodyTemplate
          : null,
      authType: asEnum(
        params.authType,
        Object.values(HttpGenericAuthType),
        DEFAULT_HTTP_GENERIC_AUTH_TYPE,
      ),
      credentialId: asNullableText(authConfig.credentialId),
      timeoutMs: asInteger(
        params.timeoutMs,
        DEFAULT_HTTP_GENERIC_TIMEOUT_MS,
        MIN_HTTP_GENERIC_TIMEOUT_MS,
        MAX_HTTP_GENERIC_TIMEOUT_MS,
      ),
      retryAttempts: asInteger(
        params.retryAttempts,
        DEFAULT_HTTP_GENERIC_RETRY_ATTEMPTS,
        0,
        MAX_HTTP_GENERIC_RETRY_ATTEMPTS,
      ),
    };
  };

  const resetConfig = (): void => {
    config.value = buildInitialConfig();
    availableUpstreamContext.value = [];
  };

  return {
    config,
    availableUpstreamContext,
    isBodyless,
    requiresCredential,
    credentialOptions,
    isCredentialStale,
    unknownMarkers,
    urlOptions,
    privateTargetReason,
    missingRequiredParams,
    malformedParams,
    isConfigValid,
    configWarnings,
    updateConfig,
    loadCredentialOptions,
    setAvailableUpstreamContext,
    toNodeParams,
    hydrateFromNode,
    resetConfig,
  };
};

/** Definicion de Pinia para UN nodo concreto (un flujo puede tener dos destinos). */
const buildHttpGenericDestinationStore = (nodeId: string) =>
  defineStore(`${STORE_ID_PREFIX}:${nodeId}`, httpGenericDestinationSetup);

/** Instancia del store, para tipar helpers y consumidores sin `any`. */
export type HttpGenericDestinationStore = ReturnType<
  ReturnType<typeof buildHttpGenericDestinationStore>
>;

/** Definiciones ya creadas, indexadas por `nodeId`. */
const definitions = new Map<string, ReturnType<typeof buildHttpGenericDestinationStore>>();

/** Store del nodo DESTINO_HTTP_GENERICO identificado por `nodeId`. */
export const useHttpGenericDestinationStore = (nodeId: string): HttpGenericDestinationStore => {
  const cached = definitions.get(nodeId);

  if (cached !== undefined) return cached();

  const definition = buildHttpGenericDestinationStore(nodeId);
  definitions.set(nodeId, definition);

  if (import.meta.hot) {
    import.meta.hot.accept(acceptHMRUpdate(definition, import.meta.hot));
  }

  return definition();
};
