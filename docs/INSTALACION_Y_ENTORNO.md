# Instalación y Entorno — Proto-Do (Linux y Windows)

Guía para poner en marcha Proto-Do en un equipo nuevo, en **Linux** o en **Windows 10/11**. Hay dos
modos de trabajo, y los dos usan PostgreSQL en Docker (`security-and-scope.md` §0):

| Modo | Qué corre en Docker | Qué corre en el anfitrión | Para qué |
|---|---|---|---|
| **Stack completo** (perfil `app`) | PostgreSQL, Redis, backend, frontend (Nginx) | Nada (solo Docker) | Demos, pruebas de integración, equipos sin Node.js |
| **Desarrollo** (sin perfil) | Solo PostgreSQL | Backend (`npm run start:dev`) y frontend (`npm run dev`) | Programar con recarga en caliente |

Comandos del día a día: [`docs/commands.md`](commands.md). Dependencias y auditoría:
[`docs/PRODUCTION_DEPS_GUIDE.md`](PRODUCTION_DEPS_GUIDE.md).

> **Toda la configuración vive en `backend/.env`** (contrato: `backend/.env.example`). Ni
> `docker-compose.yml`, ni `db/docker-init/`, ni la plantilla de Nginx, ni `scripts/` tienen valores por
> defecto: si falta una variable obligatoria, fallan diciendo cuál (§1.2).

## Índice

