# Proto-Do — Backend

API construida con [NestJS](https://nestjs.com/) que implementa el motor FSM del proyecto: ingesta de correos, extracción web, inferencia con LLM, validación/mapeo a plantillas y despacho hacia Drupal/Acens, con trazabilidad completa en PostgreSQL.

## Stack tecnológico

| Categoría | Librerías |
| --- | --- |
| **Framework** | NestJS 11 (Express), TypeORM 🐘 sobre PostgreSQL 16 |
| **Colas / Programación** | `@nestjs/bullmq`, `@nestjs/schedule` |
| **Tiempo real** | `@nestjs/websockets` + `socket.io` |
| **Ingesta de correo** | `imapflow` (conexión IMAP), `mailparser` (decodificación MIME) |
| **Extracción web** | `cheerio`, `playwright`, `@mozilla/readability`, `jsdom` |
| **Inferencia LLM** | `@anthropic-ai/sdk` (Claude), `openai` (ChatGPT) |
| **Validación / transformación** | `ajv`, `validator`, `sanitize-html`, `handlebars` |
| **Seguridad y perímetro** | `ip-range-check` (CIDR), `otplib` (OTP), `@nestjs/throttler` |
| **Trazabilidad** | `winston`, `winston-daily-rotate-file` |
| **Testing** | Jest, Supertest |

## Requisitos previos

- Node.js ≥ 22
- PostgreSQL 16 corriendo vía Docker (ver [docker-compose.yml](../docker-compose.yml) en la raíz)
- Archivo `.env` en la raíz del monorepo con las variables de entorno (ver `.env.example`)

## Arranque para desarrollo

```bash
npm install

# levanta PostgreSQL si aún no está activo
cd .. && docker compose up -d && cd backend

# servidor en modo watch
npm run start:dev
```

Otros modos de arranque:

```bash
npm run start        # ejecución simple
npm run start:debug  # con inspector de depuración
npm run start:prod   # producción (requiere `npm run build` previo)
```

## Testing

```bash
npm test            # pruebas unitarias (Jest)
npm run test:watch  # modo watch
npm run test:cov    # cobertura
npm run test:e2e    # pruebas end-to-end
```

Consulta `.claude/rules/testing-standards.md` en la raíz del proyecto para el estándar AAA y los casos límite obligatorios en cada estrategia de nodo.

## Calidad de código

```bash
npm run lint    # ESLint + Prettier con autofix
npm run format  # Prettier sobre src/ y test/
```
