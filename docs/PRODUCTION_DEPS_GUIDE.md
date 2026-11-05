# Guía de Producción: Dependencias Node.js

Documento técnico que desarrolla la regla `.claude/rules/dependency-security.md`. Cubre cómo se
garantiza que el código que se prueba es el mismo que se despliega, cómo se verifica la integridad
de cada paquete y cómo se audita la cadena de suministro.

Ámbito: `backend/` (NestJS) y `frontend/` (Quasar/Vite), dos proyectos con su propio
`package.json` y `package-lock.json`. No hay `package.json` en la raíz.

---

## 1. Determinismo

Un rango como `"axios": "^1.19.0"` admite cualquier `1.x` posterior. Sin un lock, dos instalaciones
del mismo commit en días distintos pueden resolver árboles distintos, y un fallo de producción deja
de ser reproducible en local.

`package-lock.json` congela el árbol completo: versión exacta, URL de descarga e `integrity` de cada
dependencia, directa o transitiva.

| Comando | Lee el lock | Modifica el lock | Uso |
|---|---|---|---|
| `npm ci` | Sí, exacto | Nunca. Falla si no concuerda con `package.json` | CI, Docker, clonado limpio, verificación |
| `npm install` | Como punto de partida | Sí, si hay que resolver algo | Añadir, quitar o actualizar dependencias |
| `npm audit fix` | Sí | Sí, dentro de los rangos declarados | Corrección de vulnerabilidades sin cambio mayor |

Flujo habitual tras un `git pull` o al cambiar de rama:

```bash
nvm use                    # lee .nvmrc de la raíz
cd backend  && npm ci
cd ../frontend && npm ci   # ejecuta también el postinstall (quasar prepare)
```

---

## 2. Integridad (SHA-512)

Cada entrada del lock lleva un campo `integrity` con el hash Subresource Integrity del tarball:

```json
"node_modules/axios": {
  "version": "1.x.y",
  "resolved": "https://registry.npmjs.org/axios/-/axios-1.x.y.tgz",
  "integrity": "sha512-…"
}
```

- `npm ci` descarga el tarball, calcula su SHA-512 y aborta con `EINTEGRITY` si no coincide. Un
  paquete alterado en el registro, en un proxy o en la caché local no llega a instalarse.
- El hash no se edita a mano. Si aparece un `EINTEGRITY` legítimo (caché corrupta):
  `npm cache verify` y repetir `npm ci`. Si persiste, se investiga antes de regenerar el lock.
- `npm audit signatures` verifica además las firmas del registro y las atestaciones de procedencia
  de los paquetes instalados. Se recomienda como paso de CI junto a `npm audit`.

---

## 3. Runtime de Node.js

- `.nvmrc` (raíz): versión exacta del equipo, hoy `24.16.0`.
- `engines` en ambos `package.json`: `"node": "^24.16.0"`, `"npm": "^11.0.0"`.

npm solo avisa (`EBADENGINE`) cuando el runtime no cumple `engines`. Para que falle, CI puede
ejecutar `npm ci --engine-strict`. La imagen Docker fija la misma versión mayor (§4).

Cambiar de versión de Node es un commit propio que toca `.nvmrc`, ambos `engines` y la imagen base,
con build y tests en verde.

---

## 4. Contenedores Docker multi-stage (referencia)

El repo aún no incluye Dockerfiles de aplicación. Esta es la plantilla de referencia para cuando se
añadan. Separa la instalación, la compilación y el runtime para que la imagen final no contenga
dependencias de desarrollo, código fuente ni herramientas de build.

### Backend (NestJS)

```dockerfile
# syntax=docker/dockerfile:1
ARG NODE_VERSION=24.16.0

# 1) Dependencias completas, solo desde el lock
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# 2) Compilación
FROM deps AS build
COPY . .
RUN npm run build

# 3) Runtime: solo dependencias de producción
FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
CMD ["node", "dist/main"]
```

### Frontend (Quasar SPA)

```dockerfile
ARG NODE_VERSION=24.16.0
FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Solo estáticos: ningún runtime de Node en la imagen final
FROM nginx:stable-alpine AS runtime
COPY --from=build /app/dist/spa /usr/share/nginx/html
```

Reglas de la plantilla:

- Copiar `package.json` y `package-lock.json` **antes** que el código: la capa de `npm ci` se
  reutiliza mientras no cambien las dependencias.
- Nunca `npm install` dentro de un Dockerfile.
- Fijar la etiqueta de la imagen base a la versión de `.nvmrc`. En producción, preferir además el
  digest (`node:24.16.0-alpine@sha256:…`).
- Ejecutar como usuario no root (`USER node`).
- `.dockerignore` con al menos `node_modules`, `dist`, `.env*` y `*.log`: los `.env` nunca entran en
  la imagen (ver `security-and-scope.md` §0.1).

---

## 5. Auditoría en CI/CD

Paso mínimo por proyecto, que falla el pipeline ante `high` o `critical`:

```bash
npm ci
npm audit --audit-level=high
npm audit signatures
```

- Frecuencia: en cada PR, antes de cada `/subir-main` y en una ejecución programada semanal (aparecen
  avisos nuevos sobre versiones ya instaladas aunque el código no cambie).
- Para separar el riesgo de producción del de desarrollo:
  `npm audit --omit=dev --audit-level=high`. Una vulnerabilidad solo de desarrollo sigue
  atendiéndose, pero su urgencia es menor.
- Corrección: `npm audit fix` sin `--force`, seguido de las verificaciones completas:

```bash
cd backend  && npm run build && npm run test
cd frontend && npx vue-tsc --noEmit && npm run test
```

- Las correcciones que exigen versión mayor van en rama o commit propio, con el changelog leído y
  las suites del módulo afectado en verde. `npm audit fix --force` no se usa sin aprobación.

---

## 6. Parches locales y `overrides`

Cuando una dependencia transitiva vulnerable no se puede actualizar porque el paquete padre fija un
rango antiguo:

1. Preferir actualizar el paquete padre.
2. Si no hay versión del padre que lo resuelva, usar `overrides` en `package.json`:

   ```json
   "overrides": { "paquete-vulnerable": "^x.y.z" }
   ```

3. `patch-package` solo para un fallo concreto sin versión publicada que lo corrija; el parche se
   versiona en `patches/`.

Todo `override` o parche se registra en la tabla de §7 con su motivo y la condición para retirarlo,
y se revisa en cada auditoría.

---

## 7. Excepciones vigentes

Vulnerabilidades `high`/`critical` conocidas y aceptadas temporalmente. Revisión: 2026-11-04.

| Proyecto | Paquete | Severidad | Alcance | Motivo | Seguimiento |
|---|---|---|---|---|---|
| `backend` | `nodemailer` (`^9.1.1`) | high | Producción: envío del OTP y alertas SMTP | El arreglo es la versión mayor `10.x`; `npm audit fix` no la aplica | Rama propia para migrar a `10.x` con las suites de correo y alertas SMTP en verde |
| `frontend` | `happy-dom` (`^20.14.5`) | high | Solo desarrollo: entorno DOM de algunos specs de Vitest; no llega al bundle | El arreglo es la versión mayor `21.x` | Subir a `21.x` y ejecutar la suite completa del frontend |

`overrides` / parches locales activos: ninguno.
