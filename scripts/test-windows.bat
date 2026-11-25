@echo off
REM ===========================================================================
REM Ejecuta las suites de Jest del backend DENTRO de Docker (servicio efimero
REM backend-test, perfil test), sin node, npm ni psql en el anfitrion.
REM Equivale a scripts/test-linux.sh.
REM
REM Flujo:
REM   1. Valida backend\.env (scripts\lib\env.bat, sin valores por defecto) y,
REM      si la suite lo necesita, E2E_DB_NAME.
REM   2. Levanta postgres y redis y espera a que esten sanos.
REM   3. scripts\migrate-windows.bat: esquema al dia en DB_NAME y crea/migra
REM      E2E_DB_NAME.
REM   4. Reconstruye backend-test - el codigo va copiado en la imagen - y lanza
REM      la suite con docker compose run --rm. Sale con el codigo de Jest.
REM
REM Uso:  scripts\test-windows.bat [unit, e2e o all] [--no-pause]   - por defecto all
REM
REM   unit = npm test           - src/**/*.spec.ts, todo con dobles de prueba
REM   e2e  = npm run test:e2e   - test/**/*.e2e-spec.ts contra E2E_DB_NAME
REM   all  = las dos, en ese orden
REM ===========================================================================
setlocal EnableExtensions DisableDelayedExpansion

cd /d "%~dp0.."

set "ENV_FILE=backend\.env"
set "EXIT_CODE=0"
set "SUITE="

:parse_args
if "%~1"=="" goto :args_done
if /i "%~1"=="--no-pause" goto :arg_no_pause
if not defined SUITE set "SUITE=%~1"
shift /1
goto :parse_args
:arg_no_pause
set "PROTODO_NO_PAUSE=1"
shift /1
goto :parse_args
:args_done
if not defined SUITE set "SUITE=all"

REM Se resuelve ANTES de tocar Docker: un argumento mal escrito no levanta nada.
set "NEEDS_E2E_DB=1"
if /i "%SUITE%"=="unit" goto :suite_unit
if /i "%SUITE%"=="e2e" goto :suite_e2e
if /i "%SUITE%"=="all" goto :suite_all
echo Suite desconocida: "%SUITE%". Validas: unit, e2e, all - por defecto all.
echo No existe una suite "integration": las pruebas con base de datos real son las e2e.
set "EXIT_CODE=2"
goto :end

:suite_unit
set "JEST_COMMAND=npm test"
set "NEEDS_E2E_DB=0"
goto :suite_ready
:suite_e2e
set "JEST_COMMAND=npm run test:e2e"
goto :suite_ready
:suite_all
set "JEST_COMMAND=npm test && npm run test:e2e"
:suite_ready

call "%~dp0lib\env.bat" "%ENV_FILE%"
if errorlevel 1 goto :failed
call "%~dp0lib\env.bat" "%ENV_FILE%" --optional E2E_DB_NAME

if "%NEEDS_E2E_DB%"=="0" goto :e2e_checked
if not defined E2E_DB_NAME goto :e2e_missing
if /i "%E2E_DB_NAME%"=="%DB_NAME%" goto :e2e_is_dev
:e2e_checked

set "COMPOSE=docker compose --env-file %ENV_FILE% --profile test"

echo == [1/4] PostgreSQL y Redis
%COMPOSE% up -d --wait postgres redis
if errorlevel 1 goto :failed

echo == [2/4] Migraciones - DB_NAME y E2E_DB_NAME
set "PROTODO_NO_PAUSE_PARENT=%PROTODO_NO_PAUSE%"
set "PROTODO_NO_PAUSE=1"
call "%~dp0migrate-windows.bat"
set "MIGRATE_RESULT=%ERRORLEVEL%"
set "PROTODO_NO_PAUSE=%PROTODO_NO_PAUSE_PARENT%"
if not "%MIGRATE_RESULT%"=="0" goto :failed

echo == [3/4] Imagen backend-test - codigo actual
%COMPOSE% build backend-test
if errorlevel 1 goto :failed

echo == [4/4] Jest: %SUITE%
REM El comando va entre comillas: `&&` lo interpreta sh dentro del contenedor,
REM no cmd.exe.
%COMPOSE% run --rm backend-test sh -c "%JEST_COMMAND%"
set "EXIT_CODE=%ERRORLEVEL%"
goto :end

:e2e_missing
echo La suite "%SUITE%" necesita E2E_DB_NAME en backend\.env, distinta de DB_NAME.
set "EXIT_CODE=1"
goto :end

:e2e_is_dev
echo E2E_DB_NAME coincide con DB_NAME: las e2e borran filas, no pueden usar la
echo base de desarrollo.
set "EXIT_CODE=1"
goto :end

:failed
set "EXIT_CODE=1"
goto :end

:end
if defined PROTODO_NO_PAUSE goto :exit
REM Pausa solo si la consola la abrio el propio .bat (doble clic: cmd.exe /c).
set "CMD_LINE=%CMDCMDLINE:"=%"
if /i not "%CMD_LINE:/c =%"=="%CMD_LINE%" pause
:exit
endlocal & exit /b %EXIT_CODE%
