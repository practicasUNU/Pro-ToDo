# COMMANDS.md — Referencia Operativa de Comandos (Proto-Do)

Manual operativo unificado del monorepo: carga de entorno, infraestructura Docker, migraciones SQL, backend NestJS, frontend Quasar, scripts de mantenimiento del sandbox y flujo de Git.

Documento vivo — actualizar ante cualquier script nuevo en `backend/package.json`, `frontend/package.json` o `.claude/commands/`.

> **No existe `package.json` en la raíz del repositorio.** No hay orquestador de workspaces: cada paquete se gestiona desde su propio directorio (`backend/`, `frontend/`). Todo comando `npm` de este documento indica desde dónde se ejecuta.

---

## 1. Carga de Variables de Entorno

### 1.1 Exportar `backend/.env` a la sesión actual

Modismo canónico, desde la **raíz del repositorio**:

```bash
set -a && source backend/.env && set +a
```

`set -a` marca para exportación toda variable que se asigne a continuación; `source` las define en **la shell actual** (no en una subshell, que es justo lo que hace falta); `set +a` cierra el modo para que las asignaciones posteriores no se exporten sin querer. A partir de ahí las variables viven en el entorno de esa terminal y las heredan todos los procesos que lance.

**Por qué importa, y no es una comodidad:**

- **El servidor MCP de PostgreSQL** (`.mcp.json`) interpola `${DB_USER}`, `${DB_PASSWORD}`, `${DB_PORT}` y `${DB_NAME}` desde el entorno del shell que lanza Claude Code o el IDE, **no** desde `backend/.env`: Node solo carga ese archivo dentro de su propio proceso. Hay que exportarlas **antes** de abrir el IDE o el servidor no conectará (`security-and-scope.md` §0).
- **Docker Compose** resuelve `${DB_USER}` y compañía leyendo un `.env` **junto al propio `docker-compose.yml`**. La raíz mantiene un symlink `.env -> backend/.env` para eso; la directiva `env_file:` de un servicio **no** sirve, solo inyecta variables dentro del contenedor en runtime.

```bash
# Recrear el symlink tras cada clonado (no se versiona: lo cubre el patrón .env* del .gitignore)
ln -s backend/.env .env
```

### 1.2 Override transitorio para una sola ejecución

Un prefijo `VAR=valor` delante del comando afecta **solo a ese proceso** y no toca la sesión:

```bash
# Timeout ampliado para una corrida concreta contra un portal lento
DRUPAL_API_TIMEOUT_MS=120000 npm run drupal:cleanup -- /prueba-verificador-titulos --dry-run
```

Es la vía preferida frente a editar `backend/.env` cuando el cambio es puntual: no deja rastro ni obliga a acordarse de revertirlo.

> ⚠️ Editar `backend/.env` **exige reiniciar el backend**. `npm run start:dev` usa `nest start --watch`, que recarga el código pero **no** vuelve a leer el `.env`.

---

## 2. Infraestructura y Base de Datos (Docker · PostgreSQL 16)

PostgreSQL corre exclusivamente dentro del contenedor `protodo_postgres` (`docker-compose.yml`, raíz). Prohibido depender de una instalación nativa o de un socket Unix del anfitrión (`security-and-scope.md` §0).

### 2.1 Requisitos previos

- Symlink `.env` → `backend/.env` en la raíz (ver §1.1).
- Variables en `backend/.env`: `DB_USER`, `DB_PASSWORD`, `DB_PORT`, `DB_NAME`.
- El puerto se publica como `${DB_PORT:-5433}:5432`: por defecto **5433** en el anfitrión, 5432 dentro del contenedor.

> 🔐 **Sobre `sudo`:** en este entorno el socket de Docker no es accesible para el usuario (`permission denied ... /var/run/docker.sock`), de modo que los comandos van con `sudo`, igual que en las cabeceras de `db/migrations/*.sql`. Si tu usuario pertenece al grupo `docker`, omítelo.

### 2.2 Ciclo de vida del contenedor

| Acción | Comando |
|---|---|
| Arrancar en segundo plano | `sudo docker compose up -d` |
| Detener (conserva el volumen) | `sudo docker compose down` |
| Ver estado | `sudo docker compose ps` |
| Logs en vivo | `sudo docker compose logs -f postgres` |
| Reiniciar sin pérdida de datos | `sudo docker compose restart postgres` |

