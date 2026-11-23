import Ajv from 'ajv';

import type { ErrorObject, ValidateFunction } from 'ajv';

/**
 * Compilacion de los JSON Schema que un operador declara en un nodo.
 *
 * Helper puro y compartido por DOS consumidores que tienen que opinar igual:
 * el DTO del `ESCUDO_POST_IA`, que rechaza un esquema invalido AL GUARDAR el
 * flujo, y la estrategia, que lo aplica en ejecucion. Si cada uno configurara su
 * propio `Ajv`, un esquema podria guardarse con una opcion y fallar con la otra
 * con el flujo ya PAUSADO.
 */

/**
 * Tope del esquema serializado. Un esquema es configuracion de un nodo, viaja
 * dentro del `pipeline_schema` y se compila en cada ejecucion: 16 KB sobran para
 * cualquier contrato de salida razonable y cortan un parametro desbocado.
 */
export const MAX_JSON_SCHEMA_LENGTH = 16_384;

/** Resultado de compilar: el validador o el motivo legible del rechazo. */
export type JsonSchemaCompilation =
  { readonly validate: ValidateFunction } | { readonly error: string };

/** Si un valor es un objeto plano (ni `null` ni arreglo). */
export const isPlainObject = (
  value: unknown,
): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Compila un esquema con las opciones CANONICAS del proyecto.
 *
 * - `strict: true`: una palabra clave desconocida o mal escrita (`requried`) es
 *   un error y no un esquema que lo acepta todo en silencio.
 * - `allErrors: true`: el operador ve todos los campos que fallan de una vez.
 * - Una instancia NUEVA por compilacion: `Ajv` cachea por `$id`, y dos nodos con
 *   el mismo `$id` y contratos distintos chocarian ("already exists").
 *
 * Sin `$data`, sin formatos externos ni `loadSchema`: nada que resuelva
 * referencias remotas. El esquema solo puede describir el objeto, no ir a buscar
 * nada fuera.
 */
export const compileJsonSchema = (schema: unknown): JsonSchemaCompilation => {
  if (!isPlainObject(schema)) {
    return { error: 'el esquema debe ser un objeto JSON' };
  }

  if (JSON.stringify(schema).length > MAX_JSON_SCHEMA_LENGTH) {
    return {
      error: `el esquema no puede superar ${MAX_JSON_SCHEMA_LENGTH} caracteres serializado`,
    };
  }

  try {
    const ajv = new Ajv({ strict: true, allErrors: true });

    return { validate: ajv.compile(schema) };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'esquema no compilable',
    };
  }
};

/**
 * Traduce los errores de `Ajv` a rutas con punto, prefijadas con la del
 * registro auditado: `/headline` -> `llm_response.headline`.
 *
 * Un `required` incumplido no trae la clave en `instancePath` (apunta al padre)
 * sino en `params.missingProperty`, y es justo el caso mas comun: se recompone.
 */
export const describeSchemaErrors = (
  errors: readonly ErrorObject[],
  label: string,
): { readonly paths: string[]; readonly messages: string[] } => {
  const paths: string[] = [];
  const messages: string[] = [];

  for (const error of errors) {
    const missing =
      error.keyword === 'required' &&
      typeof error.params['missingProperty'] === 'string'
        ? `/${error.params['missingProperty']}`
        : '';
    const pointer = `${error.instancePath}${missing}`;
    const path = `${label}${pointer.replace(/\//g, '.')}`;

    paths.push(path);
    messages.push(`${path} ${error.message ?? 'no cumple el esquema'}`);
  }

  return { paths: [...new Set(paths)], messages };
};
