@echo off
REM ===========================================================================
REM Aplica las migraciones pendientes de db\migrations\ DENTRO del contenedor
REM postgres (docker compose exec), sin psql en el anfitrion ni Git Bash.
REM
REM Misma semantica que scripts/migrate-linux.sh y scripts/apply-migrations.sh:
REM la tabla schema_migrations guarda cada archivo ya aplicado (su nombre, p. ej.
REM 005-tipos-nodo-fsm.sql, igual que db\docker-init\02-bootstrap.sh); solo se
REM ejecuta lo que falta, en orden ascendente, y se corta en el primer fallo. NO
REM se reaplica toda la historia: init.sql es el acumulado final y no se puede
REM encadenar con ella (docs\commands.md, seccion 3.1.2).
REM
REM Un volumen nuevo ya nace con schema_migrations en baseline
REM (db\docker-init\02-bootstrap.sh). Una base anterior no la tiene: el script
REM se detiene y pide --baseline, que las registra SIN ejecutarlas. Usalo una
REM sola vez y solo si la base ya esta al dia.
REM
REM Configuracion: solo backend\.env (scripts\lib\env.bat), sin valores por
REM defecto. psql dentro del contenedor usa el puerto interno (PGPORT = DB_PORT),
REM por eso no lleva -p.
REM
REM BASE E2E. Si E2E_DB_NAME tiene valor (y es distinta de DB_NAME), tambien se
REM atiende, sin npm ni psql en el anfitrion:
REM   - No existe: se CREA como un volumen nuevo (init.sql + 02-bootstrap.sh:
REM     baseline, ADMIN, semilla 069) y despues se migra. NO se le aplican las
REM     69 migraciones desde cero: la historia no se puede encadenar.
REM   - Existe con schema_migrations: se migra como DB_NAME.
REM   - Existe sin schema_migrations: se omite y se indica como recrearla.
REM
REM Uso:  scripts\migrate-windows.bat [--baseline] [--no-pause]
REM
REM Las consultas a psql se vuelcan a un archivo temporal y se leen con
REM `set /p` o `for /f`: evita los problemas de comillas y parentesis de
REM `for /f` con SQL en linea.
REM ===========================================================================
setlocal EnableExtensions DisableDelayedExpansion

cd /d "%~dp0.."

set "ENV_FILE=backend\.env"
set "MIGRATIONS_DIR=db\migrations"
set "MAX_WAIT_ATTEMPTS=30"
set "BASELINE=0"
set "EXIT_CODE=0"
set "TEMP_PREFIX=%TEMP%\protodo-migrate-%RANDOM%%RANDOM%"
set "QUERY_FILE=%TEMP_PREFIX%-query.txt"
set "APPLIED_RAW=%TEMP_PREFIX%-applied-raw.txt"
set "APPLIED_FILE=%TEMP_PREFIX%-applied.txt"
set "SQL_FILE=%TEMP_PREFIX%-stmt.sql"

:parse_args
if "%~1"=="" goto :args_done
if /i "%~1"=="--baseline" set "BASELINE=1"
if /i "%~1"=="--no-pause" set "PROTODO_NO_PAUSE=1"
shift /1
goto :parse_args
:args_done

REM --- Configuracion desde backend\.env (el entorno manda sobre el archivo) --
call "%~dp0lib\env.bat" "%ENV_FILE%"
if errorlevel 1 goto :failed
REM Opcional por contrato: sin ella simplemente no se migra la base E2E.
call "%~dp0lib\env.bat" "%ENV_FILE%" --optional E2E_DB_NAME

REM Siempre con --env-file: compose resuelve ${VAR:?} desde backend\.env.
set "COMPOSE=docker compose --env-file %ENV_FILE%"

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
if not "%QUERY_RESULT%"=="1" goto :e2e_create

call :query "%E2E_DB_NAME%" "SELECT to_regclass('public.schema_migrations') IS NOT NULL"
if errorlevel 1 goto :failed
if not "%QUERY_RESULT%"=="t" goto :e2e_untracked