En el primer arranque sobre un volumen vacío, Postgres ejecuta `init.sql` desde `docker-entrypoint-initdb.d`.

> ⚠️ **Comando destructivo — pérdida total de datos:**
> ```bash
> sudo docker compose down -v && sudo docker compose up -d
> ```
> Elimina el volumen `pgdata_protodo` entero y recrea la base vacía desde `init.sql`. Usar solo tras confirmación explícita.

### 2.3 Acceso interactivo a `psql`

```bash
sudo docker exec -it protodo_postgres \
  psql -U "${DB_USER:-unuware007}" -d "${DB_NAME:-DB_PRO-TODO}"
```

Las llaves con `:-` aportan el valor por defecto cuando la variable no está exportada en la sesión (§1.1). **Las comillas no son opcionales**: `DB_NAME` vale `DB_PRO-TODO` y contiene un guion.

### 2.4 Automatización vía slash command

`/docker-db <accion>` (`.claude/commands/docker-db.md`) mapea `up | down | restart | status | reset` a los comandos anteriores, exigiendo confirmación expresa antes de `reset`.

---

## 3. Migraciones de Base de Datos

**No existe CLI de TypeORM para migraciones en este proyecto** (`synchronize: false`, sin `data-source.ts`, sin scripts `migration:run|revert|generate`). Tampoco existe `npm run typeorm seed:run`. El esquema se gestiona con **SQL plano versionado**:

| Ruta | Rol |
|---|---|
| `init.sql` (raíz) | Esquema completo y definitivo. Se ejecuta **solo** en la primera inicialización del volumen Docker. Debe mantenerse sincronizado con el acumulado de las migraciones. |
| `db/migrations/NNN-descripcion.sql` | Migraciones incrementales numeradas e **idempotentes**, para bases existentes que no pueden re-sembrarse. |

### 3.1 Aplicar una migración

```bash
sudo docker exec -i protodo_postgres \
  psql -U "${DB_USER:-unuware007}" -d "${DB_NAME:-DB_PRO-TODO}" \
  < db/migrations/<archivo>.sql
```

`exec -i` (no `-it`): hay que alimentar la entrada estándar con el archivo, y pedir TTY con `-t` rompe la redirección.

Cada migración termina con sus propios `SELECT` de comprobación. **Léelos**: son el contrato de que el cambio se aplicó, y varias devuelven banderas que distinguen «aplicado» de «no encontró nada que cambiar».

```bash
# Aplicar varias en orden, deteniéndose en el primer fallo
for f in db/migrations/03{6,7,8}-*.sql; do
  echo "== $f"
  sudo docker exec -i protodo_postgres \
    psql -v ON_ERROR_STOP=1 -U "${DB_USER:-unuware007}" -d "${DB_NAME:-DB_PRO-TODO}" < "$f" || break
done
```

> ⚠️ Aplicar una migración es **decisión del desarrollador**: no ocurre al arrancar el backend ni forma parte de ningún script. El orden importa y hay dependencias entre archivos (la `038` revierte parte de la `037`, que depende de la `035`).

### 3.2 Crear una migración nueva

1. `db/migrations/<NNN>-<descripcion-kebab>.sql`, con número consecutivo al más alto existente.
2. DDL/DML **idempotente** (`IF NOT EXISTS`, `WHERE ... LIKE` que impida reaplicar, etc.).
3. Replicar el mismo cambio en `init.sql` para que una base nueva nazca con el esquema final.
4. Cabecera comentada en español explicando **el porqué**, de qué migración depende y el comando de aplicación.
5. Si toca una columna `jsonb` cuyo contenido referencia nombres por texto (`promptCode`, `nodeType`), reescribir también los registros existentes en la misma transacción.

---

## 4. Backend (NestJS 🦁) — `backend/`

Todos los comandos se ejecutan desde `backend/`.

### 4.1 Ejecución

| Comando | Descripción |
|---|---|
| `npm run start` | Arranque simple, sin recarga. |
| `npm run start:dev` | Desarrollo con *hot-reload* (`nest start --watch`). **No recarga `backend/.env`.** |
| `npm run start:debug` | Igual que `start:dev` con el inspector de Node (`--debug`). |
| `npm run build` | Compila a `dist/` (`nest build`). |
| `npm run start:prod` | Ejecuta el artefacto compilado (`node dist/main`). Requiere `build` previo. |

