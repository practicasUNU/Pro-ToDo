@echo off
REM ===========================================================================
REM Lectura comun de backend\.env para los scripts de Docker en Windows
REM (setup-windows.bat, migrate-windows.bat). Equivale a scripts/lib/env.sh.
REM
REM backend\.env es la UNICA fuente de configuracion del stack (contrato:
REM backend\.env.example). Aqui no hay valores por defecto.
REM
REM Uso:  call "%~dp0lib\env.bat" "backend\.env"
REM           Carga REQUIRED_ENV_VARS (todas obligatorias).
REM       call "%~dp0lib\env.bat" "backend\.env" --optional VAR1 VAR2 ...
REM           Carga esas VAR si existen, sin fallar si estan vacias.
REM
REM Para cada VAR: si no esta definida en el entorno, la toma del archivo (gana
REM la ultima linea, quita comillas). El entorno manda, como en la interpolacion
REM de `docker compose --env-file`. Las obligatorias que queden vacias se listan
REM en ENV_MISSING y el errorlevel es 1; si el archivo no existe, errorlevel 2.
REM
REM Sin setlocal a proposito: las variables tienen que llegar al llamador.
REM Solo se leen las claves pedidas, con findstr por clave, de modo que los
REM secretos de otras lineas (con & | < > o comillas) nunca pasan por cmd.exe.
REM ===========================================================================

REM Las mismas que docker-compose.yml exige con ${VAR:?} (compose interpola el
REM archivo entero, asi que hasta `docker compose exec` falla sin ellas), mas
REM FRONTEND_URL, que el gateway de sockets necesita.
set "REQUIRED_ENV_VARS=DB_NAME DB_USER DB_PASSWORD DB_PORT POSTGRES_HOST_PORT PORT FRONTEND_URL FRONTEND_PORT FRONTEND_BIND_ADDRESS REDIS_PORT BOOTSTRAP_ADMIN_EMAIL"

set "ENV_MISSING="
set "_ENVLIB_FILE=%~1"
if not exist "%_ENVLIB_FILE%" goto :envlib_no_file
if /i "%~2"=="--optional" goto :envlib_optional

for %%K in (%REQUIRED_ENV_VARS%) do call :envlib_load %%K
call :envlib_cleanup
if defined ENV_MISSING goto :envlib_report
exit /b 0

:envlib_optional
shift /1
shift /1
:envlib_optional_next
if "%~1"=="" goto :envlib_optional_done
call :envlib_load "%~1"
shift /1
goto :envlib_optional_next
:envlib_optional_done
REM Las opcionales vacias no son un error.
set "ENV_MISSING="
call :envlib_cleanup
exit /b 0

:envlib_report
echo Faltan variables obligatorias en backend\.env:
for %%K in (%ENV_MISSING%) do echo   - %%K
echo Copialas de backend\.env.example y dales valor.
exit /b 1

:envlib_no_file
echo No existe %_ENVLIB_FILE%. Crealo desde backend\.env.example y rellenalo.
set "_ENVLIB_FILE="
exit /b 2

REM ---------------------------------------------------------------------------
REM :envlib_cleanup: no deja variables auxiliares en el entorno del llamador.
REM ---------------------------------------------------------------------------
:envlib_cleanup
set "_ENVLIB_FILE="
set "_ENVLIB_KEY="
set "_ENVLIB_VALUE="
goto :eof

REM ---------------------------------------------------------------------------
REM :envlib_load <CLAVE>
REM ---------------------------------------------------------------------------
:envlib_load
set "_ENVLIB_KEY=%~1"
if defined %_ENVLIB_KEY% goto :envlib_check
set "_ENVLIB_VALUE="
REM `findstr /b /l` con "CLAVE=": no confunde DB_PORT con DB_PORT_EXTRA. %%B se
REM expande despues del analisis de la linea: sus caracteres especiales no se
REM interpretan.
for /f "usebackq tokens=1,* delims==" %%A in (`findstr /b /l /c:"%_ENVLIB_KEY%=" "%_ENVLIB_FILE%"`) do set "_ENVLIB_VALUE=%%B"
if defined _ENVLIB_VALUE set "_ENVLIB_VALUE=%_ENVLIB_VALUE:"=%"
if defined _ENVLIB_VALUE set "%_ENVLIB_KEY%=%_ENVLIB_VALUE%"
:envlib_check
if not defined %_ENVLIB_KEY% set "ENV_MISSING=%ENV_MISSING% %_ENVLIB_KEY%"
goto :eof
