import { defineStore, acceptHMRUpdate } from 'pinia';
import { computed, ref } from 'vue';

import * as webScraperService from '@services/nodes/web-scraper.service';

import type { HydratableNode } from '@stores/nodes/node-store-registry';

import type {
  CheckScraperMetrics,
  CheckScraperPayload,
  ScrapedWebPayload,
  WebScraperConfigDto,
} from '@/types/web-scraper';

/** Prefijo del id de Pinia. El id real lleva el `nodeId` detras. */
const STORE_ID_PREFIX = 'node-web-scraper';

// --- Defectos y rangos, replicados de `web-scraper-config.dto.ts` -------------
//
// Se copian en vez de importarse porque no hay paquete compartido entre los dos
// lados. Sin esta copia el operador veria un 400 de servidor donde deberia haber
// visto una regla de campo, que es el mismo motivo por el que
// `trigger-imap.store.ts` replica su `@Min(30000)`.

export const DEFAULT_SCRAPER_TIMEOUT_MS = 20_000;
export const MIN_SCRAPER_TIMEOUT_MS = 5_000;
export const MAX_SCRAPER_TIMEOUT_MS = 60_000;

export const DEFAULT_SCRAPER_MAX_RETRIES = 2;
export const MAX_SCRAPER_RETRIES = 3;

export const DEFAULT_SCRAPER_RETRY_DELAY_MS = 2_000;
export const MIN_SCRAPER_RETRY_DELAY_MS = 500;
export const MAX_SCRAPER_RETRY_DELAY_MS = 10_000;

/** Namespace del que salen las URLs: el que publica PARSER_PRE_IA. */
export const URL_SOURCE_NAMESPACE = 'parsed_email';

/** Campo del payload del parser que contiene los enlaces de contenido. */
export const URL_SOURCE_FIELD = 'extracted_urls';

/**
 * Cuantas posiciones de `extracted_urls` ofrece el selector.
 *
 * DIEZ, y no las cincuenta que el backend admite como tope: el selector no es un
 * inventario del correo, es una eleccion de POSICION, y una lista de cincuenta
 * entradas identicas salvo el indice no ayuda a elegir ninguna. Una nota de
 * prensa trae uno o dos enlaces de contenido; mas alla del decimo la posicion
 * deja de ser una referencia estable entre un correo y el siguiente.
 */
export const SELECTABLE_URL_SLOTS = 10;

/** Textos de las reglas de campo. Se exportan para que las pruebas los aseveren. */
export const TIMEOUT_RULE = `La espera debe estar entre ${MIN_SCRAPER_TIMEOUT_MS} y ${MAX_SCRAPER_TIMEOUT_MS} ms`;
export const MAX_RETRIES_RULE = `Los reintentos deben estar entre 0 y ${MAX_SCRAPER_RETRIES}`;
export const RETRY_DELAY_RULE = `La espera entre reintentos debe estar entre ${MIN_SCRAPER_RETRY_DELAY_MS} y ${MAX_SCRAPER_RETRY_DELAY_MS} ms`;

/** Opcion del selector determinista de URL. */
export interface TargetUrlOption {
  readonly label: string;
  readonly value: string;
}

/** Plantilla de interpolacion de la posicion `index` del arreglo de enlaces. */
export const urlTemplateFor = (index: number): string =>
  `{{${URL_SOURCE_NAMESPACE}.${URL_SOURCE_FIELD}[${index}]}}`;

/**
 * Opciones del selector: POSICIONES, no URLs.
 *
 * Aqui esta la decision central del nodo. En tiempo de diseno el flujo no se ha
 * ejecutado, no hay `StatePayloadContext` y por tanto NO existe ningun
 * `extracted_urls` real que ofrecer. El unico canal que el anfitrion expone,
 * `setAvailableUpstreamNamespaces`, entrega NOMBRES de namespace y no su
 * contenido.
 *
 * Y esta bien que asi sea: lo que el nodo debe guardar nunca es una URL, es una
 * POSICION. El flujo se ejecutara sobre correos distintos cada dia, asi que
 * anclar la configuracion a la URL concreta de un correo de ejemplo produciria
 * un `targetUrl` literal que en produccion apunta a una noticia caducada.
 */
const buildUrlOptions = (): readonly TargetUrlOption[] =>
  Array.from({ length: SELECTABLE_URL_SLOTS }, (_, index) => ({
    label: `Enlace ${index + 1} del correo`,
    value: urlTemplateFor(index),
  }));

