import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { resolveTestDatabase } from '@test/helpers/test-database.resolver';

import type { SpawnSyncReturns } from 'node:child_process';

/**
 * Resolucion de la base de pruebas E2E desde `E2E_DB_NAME`.
 *
 * Vive bajo `test/` con sufijo `.e2e-spec.ts` porque `jest.rootDir` es `src`:
 * `npm test` no ejecuta specs de `test/`. NO toca la base de datos: la regla es
 * una funcion pura y el envoltorio bash se ejecuta sobre un `.env` ficticio en
 * un directorio temporal. Los nombres de base son ficticios (REGLA 1).
 */
const DEV_DB = 'fake_dev_db';
const TEST_DB = 'fake_test_db';
const OVERRIDE_DB = 'fake_override_db';

const REPO_ROOT = resolve(__dirname, '../../..');
const WRAPPER_SOURCE = join(REPO_ROOT, 'scripts/with-test-env.sh');
const JEST_E2E_CONFIG = resolve(__dirname, '../jest-e2e.json');

/** Monta `<tmp>/scripts/with-test-env.sh` + `<tmp>/backend/.env` y lo ejecuta. */
const runWrapper = (
  envFileContent: string,
  command: string[],
  extraEnv: Record<string, string> = {},
): SpawnSyncReturns<string> => {
  const root = mkdtempSync(join(tmpdir(), 'protodo-e2e-env-'));

  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'backend'));
    copyFileSync(WRAPPER_SOURCE, join(root, 'scripts/with-test-env.sh'));
    writeFileSync(join(root, 'backend/.env'), envFileContent);

    return spawnSync(
      'bash',
      [join(root, 'scripts/with-test-env.sh'), ...command],
      {
        encoding: 'utf8',
        // Entorno limpio: sin el DB_NAME que pudiera traer quien lanza la suite.
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...extraEnv },
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

describe('resolveTestDatabase', () => {
  it('toma E2E_DB_NAME de backend/.env cuando no llega DB_NAME por el entorno', () => {
    // Arrange 📐
    const fileEnv = { DB_NAME: DEV_DB, E2E_DB_NAME: TEST_DB };

    // Act ⚙️
    const result = resolveTestDatabase({ fileEnv });

    // Assert 🎯
    expect(result).toEqual({
      dbName: TEST_DB,
      source: 'e2e-db-name',
      warning: undefined,
    });
  });

  it('prefiere un E2E_DB_NAME exportado al del archivo', () => {
    // Arrange 📐
    const fileEnv = { DB_NAME: DEV_DB, E2E_DB_NAME: TEST_DB };

    // Act ⚙️
    const result = resolveTestDatabase({ envE2eDbName: OVERRIDE_DB, fileEnv });

    // Assert 🎯
    expect(result.dbName).toBe(OVERRIDE_DB);
  });

  it('respeta un DB_NAME explicito distinto del de desarrollo', () => {
    // Arrange 📐
    const fileEnv = { DB_NAME: DEV_DB, E2E_DB_NAME: TEST_DB };

    // Act ⚙️
    const result = resolveTestDatabase({
      envDbName: ` ${OVERRIDE_DB}\r`,
      fileEnv,
    });

    // Assert 🎯
    expect(result).toEqual({ dbName: OVERRIDE_DB, source: 'cli' });
  });

  it('descarta con aviso un DB_NAME heredado que apunta a desarrollo', () => {
    // Arrange 📐
    const fileEnv = { DB_NAME: DEV_DB, E2E_DB_NAME: TEST_DB };

    // Act ⚙️
    const result = resolveTestDatabase({ envDbName: DEV_DB, fileEnv });

    // Assert 🎯
    expect(result.dbName).toBe(TEST_DB);
    expect(result.source).toBe('e2e-db-name');
    expect(result.warning).toContain('heredado');
  });

  it('aborta si E2E_DB_NAME coincide con DB_NAME de desarrollo', () => {
    // Arrange 📐
    const fileEnv = { DB_NAME: DEV_DB, E2E_DB_NAME: DEV_DB };

    // Act ⚙️
    const act = (): unknown => resolveTestDatabase({ fileEnv });

    // Assert 🎯
    expect(act).toThrow(/base de desarrollo/);
  });

  it('aborta si E2E_DB_NAME esta vacio y no hay override', () => {
    // Arrange 📐
    const fileEnv = { DB_NAME: DEV_DB, E2E_DB_NAME: '   ' };

    // Act ⚙️
    const act = (): unknown =>
      resolveTestDatabase({ envDbName: DEV_DB, fileEnv });

    // Assert 🎯
    expect(act).toThrow(/Falta E2E_DB_NAME/);
  });

  it('aborta si no hay ni backend/.env ni variables de entorno', () => {
    // Arrange 📐
    const fileEnv = {};

    // Act ⚙️
    const act = (): unknown => resolveTestDatabase({ fileEnv });

    // Assert 🎯
    expect(act).toThrow(/Falta E2E_DB_NAME/);
  });
});

describe('scripts/with-test-env.sh', () => {
  it('exporta E2E_DB_NAME como DB_NAME sin pasar DB_NAME por la linea de comandos', () => {
    // Arrange 📐
    const envFile = `DB_NAME=${DEV_DB}\r\nE2E_DB_NAME="${TEST_DB}" # comentario\r\n`;

    // Act ⚙️
    const result = runWrapper(envFile, ['printenv', 'DB_NAME']);

    // Assert 🎯
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(TEST_DB);
  });

  it('sustituye con aviso un DB_NAME heredado de desarrollo', () => {
    // Arrange 📐
    const envFile = `DB_NAME=${DEV_DB}\nE2E_DB_NAME=${TEST_DB}\n`;

    // Act ⚙️
    const result = runWrapper(envFile, ['printenv', 'DB_NAME'], {
      DB_NAME: DEV_DB,
    });

    // Assert 🎯
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(TEST_DB);
    expect(result.stderr).toContain('heredado');
  });

  it('respeta un override explicito DB_NAME distinto del de desarrollo', () => {
    // Arrange 📐
    const envFile = `DB_NAME=${DEV_DB}\nE2E_DB_NAME=${TEST_DB}\n`;

    // Act ⚙️
    const result = runWrapper(envFile, ['printenv', 'DB_NAME'], {
      DB_NAME: OVERRIDE_DB,
    });

    // Assert 🎯
    expect(result.stdout.trim()).toBe(OVERRIDE_DB);
  });

  it('aborta sin ejecutar el comando si E2E_DB_NAME es la base de desarrollo', () => {
    // Arrange 📐
    const envFile = `DB_NAME=${DEV_DB}\nE2E_DB_NAME=${DEV_DB}\n`;

    // Act ⚙️
    const result = runWrapper(envFile, ['echo', 'REACHED']);

    // Assert 🎯
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('REACHED');
    expect(result.stderr).toContain('base de desarrollo');
  });

  it('aborta sin ejecutar el comando si falta E2E_DB_NAME', () => {
    // Arrange 📐
    const envFile = `DB_NAME=${DEV_DB}\n`;

    // Act ⚙️
    const result = runWrapper(envFile, ['echo', 'REACHED']);

    // Assert 🎯
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('REACHED');
    expect(result.stderr).toContain('Falta E2E_DB_NAME');
  });
});

describe('test/jest-e2e.json', () => {
  it('carga la guarda en setupFiles, antes de que ningun spec importe AppModule', () => {
    // Arrange 📐
    const config = JSON.parse(readFileSync(JEST_E2E_CONFIG, 'utf8')) as {
      setupFiles?: string[];
    };

    // Act ⚙️
    const setupFiles = config.setupFiles ?? [];

    // Assert 🎯
    expect(setupFiles).toContain('<rootDir>/helpers/e2e-database.guard.ts');
  });
});
