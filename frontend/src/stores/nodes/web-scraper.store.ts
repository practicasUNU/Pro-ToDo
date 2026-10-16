import { defineStore, acceptHMRUpdate } from 'pinia';
import { computed, ref } from 'vue';

import * as webScraperService from '@services/nodes/web-scraper.service';

import type { HydratableNode, UpstreamNamespace } from '@stores/nodes/node-store-registry';

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

/**
 * Replica de `DEFAULT_SCRAPER_SKIP_IF_EMPTY` del DTO del backend.
 *
 * Por defecto un extractor sin origen se SALTA en vez de romper el flujo: el
 * modo de fallo que cubre —el correo sin enlaces, la contingencia OCR que no
 * publica ninguna URL— es rutinario. El precio esta asumido: un operador que
 * olvide elegir el origen obtiene un nodo que no extrae nada, y por eso
 * `configWarnings` se lo dice sin bloquearle el paso.
 */
export const DEFAULT_SCRAPER_SKIP_IF_EMPTY = true;

/**
 * Replica de `DEFAULT_SCRAPER_IGNORE_EXTRACTION_FAILURE` del DTO del backend.
 *
 * Cubre el fallo AJENO —el portal que no responde o se niega a servir—, no la
 * ausencia de origen, que es de lo que se ocupa la bandera de arriba.
 */
export const DEFAULT_SCRAPER_IGNORE_EXTRACTION_FAILURE = true;
export const MIN_SCRAPER_RETRY_DELAY_MS = 500;
export const MAX_SCRAPER_RETRY_DELAY_MS = 10_000;

/**
 * Tope de dominios excluidos, replica de `MAX_EXCLUDED_DOMAINS` del DTO.
 */
export const MAX_EXCLUDED_DOMAINS = 20;

/**
 * Forma admitida de un dominio excluido: SOLO el host.
 *
 * Replica `EXCLUDED_DOMAIN_PATTERN` del backend, que es quien decide. Sin esta
 * copia, teclear `https://madrimasd.org/portal` en los chips se saldria con la
 * suya hasta el 400 del guardado, y el operador leeria un error de servidor
 * donde deberia haber leido una regla de campo.
 */
export const EXCLUDED_DOMAIN_PATTERN = /^(?!-)[a-z0-9-]+(?<!-)(?:\.(?!-)[a-z0-9-]+(?<!-))+$/i;

/**
 * Dominios que el desplegable OFRECE, nunca los que siembra.
 *
 * El portal institucional propio es el caso que motiva el filtro: su enlace
 * viaja en el correo como metadato de enrutado editorial para el destino, no
 * como la noticia que hay que raspar. Se ofrece como sugerencia y no como valor
 * por defecto porque el backend mantiene su DTO neutro —ningun dominio de
 * ningun cliente cableado— y porque sembrarlo cambiaria el comportamiento de
 * todo flujo que se reabra sin que nadie lo haya pedido.
 */
export const EXCLUDED_DOMAIN_SUGGESTIONS: readonly string[] = ['madrimasd.org'];

/**
 * Cuantas posiciones ofrece el selector por cada campo de tipo `url[]`.
 *
 * DIEZ, y no las cincuenta que el backend admite como tope: el selector no es un
 * inventario del correo, es una eleccion de POSICION, y una lista de cincuenta
 * entradas identicas salvo el indice no ayuda a elegir ninguna. Una nota de
 * prensa trae uno o dos enlaces de contenido; mas alla del decimo la posicion
 * deja de ser una referencia estable entre un correo y el siguiente.
 */
export const SELECTABLE_URL_SLOTS = 10;

/**
 * Forma que debe tener `targetUrl`: una unica marca `{{raiz.campo}}`.
 *
 * Replica `INTERPOLATION_ONLY_PATTERN` del backend, que es el que de verdad
 * decide (`@Matches` de `WebScraperConfigDto`). El anclaje no es cosmetico: sin
 * el bastaria con CONTENER una marca y `https://otro-portal.es/?x={{ns.campo}}`
 * pasaria el filtro, que es una URL literal disfrazada.
 *
 * NO sustituye a la comprobacion de pertenencia a `urlOptions`, la acompana.
 * El patron dice que la forma es resoluble; la lista dice que ESE namespace
 * existe de verdad aguas arriba. Un `targetUrl` heredado puede cumplir lo
 * primero y no lo segundo.
 */
