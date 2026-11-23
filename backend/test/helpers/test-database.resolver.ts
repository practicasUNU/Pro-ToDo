import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

/** Variables de entorno ya parseadas (de `process.env` o de un `.env`). */
export type EnvRecord = Readonly<Record<string, string | undefined>>;

/** Entradas de la resolucion: lo que trae el entorno y lo que declara `backend/.env`. */
export interface TestDatabaseInput {
  /** `process.env.DB_NAME`: override por linea de comandos o herencia de `source backend/.env`. */
  envDbName?: string;
  /** `process.env.E2E_DB_NAME`: gana sobre el del archivo si alguien lo exporto. */
  envE2eDbName?: string;
  /** Contenido parseado de `backend/.env`. */
  fileEnv: EnvRecord;
}

/** Base resuelta y de donde salio. */
export interface TestDatabaseResolution {
  dbName: string;
  source: 'cli' | 'e2e-db-name';
  /** Presente cuando se descarto un `DB_NAME` heredado que apuntaba a desarrollo. */
  warning?: string;
}

/** `backend/.env`: este fichero esta en `backend/test/helpers/`. */
export const ENV_FILE_PATH = resolve(__dirname, '../../.env');

export const TEST_DATABASE_USAGE =
  "Declara E2E_DB_NAME='<nombre_bd_test>' en backend/.env (distinto de DB_NAME) " +
  "o lanza con un override explicito: DB_NAME='<nombre_bd_test>' npm run test:e2e";

/** Recorta espacios y CR; una cadena vacia cuenta como ausente. */
const clean = (value?: string): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/**
 * Lee un `.env` con el parser nativo de Node (`util.parseEnv`), sin dependencias.
 * Si el archivo no existe devuelve un objeto vacio: en CI todo puede llegar por
 * el entorno.
 */
export const readEnvFile = (path: string = ENV_FILE_PATH): EnvRecord => {
  if (!existsSync(path)) {
    return {};
  }

  return parseEnv(readFileSync(path, 'utf8'));
};

/**
 * Decide contra que base corren las suites e2e. Funcion PURA: no lee el disco ni
 * toca `process.env`, de modo que se prueba sin base de datos.
 *
 * PRECEDENCIA (la misma que aplica `scripts/with-test-env.sh`):
 *   1. `DB_NAME` del entorno distinto del `DB_NAME` de `backend/.env` -> override
 *      explicito, se respeta.
 *   2. `DB_NAME` del entorno IGUAL al de desarrollo -> no puede ser intencionado
 *      (es la herencia de `set -a && source backend/.env`, el modismo del MCP):
 *      se descarta con aviso y se usa `E2E_DB_NAME`.
 *   3. Sin `DB_NAME` en el entorno -> `E2E_DB_NAME` (entorno y, si no, archivo).
 *
 * Aborta si el resultado esta vacio o coincide con la base de desarrollo: las
 * suites montan el `AppModule` real, siembran y borran filas, y
 * `FsmModule.onModuleInit` pausa sin filtro toda ejecucion EN_PROCESO.
 */
export const resolveTestDatabase = ({
  envDbName,
  envE2eDbName,
  fileEnv,
}: TestDatabaseInput): TestDatabaseResolution => {
  const developmentDb = clean(fileEnv.DB_NAME);
  const explicitDb = clean(envDbName);

  if (explicitDb && explicitDb !== developmentDb) {
    return { dbName: explicitDb, source: 'cli' };
  }

  const e2eDb = clean(envE2eDbName) ?? clean(fileEnv.E2E_DB_NAME);

  if (!e2eDb) {
    throw new Error(`[e2e] Falta E2E_DB_NAME. ${TEST_DATABASE_USAGE}`);
  }

  if (e2eDb === developmentDb) {
    throw new Error(
      `[e2e] E2E_DB_NAME apunta a la base de desarrollo (DB_NAME de backend/.env). ${TEST_DATABASE_USAGE}`,
    );
  }

  const warning = explicitDb
    ? '[e2e] DB_NAME del entorno es la base de desarrollo (heredado de `source backend/.env`); se usa E2E_DB_NAME.'
    : undefined;

  return { dbName: e2eDb, source: 'e2e-db-name', warning };
};
