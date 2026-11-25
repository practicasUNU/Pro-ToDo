@echo off
REM ===========================================================================
REM Puesta en marcha del stack completo de Proto-Do en Windows 10/11 (Docker).
REM Se usa con doble clic o desde CMD / PowerShell; no necesita Git Bash.
REM
REM Flujo (identico al de scripts/setup-linux.sh):
REM   1. Comprueba Docker; si falta, lo instala con winget y pide reiniciar.
REM   2. Si el demonio no responde, abre Docker Desktop y espera (max. ~3 min).
REM   3. Si falta backend\.env, lo crea desde la plantilla y SE DETIENE: el
REM      primer arranque del volumen fija DB_USER/DB_PASSWORD para siempre.
REM   4. docker compose --profile app up -d --build
REM   5. Aplica las migraciones pendientes (scripts\migrate-windows.bat).
REM
REM Uso:  scripts\setup-windows.bat [--no-pause]
REM Guia: docs\INSTALACION_Y_ENTORNO.md
REM
REM Sin expansion retardada y sin bloques con parentesis en los mensajes: es lo
REM que mas falla en cmd.exe. El flujo va con etiquetas y goto.
REM ===========================================================================
setlocal EnableExtensions DisableDelayedExpansion

cd /d "%~dp0.."

set "ENV_FILE=backend\.env"
set "ENV_TEMPLATE=backend\.env.example"
set "DOCKER_DESKTOP_EXE=%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
set "MAX_WAIT_ATTEMPTS=60"
set "WAIT_SECONDS=3"
set "EXIT_CODE=0"

if /i "%~1"=="--no-pause" set "PROTODO_NO_PAUSE=1"

echo == [1/5] Docker
where docker >nul 2>&1
if not errorlevel 1 goto :docker_found

echo No se encontro docker en el PATH.
where winget >nul 2>&1
if errorlevel 1 goto :no_winget

echo Instalando Docker Desktop con winget. Puede pedir permisos de administrador...
winget install -e --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements
if errorlevel 1 goto :winget_failed

echo.
echo Docker Desktop se ha instalado.
echo   1. REINICIA el equipo: WSL 2 y el servicio de Docker lo necesitan.
echo   2. Abre Docker Desktop una vez y acepta sus condiciones.
echo   3. Vuelve a ejecutar scripts\setup-windows.bat
set "EXIT_CODE=1"
goto :end

:no_winget
echo winget no esta disponible en este equipo.
echo Instala Docker Desktop a mano desde https://www.docker.com/products/docker-desktop/
echo o instala "App Installer" desde Microsoft Store para tener winget.
echo Despues reinicia el equipo y vuelve a ejecutar este script.
set "EXIT_CODE=1"
goto :end

:winget_failed
echo.
echo La instalacion con winget ha fallado o necesita un reinicio.
echo   - Comprueba que la virtualizacion esta activada en la BIOS/UEFI.
echo   - Habilita WSL 2 desde una consola de administrador:  wsl --install
echo   - REINICIA el equipo y vuelve a ejecutar scripts\setup-windows.bat
set "EXIT_CODE=1"
goto :end

:docker_found
docker compose version >nul 2>&1
if not errorlevel 1 goto :compose_found
echo Falta el plugin "docker compose" v2. Actualiza Docker Desktop.
set "EXIT_CODE=1"
goto :end

:compose_found
docker compose version

echo == [2/5] Demonio de Docker
docker info >nul 2>&1
if not errorlevel 1 goto :daemon_ready

if not exist "%DOCKER_DESKTOP_EXE%" goto :no_desktop_exe
echo Docker no responde. Iniciando Docker Desktop...
start "" "%DOCKER_DESKTOP_EXE%"

set /a ATTEMPT=0
:wait_daemon
set /a ATTEMPT+=1
if %ATTEMPT% gtr %MAX_WAIT_ATTEMPTS% goto :daemon_timeout
call :sleep %WAIT_SECONDS%
docker info >nul 2>&1
if errorlevel 1 goto :wait_daemon
goto :daemon_ready

:no_desktop_exe
echo Docker no responde y no se encontro "%DOCKER_DESKTOP_EXE%".
echo Abre Docker Desktop a mano, espera a que indique "Engine running" y vuelve a ejecutar.
set "EXIT_CODE=1"
goto :end

:daemon_timeout
echo Docker Desktop no ha respondido tras %MAX_WAIT_ATTEMPTS% intentos.
echo   - Si es la primera vez, acepta las condiciones de Docker Desktop.
echo   - Si acabas de instalar WSL 2, reinicia el equipo.
echo   - Revisa que la virtualizacion este activada en la BIOS/UEFI.
set "EXIT_CODE=1"
goto :end

:daemon_ready
echo Docker responde.

echo == [3/5] Variables de entorno
if exist "%ENV_FILE%" goto :env_ready
if not exist "%ENV_TEMPLATE%" goto :no_template
copy /y "%ENV_TEMPLATE%" "%ENV_FILE%" >nul
echo Se ha creado backend\.env a partir de backend\.env.example.
echo Revisa AHORA las credenciales antes de continuar:
echo   DB_USER, DB_PASSWORD, DB_NAME, BOOTSTRAP_ADMIN_EMAIL, JWT_SECRET,
echo   CREDENTIALS_ENCRYPTION_KEY, IMAP/SMTP, ANTHROPIC_API_KEY, DRUPAL_*, ACENS_API_KEY
echo El primer arranque del volumen fija las credenciales de PostgreSQL y no se
echo pueden cambiar despues sin recrearlo. Despues vuelve a ejecutar este script.
goto :end

:no_template
echo No existe %ENV_TEMPLATE%. Ejecuta el script desde un clon completo del repositorio.
set "EXIT_CODE=1"
goto :end

:env_ready
echo == [4/5] Contenedores - perfil app
docker compose --env-file "%ENV_FILE%" --profile app up -d --build
if errorlevel 1 goto :compose_failed

echo == [5/5] Migraciones
set "PROTODO_NO_PAUSE_PARENT=%PROTODO_NO_PAUSE%"
set "PROTODO_NO_PAUSE=1"
call "%~dp0migrate-windows.bat"
if errorlevel 1 set "EXIT_CODE=1"
set "PROTODO_NO_PAUSE=%PROTODO_NO_PAUSE_PARENT%"
if "%EXIT_CODE%"=="1" goto :end

echo.
echo == Listo. Panel: http://localhost:8080  (o el FRONTEND_PORT de backend\.env)
goto :end

:compose_failed
echo.
echo docker compose up ha fallado. Causas habituales:
echo   - Puerto ocupado 5433/3000/6379/8080:  netstat -ano ^| findstr :8080
echo   - Credenciales de backend\.env distintas de las del volumen ya creado.
echo Revisa: docker compose --env-file backend\.env --profile app logs
set "EXIT_CODE=1"
goto :end

REM ---------------------------------------------------------------------------
REM :sleep <segundos>. `timeout` falla si la entrada esta redirigida; en ese
REM caso se espera con ping, que no depende de la consola.
REM ---------------------------------------------------------------------------
:sleep
timeout /t %~1 /nobreak >nul 2>&1
if errorlevel 1 ping -n %~1 127.0.0.1 >nul 2>&1
goto :eof

:end
if defined PROTODO_NO_PAUSE goto :exit
REM Pausa solo si la consola la abrio el propio .bat (doble clic: cmd.exe /c).
set "CMD_LINE=%CMDCMDLINE:"=%"
if /i not "%CMD_LINE:/c =%"=="%CMD_LINE%" pause
:exit
endlocal & exit /b %EXIT_CODE%