### 4.2 Calidad y tipos

| Comando | Descripción |
|---|---|
| `npm run lint` | ESLint sobre `{src,apps,libs,test}/**/*.ts` con `--fix`. |
| `npm run format` | Prettier `--write` sobre `src/**/*.ts` y `test/**/*.ts`. |
| `npx tsc --noEmit -p tsconfig.build.json` | **Comando de referencia** para saber si el código de producción compila (excluye `*.spec.ts`). |

> ⚠️ `npx tsc --noEmit -p tsconfig.json` (sin `.build`) reporta errores preexistentes en `*.spec.ts` —mocks de TypeORM, DTOs sin *index signature*— que **no son regresiones**. No usarlo como criterio de corrección.

### 4.3 Pruebas (Jest, patrón AAA)

| Comando | Descripción |
|---|---|
| `npm test` | Suite completa de pruebas unitarias. |
| `npm test -- <ruta.spec.ts>` | Un único archivo. |
| `npx jest <ruta1> <ruta2>` | Varios archivos concretos. |
| `npx jest -t "<nombre del test>"` | Filtra por nombre de caso. |
| `npm run test:watch` | Modo observador. |
| `npm run test:cov` | Con cobertura (`../coverage`). |
| `npm run test:debug` | `--inspect-brk --runInBand` para depuración paso a paso. |
| `npm run test:e2e` | Integración/E2E (`test/jest-e2e.json`, configuración aparte). |

> `jest.rootDir` es `src`, así que **un `.spec.ts` colocado en `backend/test/` no lo ejecuta `npm test`**. Los specs unitarios viven junto al fuente; `backend/test/` alberga factories, fixtures y los `*.e2e-spec.ts`.

---

## 5. Frontend (Vue 3 + Quasar ⚡) — `frontend/`

Todos los comandos se ejecutan desde `frontend/`.

### 5.1 Ejecución y build

| Comando | Descripción |
|---|---|
| `npm run dev` | Servidor de desarrollo Vite (`quasar dev`). |
| `npm run build` | Compilación SPA de producción (`quasar build`). |
| `npm run postinstall` | `quasar prepare --silent`; regenera `.quasar/` (automático en `npm install`). |

### 5.2 Calidad y tipos

| Comando | Descripción |
|---|---|
| `npm run typecheck` | `vue-tsc --noEmit`. **Comando de referencia** para tipos. Equivale a `npx vue-tsc --noEmit`. |
| `npm run lint` | Prettier `--write` + ESLint `--fix` sobre `src*/**/*.{ts,js,cjs,mjs,vue}`. |
| `npm run lint:check` | Variante de solo lectura — **rota como *gate*, ver aviso**. |

> ⚠️ **`npm run lint:check` no sirve como criterio de aprobación:** invoca `prettier` sin `--check`, por lo que **imprime el contenido completo de cada archivo** en vez de reportar diferencias. Alternativa fiable:
> ```bash
> npx prettier --check "**/*.{js,ts,vue,css,scss,html,md,json}" --ignore-path .gitignore
> npx eslint -c ./eslint.config.js "./src/**/*.{ts,vue}"
> ```

### 5.3 Pruebas (Vitest)

| Comando | Descripción |
|---|---|
| `npm test` | Ejecuta la suite una vez (`vitest run`). **No existe `npm run test:unit`.** |
| `npm run test:watch` | Modo observador (`vitest`). |
| `npx vitest run <ruta.spec.ts>` | Un único archivo. |

### 5.4 Variables de entorno

- Archivo real `frontend/.env` (no versionado); plantilla `frontend/.env.example`.
- Toda variable expuesta al cliente exige el prefijo `VITE_` (`security-and-scope.md` §0.1).
- Actuales: `VITE_API_BASE_URL`, `VITE_ACCEPTED_EMAIL_DOMAINS`.
- 🚫 Prohibido declarar aquí secretos de infraestructura o de terceros (`JWT_SECRET`, `OTP_SECRET`, `ANTHROPIC_API_KEY`, `DRUPAL_API_TOKEN`, `ACENS_API_KEY`). Esos viven solo en `backend/.env`.

---

