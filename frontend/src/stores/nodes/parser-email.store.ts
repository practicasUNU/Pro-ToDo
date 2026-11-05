import { defineStore, acceptHMRUpdate } from 'pinia';
import { computed, ref } from 'vue';

import * as parserEmailService from '@services/nodes/parser-email.service';

import type { HydratableNode } from '@stores/nodes/node-store-registry';

import type {
  CheckParserPayload,
  CheckParserResult,
  ParsedEmailAttachment,
  ParsedEmailPayload,
  ParserEmailConfigDto,
} from '@/types/parser-email';

import { ERR_PARSER_UNEXTRACTABLE_MEDIA } from '@/types/nodes/error-branch.types';

/** Namespace del que el parser lee el correo crudo, el mismo que asume el backend. */
export const DEFAULT_PARSER_SOURCE_NAMESPACE = 'raw_email';

/** Umbral por defecto, replicado de `DEFAULT_MIN_BODY_LENGTH` del backend. */
export const DEFAULT_MIN_BODY_LENGTH = 50;

/**
 * Umbral minimo admisible, replicado del `@IsPositive()` del DTO backend.
 *
 * Es UNO y no cero, y la diferencia importa en las dos capas: con un umbral de
 * cero la condicion `bodyLength < minBodyLength` seria imposible de satisfacer,
 * de modo que `requires_multimodal_fallback` nunca se activaria y un correo cuyo
 * unico contenido es un PDF escaneado pasaria al modelo sin nada que leer.
 *
 * El backend ya lo rechaza; sin esta copia el operador veria un 400 de servidor
 * donde deberia haber visto una regla de campo. Es el mismo motivo por el que
 * `trigger-imap.store.ts` replica el `@Min(30000)` en `MIN_POLL_INTERVAL_MS`.
 */
export const MIN_BODY_LENGTH = 1;

/** Texto de la regla del campo. Se exporta para que la prueba lo asevere sin copiarlo. */
export const MIN_BODY_LENGTH_RULE = 'El umbral debe ser mayor o igual a 1';

/**
 * Correo de prueba del banco. NO forma parte de los `params` del nodo.
 *
 * Lleva `subject` y el interruptor de adjunto ademas de los dos cuerpos porque
 * sin ellos dos de las metricas del panel serian constantes muertas:
 * `clean_title` se deriva del asunto, y `requires_multimodal_fallback` exige un
 * adjunto de imagen o PDF ADEMAS del cuerpo corto.
 */
export interface ParserSandboxInput {
  subject: string;
  html: string;
  text: string;
  /**
   * Simula un adjunto PDF para poder observar la regla multimodal.
   *
   * Es un interruptor y no un selector de ficheros: la decision del nodo solo
   * mira `contentType`, nunca los bytes, y subir un binario de verdad al
   * asistente seria pagar megabytes por un booleano.
   */
  simulateVisualAttachment: boolean;
}

/** Adjunto simulado que el interruptor inyecta en la peticion de prueba. */
const SIMULATED_ATTACHMENT: ParsedEmailAttachment = {
  filename: 'nota-de-prensa.pdf',
  contentType: 'application/pdf',
  size: 1024,
};

/**
 * Lee una cadena de los `params` crudos del esquema.
 *
 * La columna es `jsonb` y pudo escribirse por SQL directo, asi que un campo
 * puede faltar o venir con otro tipo.
 */
const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Lee un numero de los `params`, con el default del backend como respaldo. */
const asNumber = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/**
 * Extensiones que el selector de exclusiones ofrece, y las UNICAS admisibles.
 *
 * Replica de `EXTRACTABLE_DOCUMENT_EXTENSIONS`
 * (`@modules/nodes/utils/document-extractor.util.ts`), que a su vez se deriva
 * del mapa `EXTENSION_KINDS` con el que el backend decide que lector aplica a
 * cada adjunto. Cualquier alta alli debe reflejarse aqui.
 *
 * Sustituye a la lista de SUGERENCIAS anterior, que ademas dejaba teclear
 * valores nuevos. Era texto libre, que §4 Poka-Yoke prohibe, y el agujero no
 * era teorico: excluir `.zip` —que el backend ni siquiera lee— no tiene ningun
 * efecto, pero la interfaz aceptaba la entrada y sugeria lo contrario.
 */
export const EXCLUDABLE_EXTENSION_PRESETS: readonly string[] = [
  '.txt',
  '.md',
  '.log',
  '.csv',
  '.tsv',
  '.pdf',
  '.docx',
  '.xlsx',
  '.xlsm',
  '.pptx',
  '.doc',
  '.xls',
  '.ppt',
];

