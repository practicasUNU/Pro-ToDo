import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Reconstruye el `texto_prompt` VIVO componiendo las migraciones SQL.
 *
 * POR QUE EXISTE. El mapeo de universidades tiene dos fuentes que deben decir lo
 * mismo: el catalogo `DRUPAL_UNIVERSITIES_CATALOG` y la tabla que viaja dentro
 * del prompt sembrado en `plantillas_prompts_ia`. La segunda no vive en ningun
 * fichero: vive en PostgreSQL, y lo unico que el repositorio guarda son las
 * migraciones que la han ido construyendo. Para poder compararlas en una prueba
 * unitaria —sin base de datos— hay que reproducir aqui lo que psql hace alla.
 *
 * POR QUE NO BASTA CON LEER UNA MIGRACION. El test original abria la 035 por
 * ruta fija. Funcionaba mientras la 035 fuese la ultima palabra sobre el prompt,
 * y dejo de funcionar en cuanto la 036 la parcheo: desde entonces el fichero 035
 * ya no describe lo que hay en la base de datos. Apuntar la ruta a la migracion
 * mas reciente solo mueve el problema a la siguiente. Componerlas todas es lo
 * unico que sobrevive a las correcciones futuras sin volver a tocarse.
 *
 * QUE NO HACE. No es un motor de SQL. Entiende las dos unicas formas que las
 * migraciones de este repositorio usan sobre `texto_prompt` —una asignacion de
 * literales concatenados y un `REPLACE` de dos argumentos— y nada mas. Una
 * migracion futura que use otra construccion debera ampliar esto; el test que lo
 * consume se pondra rojo, que es exactamente lo que debe pasar.
 */

/** Raiz del repositorio: este fichero esta en `backend/test/helpers/`. */
const MIGRATIONS_DIR = resolve(__dirname, '../../../db/migrations');

/**
 * Un literal de cadena de PostgreSQL, con su prefijo `E` opcional.
 *
 * El prefijo importa: `E'\n'` es un salto de linea real y `'\n'` son dos
 * caracteres. Las migraciones usan el primero para separar las lineas del
 * prompt, de modo que tratarlos igual pegaria toda la tabla de universidades en
 * un solo renglon.
 */
const SQL_LITERAL = /(E?)'((?:[^']|'')*)'/g;

/** Nombre de la fila cuyo prompt se reconstruye. */
const PROMPT_CODE = 'VERIFICADOR_TITULOS_DEFAULT';

/** Devuelve el valor real de un literal SQL ya recortado de sus comillas. */
const decodeLiteral = (raw: string, isEscapeString: boolean): string => {
  // La comilla simple se escapa duplicandola, en las dos variantes de literal.
  const unquoted = raw.replace(/''/g, "'");

  if (!isEscapeString) {
    return unquoted;
  }

  return unquoted
    .replace(/\\\\/g, '\\')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t');
};

/** Todos los literales de un fragmento, en orden de aparicion. */
const literalsIn = (segment: string): readonly string[] =>
  [...segment.matchAll(SQL_LITERAL)].map((match) =>
    decodeLiteral(match[2] ?? '', match[1] === 'E'),
  );

/**
 * El fragmento que va desde `SET texto_prompt =` hasta `actualizado_en`.
 *
 * Cortar en `actualizado_en` y no al final de la sentencia es lo que mantiene
 * fuera a los `SELECT` de comprobacion del final de cada migracion, que estan
 * llenos de literales `'%...%'` que no tienen nada que ver con el prompt.
 */
const assignmentIn = (chunk: string): string | null => {
  const start = chunk.indexOf('SET texto_prompt =');

  if (start === -1) {
    return null;
  }

  const rest = chunk.slice(start + 'SET texto_prompt ='.length);
  const end = rest.indexOf('actualizado_en');

  return end === -1 ? rest : rest.slice(0, end);
};

/**
 * El `texto_prompt` tal y como quedaria en la base de datos tras aplicar, en
 * orden, todas las migraciones del repositorio.
 *
 * El orden es el alfabetico de los nombres de fichero, que por el prefijo
 * numerico (`035-`, `036-`, `037-`) coincide con el de aplicacion.
 */
export const composeSeededPrompt = (): string => {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  let prompt = '';

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');

    // Se trocea por la sentencia y no por fichero: la 036 toca el prompt DOS
    // veces, con un UPDATE sobre `plantillas_html` en medio.
    const chunks = sql.split('UPDATE plantillas_prompts_ia').slice(1);

    for (const chunk of chunks) {
      if (!chunk.includes(PROMPT_CODE)) {
        continue;
      }

      const assignment = assignmentIn(chunk);

      if (assignment === null) {
        continue;
      }

      const literals = literalsIn(assignment);

      if (assignment.trimStart().startsWith('REPLACE(')) {
        const [target, replacement] = literals;

        if (target !== undefined && replacement !== undefined) {
          prompt = prompt.split(target).join(replacement);
        }

        continue;
      }

      // Asignacion completa: reemplaza lo acumulado. Es lo que hacen la 032, la
      // 034 y la 035, cada una reescribiendo el prompt entera.
      prompt = literals.join('');
    }
  }

  return prompt;
};

/**
 * Los sub-acordeones que el prompt vivo manda escribir en `data-parent`.
 *
 * Descarta el valor de relleno de la plantilla: no es una universidad, es la
 * marca de «esto lo tienes que sustituir tu».
 */
export const accordionsInSeededPrompt = (): readonly string[] =>
  [...composeSeededPrompt().matchAll(/data-parent="(#accordion[A-Za-z0-9]+)"/g)]
    .map((match) => match[1] ?? '')
    .filter((id) => id !== '#accordionPadreId');
