# Índice de Reglas del Proyecto (`.claude/rules/`)

> El índice canónico es `claude.md` (§ "📜 Reglas del Proyecto"). Este archivo es un espejo breve
> para quien navegue la carpeta; al añadir una regla, actualizar los dos.

* `architecture-patterns.md`: motor FSM, patrón Strategy (`INodeStrategy`) y contexto inmutable.
* `code-conventions.md`: idioma de identificadores, estándares TypeScript/Vue y orden de archivos.
* `dependency-security.md`: `npm ci`, lockfiles versionados, runtime fijado (`.nvmrc` + `engines`) y auditoría `npm audit --audit-level=high`.
* `frontend-architecture.md`: capa de servicios HTTP y flujo Componente → Store → Servicio.
* `frontend-quasar.md`: tokens `--pd-*`, tríada modular de nodos y Poka-Yoke.
* `git-workflow.md`: ramas y Conventional Commits.
* `security-and-scope.md`: PostgreSQL en Docker, red local, OTP y límites de alcance.
* `system-prompt.md`: identidad del asistente y artefactos obligatorios.
* `testing-standards.md`: patrón AAA, dobles de prueba y casos límite.
