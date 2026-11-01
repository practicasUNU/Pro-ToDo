import { defineStore, acceptHMRUpdate } from 'pinia';
import { computed, ref } from 'vue';

import {
  ACENS_ENDPOINT_PATH_PATTERN,
  AcensHttpMethod,
  BODYLESS_ACENS_METHODS,
  DEFAULT_ACENS_METHOD,
  DEFAULT_ACENS_TIMEOUT_MS,
  MAX_ACENS_ENDPOINT_PATH_LENGTH,
  MAX_ACENS_PAYLOAD_TEMPLATE_LENGTH,
  MAX_ACENS_TIMEOUT_MS,
  MIN_ACENS_TIMEOUT_MS,
} from '@/types/nodes/acens-http.types';
import {
  FORBIDDEN_HEADER_NAMES,
  HTTP_MARKER_PATTERN,
  KEY_VALUE_NAME_PATTERN,
  MAX_KEY_VALUE_ENTRIES,
  MAX_KEY_VALUE_VALUE_LENGTH,
} from '@/types/nodes/http-generic-destination.types';

import type { HydratableNode, UpstreamNamespace } from '@stores/nodes/node-store-registry';

import type { AcensHttpNodeConfig } from '@/types/nodes/acens-http.types';
import type { KeyValueRow } from '@/types/nodes/http-generic-destination.types';

/** Prefijo del id de Pinia; el sufijo es el `nodeId` del `pipeline_schema`. */
const STORE_ID_PREFIX = 'acensHttpNode';

const asNullableText = (value: unknown): string | null => {
  const text = typeof value === 'string' ? value.trim() : '';

  return text === '' ? null : text;
};

const asInteger = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;

const asMethod = (value: unknown): AcensHttpMethod =>
  typeof value === 'string' && (Object.values(AcensHttpMethod) as string[]).includes(value)
    ? (value as AcensHttpMethod)
    : DEFAULT_ACENS_METHOD;

