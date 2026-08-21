# Reglas de Flujo de Trabajo con Git y Automatización

## 1. 🚀 Metodología: GitHub Flow Simplificado
- 🏛️ **Rama `main`:** Representa el código estable para producción. Queda estrictamente prohibido realizar commits directos sobre `main`.
- 🌿 **Ramas de Funcionalidad (`feat/nombre-tarea`):** Cada tarea, corrección o módulo se desarrolla en una rama aislada creada a partir de `main`.
- 🔀 **Integración:** La unión a `main` se realiza mediante Pull Request o Merge tras validar que las pruebas unitarias pasen satisfactoriamente.

---

## 2. 🏷️ Estándar de Conventional Commits
- **Estructura Requerida:** `tipo(alcance): descripción en español`.
- **Tipos Permitidos:** `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `style`.
- **Coincidencia de Alcance (*Scope*):** El valor dentro del paréntesis debe coincidir de forma idéntica con el sufijo de la rama activa.
  - Rama: `feat/nodo-imap` ➔ Commit válido: `feat(nodo-imap): implementar lectura de correos adjuntos`.
- **Idioma del Mensaje:** La descripción de la acción debe redactarse en **español**.

---

## 3. 🪝 Scripts de Automatización (Git Hooks Locales)

Los scripts versionados en [`.git/hooks/pre-commit`](../../.git/hooks/pre-commit) y [`.git/hooks/commit-msg`](../../.git/hooks/commit-msg) son la fuente de verdad; se copian a `.git/hooks/` de la máquina local (ver activación de permisos abajo). Identificadores en inglés, mensajes al desarrollador en español:

- **Pre-commit:** bloquea cualquier commit directo sobre `main` (salvo que sea un merge en curso, `.git/MERGE_HEAD`).
- **Commit-msg:** valida el patrón `tipo(alcance): descripción` contra los tipos permitidos (`feat|fix|docs|style|refactor|test|chore|perf`) y exige que el `alcance` coincida con el sufijo de la rama activa (`feat/<alcance>`).

### Activación de Permisos

```bash
chmod +x .git/hooks/pre-commit .git/hooks/commit-msg

```