call :migrate_database "%E2E_DB_NAME%"
if errorlevel 1 goto :failed
goto :end

:e2e_create
call :bootstrap_e2e_database "%E2E_DB_NAME%"
if errorlevel 1 goto :failed
call :migrate_database "%E2E_DB_NAME%"
if errorlevel 1 goto :failed
goto :end

:e2e_untracked
echo -- %E2E_DB_NAME% - E2E_DB_NAME - existe pero no tiene schema_migrations: se omite.
echo    Es una base de pruebas: borrala y este script la recreara al dia:
echo      docker compose --env-file backend\.env exec postgres dropdb -U %DB_USER% %E2E_DB_NAME%
echo      scripts\migrate-windows.bat
goto :end

:failed
set "EXIT_CODE=1"
goto :end

REM ===========================================================================
REM :bootstrap_e2e_database <base>. Crea la base como un volumen nuevo. Si algo
REM falla, borra la base RECIEN creada - y solo esa - para no dejar una a medias
REM que la siguiente ejecucion saltaria por no tener schema_migrations.
REM ===========================================================================
:bootstrap_e2e_database
set "NEW_DB=%~1"
echo == Creando %NEW_DB% - E2E_DB_NAME: init.sql + bootstrap
REM El SQL va por un archivo: `:"db"` cita el identificador en psql y evita
REM pelear con las comillas de cmd.exe dentro de -c.
> "%SQL_FILE%" echo CREATE DATABASE :"db";
%COMPOSE% exec -T postgres psql -X -v ON_ERROR_STOP=1 --quiet -U "%DB_USER%" -d postgres -v "db=%NEW_DB%" < "%SQL_FILE%"
if errorlevel 1 exit /b 1

%COMPOSE% exec -T postgres psql -X -v ON_ERROR_STOP=1 --quiet -U "%DB_USER%" -d "%NEW_DB%" -f /docker-entrypoint-initdb.d/01-init.sql >nul
if errorlevel 1 goto :bootstrap_e2e_failed
%COMPOSE% exec -T -e "POSTGRES_DB=%NEW_DB%" postgres bash /docker-entrypoint-initdb.d/02-bootstrap.sh
if errorlevel 1 goto :bootstrap_e2e_failed
del "%SQL_FILE%" >nul 2>&1
exit /b 0

:bootstrap_e2e_failed
echo Fallo el bootstrap de %NEW_DB%: se borra la base recien creada.
> "%SQL_FILE%" echo DROP DATABASE IF EXISTS :"db";
%COMPOSE% exec -T postgres psql -X --quiet -U "%DB_USER%" -d postgres -v "db=%NEW_DB%" < "%SQL_FILE%"
del "%SQL_FILE%" >nul 2>&1
exit /b 1

REM ===========================================================================
REM :migrate_database <base>
REM ===========================================================================
:migrate_database
set "TARGET_DB=%~1"
set /a APPLIED=0
set /a SKIPPED=0
set /a REGISTERED=0
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
%COMPOSE% exec -T postgres psql -X -v ON_ERROR_STOP=1 --quiet -U "%DB_USER%" -d "%TARGET_DB%" -c "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());" >nul
if errorlevel 1 exit /b 1

REM Una sola consulta con todas las versiones aplicadas, en vez de una por
REM archivo. btrim por si alguna se registro con espacios o CR.
%COMPOSE% exec -T postgres psql -X -q -tA -U "%DB_USER%" -d "%TARGET_DB%" -c "SELECT btrim(version, E' \t\r\n') FROM schema_migrations ORDER BY 1" > "%APPLIED_RAW%"
if errorlevel 1 exit /b 1