export const INTERPOLATION_ONLY_PATTERN =
  /^\{\{\s*[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+|\[\d+\])+\s*\}\}$/;

/** Textos de las reglas de campo. Se exportan para que las pruebas los aseveren. */
export const TIMEOUT_RULE = `La espera debe estar entre ${MIN_SCRAPER_TIMEOUT_MS} y ${MAX_SCRAPER_TIMEOUT_MS} ms`;
export const MAX_RETRIES_RULE = `Los reintentos deben estar entre 0 y ${MAX_SCRAPER_RETRIES}`;
export const RETRY_DELAY_RULE = `La espera entre reintentos debe estar entre ${MIN_SCRAPER_RETRY_DELAY_MS} y ${MAX_SCRAPER_RETRY_DELAY_MS} ms`;
export const EXCLUDED_DOMAIN_RULE =
  'Escribe solo el host (ej. madrimasd.org), sin https:// ni rutas';

/** Opcion del selector determinista de URL. */
export interface TargetUrlOption {
  readonly label: string;
  readonly value: string;
}

/** Plantilla de interpolacion de un campo escalar. */
export const urlTemplateFor = (namespace: string, field: string): string =>
  `{{${namespace}.${field}}}`;

/** Plantilla de interpolacion de la posicion `index` de un campo de arreglo. */
export const indexedUrlTemplateFor = (namespace: string, field: string, index: number): string =>
  `{{${namespace}.${field}[${index}]}}`;

/**
 * Etiqueta de la opcion que delega la eleccion en el nodo.
 *
 * Se exporta para que las pruebas la aseveren sin recopiarla.
 */
export const FIRST_ELIGIBLE_LABEL_SUFFIX = 'primer enlace elegible';

/**
 * Opciones del selector: POSICIONES del contexto, no URLs.
 *
 * Aqui esta la decision central del nodo, y tiene dos mitades.
 *
 * LA PRIMERA: lo que se guarda nunca es una URL, es una REFERENCIA. En tiempo de
 * diseno el flujo no se ha ejecutado, no hay `StatePayloadContext` y por tanto no
 * existe ningun enlace real que ofrecer. El flujo correra sobre correos distintos
 * cada dia, asi que anclar la configuracion a la URL concreta de un correo de
 * ejemplo produciria un `targetUrl` que en produccion apunta a una noticia
 * caducada.
 *
 * LA SEGUNDA: de donde sale el catalogo. Las opciones se derivan de la TOPOLOGIA
 * que el anfitrion declara, cruzada con los campos que cada tipo de nodo publica
 * segun el catalogo del backend. No hay ningun namespace escrito a mano en este
 * archivo, y es la diferencia con la version anterior: aquella ofrecia diez
 * posiciones fijas de `parsed_email.extracted_urls` pasara lo que pasara, de modo
 * que un flujo que extrajera sus enlaces de cualquier otro nodo era
 * inconfigurable, y uno sin parser aguas arriba ofrecia diez opciones que ninguna
 * ejecucion podria resolver.
 *
 * Solo se ofrecen los campos de tipo URL. Un `character_count` es interpolable
 * igual que cualquier otro, pero ofrecerlo como origen de una direccion seria el
 * error de tipeo que el selector existe para impedir.
 *
 * Un `url[]` se despliega en `SELECTABLE_URL_SLOTS` posiciones; un `url` escalar
 * aporta una sola opcion.
 */
