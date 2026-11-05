# Reglas de Reproducibilidad, Seguridad y Auditoría de Dependencias (Node.js)

El repositorio contiene dos proyectos Node.js independientes, `backend/` (NestJS) y `frontend/`
(Quasar/Vite). No hay `package.json` en la raíz. Estas reglas aplican a ambos por separado. La guía
de producción que las desarrolla está en `docs/PRODUCTION_DEPS_GUIDE.md`.

---

## 1. 📦 Instalación determinista: `npm ci`

- **Obligatorio `npm ci`** en CI, en imágenes Docker, tras un clonado limpio y al verificar una rama
  ajena. `npm ci` instala exactamente lo que fija `package-lock.json`, borra `node_modules/` antes y
  falla si el lock y `package.json` no concuerdan.
- **`npm install` solo de forma consciente:** para añadir, quitar o actualizar una dependencia. El
  `package-lock.json` resultante se commitea en el mismo commit que el cambio de `package.json`.
- ❌ Prohibido `npm install --no-package-lock`, `--no-save` en cambios que se vayan a commitear, y
  borrar el lock para "resolver" un conflicto. Ante un conflicto de merge en el lock: quedarse con
  una de las dos versiones, ejecutar `npm install` y revisar el diff resultante.

---

## 2. 🔒 Lockfiles versionados

- `backend/package-lock.json` y `frontend/package-lock.json` se rastrean siempre en Git.
- ❌ Prohibido añadir `package-lock.json` (o un patrón que lo cubra) a cualquier `.gitignore`.
- El campo `integrity` (hash SHA-512) de cada paquete del lock es la garantía de que lo instalado es
  byte a byte lo publicado. No se edita a mano.
- Un PR que cambia `package.json` sin cambiar el lock correspondiente (o al revés) se rechaza.

---

## 3. 🟢 Runtime fijado: `.nvmrc` + `engines`

- `.nvmrc` en la raíz del repo fija la versión exacta de Node.js del equipo (hoy `24.16.0`). `nvm use`
  lo encuentra desde `backend/` y `frontend/` al buscar hacia arriba.
- Cada `package.json` declara `engines.node` y `engines.npm` coherentes con `.nvmrc`
  (hoy `"node": "^24.16.0"`, `"npm": "^11.0.0"`).
- Cambiar de versión mayor de Node es un cambio propio: se actualizan `.nvmrc`, ambos `engines` y la
  imagen base de Docker en el mismo commit, con build y tests en verde.

---

## 4. 🛡️ Auditoría: `npm audit --audit-level=high`

- **Cuándo:** antes de cada `/subir-main`, al añadir o actualizar dependencias y, como mínimo, una
  vez por semana en ambos proyectos.
- **Umbral:** `--audit-level=high`. Las vulnerabilidades `high` y `critical` se atienden; las
  `moderate` y `low` se revisan pero no bloquean.
- **Corrección:**
  - `npm audit fix` (sin `--force`) está permitido: solo aplica versiones compatibles con los rangos
    declarados. Tras ejecutarlo, build y tests completos.
  - ❌ `npm audit fix --force` está prohibido sin aprobación explícita: instala versiones mayores
    sin revisar sus cambios incompatibles.
  - Las subidas de versión mayor se hacen en una rama o commit propio, leyendo el changelog y con
    las suites del módulo afectado en verde.
- **Excepciones:** una vulnerabilidad `high`/`critical` que no se pueda corregir en el momento se
  registra en `docs/PRODUCTION_DEPS_GUIDE.md` (§ Excepciones vigentes) con paquete, motivo, alcance
  real (runtime de producción o solo desarrollo) y tarea de seguimiento. Lo no registrado no está
  aceptado.

---

## 5. 🩹 Parches locales y `overrides`

- `overrides` en `package.json` o `patch-package` solo se usan para forzar una versión segura de una
  dependencia transitiva cuando el paquete padre aún no la admite.
- Cada uso se documenta en la guía de producción con el motivo y la condición para retirarlo, y se
  revisa en cada auditoría.