/** Config inicial: el primer enlace del correo y los tres defectos del backend. */
const buildInitialConfig = (): WebScraperConfigDto => ({
  targetUrl: urlTemplateFor(0),
  timeoutMs: DEFAULT_SCRAPER_TIMEOUT_MS,
  maxRetries: DEFAULT_SCRAPER_MAX_RETRIES,
  retryDelayMs: DEFAULT_SCRAPER_RETRY_DELAY_MS,
});

/** Coercion defensiva de una clave textual del `jsonb`. */
const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Coercion defensiva de una clave numerica del `jsonb`. */
const asNumber = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/** Entero dentro de un rango cerrado. */
const isIntegerInRange = (value: number, min: number, max: number): boolean =>
  Number.isInteger(value) && value >= min && value <= max;

const webScraperSetup = () => {
  const config = ref<WebScraperConfigDto>(buildInitialConfig());

  /**
   * Namespaces que declaran los nodos anteriores del flujo.
   *
   * Arranca con el del parser como defecto PROVISIONAL, mismo criterio que
   * `template-mapper.store.ts`: un anfitrion que no llame al setter no debe
   * dejar el nodo bloqueado sin explicacion.
   */
  const availableUpstreamNamespaces = ref<string[]>([URL_SOURCE_NAMESPACE]);

  /** URL REAL del banco de pruebas. NO forma parte de los `params` del nodo. */
  const sandboxUrl = ref<string>('');

  const sandboxResult = ref<ScrapedWebPayload | null>(null);
  const sandboxMetrics = ref<CheckScraperMetrics | null>(null);
  const sandboxWarnings = ref<string[]>([]);
  const loading = ref<boolean>(false);

  const urlOptions = computed<readonly TargetUrlOption[]>(buildUrlOptions);

  /**
   * El flujo produce el namespace del que el selector lee las URLs.
   *
   * Es la condicion que hace resoluble cualquiera de las opciones ofrecidas: sin
   * un PARSER_PRE_IA aguas arriba, `{{parsed_email.extracted_urls[0]}}` no
   * existe en el contexto y el nodo fallaria con ERR_SCRAPER_URL_UNRESOLVED en
   * la primera ejecucion. Mismo criterio que `missingRequiredVariables` del
   * mapeador: detectarlo al configurar es la diferencia entre corregirlo ahora o
   * descubrirlo en produccion con el flujo PAUSADO.
   */
  const hasUrlSource = computed<boolean>(() =>
    availableUpstreamNamespaces.value.includes(URL_SOURCE_NAMESPACE),
  );

  /**
   * Contrato Poka-Yoke que el stepper consulta para habilitar "Siguiente".
   *
   * Los tres rangos numericos replican los `@Min`/`@Max` del DTO del backend,
   * que queda intacto; esta copia solo adelanta el rechazo al formulario.
   *
   * `targetUrl` se valida contra la lista CERRADA de opciones y no con una
   * expresion regular: el selector no admite texto libre (regla
   * frontend-quasar.md §4), asi que el conjunto de valores legitimos es
   * exactamente el que este store ofrece. Comprobarlo contra un patron dejaria
   * pasar una plantilla bien formada hacia un namespace que este nodo nunca
   * propone, y con ella un flujo que solo fallaria al ejecutarse.
   *
   * NO exige haber probado la extraccion, a diferencia del disparador IMAP.
   * Alli la comprobacion protege de unas credenciales que no fallarian hasta el
   * primer sondeo; aqui la URL de produccion ni siquiera existe todavia —es una
   * posicion dentro de un contexto futuro—, asi que no hay nada que un banco de
   * pruebas pueda verificar sobre ella. Ese aviso vive en `configWarnings`.
   */
  const isConfigValid = computed<boolean>(
    () =>
      urlOptions.value.some((option) => option.value === config.value.targetUrl) &&
      hasUrlSource.value &&
      isIntegerInRange(config.value.timeoutMs, MIN_SCRAPER_TIMEOUT_MS, MAX_SCRAPER_TIMEOUT_MS) &&
      isIntegerInRange(config.value.maxRetries, 0, MAX_SCRAPER_RETRIES) &&
      isIntegerInRange(
        config.value.retryDelayMs,
        MIN_SCRAPER_RETRY_DELAY_MS,
        MAX_SCRAPER_RETRY_DELAY_MS,
      ),
  );

  /**
   * Avisos que el operador deberia leer antes de guardar. NUNCA bloquean.
   *
   * Es la contrapartida honesta de `isConfigValid`: aquel responde "se puede
   * guardar", este responde "se puede, pero conviene que sepas esto".
   */
  const configWarnings = computed<readonly string[]>(() => {
    const warnings: string[] = [];

    if (sandboxResult.value === null) {
      warnings.push(
        'No se ha probado la extraccion sobre ninguna URL real. El nodo solo se sabe funcional contra el portal concreto del que lleguen los enlaces.',
      );
    }

    // Este aviso es literalmente el que el TSDoc del DTO del backend pide que
    // alguien de, y que hoy no da nadie mas: las dos capas de reintento se
    // MULTIPLICAN, y el operador no tiene por que deducirlo.
    if (config.value.maxRetries > 0) {
      warnings.push(
        `Este nodo lleva su propio reintento rapido (${config.value.maxRetries}). Si el flujo declara ademas un "retryPolicy", las dos capas se multiplican: conviene dejar el del esquema en 0.`,
      );
    }

    const worstCaseMs =
      config.value.timeoutMs * (config.value.maxRetries + 1) +
      config.value.retryDelayMs * config.value.maxRetries;

    if (worstCaseMs > MAX_SCRAPER_TIMEOUT_MS) {
      warnings.push(
        `En el peor caso este nodo retendria el flujo unos ${Math.round(worstCaseMs / 1000)} segundos antes de darse por vencido.`,
      );
    }

    return warnings;
  });

  /** Se puede probar cuando hay una URL real escrita y no hay otra prueba en vuelo. */
  const canRunSandbox = computed<boolean>(
    () => sandboxUrl.value.trim().length > 0 && !loading.value,
  );

  /**
   * Cuerpo de la peticion del banco de pruebas.
   *
   * Envia `sandboxUrl` y NO `config.targetUrl`, y este es el unico punto donde
   * el banco y la configuracion se separan. `config.targetUrl` es una plantilla
   * contra un contexto que en tiempo de diseno no existe, y el DTO del backend
   * la rechaza con un 400 por su `@IsUrl`: mandarla haria el endpoint
   * inutilizable.
   */
  const sandboxPayload = computed<CheckScraperPayload>(() => ({
    targetUrl: sandboxUrl.value.trim(),
    timeoutMs: config.value.timeoutMs,
    maxRetries: config.value.maxRetries,
    retryDelayMs: config.value.retryDelayMs,
  }));

  /**
   * Caduca el resultado del banco.
   *
   * Un panel que sobrevive al cambio del parametro que lo produjo es peor que no
   * tener panel: afirma sobre una configuracion que ya no es la que hay.
   */
  const invalidateSandboxResult = (): void => {
    sandboxResult.value = null;
    sandboxMetrics.value = null;
    sandboxWarnings.value = [];
  };

  const updateConfig = (patch: Partial<WebScraperConfigDto>): void => {
    config.value = { ...config.value, ...patch };
    invalidateSandboxResult();
  };

  const setSandboxUrl = (url: string): void => {
    sandboxUrl.value = url;
    invalidateSandboxResult();
  };

  const setAvailableUpstreamNamespaces = (namespaces: string[]): void => {
    availableUpstreamNamespaces.value = [...namespaces];
  };

  /**
   * Lanza la extraccion de prueba contra la URL real del banco.
   *
   * NO captura: la excepcion se propaga al componente, que es quien decide el
   * mensaje al usuario (`frontend-architecture.md` §2.1). El `finally` solo
   * garantiza que el boton deje de girar.
   *
   * Un fallo DIAGNOSTICADO —portal caido, muro de pago, pagina sin articulo— no
   * es una excepcion: llega como `success: false` y se muestra como aviso, igual
   * que hace el parser con su `body_source: 'none'`.
   */
  const runSandboxTest = async (): Promise<void> => {
    loading.value = true;

    try {
      const result = await webScraperService.checkScraper(sandboxPayload.value);

      sandboxMetrics.value = result.metrics ?? null;
      sandboxWarnings.value = [...(result.warnings ?? [])];

      if (result.success && result.preview !== undefined) {
        sandboxResult.value = result.preview;

        return;
      }

      sandboxResult.value = null;

      if (result.error !== undefined) {
        sandboxWarnings.value = [
          `[${result.error.code}] ${result.error.message}`,
          ...sandboxWarnings.value,
        ];
      }
    } finally {
      loading.value = false;
    }
  };

  /**
   * `params` que este nodo aporta al `pipeline_schema`.
   *
   * Los tres numericos solo se publican si DIFIEREN del defecto, mismo criterio
   * que el parser: congelar el defecto de hoy dentro de cada esquema guardado
   * haria que cambiarlo manana no alcanzase a ningun flujo existente, y ademas
   * reescribiria en silencio un nodo que alguien redacto a mano sin esas claves.
   */
  const toNodeParams = (): Record<string, unknown> => {
    const params: Record<string, unknown> = {
      targetUrl: config.value.targetUrl,
    };

    if (config.value.timeoutMs !== DEFAULT_SCRAPER_TIMEOUT_MS) {
      params.timeoutMs = config.value.timeoutMs;
    }

    if (config.value.maxRetries !== DEFAULT_SCRAPER_MAX_RETRIES) {
      params.maxRetries = config.value.maxRetries;
    }

    if (config.value.retryDelayMs !== DEFAULT_SCRAPER_RETRY_DELAY_MS) {
      params.retryDelayMs = config.value.retryDelayMs;
    }

    return params;
  };

  /**
   * Carga los valores de un nodo YA GUARDADO. Inversa de `toNodeParams()`.
   *
   * Las coerciones no son paranoia: `pipeline_schema` es una columna `jsonb` y
   * pudo escribirse por SQL directo o por una version anterior del asistente.
   *
   * La URL del banco NO se toca: es material de prueba, no del nodo.
   */
  const hydrateFromNode = (node: HydratableNode): void => {
    const params = node.params;

    config.value = {
      targetUrl: asText(params.targetUrl) || urlTemplateFor(0),
      timeoutMs: asNumber(params.timeoutMs, DEFAULT_SCRAPER_TIMEOUT_MS),
      maxRetries: asNumber(params.maxRetries, DEFAULT_SCRAPER_MAX_RETRIES),
      retryDelayMs: asNumber(params.retryDelayMs, DEFAULT_SCRAPER_RETRY_DELAY_MS),
    };
    invalidateSandboxResult();
  };

  const resetConfig = (): void => {
    config.value = buildInitialConfig();
    sandboxUrl.value = '';
    invalidateSandboxResult();
  };

  return {
    config,
    sandboxUrl,
    sandboxResult,
    sandboxMetrics,
    sandboxWarnings,
    loading,
    urlOptions,
    hasUrlSource,
    isConfigValid,
    configWarnings,
    canRunSandbox,
    sandboxPayload,
    updateConfig,
    setSandboxUrl,
    setAvailableUpstreamNamespaces,
    runSandboxTest,
    toNodeParams,
    hydrateFromNode,
    resetConfig,
  };
};