## 6. Scripts Manuales y Mantenimiento del Sandbox

Se ejecutan desde `backend/`, **no son pruebas automatizadas** y no corren en CI. Requieren credenciales reales en `backend/.env`.

| Comando | Propósito |
|---|---|
| `npm run test:fsm:manual` | Flujo FSM dummy de punta a punta. |
| `npm run seed:fsm-runner` | Siembra datos de prueba para el motor FSM. |
| `npm run test:drupal:e2e` | E2E contra el sandbox real de Drupal. |
| `npm run test:e2e:titulos` | E2E del flujo verificador de títulos. |
| `npm run probe:drupal:upload` | Sonda de subida de ficheros a Drupal. |
| `npm run drupal:cleanup` | Purga los rastros de las pruebas en una página del sandbox. |
| `npm run drupal:clean` | Purga **quirúrgica** por UUID, selector o deduplicación de comités. |
| `npm run drupal:inject` | Inyecta marcado HTML en una página, por selector y modo. |

> 🔴 **`DRUPAL_API_BASE_URL` apunta a `https://www.madrimasd.org`, el portal real.** Las páginas son de sandbox, pero lo que se escribe en ellas queda publicado. **Empieza siempre por el simulacro.**

### 6.1 `drupal:cleanup` — limpieza de la página de títulos

Argumentos **posicionales** (`[alias|uuid] [selector adicional]`) más banderas reconocidas en cualquier posición.

```bash
# 1. SIMULACRO: imprime el desglose por selector, lo que preserva y los cambios de visibilidad. No escribe.
DRUPAL_API_TIMEOUT_MS=120000 npm run drupal:cleanup -- /prueba-verificador-titulos --dry-run

# 2. Ejecución real, una vez revisado el simulacro
DRUPAL_API_TIMEOUT_MS=120000 npm run drupal:cleanup -- /prueba-verificador-titulos

# Otra página del sandbox, o un selector adicional puntual
npm run drupal:cleanup -- /prueba-licitaciones
npm run drupal:cleanup -- /prueba-licitaciones '.mi-selector' --dry-run
```

Sin argumentos usa `/prueba-verificador-titulos`. El alias se resuelve a UUID por el mapa interno, con respaldo cableado para las dos páginas conocidas.

El script ya impone un **suelo de 120 s** al timeout (`Math.max(timeoutMs, CLEANUP_MIN_TIMEOUT_MS)`), de modo que `DRUPAL_API_TIMEOUT_MS=120000` es redundante pero inofensivo; el portal tarda del orden de 80 s en servir esta página y los 15 s por defecto de `DrupalApiConfig` cortaban la lectura.

#### Reset total (`--all` / `--force-all`)

Por defecto, la heurística `preserveLoneInjectedCommittee` **salva** todo comité inyectado que no tenga una copia nativa al lado, para no despublicar el único ejemplar de un comité. En una página de pruebas eso es casi todo, así que vaciarla del todo era imposible sin editar el código.

`--all` (o `--force-all`) desactiva esa heurística y purga el 100% de lo inyectado:

```bash
# Simulacro: enumera lo que se llevaría. --all SIN --write no escribe.
npm run drupal:cleanup -- /prueba-verificador-titulos --all

# Purgar absolutamente todo lo inyectado en pruebas (sin preservaciones)
npm run drupal:cleanup -- /prueba-verificador-titulos --all --write
```

> ⚠️ **`--all` exige `--write`, al contrario que el resto del script.** Es la única asimetría de `drupal:cleanup`, que por lo demás escribe por defecto y simula solo con `--dry-run`. El motivo es el peor caso de cada bandera: un olvido de `--dry-run` en una corrida normal retira los bloques de prueba, que es para lo que existe el script; un olvido con `--all` vacía la página de un portal publicado.

Lo que `--all` **no** hace: solo anula el guard de preservación. La reposición de paneles de universidad y las reglas de visibilidad de CEU siguen corriendo después, de modo que la página se queda sin inyecciones pero **con su estructura de universidades intacta**.

### 6.2 `drupal:clean` — purga quirúrgica

**Simula por defecto**: sin `--write` no emite ningún PATCH, enumera lo que quitaría y termina. `--dry-run` cancela un `--write` simultáneo.