/**
 * Lleva una extension a su forma canonica: minusculas y con punto inicial.
 *
 * Replica de `normalizeExtension` del DTO del backend. Se normaliza AQUI, al
 * entrar en el store, porque `new-value-mode="add-unique"` compara cadenas en
 * crudo: sin esto, `PPTX` y `.pptx` convivirian como dos entradas distintas y
 * ninguna de las dos excluiria el fichero que el operador queria excluir.
 */
export const normalizeExtension = (value: string): string => {
  const trimmed = value.trim().toLowerCase();

  if (trimmed === '') {
    return '';
  }

  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
};

/** Configuracion inicial; se reutiliza en `resetConfig`. */
const buildInitialConfig = (): ParserEmailConfigDto => ({
  minBodyLength: DEFAULT_MIN_BODY_LENGTH,
  sourceNamespace: DEFAULT_PARSER_SOURCE_NAMESPACE,
  // El mismo defecto que el backend, y por el mismo motivo: bifurcar es una
  // decision del disenador del flujo, no del despliegue.
  failOnUnextractableMedia: false,
  skipDocumentExtraction: false,
  excludedExtensions: [],
});

/** Correo de prueba inicial: vacio, para no sugerir un ejemplo que nadie pidio. */
const buildInitialSandboxInput = (): ParserSandboxInput => ({
  subject: '',
  html: '',
  text: '',
  simulateVisualAttachment: false,
});

/** Prefijo del id de Pinia; el sufijo es el `nodeId` del `pipeline_schema`. */
const STORE_ID_PREFIX = 'node-parser-email';