const buildWebScraperStore = (nodeId: string) =>
  defineStore(`${STORE_ID_PREFIX}:${nodeId}`, webScraperSetup);

/** Instancia del store, para tipar helpers y consumidores sin `any`. */
export type WebScraperStore = ReturnType<ReturnType<typeof buildWebScraperStore>>;

/**
 * Definiciones ya creadas, indexadas por `nodeId`.
 *
 * Se memoiza la DEFINICION, no la instancia: de la instancia ya se encarga
 * Pinia, que cachea por id en la instancia activa.
 */
const definitions = new Map<string, ReturnType<typeof buildWebScraperStore>>();

/**
 * Store del nodo EXTRACTOR_WEB identificado por `nodeId`.
 *
 * Cada nodo del pipeline recibe su propia instancia, aislada de las demas: un
 * flujo puede extraer dos enlaces distintos del mismo correo con dos nodos, y
 * un id fijo haria que el segundo pisara la configuracion del primero.
 */
export const useWebScraperStore = (nodeId: string): WebScraperStore => {
  const cached = definitions.get(nodeId);

  if (cached !== undefined) return cached();

  const definition = buildWebScraperStore(nodeId);
  definitions.set(nodeId, definition);

  // Con ids dinamicos no hay una definicion unica que declarar al cargar el
  // modulo, asi que el HMR se arma sobre cada definicion nueva.
  if (import.meta.hot) {
    import.meta.hot.accept(acceptHMRUpdate(definition, import.meta.hot));
  }

  return definition();
};