```bash
# Inventario de lo que publicó un flujo, sin tocar nada
npm run drupal:clean -- --uuid=b17d69d8-6998-4883-b8dc-153b55dbd9c5 --injected-only

# Selector a medida, todavía en simulacro
npm run drupal:clean -- --uuid=<UUID> --selector='.panel-default:has(.panel-heading:contains("UAM 9"))'

# Aplicar de verdad
npm run drupal:clean -- --uuid=<UUID> --injected-only --write
```

**`--dedup-committees`** conserva **una sola copia por código de comité** (el texto de `.panel-comite-codigo`) y elimina las sobrantes. Es la bandera para el flujo que se ejecutó de más y publicó el mismo comité varias veces:

```bash
# Inventario de duplicados, sin tocar nada
npm run drupal:clean -- --uuid=<UUID> --dedup-committees

# Aplicar de verdad
npm run drupal:clean -- --uuid=<UUID> --dedup-committees --write
```

Detalles que conviene saber antes de usarla:

- **Conserva el primero** de cada grupo en orden de documento (el más antiguo de la página) y borra el resto.
- **Agrupa por código en toda la página**, no por universidad: dos comités con el mismo código colgando de universidades distintas se tratan como duplicados y solo sobrevive el primero. Revisa el inventario del simulacro antes de añadir `--write`.
- **Ignora los paneles sin código legible:** sin código no hay forma de saber de qué comité son copia, así que nunca se borran.
- Se ancla a `.panel-group .panel-group > .panel:has(.panel-comite-codigo)` por la regla de §6.4; **no** usa un `.panel:has(...)` suelto.
- Combinable con las demás banderas. Corre **después** de ellas, sobre el HTML que dejan.

**`--keep-count=<n>`** es la deduplicación **ordinal**: de las coincidencias de `--selector`, conserva las `n` primeras en orden de documento y purga las sobrantes. Es la bandera para cuando el criterio no es el código del comité sino «de estos, quédate con uno»:

```bash
# Simular: retiene el primero y purga los duplicados
npm run drupal:clean -- --uuid=b17d69d8-6998-4883-b8dc-153b55dbd9c5 --selector='.panel-group .panel-group > .panel:has(.panel-heading:contains("ESIC 2"))' --keep-count=1

# Aplicar de verdad
npm run drupal:clean -- --uuid=b17d69d8-6998-4883-b8dc-153b55dbd9c5 --selector='.panel-group .panel-group > .panel:has(.panel-heading:contains("ESIC 2"))' --keep-count=1 --write
```

- **Exige `--selector`.** El script puede componer hasta tres selectores a la vez (`--injected-only`, `--remove-root-panels`, `--selector`) y «conserva los primeros n» no tiene un significado único repartido entre ellos; sin `--selector` aborta.
- **Un valor no entero aborta**, no cae a 0. Un `--keep-count=dos` interpretado como 0 purgaría *todas* las coincidencias, que es lo contrario de lo pedido.
- El simulacro lista por separado **cuáles se preservan** y cuáles caen, para poder comprobar que el orden del documento es el que crees.
- Si las coincidencias no superan a `n`, es un NOOP: no se emite PATCH.

> ⚠️ `--uuid` es **obligatorio** (no acepta alias de ruta) y hay que pedir **algo** que purgar: `--injected-only`, `--remove-root-panels`, `--dedup-committees`, `--keep-count=<n>` o `--selector=<css>`. Un `--uuid=<UUID> --dry-run` a secas aborta con *«No se ha pedido nada que purgar»*.

### 6.3 `drupal:inject` — inyección de marcado

Coloca un bloque HTML dentro de una página, sin escribir un script desechable para cada ocasión. **Simula por defecto**, como `drupal:clean`.

```bash
# Inyectar desde archivo local en un sub-acordeón
npm run drupal:inject -- --uuid=b17d69d8-6998-4883-b8dc-153b55dbd9c5 --file=src/scripts/fixtures/esic-2.html --target='#accordionESIC' --mode=append --write

# Inyectar marcado en línea
npm run drupal:inject -- --uuid=b17d69d8-6998-4883-b8dc-153b55dbd9c5 --html='<div class="panel panel-default">...</div>' --target='#accordion' --write
```