const buildUrlOptions = (context: readonly UpstreamNamespace[]): readonly TargetUrlOption[] =>
  context.flatMap(({ namespace, fields }) =>
    fields.flatMap((field) => {
      const suffix = field.description === undefined ? '' : ` — ${field.description}`;

      if (field.type === 'url') {
        return [
          {
            label: `${namespace}.${field.name}${suffix}`,
            value: urlTemplateFor(namespace, field.name),
          },
        ];
      }

      if (field.type !== 'url[]') return [];

      // LA PRIMERA opcion del arreglo no es una posicion: es un CRITERIO. El
      // enlace del portal propio y el de la noticia llegan en el mismo correo y
      // su orden cambia de un dia para otro, asi que fijar la posicion 1 raspa
      // tan pronto uno como el otro. Delegando en el nodo, la eleccion la hace
      // "no ser un dominio excluido", que si es estable. Va la primera porque es
      // la respuesta correcta en el caso normal; las posiciones se quedan para
      // el correo de formato fijo.
      return [
        {
          label: `${namespace}.${field.name} — ${FIRST_ELIGIBLE_LABEL_SUFFIX} (salta los dominios excluidos)`,
          value: urlTemplateFor(namespace, field.name),
        },
        ...Array.from({ length: SELECTABLE_URL_SLOTS }, (_, index) => ({
          label: `${namespace}.${field.name} — posicion ${index + 1}`,
          value: indexedUrlTemplateFor(namespace, field.name, index),
        })),
      ];
    }),
  );

/**
 * Config inicial: SIN `targetUrl` y con los tres defectos del backend.
 *
 * La cadena vacia y no una plantilla concreta: ya no existe un origen por
 * defecto que valga para todo flujo, porque el catalogo de opciones depende de
 * quien vaya delante. Un valor prefijado aqui seria una eleccion que el operador
 * no ha hecho, y que `isConfigValid` tendria que rechazar acto seguido en cuanto
 * la topologia no lo respaldara.
 */
const buildInitialConfig = (): WebScraperConfigDto => ({
  targetUrl: '',
  timeoutMs: DEFAULT_SCRAPER_TIMEOUT_MS,
  maxRetries: DEFAULT_SCRAPER_MAX_RETRIES,
  retryDelayMs: DEFAULT_SCRAPER_RETRY_DELAY_MS,
  skipIfEmpty: DEFAULT_SCRAPER_SKIP_IF_EMPTY,
  ignoreExtractionFailure: DEFAULT_SCRAPER_IGNORE_EXTRACTION_FAILURE,
  excludedDomains: [],
});

/** Coercion defensiva de una clave textual del `jsonb`. */
const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Coercion defensiva de una clave numerica del `jsonb`. */
const asNumber = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/** Coercion defensiva de una clave booleana del `jsonb`. */
const asBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

/** Coercion defensiva de una lista de dominios del `jsonb`. */
const asDomainList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** Entero dentro de un rango cerrado. */
const isIntegerInRange = (value: number, min: number, max: number): boolean =>
  Number.isInteger(value) && value >= min && value <= max;

