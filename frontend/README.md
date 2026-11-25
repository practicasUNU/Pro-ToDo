# Proto-Do — Frontend

SPA construida con [Vue 3](https://vuejs.org/) y [Quasar Framework](https://quasar.dev/) para la operación, configuración y monitoreo en tiempo real de los flujos FSM del backend.

## Stack tecnológico

| Categoría         | Librerías                                                               |
| ----------------- | ----------------------------------------------------------------------- |
| **Framework**     | Vue 3 (Composition API, `<script setup>`), Quasar 2 (Vite)              |
| **Estado global** | Pinia                                                                   |
| **Enrutamiento**  | Vue Router                                                              |
| **Comunicación**  | Axios (HTTP), `socket.io-client` (eventos en tiempo real de los flujos) |
| **Calidad**       | ESLint, Prettier, `vue-tsc` (chequeo de tipos), Vitest                  |

## Requisitos previos

- Node.js **24.16.0** (`.nvmrc` en la raíz) y npm ≥ 11, según `engines` de `package.json`.
- Backend corriendo (ver [../backend/README.md](../backend/README.md)) para consumir la API y los WebSockets.

## Instalación

```bash
npm ci   # instalación determinista desde package-lock.json; ejecuta `quasar prepare` (postinstall)
```

No uses `npm install` (ni `pnpm`/`yarn`) en un clonado limpio: el único lockfile versionado es `package-lock.json`. Ver [docs/PRODUCTION_DEPS_GUIDE.md](../docs/PRODUCTION_DEPS_GUIDE.md).

## Variables de entorno

```bash
cp .env.example .env
```

- Toda variable expuesta al cliente lleva el prefijo `VITE_` (`VITE_API_BASE_URL`, `VITE_ACCEPTED_EMAIL_DOMAINS`).
- 🚫 Nunca declares aquí secretos de infraestructura ni tokens de terceros: viven solo en `backend/.env`.

## Arranque para desarrollo

```bash
npm run dev   # quasar dev: Vite con HMR
```

## Testing y chequeo de tipos

```bash
npm test             # Vitest, una pasada (vitest run)
npm run test:watch   # Vitest en modo observador
npm run typecheck    # vue-tsc --noEmit (referencia de tipos)
npm run lint         # Prettier --write + ESLint --fix
```

> ⚠️ `npm run lint:check` **no sirve como gate**: invoca `prettier` sin `--check` e imprime cada archivo. Alternativa fiable:
>
> ```bash
> npx prettier --check "**/*.{js,ts,vue,css,scss,html,md,json}" --ignore-path .gitignore
> npx eslint -c ./eslint.config.js "./src/**/*.{ts,vue}"
> ```

## Build de producción

```bash
npm run build   # quasar build
```

## Configuración

Ver [Configuring quasar.config.js](https://v2.quasar.dev/quasar-cli-vite/quasar-config-file) para ajustes del CLI de Quasar. La referencia operativa de comandos del monorepo está en [docs/commands.md](../docs/commands.md).