| Bandera | Obligatoria | Defecto | Qué hace |
|---|---|---|---|
| `--uuid=<UUID>` | sí | — | Página destino. No acepta alias de ruta. |
| `--html=<marcado>` | una de las dos | — | Marcado en línea. No se recorta. |
| `--file=<ruta>` | una de las dos | — | Lee el marcado de un fichero local. |
| `--target=<css>` | no | `#accordion` | Contenedor donde se inserta. |
| `--mode=<modo>` | no | `append` | `append`, `prepend` o `replace`. |
| `--write` | no | *(simula)* | Sin ella no se emite ningún PATCH. |

- `append` inserta al final del contenedor, `prepend` al principio y `replace` sustituye el nodo que casa con `--target` **entero**.
- `--html` y `--file` son **excluyentes**: pedir los dos aborta.
- **Un `--target` que no casa con nada es un fallo, no un fallback.** El script no «se las arregla» cayendo a `#accordion`: aborta y dice qué selector no encontró. Un bloque en el contenedor equivocado no se distingue de uno bien puesto hasta que alguien mira la página.
- Elige el destino **visible**: la plantilla de muestra del portal cuelga de un `.d-none` y duplica cada contenedor, de modo que una búsqueda ingenua acierta con el escondido y el bloque se publica donde nadie lo ve. Si el contenedor elegido viene oculto, lo destapa y lo avisa en el simulacro.
- El simulacro imprime la longitud del marcado, cuántas veces casa el destino y una vista previa de ambos.

`src/scripts/fixtures/esic-2.html` es el bloque del comité ESIC 2, guardado para poder reinyectarlo con `--file`.

### 6.4 Regla de oro de los selectores

La página agregadora es un acordeón de **dos niveles** y los paneles de universidad y de comité comparten la clase `.panel`. Un `.panel:has(#loQueSea)` casa **también con el panel de la universidad** que contiene el objetivo: ya borró una universidad entera de la página. Toda mutación por `:has()` se ancla al segundo nivel:

```
.panel-group .panel-group > .panel:has(...)
```

---

## 7. Control de Versiones (Git Flow)

### 7.1 Metodología

- 🏛️ **`main`** es código estable. **Prohibido commitear directamente** sobre ella; lo bloquea el hook `pre-commit`.
- 🌿 Cada tarea vive en su rama: `feat/<tarea>`, `fix/<tarea>`, `docs/<tarea>`…
- 🔀 La integración a `main` se hace por Pull Request o merge, tras pasar las pruebas.

### 7.2 Conventional Commits y coincidencia de *scope*

Estructura: `tipo(alcance): descripción en español`.

Tipos permitidos: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `perf`.

**El `alcance` debe coincidir exactamente con el sufijo de la rama activa**, y lo valida el hook `commit-msg`:

| Rama | Commit válido |
|---|---|
| `feat/nodo-imap` | `feat(nodo-imap): implementar lectura de adjuntos` |
| `fix/ocr-json-truncado` | `fix(ocr-json-truncado): recortar la respuesta parcial` |
| `docs/commands-reference` | `docs(commands-reference): compilar la guía de comandos` |

> ⚠️ El hook recorta **cualquiera** de los prefijos de tipo válidos, no solo `feat/`. El patrón del alcance es `[a-zA-Z0-9_-]+`: **no admite barras**, de modo que una rama anidada como `feat/area/tarea` no tiene ningún alcance que la satisfaga.
>
> El tipo `merge` **no está permitido**, así que un mensaje como `merge(rama): …` es rechazado.

### 7.3 Los hooks no se distribuyen

`.git/hooks/pre-commit` y `.git/hooks/commit-msg` son la fuente de verdad de lo anterior, pero `.git/` queda fuera del control de versiones: **no existe copia versionada** y hay que recrearlos tras cada clonado.

```bash
chmod +x .git/hooks/pre-commit .git/hooks/commit-msg
```

### 7.4 Trabajo diario

```bash
git checkout -b fix/<tarea>          # rama nueva desde la actual
git add -A <rutas>                   # preferible a `git add .`
git commit -m "fix(<tarea>): descripción en español"
git push -u origin HEAD              # primera subida: crea la rama remota y la vincula
git push                             # subidas siguientes
```

Etiquetas:

```bash
git tag -a v1.2.0 -m "Descripción de la versión"
git push origin v1.2.0               # una concreta
git push origin --tags               # todas las pendientes
```