const webScraperSetup = () => {
  const config = ref<WebScraperConfigDto>(buildInitialConfig());

  /**
   * Namespaces anteriores del flujo, con los campos que publica cada uno.
   *
   * Arranca VACIO, y aqui se cambia de criterio respecto a la version anterior,
   * que sembraba `parsed_email` como defecto provisional. Sembrar un defecto
   * significaba ofrecer opciones sobre un nodo que quiza no esta en el flujo: el
   * operador podia elegir una y avanzar el asistente con una referencia que
   * ninguna ejecucion sabria resolver. Vacio el selector se deshabilita y el
   * banner dice por que, que es un bloqueo explicado en vez de una trampa.
   */
  const availableUpstreamContext = ref<UpstreamNamespace[]>([]);

  /** URL REAL del banco de pruebas. NO forma parte de los `params` del nodo. */
  const sandboxUrl = ref<string>('');

  const sandboxResult = ref<ScrapedWebPayload | null>(null);
  const sandboxMetrics = ref<CheckScraperMetrics | null>(null);
  const sandboxWarnings = ref<string[]>([]);
  const loading = ref<boolean>(false);

  const urlOptions = computed<readonly TargetUrlOption[]>(() =>
    buildUrlOptions(availableUpstreamContext.value),
  );

  /**
   * Algun nodo anterior publica un campo del que pueda salir una URL.
   *
   * Es la condicion que hace resoluble cualquiera de las opciones ofrecidas: sin
   * un origen aguas arriba no hay nada que interpolar, el nodo fallaria con
   * ERR_SCRAPER_URL_UNRESOLVED en la primera ejecucion, y el selector no tiene
   * nada honesto que mostrar. Mismo criterio que `missingRequiredVariables` del
   * mapeador: detectarlo al configurar es la diferencia entre corregirlo ahora o
   * descubrirlo en produccion con el flujo PAUSADO.
   *
   * Se deriva de las OPCIONES y no de la lista de namespaces: un nodo anterior
   * que solo publique texto esta presente y aun asi no sirve de origen.
   */
  const hasUrlSource = computed<boolean>(() => urlOptions.value.length > 0);

  /**
   * El `targetUrl` guardado ya no figura entre las opciones ofrecibles.
   *
   * Distingue "no has elegido nada" de "lo que elegiste dejo de existir", que
   * son dos bloqueos con causas opuestas: el primero se resuelve eligiendo, el
   * segundo reordenando el flujo o recuperando el nodo que producia ese
   * namespace. Sin esta distincion, reabrir un flujo heredado mostraria un
   * selector en blanco sin decir que se acaba de perder una configuracion.
   */
  const hasStaleTargetUrl = computed<boolean>(
    () =>
      config.value.targetUrl.length > 0 &&
      !urlOptions.value.some((option) => option.value === config.value.targetUrl),
  );

  /**
   * Contrato Poka-Yoke que el stepper consulta para habilitar "Siguiente".
   *
   * Los tres rangos numericos replican los `@Min`/`@Max` del DTO del backend,
   * que queda intacto; esta copia solo adelanta el rechazo al formulario.
   *
   * `targetUrl` pasa TRES filtros, y ninguno sobra:
   *
   * 1. No vacio, SALVO que `skipIfEmpty` este activo. Esa bandera declara que
   *    la ausencia de origen es una decision —el flujo de contingencia OCR no
   *    tiene de donde sacar una URL— y no un olvido. Ojo a la asimetria: exime
   *    al campo VACIO, nunca al campo MAL PUESTO. Un `targetUrl` obsoleto sigue
   *    bloqueando con la bandera activa, porque "omitir si no hay" no es
   *    "omitir si esta mal", y tratarlos igual convertiria una configuracion
   *    rota en una omision silenciosa.
   * 2. Casa el patron anclado de interpolacion. Replica el `@Matches` del DTO
   *    del backend, de modo que un `targetUrl` heredado con una URL literal
   *    —admisible en una version anterior— se rechace aqui con una regla de
   *    campo en vez de con un 400 al guardar.
   * 3. Pertenece a `urlOptions`. Es el filtro fuerte, y el patron no lo
   *    sustituye: una plantilla bien formada hacia un namespace que el flujo no
   *    produce es sintacticamente impecable y aun asi irresoluble. La lista ya
   *    no es fija, es la proyeccion de la topologia declarada por el anfitrion,
   *    asi que comprobarla es comprobar el flujo real.
   *
   * NO exige haber probado la extraccion, a diferencia del disparador IMAP.
   * Alli la comprobacion protege de unas credenciales que no fallarian hasta el
   * primer sondeo; aqui la URL de produccion ni siquiera existe todavia —es una
   * posicion dentro de un contexto futuro—, asi que no hay nada que un banco de
   * pruebas pueda verificar sobre ella. Ese aviso vive en `configWarnings`.
   */
  const isUrlSourceValid = computed<boolean>(
    () =>
      INTERPOLATION_ONLY_PATTERN.test(config.value.targetUrl) &&
      urlOptions.value.some((option) => option.value === config.value.targetUrl),
  );

  /**
   * El origen elegido delega la seleccion en el nodo.
   *
   * Se deduce de la FORMA del origen —una marca sin indice de arreglo— y no de
   * un campo aparte, igual que hace la estrategia del backend: dos fuentes para
   * la misma decision admitirian estados incoherentes (una posicion fija junto
   * a un modo "primer elegible") y alguien tendria que arbitrar cual gana.
   */
  const isFirstEligibleTarget = computed<boolean>(
    () =>
      config.value.targetUrl.length > 0 &&
      !config.value.targetUrl.includes('[') &&
      urlOptions.value.some((option) => option.value === config.value.targetUrl),
  );

  /**
   * Los dominios excluidos estan bien escritos y no pasan del tope.
   *
   * Replica lo que el `@Matches({ each: true })` del DTO decide; esta copia solo
   * adelanta el rechazo al formulario.
   */
  const areExcludedDomainsValid = computed<boolean>(
    () =>
      config.value.excludedDomains.length <= MAX_EXCLUDED_DOMAINS &&
      config.value.excludedDomains.every((domain) => EXCLUDED_DOMAIN_PATTERN.test(domain)),
  );

  const isConfigValid = computed<boolean>(
    () =>
      (config.value.targetUrl.length === 0 ? config.value.skipIfEmpty : isUrlSourceValid.value) &&
      areExcludedDomainsValid.value &&
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

    if (hasStaleTargetUrl.value) {
      warnings.push(
        `El origen guardado "${config.value.targetUrl}" ya no lo produce ningun paso anterior del flujo. Se conserva tal cual para no reescribir en silencio lo que alguien configuro, pero hay que elegir uno nuevo o reordenar el flujo.`,
      );
    }

    if (config.value.skipIfEmpty && config.value.targetUrl.length === 0) {
      warnings.push(
        'Este nodo se saltara: no hay origen seleccionado y "Omitir extraccion" esta activo. El flujo continuara con los campos de "scraped_web" en blanco.',
      );
    }

    // Aqui vivian dos avisos sobre la combinacion de "primer enlace elegible"
    // y los dominios excluidos. Se retiraron con el banner del formulario por
    // el mismo motivo: describian una equivalencia correcta —no un problema— y
    // aparecian en la configuracion normal del nodo, de modo que acostumbraban
    // al operador a ignorar la lista de avisos donde si aparecen los reales.

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

  /**
   * El operador no puede apagar la omision cuando no hay de donde extraer.
   *
   * No se mira lo que diga la plantilla —a diferencia de `trigger-imap`, que
   * bloquea `includeAttachments` porque una ruta de contingencia lo exige—, sino
   * la TOPOLOGIA real: sin ningun campo de tipo URL aguas arriba, cualquier
   * valor distinto de `true` produce un esquema que la regla 8 rechaza al
   * guardar. Dejarlo editable seria ofrecer una eleccion cuyo unico desenlace es
   * un 400 del backend.
   */
  const isSkipIfEmptyLocked = computed<boolean>(() => !hasUrlSource.value);

  /**
   * Recoge lo que la PLANTILLA sembro al declarar la topologia.
   *
   * Canal aparte de `hydrateFromNode`: aquel restaura un flujo ya guardado y
   * este trae las decisiones del disenador del flujo al instanciarlo. Sin esta
   * implementacion, el `skipIfEmpty` que la plantilla escribio se perdia al
   * abrir el asistente y el flujo de contingencia volvia a ser irrepresentable.
   *
   * Se ignora lo que no sea booleano: `configuracion_pipeline` es `jsonb` y pudo
   * escribirse por SQL directo, donde la cadena `'false'` es *truthy*.
   */
  const applyTemplateParams = (params: Record<string, unknown>): void => {
    if (typeof params.skipIfEmpty === 'boolean') {
      config.value = { ...config.value, skipIfEmpty: params.skipIfEmpty };
    }

    if (typeof params.ignoreExtractionFailure === 'boolean') {
      config.value = {
        ...config.value,
        ignoreExtractionFailure: params.ignoreExtractionFailure,
      };
    }

    // Tambien los dominios excluidos: son una decision EDITORIAL del disenador
    // de la plantilla ("este flujo nunca raspa el portal propio"), no un valor
    // de calibracion del flujo concreto. Perderlos al instanciar obligaria a
    // redescubrirlos en cada flujo nuevo, y el primero en notarlo seria el
    // articulo publicado con el contenido equivocado.
    if (Array.isArray(params.excludedDomains)) {
      config.value = {
        ...config.value,
        excludedDomains: asDomainList(params.excludedDomains),
      };
    }
  };

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

  /**
   * Canal rico del anfitrion: namespaces anteriores CON sus campos.
   *
   * Es el unico que este nodo implementa. `setAvailableUpstreamNamespaces`, que
   * solo entrega nombres, no le sirve: para componer `{{namespace.campo}}` hace
   * falta el campo, y adivinarlo seria volver al `extracted_urls` escrito a mano
   * que esta version elimina.
   */
  const setAvailableUpstreamContext = (context: UpstreamNamespace[]): void => {
    availableUpstreamContext.value = [...context];
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
    const params: Record<string, unknown> = {};

    // `targetUrl` se OMITE cuando no se ha elegido, en vez de publicarse como
    // cadena vacia. Un nodo sin origen es un nodo sin configurar, y asi es como
    // lo declara una plantilla de flujo: por ausencia. Publicar `''` seria
    // afirmar que hay un valor, y el `@IsNotEmpty` del DTO lo rechazaria al
    // guardar —que es justo lo que impedia que una plantilla contuviera este
    // nodo—. El paso sigue bloqueado por `isConfigValid`; lo que cambia es que
    // el esquema se puede persistir a medias, como borrador.
    if (config.value.targetUrl.length > 0) {
      params.targetUrl = config.value.targetUrl;
    }

    // SIEMPRE, y aqui se rompe a proposito el criterio de los tres numericos.
    // `skipIfEmpty` no es un valor de calibracion sino una declaracion con
    // consecuencia TOPOLOGICA: la regla 8 del validador solo exime al nodo si
    // encuentra el `true` escrito en el esquema. Omitirlo por coincidir con el
    // defecto dejaba al operador viendo un toggle encendido mientras el flujo
    // de contingencia seguia siendo rechazado al guardar, sin nada en el
    // esquema que explicara por que. Una exencion que no esta escrita tampoco
    // es auditable por quien revise la plantilla despues.
    params.skipIfEmpty = config.value.skipIfEmpty;

    // Solo si DIFIERE del defecto, al contrario que `skipIfEmpty`: esta bandera
    // no tiene consecuencia topologica —el validador no la consulta—, de modo
    // que vale el criterio general de no engordar el esquema con lo que el
    // defecto ya dice.
    if (config.value.ignoreExtractionFailure !== DEFAULT_SCRAPER_IGNORE_EXTRACTION_FAILURE) {
      params.ignoreExtractionFailure = config.value.ignoreExtractionFailure;
    }

    // Se OMITE la lista vacia, como `targetUrl`: ausencia es "no filtra nada", y
    // publicar `[]` llenaria de ruido todo esquema guardado sin decir nada que
    // el defecto no diga ya.
    if (config.value.excludedDomains.length > 0) {
      params.excludedDomains = [...config.value.excludedDomains];
    }

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
   * `targetUrl` se restaura VERBATIM, aunque no figure entre las opciones que la
   * topologia actual ofrece. La version anterior caia a `urlTemplateFor(0)` en
   * ese caso, y eso era reescribir en silencio la configuracion que el operador
   * venia a revisar: abria el formulario afirmando una eleccion que nadie hizo y
   * guardar la persistia. Conservarlo deja el nodo bloqueado por `isConfigValid`
   * y explicado por `configWarnings`, que es el fallo honesto.
   *
   * La URL del banco NO se toca: es material de prueba, no del nodo.
   */
  const hydrateFromNode = (node: HydratableNode): void => {
    const params = node.params;

    config.value = {
      targetUrl: asText(params.targetUrl),
      timeoutMs: asNumber(params.timeoutMs, DEFAULT_SCRAPER_TIMEOUT_MS),
      maxRetries: asNumber(params.maxRetries, DEFAULT_SCRAPER_MAX_RETRIES),
      retryDelayMs: asNumber(params.retryDelayMs, DEFAULT_SCRAPER_RETRY_DELAY_MS),
      skipIfEmpty: asBoolean(params.skipIfEmpty, DEFAULT_SCRAPER_SKIP_IF_EMPTY),
      ignoreExtractionFailure: asBoolean(
        params.ignoreExtractionFailure,
        DEFAULT_SCRAPER_IGNORE_EXTRACTION_FAILURE,
      ),
      excludedDomains: asDomainList(params.excludedDomains),
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
    hasStaleTargetUrl,
    isUrlSourceValid,
    isFirstEligibleTarget,
    areExcludedDomainsValid,
    isSkipIfEmptyLocked,
    isConfigValid,
    configWarnings,
    canRunSandbox,
    sandboxPayload,
    updateConfig,
    setSandboxUrl,
    setAvailableUpstreamContext,
    runSandboxTest,
    toNodeParams,
    applyTemplateParams,
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