// Estado reactivo del nodo PARSER_PRE_IA (regla frontend-quasar.md §3.1).
// No conoce Axios ni rutas: delega en su servicio y expone `isConfigValid`, que
// es lo unico que el asistente consulta para habilitar el avance.
//
// El cuerpo se declara aparte y NO recibe el `nodeId`: este estado no sabe en
// que posicion del grafo esta ni como se llama su nodo. El `nodeId` solo decide
// CUANTAS instancias hay, y eso se resuelve en el id de Pinia.
const parserEmailSetup = () => {
  const config = ref<ParserEmailConfigDto>(buildInitialConfig());
  const sandboxInput = ref<ParserSandboxInput>(buildInitialSandboxInput());
  const sandboxResult = ref<ParsedEmailPayload | null>(null);
  const loading = ref(false);
  /** Avisos del backend: los que en la ejecucion real solo llegan al `.log`. */
  const sandboxWarnings = ref<readonly string[]>([]);

  /**
   * Contrato Poka-Yoke que el stepper consulta para habilitar "Siguiente".
   *
   * El `>= 1` replica el `@IsPositive()` del DTO backend, que queda intacto.
   *
   * NO exige haber probado el saneado, a diferencia del disparador IMAP. Aquella
   * exigencia protege de unas credenciales equivocadas que no fallarian hasta el
   * primer sondeo; aqui no hay credenciales, ni red, ni nada que pueda estar mal
   * sin que el formulario lo vea. Copiar ese Poka-Yoke haria imposible guardar un
   * flujo con parser sin tener a mano un correo de ejemplo, que es una barrera
   * sin peligro detras. Por el mismo motivo no se implementa `configWarnings`.
   */
  const isConfigValid = computed<boolean>(() => {
    const value = Number(config.value.minBodyLength);

    return Number.isInteger(value) && value >= MIN_BODY_LENGTH;
  });

  /** Hay algo que sanear: sin cuerpo la prueba no diria nada. */
  const canRunSandbox = computed<boolean>(
    () => sandboxInput.value.text.trim() !== '' || sandboxInput.value.html.trim() !== '',
  );

  /** Cuerpo de la peticion, derivado del correo de ejemplo y del umbral actual. */
  const sandboxPayload = computed<CheckParserPayload>(() => ({
    subject: sandboxInput.value.subject.trim(),
    text: sandboxInput.value.text,
    html: sandboxInput.value.html,
    minBodyLength: config.value.minBodyLength,
    // Spread condicional y no `attachments: undefined`: con
    // `exactOptionalPropertyTypes` activo, asignar `undefined` a un `?: T` no
    // compila. Ademas, el backend rechaza las claves que no espera.
    ...(sandboxInput.value.simulateVisualAttachment ? { attachments: [SIMULATED_ATTACHMENT] } : {}),
  }));

  /** Descarta el resultado en pantalla porque ya no corresponde a la entrada. */
  const invalidateSandboxResult = (): void => {
    sandboxResult.value = null;
    sandboxWarnings.value = [];
  };

  /**
   * Cambia la configuracion e INVALIDA el resultado mostrado.
   *
   * `minBodyLength` decide `requires_multimodal_fallback`, asi que un resultado
   * calculado con el umbral anterior dejaria en pantalla un veredicto que ya no
   * corresponde a lo que dice el formulario.
   */
  const updateConfig = (partial: Partial<ParserEmailConfigDto>): void => {
    const normalized: Partial<ParserEmailConfigDto> =
      partial.excludedExtensions === undefined
        ? partial
        : {
            ...partial,
            excludedExtensions: [
              ...new Set(partial.excludedExtensions.map(normalizeExtension)),
            ].filter((extension) => extension !== ''),
          };

    config.value = { ...config.value, ...normalized };
    invalidateSandboxResult();
  };

  /**
   * Ajusta el nodo a los codigos que su ruta de contingencia declara atrapar.
   *
   * Implementa el metodo opcional del contrato `NodeConfigStore`. El agregador
   * no puede encender `failOnUnextractableMedia` por su cuenta —§3.1 le prohibe
   * conocer la forma interna de esta config—, y sin encenderlo la regla 10 del
   * validador de topologia rechaza el esquema al guardar: la ruta atraparia un
   * codigo que el nodo, con estos `params`, no puede emitir.
   *
   * Es IDEMPOTENTE y reversible: una lista sin el codigo lo apaga. Retirar la
   * rama tiene que devolver el nodo a su comportamiento anterior, o el flujo se
   * quedaria fallando ante un correo de solo imagen sin nadie que lo recogiera.
   *
   * El correo de prueba NO se invalida: esto no cambia como se sanea el correo,
   * solo si el nodo declara el caso como fallo.
   */
  const declareCaughtErrorCodes = (codes: readonly string[]): void => {
    config.value = {
      ...config.value,
      failOnUnextractableMedia: codes.includes(ERR_PARSER_UNEXTRACTABLE_MEDIA),
    };
  };

  /** Igual, para el correo de ejemplo: cambiar la entrada caduca la salida. */
  const updateSandboxInput = (partial: Partial<ParserSandboxInput>): void => {
    sandboxInput.value = { ...sandboxInput.value, ...partial };
    invalidateSandboxResult();
  };

  /**
   * Sanea el correo de ejemplo contra el backend.
   *
   * No captura la excepcion: el store solo garantiza el `finally` que apaga
   * `loading`, y es el componente quien decide el mensaje al usuario
   * (`frontend-architecture.md` §2.1).
   */
  const runSandboxTest = async (): Promise<void> => {
    loading.value = true;

    try {
      const result: CheckParserResult = await parserEmailService.checkParser(sandboxPayload.value);

      sandboxResult.value = result.parsed ?? null;
      sandboxWarnings.value = result.warnings ?? [];

      // Un fallo diagnosticado por el backend llega como 200 con
      // `success: false`. Se guarda igual —el componente decide el aviso— pero
      // sin payload que mostrar.
      if (!result.success) {
        sandboxResult.value = null;
        sandboxWarnings.value = result.error === undefined ? [] : [result.error.message];
      }
    } finally {
      loading.value = false;
    }
  };

  /**
   * `params` del nodo para el `pipeline_schema`.
   *
   * `minBodyLength` va SIEMPRE: es el unico campo del formulario, y publicar lo
   * que el operador decidio es el contrato del metodo.
   *
   * `sourceNamespace` va SOLO si difiere del defecto, y ninguna de las dos
   * alternativas simples sirve:
   *
   * - Emitirlo siempre congelaria el defecto de HOY dentro de cada
   *   `pipeline_schema` guardado. Es el mismo fallo que documenta el TSDoc de
   *   `DEFAULT_MIN_BODY_LENGTH` del backend al recalibrarse de 200 a 50: mover
   *   un defecto no debe dejar atras a los flujos ya creados.
   * - Omitirlo siempre reescribiria en silencio un nodo de autoria manual. El
   *   panel JSON de plantillas permite escribir `sourceNamespace: "scraped_web"`,
   *   y abrir ese flujo en el asistente y volver a guardarlo lo devolveria a
   *   `raw_email` sin que nadie lo pidiera: el nodo pasaria a leer de otro
   *   namespace y fallaria con ERR_PARSER_SOURCE_MISSING.
   *
   * Publicarlo solo cuando es una decision explicita satisface las dos cosas y
   * mantiene el contrato de ida y vuelta del registro de stores.
   */
  const toNodeParams = (): Record<string, unknown> => ({
    minBodyLength: config.value.minBodyLength,
    ...(config.value.sourceNamespace !== DEFAULT_PARSER_SOURCE_NAMESPACE
      ? { sourceNamespace: config.value.sourceNamespace }
      : {}),
    // Se publica solo cuando esta ENCENDIDO, con el mismo criterio que
    // `sourceNamespace`: el defecto del backend es `false`, asi que emitirlo
    // apagado solo anadiria ruido a cada esquema guardado. Encendido SI tiene
    // que viajar, porque es lo que hace legal la ruta de error que lo acompana.
    ...(config.value.failOnUnextractableMedia ? { failOnUnextractableMedia: true } : {}),
    // Mismo criterio para los dos siguientes: solo viajan cuando se apartan del
    // defecto del backend, para no engordar cada esquema guardado con el valor
    // que ya se aplicaria solo.
    ...(config.value.skipDocumentExtraction ? { skipDocumentExtraction: true } : {}),
    ...(config.value.excludedExtensions.length > 0
      ? { excludedExtensions: [...config.value.excludedExtensions] }
      : {}),
  });

  /**
   * Carga la configuracion de un nodo ya guardado.
   *
   * El correo de prueba NO se toca: es material del banco de pruebas, no del
   * nodo, y reiniciarlo al abrir un flujo existente borraria el ejemplo que el
   * operador acababa de pegar.
   */
  const hydrateFromNode = (node: HydratableNode): void => {
    const params = node.params;

    config.value = {
      minBodyLength: asNumber(params.minBodyLength, DEFAULT_MIN_BODY_LENGTH),
      sourceNamespace: asText(params.sourceNamespace) || DEFAULT_PARSER_SOURCE_NAMESPACE,
      // `=== true` y no un cast: la columna es `jsonb` y pudo escribirse por SQL
      // directo, donde la cadena "false" es un valor veraz.
      failOnUnextractableMedia: params.failOnUnextractableMedia === true,
      skipDocumentExtraction: params.skipDocumentExtraction === true,
      // Se vuelve a normalizar al rehidratar: la columna es `jsonb` y pudo
      // escribirse por SQL directo, sin pasar por este store.
      excludedExtensions: Array.isArray(params.excludedExtensions)
        ? [
            ...new Set(params.excludedExtensions.map((entry) => normalizeExtension(String(entry)))),
          ].filter((extension) => extension !== '')
        : [],
    };
    invalidateSandboxResult();
  };

  const resetConfig = (): void => {
    config.value = buildInitialConfig();
    sandboxInput.value = buildInitialSandboxInput();
    invalidateSandboxResult();
  };

  return {
    config,
    sandboxInput,
    sandboxResult,
    sandboxWarnings,
    loading,
    isConfigValid,
    canRunSandbox,
    sandboxPayload,
    updateConfig,
    declareCaughtErrorCodes,
    updateSandboxInput,
    runSandboxTest,
    toNodeParams,
    hydrateFromNode,
    resetConfig,
  };
};

