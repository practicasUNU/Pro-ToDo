import { readEnvFile, resolveTestDatabase } from './test-database.resolver';

/**
 * Guarda de base de datos de las suites e2e.
 *
 * POR QUE EXISTE. Las suites montan el `AppModule` REAL, siembran y borran filas,
 * y `FsmModule.onModuleInit` pausa sin filtro toda ejecucion EN_PROCESO. Contra
 * la base de desarrollo eso destruye datos ajenos. El nombre de la base de
 * pruebas no vive en el repositorio: lo declara cada maquina en `E2E_DB_NAME`
 * de `backend/.env`, y `DB_NAME=...` en la linea de comandos sigue sirviendo
 * como override explicito. La regla completa esta en `resolveTestDatabase`.
 *
 * Se carga con `setupFiles` de `test/jest-e2e.json`, es decir, antes de que el
 * spec importe nada. En ese momento `ConfigModule` aun no ha leido
 * `backend/.env`; como `ConfigModule` no pisa lo que ya esta en el entorno, el
 * `DB_NAME` que se fija aqui es la base que usara la aplicacion.
 *
 * Aborta (lanza) antes de abrir ninguna conexion si no hay base de pruebas o si
 * coincide con la de desarrollo.
 */
export const assertIsolatedTestDatabase = (): void => {
  const { dbName, warning } = resolveTestDatabase({
    envDbName: process.env.DB_NAME,
    envE2eDbName: process.env.E2E_DB_NAME,
    fileEnv: readEnvFile(),
  });

  if (warning) {
    console.warn(warning);
  }

  process.env.DB_NAME = dbName;
};

assertIsolatedTestDatabase();