const asRows = (value: unknown): KeyValueRow[] =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.entries(value as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        .map(([name, rowValue]) => ({ name, value: rowValue }))
    : [];

const toRecord = (rows: readonly KeyValueRow[]): Record<string, string> =>
  Object.fromEntries(
    rows.filter((row) => row.name.trim() !== '').map((row) => [row.name.trim(), row.value]),
  );

const buildInitialConfig = (): AcensHttpNodeConfig => ({
  method: DEFAULT_ACENS_METHOD,
  endpointPath: null,
  headers: [],
  payloadTemplate: null,
  timeoutMs: DEFAULT_ACENS_TIMEOUT_MS,
});

// Estado reactivo del nodo DESTINO_ACENS (regla frontend-quasar.md §3.1).
//
// SIN servicio: el nodo no pide nada al backend. La URL base y la clave son del
// servidor (`AcensApiConfig`) y nunca llegan al navegador; aqui solo se edita la
// ruta relativa, el verbo, las cabeceras extra, el cuerpo y la espera.
const acensHttpSetup = () => {
  const config = ref<AcensHttpNodeConfig>(buildInitialConfig());

  /** Namespaces que publican los pasos ANTERIORES, con sus campos. */
  const availableUpstreamContext = ref<UpstreamNamespace[]>([]);

  const isBodyless = computed(() => BODYLESS_ACENS_METHODS.has(config.value.method));

  /** Marcadores que no resuelve ningun paso anterior (solo con contexto cargado). */
  const unknownMarkers = computed<readonly string[]>(() => {
    if (availableUpstreamContext.value.length === 0) return [];

    const texts = [
      config.value.endpointPath ?? '',
      ...config.value.headers.map((row) => row.value),
      isBodyless.value ? '' : (config.value.payloadTemplate ?? ''),
    ];
    const unknown = new Set<string>();

    for (const text of texts) {
      for (const match of text.matchAll(HTTP_MARKER_PATTERN)) {
        const upstream = availableUpstreamContext.value.find(
          (entry) => entry.namespace === match[1],
        );
        const fieldKnown =
          upstream !== undefined &&
          (upstream.fields.length === 0 ||
            upstream.fields.some((entry) => entry.name === match[2]));

        if (!fieldKnown) unknown.add(match[0].replace(/\s+/g, ''));
      }
    }

    return [...unknown];
  });

  /** Lo que falta para EJECUTAR: calco de `getIncompleteParams` del backend. */
  const missingRequiredParams = computed<readonly string[]>(() =>
    asNullableText(config.value.endpointPath) === null ? ['endpointPath'] : [],
  );

  const describeHeadersProblem = (rows: readonly KeyValueRow[]): string | null => {
    if (rows.length > MAX_KEY_VALUE_ENTRIES) {
      return `Cabeceras: maximo ${MAX_KEY_VALUE_ENTRIES} entradas.`;
    }

    const names = new Set<string>();

    for (const row of rows) {
      const name = row.name.trim();

      if (!KEY_VALUE_NAME_PATTERN.test(name)) {
        return `Cabeceras: "${name}" no es un nombre valido (letras, digitos, ".", "-" y "_").`;
      }

      if (FORBIDDEN_HEADER_NAMES.has(name.toLowerCase())) {
        return `Cabeceras: "${name}" no se puede fijar a mano; la clave de Acens la pone el servidor.`;
      }

      if (names.has(name.toLowerCase())) return `Cabeceras: "${name}" esta repetido.`;

      if (row.value.length > MAX_KEY_VALUE_VALUE_LENGTH || /[\r\n]/.test(row.value)) {
        return `Cabeceras: el valor de "${name}" supera ${MAX_KEY_VALUE_VALUE_LENGTH} caracteres o tiene saltos de linea.`;
      }

      names.add(name.toLowerCase());
    }

    return null;
  };

  /** Lo que el DTO rechazaria por formato, mas los marcadores sin origen. */
  const malformedParams = computed<readonly string[]>(() => {
    const problems: string[] = [];
    const { value: current } = config;
    const path = asNullableText(current.endpointPath);

    if (
      path !== null &&
      (path.length > MAX_ACENS_ENDPOINT_PATH_LENGTH || !ACENS_ENDPOINT_PATH_PATTERN.test(path))
    ) {
      problems.push(
        'La ruta debe ser relativa y empezar por "/" (sin https://, sin "//", sin ".." ni espacios): la URL base la fija el servidor.',
      );
    }

    const headersProblem = describeHeadersProblem(current.headers);
    if (headersProblem !== null) problems.push(headersProblem);

    const template = current.payloadTemplate ?? '';

    if (template.trim() !== '') {
      if (isBodyless.value) {
        problems.push(`Un ${current.method} no lleva cuerpo: deja el payload vacio.`);
      } else if (template.length > MAX_ACENS_PAYLOAD_TEMPLATE_LENGTH) {
        problems.push(
          `El payload no puede superar ${MAX_ACENS_PAYLOAD_TEMPLATE_LENGTH} caracteres.`,
        );
      } else {
        try {
          JSON.parse(template);
        } catch {
          problems.push(
            'El payload no es JSON valido. Los marcadores {{ns.campo}} van dentro de cadenas.',
          );
        }
      }
    }

    if (unknownMarkers.value.length > 0) {
      problems.push(
        `Ningun paso anterior publica: ${unknownMarkers.value.join(', ')}. Usa el boton de variables.`,
      );
    }

    return problems;
  });

  const isConfigValid = computed<boolean>(
    () => missingRequiredParams.value.length === 0 && malformedParams.value.length === 0,
  );

  /** Avisos no bloqueantes del paso (contrato de `NodeConfigStore`). */
  const configWarnings = computed<readonly string[]>(() =>
    config.value.method === AcensHttpMethod.POST
      ? [
          'Un POST a Acens no se reintenta automaticamente: un envio masivo repetido podria salir dos veces.',
        ]
      : [],
  );

  /** Aplica un parche parcial conservando la inmutabilidad de `config`. */
  const updateConfig = (patch: Partial<AcensHttpNodeConfig>): void => {
    config.value = { ...config.value, ...patch };
  };

  const setAvailableUpstreamContext = (context: UpstreamNamespace[]): void => {
    availableUpstreamContext.value = [...context];
  };

  /** `params` del nodo; `method` viaja siempre, el resto solo si difiere del defecto. */
  const toNodeParams = (): Record<string, unknown> => {
    const { value: current } = config;
    const params: Record<string, unknown> = { method: current.method };

    const path = asNullableText(current.endpointPath);
    if (path !== null) params.endpointPath = path;

    const headers = toRecord(current.headers);
    if (Object.keys(headers).length > 0) params.headers = headers;

    if (!isBodyless.value && (current.payloadTemplate ?? '').trim() !== '') {
      params.payloadTemplate = current.payloadTemplate;
    }

    if (current.timeoutMs !== DEFAULT_ACENS_TIMEOUT_MS) params.timeoutMs = current.timeoutMs;

    return params;
  };

  /** Carga un nodo ya guardado; lectura defensiva (la columna es `jsonb`). */
  const hydrateFromNode = (node: HydratableNode): void => {
    const { params } = node;

    config.value = {
      method: asMethod(params.method),
      endpointPath: asNullableText(params.endpointPath),
      headers: asRows(params.headers),
      payloadTemplate:
        typeof params.payloadTemplate === 'string' && params.payloadTemplate.trim() !== ''
          ? params.payloadTemplate
          : null,
      timeoutMs: asInteger(
        params.timeoutMs,
        DEFAULT_ACENS_TIMEOUT_MS,
        MIN_ACENS_TIMEOUT_MS,
        MAX_ACENS_TIMEOUT_MS,
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
    unknownMarkers,
    missingRequiredParams,
    malformedParams,
    isConfigValid,
    configWarnings,
    updateConfig,
    setAvailableUpstreamContext,
    toNodeParams,
    hydrateFromNode,
    resetConfig,
  };
};

const buildAcensHttpStore = (nodeId: string) =>
  defineStore(`${STORE_ID_PREFIX}:${nodeId}`, acensHttpSetup);

/** Instancia del store, para tipar helpers y consumidores sin `any`. */
export type AcensHttpStore = ReturnType<ReturnType<typeof buildAcensHttpStore>>;

/** Definiciones ya creadas, indexadas por `nodeId`. */
const definitions = new Map<string, ReturnType<typeof buildAcensHttpStore>>();

/** Store del nodo DESTINO_ACENS identificado por `nodeId`. */
export const useAcensHttpStore = (nodeId: string): AcensHttpStore => {
  const cached = definitions.get(nodeId);

  if (cached !== undefined) return cached();

  const definition = buildAcensHttpStore(nodeId);
  definitions.set(nodeId, definition);

  if (import.meta.hot) {
    import.meta.hot.accept(acceptHMRUpdate(definition, import.meta.hot));
  }

  return definition();
};
