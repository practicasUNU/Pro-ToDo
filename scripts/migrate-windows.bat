@echo off
REM ===========================================================================
REM Aplica las migraciones pendientes de db\migrations\ DENTRO del contenedor
REM postgres (docker compose exec), sin psql en el anfitrion ni Git Bash.
REM
REM Misma semantica que scripts/migrate-linux.sh y scripts/apply-migrations.sh:
REM la tabla schema_migrations guarda cada archivo ya aplicado; solo se ejecuta
REM lo que falta, en orden ascendente, y se corta en el primer fallo. NO se
REM reaplica toda la historia: init.sql es el acumulado final y no se puede
REM encadenar con ella (docs\commands.md, seccion 3.1.2).
REM
REM Un volumen nuevo ya nace con schema_migrations en baseline
REM (db\docker-init\02-bootstrap.sh). Una base anterior no la tiene: el script
REM se detiene y pide --baseline, que las registra SIN ejecutarlas. Usalo una
REM sola vez y solo si la base ya esta al dia.
REM
REM Si E2E_DB_NAME esta definida y esa base existe, se migra tambien.
REM
REM Uso:  scripts\migrate-windows.bat [--baseline] [--no-pause]
REM
REM Las consultas a psql se vuelcan a un archivo temporal y se leen con
REM `set /p`: evita los problemas de comillas y parentesis de `for /f` con SQL.
REM ===========================================================================
setlocal EnableExtensions DisableDelayedExpansion

cd /d "%~dp0.."

set "ENV_FILE=backend\.env"
set "MIGRATIONS_DIR=db\migrations"
set "MAX_WAIT_ATTEMPTS=30"
set "BASELINE=0"
set "EXIT_CODE=0"
set "QUERY_FILE=%TEMP%\protodo-migrate-%RANDOM%-query.txt"
set "APPLIED_FILE=%TEMP%\protodo-migrate-%RANDOM%-applied.txt"

:parse_args
if "%~1"=="" goto :args_done
if /i "%~1"=="--baseline" set "BASELINE=1"
if /i "%~1"=="--no-pause" set "PROTODO_NO_PAUSE=1"
shift /1
goto :parse_args
:args_done

REM --- Lectura de backend\.env (el entorno manda sobre el archivo) ----------
REM Solo se miran las claves que interesan; el valor (%%B) no se reinterpreta,
REM asi que los secretos con caracteres especiales de otras lineas no molestan.
set "FILE_DB_USER="
set "FILE_DB_NAME="
set "FILE_E2E_DB_NAME="
if not exist "%ENV_FILE%" goto :env_read
for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%ENV_FILE%") do (
  if /i "%%A"=="DB_USER" set "FILE_DB_USER=%%B"
  if /i "%%A"=="DB_NAME" set "FILE_DB_NAME=%%B"
  if /i "%%A"=="E2E_DB_NAME" set "FILE_E2E_DB_NAME=%%B"
)
:env_read
if defined FILE_DB_USER set "FILE_DB_USER=%FILE_DB_USER:"=%"
if defined FILE_DB_NAME set "FILE_DB_NAME=%FILE_DB_NAME:"=%"
if defined FILE_E2E_DB_NAME set "FILE_E2E_DB_NAME=%FILE_E2E_DB_NAME:"=%"
if not defined DB_USER set "DB_USER=%FILE_DB_USER%"
if not defined DB_NAME set "DB_NAME=%FILE_DB_NAME%"
if not defined E2E_DB_NAME set "E2E_DB_NAME=%FILE_E2E_DB_NAME%"
if not defined DB_USER set "DB_USER=postgres"
if not defined DB_NAME set "DB_NAME=protodo"

set "COMPOSE=docker compose"
if exist "%ENV_FILE%" set "COMPOSE=docker compose --env-file %ENV_FILE%"

REM --- Espera a que postgres pase pg_isready ---------------------------------
echo == Esperando a PostgreSQL - pg_isready
set /a ATTEMPT=0
:wait_pg
%COMPOSE% exec -T postgres pg_isready -U "%DB_USER%" -d "%DB_NAME%" >nul 2>&1
if not errorlevel 1 goto :pg_ready
set /a ATTEMPT+=1
if %ATTEMPT% geq %MAX_WAIT_ATTEMPTS% goto :pg_timeout
call :sleep 2
goto :wait_pg

:pg_timeout
echo PostgreSQL no responde. Comprueba que los contenedores estan arriba:
echo   docker compose --env-file backend\.env ps
echo   docker compose --env-file backend\.env logs postgres
echo Si no lo estan, ejecuta scripts\setup-windows.bat
set "EXIT_CODE=1"
goto :end

:pg_ready
if "%BASELINE%"=="1" echo == Modo BASELINE: se registran sin ejecutar

call :migrate_database "%DB_NAME%"
if errorlevel 1 goto :failed

REM El baseline es una decision sobre UNA base concreta: nunca toca la E2E.
if "%BASELINE%"=="1" goto :end
if not defined E2E_DB_NAME goto :end
if /i "%E2E_DB_NAME%"=="%DB_NAME%" goto :end

call :query postgres "SELECT 1 FROM pg_database WHERE datname = '%E2E_DB_NAME%'"
if errorlevel 1 goto :failed
if not "%QUERY_RESULT%"=="1" goto :e2e_missing

call :query "%E2E_DB_NAME%" "SELECT to_regclass('public.schema_migrations') IS NOT NULL"
if errorlevel 1 goto :failed
if not "%QUERY_RESULT%"=="t" goto :e2e_untracked

call :migrate_database "%E2E_DB_NAME%"
if errorlevel 1 goto :failed
goto :end