- [1. Arquitectura de servicios y puertos](#1-arquitectura-de-servicios-y-puertos)
  - [1.1 Flujo de peticiones en Docker](#11-flujo-de-peticiones-en-docker)
  - [1.2 Configuración centralizada en backend/.env](#12-configuración-centralizada-en-backendenv)
  - [1.3 Variables que sobrescribe docker-compose.yml](#13-variables-que-sobrescribe-docker-composeyml)
  - [1.4 Perímetro de red en Docker](#14-perímetro-de-red-en-docker)
- [2. Entorno en Linux (Ubuntu / Zorin OS / Debian / Arch)](#2-entorno-en-linux-ubuntu--zorin-os--debian--arch)
  - [2.1 Prerrequisitos](#21-prerrequisitos)
  - [2.2 Puesta en marcha con los scripts](#22-puesta-en-marcha-con-los-scripts)
  - [2.3 Servidor web y proxy inverso (Apache2 / Nginx)](#23-servidor-web-y-proxy-inverso-apache2--nginx)
    - [2.3.1 Apache2 (mod_proxy)](#231-apache2-mod_proxy)
    - [2.3.2 Nginx](#232-nginx)
  - [2.4 Variables de entorno y credenciales](#24-variables-de-entorno-y-credenciales)
  - [2.5 Migraciones](#25-migraciones)
  - [2.6 Modo desarrollo (backend y frontend en el anfitrión)](#26-modo-desarrollo-backend-y-frontend-en-el-anfitrión)
- [3. Entorno en Windows (Windows 10 / 11)](#3-entorno-en-windows-windows-10--11)
  - [3.1 Prerrequisitos](#31-prerrequisitos)
  - [3.2 Puesta en marcha con los scripts .bat](#32-puesta-en-marcha-con-los-scripts-bat)
  - [3.3 Variables de entorno y credenciales](#33-variables-de-entorno-y-credenciales)
  - [3.4 Problemas comunes en Windows](#34-problemas-comunes-en-windows)
  - [3.5 Solución de problemas en Windows 11](#35-solución-de-problemas-en-windows-11)
    - [3.5.1 Instalación manual de WSL 2 (GitHub Releases)](#351-instalación-manual-de-wsl-2-github-releases)
    - [3.5.2 Acceso HTTP local y «Modo solo HTTPS»](#352-acceso-http-local-y-modo-solo-https)
    - [3.5.3 Puertos de PostgreSQL: interno frente a anfitrión](#353-puertos-de-postgresql-interno-frente-a-anfitrión)
- [4. Pruebas automatizadas en Docker](#4-pruebas-automatizadas-en-docker)
- [5. Verificación del entorno](#5-verificación-del-entorno)

---

## 1. Arquitectura de servicios y puertos

| Servicio | Contenedor | Puerto en el anfitrión | Puerto interno | Expuesto en | Notas |
|---|---|---|---|---|---|
| Frontend (Nginx + SPA Quasar) | `protodo_frontend` | `FRONTEND_PORT` | `80` | `FRONTEND_BIND_ADDRESS` | Perfil `app`. Enruta `/api`, `/api/socket.io` y `/static/uploads` al backend |
| Frontend en desarrollo (`quasar dev`) | — (anfitrión) | `9000` | — | `localhost` | Modo desarrollo; usa `frontend/.env` |
| Backend NestJS | `protodo_backend` | `PORT` | `PORT` | `127.0.0.1` | Perfil `app`. API en `/api`, Swagger en `/api/docs` |
| PostgreSQL 16 | `protodo_postgres` | `POSTGRES_HOST_PORT` | `DB_PORT` (`PGPORT`) | todas las interfaces | Siempre (con y sin perfil). Volumen `pgdata_protodo` |
| Redis 7 | `protodo_redis` | `REDIS_PORT` | `REDIS_PORT` | `127.0.0.1` | Perfiles `app` y `test`. Provisionado para BullMQ; hoy el backend no lo consume |
| Pruebas Jest (`backend-test`) | efímero (`run --rm`) | — | — | — | Perfil `test`. Etapa `test` de `backend/Dockerfile`, con devDependencies (§4) |
| Portal Drupal (externo o local) | — (fuera de este repo) | `80` / `443` | — | según el servidor | Apache o Nginx propios (§2.3). El backend lo llama vía `DRUPAL_API_BASE_URL` |

Todos los nombres en mayúsculas son variables de `backend/.env`. Con los valores de
`backend/.env.example`: panel en `8080`, PostgreSQL en `5433` (dentro y fuera), Redis en `6379` y
backend en el `PORT` que declares.

### 1.1 Flujo de peticiones en Docker

```
Navegador ──http://localhost:<FRONTEND_PORT>──▶ protodo_frontend (Nginx :80)
                                        ├── /                → SPA (dist/spa)
                                        ├── /api/*           ─┐
                                        ├── /api/socket.io/* ─┼─▶ protodo_backend:<PORT> ──▶ protodo_postgres:<DB_PORT>
                                        └── /static/uploads/*─┘                          └─▶ protodo_redis:<REDIS_PORT>
                                                                       │
                                                                       └─▶ Drupal / Acens / IMAP / IA (salida a Internet)
```

- Los contenedores comparten la red `protodo_net` (subred fija `172.28.0.0/16`) y se ven por nombre
  de servicio (`postgres`, `redis`, `backend`).
- Socket.io usa el path **`/api/socket.io`** (namespace `/events`), no `/socket.io`: el mismo
  `location /api/` lo enruta, con las cabeceras `Upgrade`/`Connection` de WebSocket.
- El frontend se compila con `VITE_API_BASE_URL=/api` (relativa): el cliente de sockets toma
  entonces el origen del propio documento (`frontend/src/services/socket.client.ts`).
- El upstream de Nginx (`backend:<PORT>`) no está escrito en ningún archivo: la imagen oficial de
  Nginx renderiza `frontend/nginx.conf.template` con `envsubst` al arrancar, sustituyendo solo
  `PORT` (`NGINX_ENVSUBST_FILTER`). Antes, `frontend/docker/10-require-env.sh` detiene el contenedor
  si `PORT` falta o no es numérico.

### 1.2 Configuración centralizada en `backend/.env`

`backend/.env` es la **única** fuente de configuración del stack, y `backend/.env.example` su
contrato. En Git no queda ningún nombre de base de datos, usuario, contraseña, correo ni puerto de
entorno:

- `docker-compose.yml` interpola con `${VAR:?mensaje}`: si falta una obligatoria, se niega a arrancar
  y dice cuál. Compose interpola el archivo **entero**, así que la comprobación aplica también a
  `docker compose up -d` sin perfil y a `docker compose exec`.
- Los scripts (`scripts/lib/env.sh` y `scripts\lib\env.bat`) validan la misma lista **antes** de
  tocar Docker y la muestran completa si falta algo. El entorno del shell manda sobre el archivo,
  igual que en la interpolación de `docker compose --env-file`.
- Todos los comandos `docker compose` de los scripts llevan `--env-file backend/.env`.

**Variables internas** (las usa el código dentro del contenedor):

| Variable | Obligatoria | Dónde actúa |
|---|---|---|
| `DB_HOST` | — | En el anfitrión, `localhost`. En Docker el compose la sobrescribe con `postgres` (nombre del servicio) |
| `DB_PORT` | Sí | Puerto **interno** de PostgreSQL (`PGPORT`). Lo usan el backend en Docker y `docker compose exec postgres psql` (sin `-p`) |
| `DB_NAME`, `DB_USER`, `DB_PASSWORD` | Sí | `POSTGRES_DB/USER/PASSWORD` del contenedor y conexión del backend. Se fijan en el **primer** arranque del volumen |
| `PORT` | Sí | Puerto en el que escucha el backend (`main.ts`), upstream de Nginx y puerto publicado en `127.0.0.1` |
| `FRONTEND_URL` | Sí (scripts) | CORS de HTTP y del gateway de sockets. Tras Nginx el panel es mismo origen, así que en Docker no interviene |
| `ALLOWED_IP_RANGES` | No | Perímetro (PROT-05). El compose le añade la subred de `protodo_net` (§1.4) |
| `BOOTSTRAP_ADMIN_EMAIL` | Sí | ADMIN que siembra `02-bootstrap.sh` en un volumen nuevo (y `scripts/bootstrap-db.sh`) |
| `ACCEPTED_EMAIL_DOMAINS` | No | Dominios de login; también se inyecta en el build del frontend |
| `E2E_DB_NAME` | No | Base de las pruebas e2e. Si tiene valor, `setup-*` / `migrate-*` la **crean** dentro del contenedor cuando falta y la migran junto a `DB_NAME`. Obligatoria para `test-* e2e` / `all` |

**Puertos publicados en el anfitrión** (solo los usa Docker):

| Variable | Obligatoria | Mapeo |
|---|---|---|
| `POSTGRES_HOST_PORT` | Sí | `POSTGRES_HOST_PORT:DB_PORT`. Es al que conectan DBeaver, `psql.exe` o pgAdmin |
| `FRONTEND_PORT` | Sí | `FRONTEND_BIND_ADDRESS:FRONTEND_PORT:80` (Nginx) |
| `FRONTEND_BIND_ADDRESS` | Sí | `127.0.0.1` = solo este equipo; `0.0.0.0` = LAN (lee §1.4 antes) |
| `REDIS_PORT` | Sí | `127.0.0.1:REDIS_PORT:REDIS_PORT` |

> ⚠️ **`DB_PORT` = `POSTGRES_HOST_PORT` en desarrollo.** Todo lo que corre en el anfitrión
> (`npm run start:dev`, el servidor MCP, `scripts/apply-migrations.sh`, `bootstrap-db.sh`) conecta a
> `localhost:DB_PORT`. Con los dos iguales (la plantilla trae `5433` en ambos) el mismo `.env` sirve
> para el stack Docker y para el desarrollo. Si los separas, el desarrollo en el anfitrión deja de
> encontrar la base.

Si actualizas un `backend/.env` anterior a este cambio, añade `POSTGRES_HOST_PORT`, `FRONTEND_PORT`,
`FRONTEND_BIND_ADDRESS`, `REDIS_PORT` y `BOOTSTRAP_ADMIN_EMAIL` (cópialas de `backend/.env.example`).
`BACKEND_PORT` ya no existe: el backend se publica en su propio `PORT`.

### 1.3 Variables que sobrescribe `docker-compose.yml`

El backend del contenedor lee `backend/.env` completo (`env_file`) y `docker-compose.yml` sobrescribe
solo lo que depende de la topología de Docker o de la imagen; ningún puerto ni credencial:

| Variable | Valor en el contenedor | Motivo |
|---|---|---|
| `DB_HOST` | `postgres` | Nombre del servicio en `protodo_net` |
| `REDIS_HOST` | `redis` | Ídem. Preparado para BullMQ |
| `LOG_DIR` | `/app/logs` | Volumen `protodo_backend_logs` |
| `ALLOWED_IP_RANGES` | el del `.env` + `172.28.0.0/16` | Ver §1.4 |
| `NODE_ENV` | `production` | Imagen de runtime |

Los `.env` **nunca** entran en una imagen (`.dockerignore`): llegan en runtime. Las variables
públicas del frontend (`VITE_*`) se fijan al compilar como *build args*; `VITE_ACCEPTED_EMAIL_DOMAINS`
se toma de `ACCEPTED_EMAIL_DOMAINS` de `backend/.env`.

### 1.4 Perímetro de red en Docker

El backend decide el acceso con la primera IP de `X-Forwarded-For` (`client-ip.util.ts`). Nginx la
**sobrescribe** con la IP que ve, para que un cliente no pueda inyectar otra. Dentro de Docker esa IP
es la de la pasarela de `protodo_net`, por eso el compose añade `172.28.0.0/16` a
`ALLOWED_IP_RANGES`.

Consecuencia: con `FRONTEND_BIND_ADDRESS=127.0.0.1` (el de la plantilla), únicamente el propio
equipo llega al panel. Si se expone en la LAN (`FRONTEND_BIND_ADDRESS=0.0.0.0`):

- **Linux:** Docker conserva la IP real de los clientes externos y el perímetro funciona; aun así,
  revisa que la IP que registra el backend en sus logs es la esperada.
- **Windows (Docker Desktop):** todo el tráfico entrante llega con una IP interna de Docker, así que
  el perímetro por IP **deja de distinguir** clientes. Para un despliegue accesible desde la LAN,
  pon delante un proxy inverso del anfitrión (§2.3) o usa Linux.

Si la subred `172.28.0.0/16` choca con otra red de tu equipo, cámbiala en `docker-compose.yml`
(bloque `networks`) y en la línea de `ALLOWED_IP_RANGES`.

---

## 2. Entorno en Linux (Ubuntu / Zorin OS / Debian / Arch)

### 2.1 Prerrequisitos

| Herramienta | Obligatoria | Para qué |
|---|---|---|
| Docker Engine + plugin `docker compose` v2 | Sí | Todos los servicios |
| Git | Sí | Clonar el repositorio |
| Node.js **24.16.0** (`.nvmrc`) + npm 11 | Solo modo desarrollo | `npm ci`, `npm run start:dev`, tests |
| `postgresql-client` (`psql`) | Opcional | `npm run db:migrate` / `db:bootstrap` desde el anfitrión |

**Ubuntu / Zorin OS / Debian** (repositorio oficial de Docker):

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git postgresql-client
sudo install -m 0755 -d /etc/apt/keyrings
# En Debian, sustituye "ubuntu" por "debian" en las dos URLs.
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
```

> Zorin OS se basa en Ubuntu: si `UBUNTU_CODENAME` sale vacío, pon a mano el de su base (p. ej.
> `noble` o `jammy`).

**Arch Linux:**

```bash
sudo pacman -S --needed docker docker-compose docker-buildx git postgresql-libs
sudo systemctl enable --now docker
```

**Usar Docker sin `sudo`** (opcional; requiere cerrar sesión y volver a entrar):

```bash
sudo usermod -aG docker "$USER"
```

**Node.js 24.16.0** (solo modo desarrollo), con `nvm`:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
# Abre una terminal nueva y, desde la raíz del repo:
nvm install && nvm use      # lee .nvmrc
```

### 2.2 Puesta en marcha con los scripts

```bash
git clone <url-del-repositorio> Pro-ToDo && cd Pro-ToDo
chmod +x scripts/*.sh db/docker-init/*.sh   # el bit ya viaja en Git; por si se pierde
scripts/setup-linux.sh
```

`setup-linux.sh` hace, en orden:

1. Comprueba `docker` y `docker compose version`.
2. Comprueba que el demonio responde (`docker info`).
3. Si no existe `backend/.env`, lo copia de `backend/.env.example`, crea el symlink `.env` →
   `backend/.env` y **se detiene** para que revises las credenciales (§2.4). Vuelve a lanzarlo
   después.
4. `docker compose --env-file backend/.env --profile app up -d --build`.
5. `scripts/migrate-linux.sh`.

El panel queda en `http://localhost:<FRONTEND_PORT>` (`8080` con la plantilla). Si falta alguna
variable obligatoria en `backend/.env`, el paso 3 la lista y se detiene (§1.2).

### 2.3 Servidor web y proxy inverso (Apache2 / Nginx)

Solo hace falta si quieres publicar Proto-Do con un nombre de dominio, con HTTPS, o servir en el
mismo equipo el portal Drupal de pruebas. El proxy del anfitrión apunta al Nginx del contenedor
(`127.0.0.1:<FRONTEND_PORT>`), que ya reparte `/api` y `/api/socket.io` al backend. Los ejemplos
usan `8080`, el `FRONTEND_PORT` de la plantilla: sustitúyelo por el tuyo.

> ⚠️ **Puertos 80/443.** Si Apache o Nginx del anfitrión ya ocupan el `80`, no pongas
> `FRONTEND_PORT=80`: deja que el proxy del anfitrión sea quien escucha en `80/443`.

> ⚠️ **Perímetro.** El proxy del anfitrión debe reenviar la IP real del cliente; el Nginx del
> contenedor la sobrescribe con la suya. Si necesitas que el backend vea la IP del cliente final a
> través de dos proxies, el `X-Forwarded-For` del contenedor (`frontend/nginx.conf.template`) tendría que
> confiar en el proxy del anfitrión (`real_ip_header` / `set_real_ip_from`): es un cambio de
> seguridad y va en su propia tarea.

#### 2.3.1 Apache2 (`mod_proxy`)

```bash
sudo a2enmod proxy proxy_http proxy_wstunnel rewrite headers
```

`/etc/apache2/sites-available/protodo.conf`:

```apache
<VirtualHost *:80>
    ServerName protodo.local

    ProxyPreserveHost On
    ProxyRequests Off

    # WebSocket de Socket.io: el Upgrade se reenvía como ws://
    RewriteEngine On
    RewriteCond %{HTTP:Upgrade} =websocket [NC]
    RewriteRule ^/api/socket.io/(.*) ws://127.0.0.1:8080/api/socket.io/$1 [P,L]

    # API REST, estáticos y SPA: todo al Nginx del contenedor
    ProxyPass        / http://127.0.0.1:8080/
    ProxyPassReverse / http://127.0.0.1:8080/
</VirtualHost>
```

```bash
sudo a2ensite protodo && sudo apache2ctl configtest && sudo systemctl reload apache2
```

**Portal Drupal de pruebas en el mismo Apache** (PHP-FPM, `DocumentRoot` del Drupal local):

```apache
<VirtualHost *:80>
    ServerName drupal.local
    DocumentRoot /var/www/html/drupal/web

    <Directory /var/www/html/drupal/web>
        # Drupal trae su .htaccess con mod_rewrite
        AllowOverride All
        Require all granted
    </Directory>
</VirtualHost>
```

Después, en `backend/.env`: `DRUPAL_API_BASE_URL=http://drupal.local` (y los `DRUPAL_*` del sandbox).
Si el backend corre **en Docker**, `drupal.local` debe resolverse desde el contenedor: usa la IP de
la LAN del anfitrión o añade al servicio `backend` de `docker-compose.yml`
`extra_hosts: ["drupal.local:host-gateway"]`.

#### 2.3.2 Nginx

`/etc/nginx/sites-available/protodo`:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    server_name protodo.local;
    client_max_body_size 10m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;          # /api/socket.io
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/protodo /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Para el modo **desarrollo** (backend en el anfitrión), cambia los destinos a
`http://127.0.0.1:<PORT de backend/.env>` para `/api/` y a `http://127.0.0.1:9000` para `/`.

### 2.4 Variables de entorno y credenciales

`backend/.env` es la única fuente (`security-and-scope.md` §0.1). Las variables de base de datos,
puertos y `BOOTSTRAP_ADMIN_EMAIL` están en §1.2; además, para que la aplicación funcione:

| Variable | Notas |
|---|---|
| `DB_USER`, `DB_PASSWORD`, `DB_NAME` | Se fijan en el **primer** arranque del volumen; cambiarlas después exige recrearlo |
| `JWT_SECRET`, `CREDENTIALS_ENCRYPTION_KEY` | Secretos propios de cada instalación |
| `IMAP_UNUWARE_PASSWORD`, `SMTP_OTP_*`, `SMTP_NODE_*` | Correo (OTP y nodos) |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` | Proveedores de IA |
| `DRUPAL_*` | Portal de destino y sandbox |
| `ACENS_API_KEY`, `ACENS_API_BASE_URL` | Destino Acens |

### 2.5 Migraciones

```bash
scripts/migrate-linux.sh              # aplica las pendientes (DB_NAME y, si existe, E2E_DB_NAME)
scripts/migrate-linux.sh --baseline   # adopta UNA vez una base que ya está al día
```

- **Volumen nuevo:** nace ya bootstrapeado. Docker ejecuta `01-init.sql` (`init.sql`) y
  `02-bootstrap.sh` (`db/docker-init/`), que registra todas las migraciones en `schema_migrations`,
  siembra el ADMIN y aplica la semilla `069`. `migrate-linux.sh` no tendrá nada que hacer.
- **Base existente con `schema_migrations`:** aplica solo las que falten, en orden, deteniéndose en
  el primer fallo.
- **Base existente sin `schema_migrations`:** el script se detiene y pide `--baseline`.
- **Base E2E (`E2E_DB_NAME`):** si no existe, se crea dentro del contenedor igual que un volumen
  nuevo —`CREATE DATABASE`, `init.sql` y `02-bootstrap.sh` (baseline, ADMIN, semilla `069`)— y
  después se migra. Es lo mismo que hace `npm run test:bootstrap`, sin Node ni `psql` en el
  anfitrión. Si el bootstrap falla, la base recién creada se borra para no dejarla a medias. Si ya
  existe pero no tiene `schema_migrations`, se omite y el script indica cómo recrearla (`dropdb`).
  `--baseline` nunca la toca.
- **Por qué no se ejecutan las 69 en cada arranque:** `init.sql` es el acumulado final y la historia
  no se puede encadenar sobre él (la `002`, `005` y `009` no aplican; la `035`–`038` están rotas).
  Detalle en [`commands.md` §3.1.2](commands.md#312-crear-una-base-desde-cero).

`scripts/apply-migrations.sh` (vía `npm run db:migrate --prefix backend`) hace lo mismo usando el
`psql` del anfitrión contra `DB_HOST:DB_PORT` de `backend/.env` (por eso `DB_PORT` =
`POSTGRES_HOST_PORT`, §1.2).

Las tres piezas registran el mismo valor en `schema_migrations.version`: el nombre del archivo sin
ruta (`005-tipos-nodo-fsm.sql`). `02-bootstrap.sh` y `migrate-linux.sh` lo toman con `basename`;
`migrate-windows.bat`, del `dir /b`.

### 2.6 Modo desarrollo (backend y frontend en el anfitrión)

```bash
ln -s backend/.env .env                  # una vez por clonado (Compose y servidor MCP)
docker compose up -d                     # solo PostgreSQL
scripts/migrate-linux.sh
(cd backend && npm ci) && (cd frontend && npm ci)
cd backend && npm run start:dev          # terminal 1
cd frontend && npm run dev               # terminal 2 → http://localhost:9000
```

`frontend/.env` debe apuntar al puerto real del backend (`VITE_API_BASE_URL=http://localhost:<PORT>/api`).
Más comandos en [`commands.md` §9](commands.md#9-resumen-rápido-quickstart).

---

## 3. Entorno en Windows (Windows 10 / 11)

### 3.1 Prerrequisitos

1. **Virtualización activada** en la BIOS/UEFI (Intel VT-x / AMD-V). Compruébalo en el Administrador
   de tareas → Rendimiento → CPU → «Virtualización: Habilitado».
2. **WSL 2**, desde PowerShell **como administrador**:

   ```powershell
   wsl --install
   ```

   **Reinicia el equipo** al terminar. Comprueba después con `wsl --status` que la versión por
   defecto es la 2. Si `wsl --install` o `wsl --update` fallan, instálalo a mano desde GitHub
   Releases (§3.5.1).
3. **Docker Desktop for Windows** (motor WSL 2). Lo instala `setup-windows.bat` con `winget` si
   falta, o a mano:

   ```powershell
   winget install -e --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements
   ```

   Ábrelo una vez y acepta sus condiciones.
4. **Git for Windows**:

   ```powershell
   winget install -e --id Git.Git
   ```

   `.gitattributes` fuerza LF en `.sh`, `.sql`, `Dockerfile*` y `.conf`, y CRLF en `.bat`, sea cual
   sea tu `core.autocrlf`. Si clonaste **antes** de que existiera `.gitattributes`, renormaliza:
   `git rm --cached -r . && git reset --hard` (descarta cambios locales: haz commit antes).

Node.js 24.16.0 solo hace falta para el modo desarrollo (`winget install -e --id OpenJS.NodeJS` o
`nvm-windows`).

### 3.2 Puesta en marcha con los scripts `.bat`

Sin Git Bash: doble clic en el Explorador, o desde CMD / PowerShell en la raíz del repo:

```bat
scripts\setup-windows.bat
```

`setup-windows.bat` hace, en orden:

1. `docker info`. Si el demonio ya responde, salta al paso 4.
2. `wsl --status`. Si WSL 2 no está operativo, explica la instalación manual del `.msi` desde GitHub
   Releases (§3.5.1) y **se detiene**.
3. `where docker`. Si falta y hay `winget`, instala Docker Desktop y **pide reiniciar** antes de
   volver a ejecutarlo. Si está instalado pero el demonio no responde, abre
   `%ProgramFiles%\Docker\Docker\Docker Desktop.exe` y espera en bucle (`timeout /t 3`) hasta ~3
   minutos.
4. Si no existe `backend\.env`, lo copia de `backend\.env.example` y **se detiene** para que revises
   las credenciales (§3.3). Si existe, comprueba que estén todas las obligatorias (§1.2) y, si falta
   alguna, las lista y se detiene.
5. `docker compose --env-file backend\.env --profile app up -d --build`.
6. `scripts\migrate-windows.bat`.

Solo migraciones:

```bat
scripts\migrate-windows.bat
scripts\migrate-windows.bat --baseline
```

La ventana espera una tecla al terminar cuando se lanza con doble clic; `--no-pause` lo evita.
Los scripts no necesitan el symlink `.env` de la raíz: pasan siempre `--env-file backend\.env`.

### 3.3 Variables de entorno y credenciales

Edita `backend\.env` (Bloc de notas, VS Code…) con las mismas variables de §2.4. En Windows,
además:

- Guarda el archivo en **UTF-8** y sin comillas alrededor de los valores que leen los `.bat` (las
  de §1.2 y `E2E_DB_NAME`; las comillas se toleran, pero no los espacios alrededor del `=` ni al
  final). Los `.bat` solo leen esas claves: los secretos con `&`, `|` o `<` del resto del archivo no
  les afectan.
- **IMAP:** `IMAP_UNUWARE_PASSWORD` y el resto de credenciales del buzón; las credenciales que se
  dan de alta desde el panel se cifran con `CREDENTIALS_ENCRYPTION_KEY`.
- **IA:** `ANTHROPIC_API_KEY` (y `OPENAI_API_KEY` / `GEMINI_API_KEY` si se usan).
- **Drupal:** `DRUPAL_API_BASE_URL`, `DRUPAL_API_USER`, `DRUPAL_API_TOKEN` y los `DRUPAL_SANDBOX_*`.
  Si el Drupal corre en el propio Windows, desde el contenedor se alcanza como
  `http://host.docker.internal`.
- **Acens:** `ACENS_API_KEY`, `ACENS_API_BASE_URL`.

### 3.4 Problemas comunes en Windows

| Síntoma | Causa | Solución |
|---|---|---|
| Docker Desktop: «Virtualization support not detected» / WSL no arranca | Virtualización apagada en BIOS/UEFI | Activa Intel VT-x / AMD-V (SVM) y reinicia |
| `winget` instala pero `docker` sigue sin encontrarse | El `PATH` de la consola es anterior a la instalación; WSL 2 pide reinicio | Reinicia el equipo y relanza `setup-windows.bat` |
| «WSL 2 installation is incomplete» | Falta el kernel de WSL 2 | `wsl --update` como administrador y reinicia; si falla, §3.5.1 |
| `setup-windows.bat` agota la espera del demonio | Primer arranque de Docker Desktop (condiciones sin aceptar) o equipo lento | Abre Docker Desktop, acepta y espera a «Engine running»; relanza |
| `Bind for 0.0.0.0:5433 failed: port is already allocated` | Otro PostgreSQL / servicio en `POSTGRES_HOST_PORT` | `netstat -ano \| findstr :5433` y para el proceso (PID), o cambia `POSTGRES_HOST_PORT` (y `DB_PORT`, §1.2) en `backend\.env` |
| Lo mismo en el puerto del panel, del backend o de Redis | IIS, otro backend, otro Redis | Cambia `FRONTEND_PORT`, `PORT` o `REDIS_PORT` en `backend\.env` |
| `required variable X is missing a value` / «Faltan variables obligatorias» | `backend\.env` anterior a la centralización (§1.2) | Copia las que falten de `backend\.env.example` y dales valor |
| `migrate-windows.bat` intenta aplicar desde la `001` y falla en la `005` | Versión antigua del script: comparaba con `findstr /x` sobre la salida LF de `psql` y no detectaba ninguna aplicada | Actualiza el repositorio; el script actual normaliza la lista a CRLF y muestra «N migraciones ya registradas» |
| `password authentication failed` tras cambiar `DB_PASSWORD` | El volumen guardó las credenciales del primer arranque | Restaura las credenciales antiguas, o recrea el volumen (**borra los datos**): `docker compose --env-file backend\.env down -v` |
| `E2E_DB_NAME ... existe pero no tiene schema_migrations` | Base de pruebas creada a mano o por una versión anterior | `docker compose --env-file backend\.env exec postgres dropdb -U <DB_USER> <E2E_DB_NAME>` y vuelve a lanzar `scripts\migrate-windows.bat` |
| `/usr/bin/env: 'bash\r': No such file or directory` en un contenedor | Un `.sh` con CRLF (clon anterior a `.gitattributes`) | Renormaliza (§3.1, paso 4) y `docker compose ... up -d --build` |
| El panel responde 403 en todas las llamadas | La IP que ve el backend no está en el perímetro | Revisa `docker compose ... logs backend` y §1.4 |

### 3.5 Solución de problemas en Windows 11

#### 3.5.1 Instalación manual de WSL 2 (GitHub Releases)

`wsl --install` y `wsl --update` descargan e instalan un `.msi` desde la carpeta del usuario. Si la
ruta del perfil tiene tildes o espacios (`C:\Users\José María\…`), pueden fallar con
**«Error catastrófico»** o abrir solo el **cuadro de ayuda de `msiexec`** sin instalar nada.
Instálalo a mano:

1. Descarga el último paquete `wsl.<versión>.x64.msi` de
   [github.com/microsoft/WSL/releases](https://github.com/microsoft/WSL/releases) (sección
   *Assets* de la release marcada como *Latest*; `arm64` solo en equipos ARM).
2. Guárdalo en una ruta **sin espacios ni tildes**, por ejemplo `C:\wsl.msi`.
3. Instálalo desde PowerShell o CMD **como administrador**:

   ```powershell
   msiexec /i C:\wsl.msi
   ```

4. **Reinicia el equipo.**
5. Fija la versión 2 por defecto y compruébalo:

   ```powershell
   wsl --set-default-version 2
   wsl --status
   ```

6. Vuelve a ejecutar `scripts\setup-windows.bat`, que ahora pasará la comprobación de WSL.

#### 3.5.2 Acceso HTTP local y «Modo solo HTTPS»

El Nginx del contenedor sirve **HTTP plano** en local: `http://localhost:<FRONTEND_PORT>` (`8080`
con la plantilla). No hay certificado. Los navegadores con **Modo solo HTTPS** activado (Floorp,
Firefox) intentan `https://localhost:8080`, que falla con un error de conexión o de protocolo:

- Escribe la URL **con** el prefijo `http://`, y acepta «Continuar al sitio HTTP» si lo pregunta, o
- añade una excepción para `localhost` en *Ajustes → Privacidad y seguridad → Modo solo HTTPS →
  Gestionar excepciones*.

Para HTTPS real, pon delante el proxy inverso del anfitrión con su certificado (§2.3).

#### 3.5.3 Puertos de PostgreSQL: interno frente a anfitrión

PostgreSQL escucha en **dos** sitios y cada cliente usa uno:

| Desde | Comando o cliente | Puerto |
|---|---|---|
| Dentro del contenedor | `docker compose --env-file backend\.env exec postgres psql -U <DB_USER> -d <DB_NAME>` | `DB_PORT` (interno, vía `PGPORT`): **sin** `-p` |
| Windows (anfitrión) | DBeaver, pgAdmin, `psql.exe -h 127.0.0.1 -p <POSTGRES_HOST_PORT> -U <DB_USER> -d <DB_NAME>` | `POSTGRES_HOST_PORT` |
| Otro contenedor de `protodo_net` | el backend (`DB_HOST=postgres`) | `DB_PORT` |

Usa `127.0.0.1` y no `localhost` en los clientes de Windows: `localhost` puede resolver primero a
`::1` (IPv6) y algunos clientes no reintentan por IPv4. Las credenciales son las de `backend\.env`
**del primer arranque** del volumen (§3.4).

---

## 4. Pruebas automatizadas en Docker

Para equipos sin Node.js ni PostgreSQL en el anfitrión. Con Node.js instalado, `npm test` y
`npm run test:e2e` desde `backend/` siguen siendo la vía rápida ([`commands.md` §4.3](commands.md#43-pruebas-jest-patrón-aaa)).

```bash
scripts/test-linux.sh            # all: unitarias y después e2e
scripts/test-linux.sh unit       # npm test          (src/**/*.spec.ts, con dobles de prueba)
scripts/test-linux.sh e2e        # npm run test:e2e  (test/**/*.e2e-spec.ts, AppModule real)
```

```bat
scripts\test-windows.bat
scripts\test-windows.bat unit
scripts\test-windows.bat e2e --no-pause
```

Los dos runners:

1. Validan `backend/.env` (§1.2). Para `e2e` y `all` exigen además `E2E_DB_NAME`, distinta de
   `DB_NAME`.
2. Levantan `postgres` y `redis` (`up -d --wait`).
3. Ejecutan `migrate-*`, que deja al día `DB_NAME` y crea o migra `E2E_DB_NAME` (§2.5).
4. Reconstruyen `backend-test` (el código va copiado en la imagen, no montado) y lanzan la suite con
   `docker compose --env-file backend/.env --profile test run --rm backend-test …`. El código de
   salida es el de Jest.

No hay suite `integration`: las pruebas con base de datos real son las `e2e`. Un argumento
desconocido termina con código `2` sin tocar Docker.

**Qué lleva el contenedor `backend-test`:**

- La etapa `test` de `backend/Dockerfile` (`FROM deps`): código completo y devDependencies. No
  cambia la imagen `runtime` del servicio `backend`.
- `env_file: backend/.env`, con `NODE_ENV=test`, `DB_HOST=postgres` y `REDIS_HOST=redis`.
- **Guarda de la base:** `DB_NAME` se sobrescribe con `E2E_DB_NAME`, y `backend/.env` se monta en
  `/app/.env` (solo lectura) para que `test/helpers/e2e-database.guard.ts` compare con la base de
  desarrollo exactamente igual que en el anfitrión. Si `E2E_DB_NAME` está vacía o coincide con
  `DB_NAME`, las e2e abortan antes de conectar.
- Montajes de solo lectura de lo que las suites leen fuera de `backend/`: `db/migrations` (en
  `/db/migrations`) y `scripts/with-test-env.sh` (en `/scripts/`).

## 5. Verificación del entorno

```bash
docker compose --env-file backend/.env --profile app config --quiet   # backend/.env completo
docker compose --env-file backend/.env --profile app ps          # todos «running» / «healthy»
docker compose --env-file backend/.env --profile app logs -f backend
curl -I http://localhost:8080/                                   # 200 (SPA); 8080 = FRONTEND_PORT
curl -s "http://localhost:8080/api/socket.io/?EIO=4&transport=polling" | head -c 80   # handshake Socket.io
```

En Windows, los mismos comandos funcionan en PowerShell (`curl.exe` en vez de `curl`) con
`backend\.env`. `config --quiet` no imprime nada si todo resuelve; evita `config` a secas, que
vuelca en pantalla los secretos de `backend/.env`.

Detener sin perder datos: `docker compose --env-file backend/.env --profile app down`.
⚠️ `down -v` **borra los volúmenes** (base de datos incluida): solo con confirmación explícita.