### 7.5 Empujar todas las ramas locales excluyendo `feat/trigger-imap-tests`

Forma recomendada — una invocación de `git push` por rama, de modo que **el fallo de una no arrastra a las demás**:

```bash
git branch --format='%(refname:short)' \
  | grep -v '^feat/trigger-imap-tests$' \
  | xargs -r -n 1 git push origin
```

Variante en una sola orden, con sustitución de comandos. Es más rápida, pero si una referencia es rechazada **se cae el push entero**:

```bash
git push origin $(git for-each-ref --format='%(refname:short)' refs/heads/ \
  | grep -v '^feat/trigger-imap-tests$')
```

Desglose:

- `git branch --format='%(refname:short)'` / `git for-each-ref ... refs/heads/` listan las ramas **locales** en texto plano, sin el asterisco ni la coloración de `git branch` a secas, que romperían el filtro.
- `grep -v '^…$'` excluye la rama con el patrón **anclado** por los dos extremos: sin `^` y `$`, un nombre que la contenga como subcadena (`feat/trigger-imap-tests-extra`) también se excluiría.
- `xargs -r -n 1` despacha **una rama por invocación**; `-r` evita ejecutar `git push` si la lista llega vacía.

> ⚠️ **Dos avisos antes de lanzarlo.** Primero: la lista incluye **`main`**, porque el filtro solo excluye lo que se le indica. Si no quieres tocarla, añade otro `grep -v '^main$'`. Segundo: este repositorio acumula **decenas de ramas locales**, así que el comando abre esa misma cantidad de subidas a `origin` de una tacada — cuenta y revisa antes de empujar:
> ```bash
> git branch --format='%(refname:short)' | grep -v '^feat/trigger-imap-tests$' | tee /dev/stderr | wc -l
> ```
> Y para ver qué haría sin hacerlo, `--dry-run` contacta con el remoto pero no escribe:
> ```bash
> git branch --format='%(refname:short)' \
>   | grep -v '^feat/trigger-imap-tests$' \
>   | xargs -r -n 1 git push --dry-run origin
> ```

---

## 8. Comandos del Asistente (`.claude/commands/`)

Slash commands invocables en Claude Code. Cada uno exige validaciones antes de tocar el repositorio.

| Comando | Uso | Resumen |
|---|---|---|
| `/nueva-rama <nombre-feature>` | Iniciar una tarea | Verifica árbol limpio, actualiza `main` y crea `feat/<nombre-feature>`. |
| `/hacer-fix <descripción>` | Corregir un bug | Ejecuta `npm test`, deduce el ámbito de la rama activa, commitea `fix(<ámbito>): …` y hace push. |
| `/actualizar-rama <descripción>` | Añadir funcionalidad | Como `/hacer-fix` pero para `feat`/`refactor`. |
| `/subir-main` | Integrar en `main` | `npm test`, `git merge --no-ff` y push a `main`. ⚠️ Nunca se invoca solo: requiere pedido explícito. |
| `/nuevo-nodo <nombre-nodo>` | Crear un nodo FSM | Genera la estrategia que implementa `INodeStrategy` y la registra en `NodeStrategyFactory`. |
| `/crear-test <ruta>` | Generar pruebas Jest | Crea/actualiza el `.spec.ts` con mocks aislados (AAA) y lo ejecuta hasta que pase. |
| `/docker-db <accion>` | Gestionar PostgreSQL | Ver §2.4. |
| `/siguiente-paso` | Planificación | Lee `git status`/`git log`, `PLAN.md` y `claude.md`, y propone la siguiente tarea. |

> ⚠️ El mensaje que genera `/subir-main` usa el tipo `merge`, que **el hook `commit-msg` rechaza** (§7.2). Hay que reescribirlo a un tipo permitido o saltarse el hook conscientemente.

---

## 9. Resumen Rápido (Quickstart)

```bash
# 0. Entorno (desde la raíz, una vez por terminal)
set -a && source backend/.env && set +a

# 1. Infraestructura
sudo docker compose up -d

# 2. Backend (terminal 1)
cd backend && npm run start:dev

# 3. Frontend (terminal 2)
cd frontend && npm run dev

# 4. Verificación antes de commitear
cd backend  && npm test && npx tsc --noEmit -p tsconfig.build.json
cd frontend && npm test && npm run typecheck
```