REM psql escribe las lineas con LF (Linux). `findstr /x` solo reconoce el final
REM de linea con CRLF, de modo que sobre ese archivo NINGUNA version coincidia y
REM se intentaba aplicar todo desde la 001 (fallaba en la 005). `for /f` lee
REM las lineas con LF y `echo` las reescribe con CRLF: con ese archivo la
REM comparacion exacta funciona.
type nul > "%APPLIED_FILE%"
for /f "usebackq delims=" %%V in ("%APPLIED_RAW%") do call :append_applied "%%V"
del "%APPLIED_RAW%" >nul 2>&1
echo -- %REGISTERED% migraciones ya registradas en schema_migrations
if %REGISTERED% equ 0 if not "%BASELINE%"=="1" echo -- AVISO: schema_migrations esta vacia: se aplicara toda la historia.

REM `dir /on`: orden ascendente por nombre (los prefijos NNN- van con ceros).
for /f "delims=" %%F in ('dir /b /a-d /on "%MIGRATIONS_DIR%\*.sql"') do call :migrate_file "%%F"

del "%APPLIED_FILE%" >nul 2>&1
if defined MIGRATION_FAILED exit /b 1

if "%BASELINE%"=="1" echo == %TARGET_DB%: %APPLIED% registradas como aplicadas, %SKIPPED% ya estaban.
if not "%BASELINE%"=="1" echo == %TARGET_DB%: %APPLIED% aplicadas, %SKIPPED% ya estaban.
exit /b 0

REM ===========================================================================
REM :append_applied <version>. Una linea CRLF por version, sin vacias.
REM ===========================================================================
:append_applied
if "%~1"=="" goto :eof
>> "%APPLIED_FILE%" echo(%~1
set /a REGISTERED+=1
goto :eof

REM ===========================================================================
REM :migrate_file <archivo.sql>. Tras el primer fallo no hace nada mas.
REM ===========================================================================
:migrate_file
if defined MIGRATION_FAILED goto :eof
set "VERSION=%~1"

REM /x linea completa, /l literal, /c: cadena entera (no lista de palabras).
findstr /x /l /c:"%VERSION%" "%APPLIED_FILE%" >nul 2>&1
if errorlevel 1 goto :migrate_file_pending
set /a SKIPPED+=1
goto :eof

:migrate_file_pending
if "%BASELINE%"=="1" goto :migrate_file_baseline
echo -- aplicando %VERSION%
%COMPOSE% exec -T postgres psql -X -v ON_ERROR_STOP=1 --quiet -U "%DB_USER%" -d "%TARGET_DB%" < "%MIGRATIONS_DIR%\%VERSION%"
if errorlevel 1 goto :migrate_file_error
goto :migrate_file_register

:migrate_file_baseline
echo -- registrando sin ejecutar %VERSION%

:migrate_file_register
REM El registro va DESPUES: si la migracion falla no queda marcada y el
REM siguiente intento la reintenta en vez de darla por buena. Mismo formato que
REM 02-bootstrap.sh y migrate-linux.sh: el nombre del archivo, sin ruta.
%COMPOSE% exec -T postgres psql -X -v ON_ERROR_STOP=1 --quiet -U "%DB_USER%" -d "%TARGET_DB%" -c "INSERT INTO schema_migrations (version) VALUES ('%VERSION%') ON CONFLICT (version) DO NOTHING;" >nul
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
%COMPOSE% exec -T postgres psql -X -q -tA -U "%DB_USER%" -d "%~1" -c "%~2" > "%QUERY_FILE%"
if errorlevel 1 exit /b 1
REM `for /f` y no `set /p`: no arrastra el resto de la linea si llega con LF.
for /f "usebackq delims=" %%R in ("%QUERY_FILE%") do if not defined QUERY_RESULT set "QUERY_RESULT=%%R"
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
del "%SQL_FILE%" >nul 2>&1
del "%APPLIED_RAW%" >nul 2>&1
del "%APPLIED_FILE%" >nul 2>&1
if defined PROTODO_NO_PAUSE goto :exit
REM Pausa solo si la consola la abrio el propio .bat (doble clic: cmd.exe /c).
set "CMD_LINE=%CMDCMDLINE:"=%"
if /i not "%CMD_LINE:/c =%"=="%CMD_LINE%" pause
:exit
endlocal & exit /b %EXIT_CODE%
