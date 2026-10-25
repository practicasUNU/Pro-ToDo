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

/** Contexto `{ namespace: { campo: ejemplo } }` a partir de lo simulado. */
export const buildSampleContext = (
  context: readonly UpstreamNamespace[],
): Record<string, Record<string, unknown>> =>
  Object.fromEntries(
    context.map(({ namespace, fields }) => [
      namespace,
      Object.fromEntries(
        fields.map((field) => [field.name, SAMPLE_BY_TYPE[field.type](field.name)]),
      ),
    ]),
  );

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
