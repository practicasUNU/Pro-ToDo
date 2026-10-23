import path from 'node:path';

/**
 * Nombre de un fichero de traza valido: los dos prefijos que escribe
 * `HybridLoggerService` con su fecha (`resolveCurrentPath`). Nada mas.
 */
const LOG_FILE_NAME_PATTERN = /^(?:fsm|execution)-\d{4}-\d{2}-\d{2}\.log$/;

/**
 * Prefijo absoluto de una ruta del stack, hasta la primera carpeta de proyecto
 * reconocible. `/var/www/app/backend/src/x.ts` -> `src/x.ts`. Perezoso a
 * proposito: recorta hasta la PRIMERA coincidencia, no hasta la ultima.
 */
const ABSOLUTE_STACK_PREFIX =
  /(?:file:\/\/)?\/[^\s()]*?\/(?=(?:src|dist|node_modules|test)\/)/g;

/** Entrada de un `.log` tal como la serializa Winston (JSON Lines). */
export type LogFileEntry = Record<string, unknown>;

/**
 * Ruta absoluta y SEGURA de un fichero de traza, o `null` si no lo es.
 *
 * La ruta llega de la base de datos (`ruta_archivo_log`), pero se trata como
 * entrada no confiable: una fila manipulada con `../../etc/passwd` convertiria
 * este endpoint en un lector de ficheros arbitrarios del servidor. Por eso:
 *
 * 1. Solo se conserva el NOMBRE base y debe casar con el patron de los ficheros
 *    que escribe el propio logger; el directorio guardado se descarta.
 * 2. Se resuelve dentro de `logDir` y se comprueba que el resultado sigue
 *    dentro (defensa en profundidad frente a enlaces o separadores raros).
 */
export const resolveLogFile = (
  logDir: string,
  storedPath: string | null | undefined,
): string | null => {
  if (storedPath === null || storedPath === undefined) return null;

  const fileName = path.basename(storedPath.trim());

  if (!LOG_FILE_NAME_PATTERN.test(fileName)) return null;

  const root = path.resolve(logDir);
  const resolved = path.resolve(root, fileName);

  return resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
};

/**
 * Recorta las rutas absolutas de un stack trace a rutas relativas al proyecto.
 *
 * El stack es lo que se viene a inspeccionar y se conserva entero, pero las
 * rutas absolutas revelarian la estructura de directorios del servidor a
 * cualquiera con acceso al panel. Las rutas sin carpeta reconocible
 * (`node:internal/...`) ya no son absolutas y quedan intactas.
 */
export const relativizeStackPaths = (stackTrace: string): string =>
  stackTrace.replace(ABSOLUTE_STACK_PREFIX, '');

/**
 * Entrada lista para salir por la API.
 *
 * Sin `payload`: lleva el contexto acumulado de la ejecucion, es decir, el
 * cuerpo de los correos, los adjuntos y las salidas de la IA. Para diagnosticar
 * un fallo basta el mensaje, el codigo y el stack; el contenido de negocio se
 * consulta en el detalle de la ejecucion, con sus propias reglas.
 */
export const sanitizeLogEntry = (entry: LogFileEntry): LogFileEntry => {
  const rest: LogFileEntry = Object.fromEntries(
    Object.entries(entry).filter(([key]) => key !== 'payload'),
  );

  return typeof rest.stackTrace === 'string'
    ? { ...rest, stackTrace: relativizeStackPaths(rest.stackTrace) }
    : rest;
};