const buildParserEmailStore = (nodeId: string) =>
  defineStore(`${STORE_ID_PREFIX}:${nodeId}`, parserEmailSetup);

/** Instancia del store, para tipar helpers y consumidores sin `any`. */
export type ParserEmailStore = ReturnType<ReturnType<typeof buildParserEmailStore>>;

/**
 * Definiciones ya creadas, indexadas por `nodeId`.
 *
 * Se memoiza la DEFINICION, no la instancia: de la instancia ya se encarga Pinia,
 * que cachea por id en la instancia activa.
 */
const definitions = new Map<string, ReturnType<typeof buildParserEmailStore>>();

/**
 * Store del nodo PARSER_PRE_IA identificado por `nodeId`.
 *
 * Cada nodo del pipeline recibe su propia instancia, aislada de las demas: dos
 * parsers en el mismo flujo pueden tener umbrales distintos.
 */
export const useParserEmailStore = (nodeId: string): ParserEmailStore => {
  const cached = definitions.get(nodeId);

  if (cached !== undefined) return cached();

  const definition = buildParserEmailStore(nodeId);
  definitions.set(nodeId, definition);

  // Con ids dinamicos no hay una definicion unica que declarar al cargar el
  // modulo, asi que el HMR se arma sobre cada definicion nueva.
  if (import.meta.hot) {
    import.meta.hot.accept(acceptHMRUpdate(definition, import.meta.hot));
  }

  return definition();
};
