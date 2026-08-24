# Proto-Do — Frontend

SPA construida con [Vue 3](https://vuejs.org/) y [Quasar Framework](https://quasar.dev/) para la operación, configuración y monitoreo en tiempo real de los flujos FSM del backend.

## Stack tecnológico

| Categoría | Librerías |
| --- | --- |
| **Framework** | Vue 3 (Composition API, `<script setup>`), Quasar 2 (Vite) |
| **Estado global** | Pinia |
| **Enrutamiento** | Vue Router |
| **Comunicación** | Axios (HTTP), `socket.io-client` (eventos en tiempo real de los flujos) |
| **Calidad** | ESLint, Prettier, `vue-tsc` (chequeo de tipos) |

## Requisitos previos

- Node.js `>= 26 || ^24 || ^22.12`
- Backend corriendo (ver [../backend/README.md](../backend/README.md)) para consumir la API y los WebSockets

## Instalación

```bash
pnpm install
# o: yarn/npm/bun install
```

## Arranque para desarrollo

```bash
pnpm run dev
# o: quasar dev
```

Levanta el servidor de Vite con Hot Module Replacement y reporte de errores en pantalla.

## Testing y chequeo de tipos

```bash
pnpm run typecheck   # verificación de tipos con vue-tsc
pnpm run lint        # ESLint + Prettier con autofix
pnpm run lint:check  # solo verificación, sin modificar archivos
```

> Nota: el proyecto aún no cuenta con suite de pruebas unitarias/e2e configurada en el frontend.

## Build de producción

```bash
pnpm run build
# o: quasar build
```

## Configuración

Ver [Configuring quasar.config.js](https://v2.quasar.dev/quasar-cli-vite/quasar-config-file) para ajustes del CLI de Quasar.
