import {
  DEFAULT_DRUPAL_SOURCE_FIELD,
  DEFAULT_DRUPAL_SOURCE_NAMESPACE,
  DRUPAL_PRESETS,
  DrupalOperationMode,
} from '@/types/nodes/drupal-http.types';
import { NodeType } from '@/types/pipeline';

import type { UpstreamNamespace } from '@stores/nodes/node-store-registry';
import type { NodeOutputFieldType } from '@/types/node-catalog';
import type { SandboxAttachment } from '@/types/node-sandbox';

// Datos de EJEMPLO para el contexto simulado del banco de pruebas: un valor
// verosimil por cada campo que publican los namespaces marcados, para que el
// operador parta de algo ejecutable en lugar de un `{}` que tendria que
// rellenar de memoria.

const SAMPLE_BY_TYPE: Readonly<Record<NodeOutputFieldType, (field: string) => unknown>> = {
  url: () => 'https://www.ejemplo.org/noticia',
  'url[]': () => ['https://www.ejemplo.org/noticia', 'https://www.ejemplo.org/otra'],
  text: (field) => `Texto de ejemplo para ${field}`,
  number: () => 1,
  boolean: () => true,
  object: () => ({}),
};

/** Namespace del correo crudo, donde la estrategia OCR busca los adjuntos. */
export const RAW_EMAIL_NAMESPACE = 'raw_email';

/** Ejemplos de un tipo de nodo concreto: `{ namespace: { campo: valor } }`. */
export type SampleOverrides = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/**
 * Licitacion de muestra de «Abrir licitación», con el envoltorio estandar.
 *
 * Es la forma que deja `APPEND_HTML_BLOCK` en la pagina y la que «Cerrar
 * licitación» busca despues por `.pd-licitacion-block` y su expediente: probar
 * la apertura con un texto suelto no ejercitaria nada de eso.
 */
export const SAMPLE_TENDER_MARKUP =
  '<div class="licitacion-entry pd-licitacion-block" data-expediente="S_2026_015">' +
  '<h3 class="licitacion-titulo">Licitación de ejemplo S_2026_015</h3>' +
  '<p class="licitacion-descripcion">Texto de ejemplo de la convocatoria.</p>' +
  '<ul class="licitacion-pliegos"></ul>' +
  '</div>';

const readText = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;

/**
 * Ejemplos especificos del nodo que se va a probar, deducidos de sus `params`.
 *
 * Hoy solo la apertura de licitaciones: se reconoce por su modo y por su
 * contenedor, porque Verificacion de titulos comparte modo y una licitacion de
 * muestra en su acordeon seria un ejemplo enganoso. Lee solo los `params` que
 * el nodo publica, no su store.
 */
export const buildSampleOverrides = (
  nodeType: NodeType,
  params: Readonly<Record<string, unknown>>,
): SampleOverrides => {
  if (
    nodeType !== NodeType.DESTINO_DRUPAL ||
    params.operationMode !== DrupalOperationMode.APPEND_HTML_BLOCK ||
    params.containerSelector !== DRUPAL_PRESETS.ABRIR_LICITACION.containerSelector
  ) {
    return {};
  }

  return {
    [readText(params.sourceNamespace, DEFAULT_DRUPAL_SOURCE_NAMESPACE)]: {
      [readText(params.sourceField, DEFAULT_DRUPAL_SOURCE_FIELD)]: SAMPLE_TENDER_MARKUP,
    },
  };
};

/**
 * Contexto `{ namespace: { campo: ejemplo } }` a partir de lo simulado.
 *
 * Los `overrides` ganan campo a campo y anaden su namespace aunque no este
 * marcado: el nodo lo necesita para ejecutarse, y obligar a marcarlo antes de
 * ver el ejemplo seria un paso que nadie sabria que falta.
 */
export const buildSampleContext = (
  context: readonly UpstreamNamespace[],
  overrides: SampleOverrides = {},
): Record<string, Record<string, unknown>> => {
  const generated: Record<string, Record<string, unknown>> = Object.fromEntries(
    context.map(({ namespace, fields }) => [
      namespace,
      Object.fromEntries(
        fields.map((field) => [field.name, SAMPLE_BY_TYPE[field.type](field.name)]),
      ),
    ]),
  );

  return Object.entries(overrides).reduce(
    (merged, [namespace, fields]) => ({
      ...merged,
      [namespace]: { ...(merged[namespace] ?? {}), ...fields },
    }),
    generated,
  );
};

/**
 * El contexto con el adjunto de una prueba de OCR en `raw_email.attachments`.
 *
 * Devuelve un objeto NUEVO: el contexto editado por el operador no se muta.
 */
export const withAttachment = (
  context: Record<string, Record<string, unknown>>,
  attachment: SandboxAttachment,
): Record<string, Record<string, unknown>> => ({
  ...context,
  [RAW_EMAIL_NAMESPACE]: {
    ...(context[RAW_EMAIL_NAMESPACE] ?? {}),
    attachments: [attachment],
  },
});

/**
 * Parsea el JSON del editor como contexto simulado, o devuelve el motivo.
 *
 * Exige la forma que valida el backend: un objeto cuyos valores son objetos.
 */
export const parseSampleContext = (
  text: string,
): { readonly context: Record<string, Record<string, unknown>> } | { readonly error: string } => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: 'El contexto simulado no es JSON valido.' };
  }

  const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

  if (!isPlainObject(parsed) || !Object.values(parsed).every(isPlainObject)) {
    return { error: 'Debe ser un objeto { namespace: { campo: valor } }.' };
  }

  return { context: parsed as Record<string, Record<string, unknown>> };
};

/** Contenido de un archivo en base64, sin el prefijo `data:...;base64,`. */
export const readFileAsBase64 = (file: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('No se pudo leer el archivo.'));
    reader.readAsDataURL(file);
  });
