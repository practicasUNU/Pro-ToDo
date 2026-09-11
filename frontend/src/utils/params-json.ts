/**
 * Interpretacion del texto del editor de `params` de un nodo de plantilla.
 *
 * Union discriminada y no `Record | null`: el motivo del rechazo es lo que el
 * editor pinta bajo el campo, y devolverlo aparte obligaria a cada llamante a
 * recomponer el mensaje o a repetir el `JSON.parse` para averiguarlo.
 */
export type ParamsParseResult =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly message: string };

/** Indentacion del editor, la misma que usa el resto de vistas con JSON. */
const JSON_INDENT = 2;

/**
 * Interpreta el texto como un objeto JSON plano. Nunca lanza.
 *
 * Se rechazan los arreglos y `null` ademas de los escalares: `params` viaja a
 * `PipelineNodeConfigDto.params`, que exige `@IsObject()`, y un arreglo pasaria
 * el `typeof === 'object'` de JavaScript para ser rechazado despues por el
 * servidor con un mensaje mucho menos util que el de aqui.
 */
export const parseParamsObject = (text: string): ParamsParseResult => {
  if (text.trim() === '') {
    return {
      ok: false,
      message: 'Los parametros no pueden estar vacios; usa {} si el nodo no necesita ninguno.',
    };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // Se conserva el mensaje del motor de JS: dice la posicion exacta del
    // caracter que rompe el documento, que es justo lo que hace falta para
    // corregirlo y lo que un texto generico perderia.
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'JSON invalido.',
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, message: 'Los parametros deben ser un objeto JSON.' };
  }

  return { ok: true, value: parsed as Record<string, unknown> };
};

/** Serializa `params` con la indentacion del editor. */
export const stringifyParams = (params: Record<string, unknown>): string =>
  JSON.stringify(params, null, JSON_INDENT);

/**
 * Igualdad estructural entre dos `params`, para la guarda de eco del editor.
 *
 * El anfitrion devuelve al editor el mismo objeto que este acaba de emitir, y
 * reserializarlo destruiria el formato del autor y la posicion de su cursor. La
 * comparacion ordena las claves porque `JSON.stringify` respeta el orden de
 * insercion: sin eso, un objeto reconstruido con las mismas claves en distinto
 * orden se veria como un valor nuevo y reescribiria el editor sin motivo.
 */
export const areParamsEqual = (
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean => canonicalize(a) === canonicalize(b);

/** Serializacion estable: mismas claves y mismos valores dan el mismo texto. */
const canonicalize = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }

  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalize(nested)}`);

    return `{${entries.join(',')}}`;
  }

  return JSON.stringify(value) ?? 'null';
};
