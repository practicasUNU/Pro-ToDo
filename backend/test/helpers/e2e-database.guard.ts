import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Guarda de base de datos de las suites e2e.
 *
 * POR QUE EXISTE. Las suites montan el `AppModule` REAL, siembran y borran filas,
 * y `FsmModule.onModuleInit` pausa sin filtro toda ejecucion EN_PROCESO. Contra
 * la base de desarrollo eso destruye datos ajenos. Antes cada suite fijaba su
 * base con un nombre escrito en el codigo; ahora el nombre no vive en el
 * repositorio: llega por `DB_NAME` en el entorno de quien lanza el comando.
 *
 * Se carga con `setupFiles` de `test/jest-e2e.json`, es decir, antes de que el
 * spec importe nada. En ese momento `ConfigModule` aun no ha leido
 * `backend/.env`, asi que `process.env.DB_NAME` solo existe si se paso de
 * forma explicita; y como `ConfigModule` no pisa lo que ya esta en el entorno,
 * es esa la base que usara la aplicacion.
 *
 * Aborta en dos casos: si `DB_NAME` falta, o si coincide con la base de
 * desarrollo declarada en `backend/.env` (la trampa de un shell que hizo
 * `source backend/.env` para el servidor MCP).
 */
const ENV_FILE_PATH = resolve(__dirname, '../../.env');

/** Primera linea `DB_NAME=...` del `.env`, sin comillas ni CR (el archivo es CRLF). */
const DB_NAME_LINE = /^\s*DB_NAME\s*=\s*["']?([^"'\r\n#]*)["']?/m;

const USAGE =
  "Lanza la suite indicando la base de pruebas: DB_NAME='<nombre_bd_test>' npm run test:e2e";

const readDevelopmentDatabase = (): string | undefined => {
  if (!existsSync(ENV_FILE_PATH)) {
    return undefined;
  }

  const match = DB_NAME_LINE.exec(readFileSync(ENV_FILE_PATH, 'utf8'));
  return match?.[1]?.trim() || undefined;
};

export const assertIsolatedTestDatabase = (): void => {
  const target = process.env.DB_NAME?.trim();

  if (!target) {
    throw new Error(`[e2e] Falta DB_NAME en el entorno. ${USAGE}`);
  }

  if (target === readDevelopmentDatabase()) {
    throw new Error(
      `[e2e] DB_NAME apunta a la base de desarrollo de backend/.env. ${USAGE}`,
    );
  }

  // Se reescribe sin espacios ni CR por si llego de un `source` del `.env` CRLF.
  process.env.DB_NAME = target;
};

assertIsolatedTestDatabase();