:e2e_missing
echo -- %E2E_DB_NAME% - E2E_DB_NAME - no existe en el contenedor: se omite.
echo    Se crea con: npm run test:bootstrap --prefix backend
goto :end

:e2e_untracked
echo -- %E2E_DB_NAME% - E2E_DB_NAME - no tiene schema_migrations: se omite.
echo    Recreala con: npm run test:bootstrap --prefix backend
goto :end

:failed
set "EXIT_CODE=1"
goto :end

REM ===========================================================================
REM :migrate_database <base>
REM ===========================================================================
:migrate_database
set "TARGET_DB=%~1"
set /a APPLIED=0
set /a SKIPPED=0
set "MIGRATION_FAILED="
echo == Migraciones sobre %TARGET_DB%

call :query "%TARGET_DB%" "SELECT to_regclass('public.schema_migrations') IS NOT NULL"
if errorlevel 1 exit /b 1
if "%QUERY_RESULT%"=="t" goto :table_present
if "%BASELINE%"=="1" goto :table_present

echo.
echo La base "%TARGET_DB%" no tiene la tabla schema_migrations, asi que no se
echo sabe que migraciones tiene aplicadas. Si la base ya esta al dia, adoptala
echo UNA vez con:   scripts\migrate-windows.bat --baseline
echo Si no lo esta, aplica a mano las que falten - docs\commands.md seccion 3.1 -
echo y despues ejecuta el baseline.
exit /b 1

:table_present
%COMPOSE% exec -T postgres psql -v ON_ERROR_STOP=1 --quiet -U "%DB_USER%" -d "%TARGET_DB%" -c "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());" >nul
if errorlevel 1 exit /b 1

REM Una sola consulta con todas las versiones aplicadas, en vez de una por archivo.
%COMPOSE% exec -T postgres psql -tA -U "%DB_USER%" -d "%TARGET_DB%" -c "SELECT version FROM schema_migrations" > "%APPLIED_FILE%"
if errorlevel 1 exit /b 1

REM `dir /on`: orden ascendente por nombre (los prefijos NNN- van con ceros).
for /f "delims=" %%F in ('dir /b /a-d /on "%MIGRATIONS_DIR%\*.sql"') do call :migrate_file "%%F"

del "%APPLIED_FILE%" >nul 2>&1
if defined MIGRATION_FAILED exit /b 1

if "%BASELINE%"=="1" echo == %TARGET_DB%: %APPLIED% registradas como aplicadas, %SKIPPED% ya estaban.
if not "%BASELINE%"=="1" echo == %TARGET_DB%: %APPLIED% aplicadas, %SKIPPED% ya estaban.
exit /b 0

REM ===========================================================================
REM :migrate_file <archivo.sql>. Tras el primer fallo no hace nada mas.
REM ===========================================================================
:migrate_file
if defined MIGRATION_FAILED goto :eof
set "VERSION=%~1"

findstr /x /l /c:"%VERSION%" "%APPLIED_FILE%" >nul 2>&1
if errorlevel 1 goto :migrate_file_pending
set /a SKIPPED+=1
goto :eof

:migrate_file_pending
if "%BASELINE%"=="1" goto :migrate_file_baseline
echo -- aplicando %VERSION%
%COMPOSE% exec -T postgres psql -v ON_ERROR_STOP=1 --quiet -U "%DB_USER%" -d "%TARGET_DB%" < "%MIGRATIONS_DIR%\%VERSION%"
if errorlevel 1 goto :migrate_file_error
goto :migrate_file_register

:migrate_file_baseline
echo -- registrando sin ejecutar %VERSION%

:migrate_file_register
REM El registro va DESPUES: si la migracion falla no queda marcada y el
REM siguiente intento la reintenta en vez de darla por buena.
%COMPOSE% exec -T postgres psql -v ON_ERROR_STOP=1 --quiet -U "%DB_USER%" -d "%TARGET_DB%" -c "INSERT INTO schema_migrations (version) VALUES ('%VERSION%') ON CONFLICT (version) DO NOTHING;" >nul
if errorlevel 1 goto :migrate_file_error
set /a APPLIED+=1
goto :eof

:migrate_file_error
echo.
echo ERROR al aplicar %VERSION% sobre %TARGET_DB%. Se detiene aqui; las
echo siguientes no se han ejecutado. Corrige el problema y vuelve a lanzar.
set "MIGRATION_FAILED=1"
goto :eof

REM ===========================================================================
REM :query <base> "<sql>"  ->  QUERY_RESULT (primera linea, sin formato)
REM ===========================================================================
:query
set "QUERY_RESULT="
%COMPOSE% exec -T postgres psql -tA -U "%DB_USER%" -d "%~1" -c "%~2" > "%QUERY_FILE%"
if errorlevel 1 exit /b 1
set /p QUERY_RESULT=<"%QUERY_FILE%"
del "%QUERY_FILE%" >nul 2>&1
exit /b 0

REM ===========================================================================
REM :sleep <segundos>. `timeout` falla con la entrada redirigida: usa ping.
REM ===========================================================================
:sleep
timeout /t %~1 /nobreak >nul 2>&1
if errorlevel 1 ping -n %~1 127.0.0.1 >nul 2>&1
goto :eof

:end
del "%QUERY_FILE%" >nul 2>&1
del "%APPLIED_FILE%" >nul 2>&1
if defined PROTODO_NO_PAUSE goto :exit
REM Pausa solo si la consola la abrio el propio .bat (doble clic: cmd.exe /c).
set "CMD_LINE=%CMDCMDLINE:"=%"
if /i not "%CMD_LINE:/c =%"=="%CMD_LINE%" pause
:exit
endlocal & exit /b %EXIT_CODE%
