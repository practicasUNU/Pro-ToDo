# Comando: /docker-db <accion>

Gestiona el ciclo de vida del contenedor de PostgreSQL 16 definido en `docker-compose.yml`, aceptando una acción opcional (`up`, `down`, `restart`, `status`, `reset`).

---

## 📋 Instrucciones de Ejecución

1. 🎯 **Identificación de la Acción:**
   - Si no se proporcionó acción, solicítala: *"Indica la acción sobre el contenedor de PostgreSQL (`up`, `down`, `restart`, `status`, `reset`):"*.

2. 🐳 **Mapeo de Acciones a Comandos:**

   | Acción | Comando | Descripción |
   | --- | --- | --- |
   | `up` | `docker compose up -d` | Levanta el contenedor `postgres` en segundo plano. |
   | `down` | `docker compose down` | Detiene y elimina el contenedor sin borrar el volumen `pgdata/`. |
   | `restart` | `docker compose restart postgres` | Reinicia el servicio sin perder datos. |
   | `status` | `docker compose ps` seguido de `docker compose logs -f postgres` | Verifica el estado y sigue los logs en vivo. |
   | `reset` | `docker compose down -v` y luego `docker compose up -d` | ⚠️ Reinicialización limpia: borra `pgdata/` y recrea la base vacía. |

3. ⚠️ **Confirmación en Acciones Destructivas:**
   - Antes de ejecutar `reset` (`down -v`), advertir explícitamente que se eliminarán todos los datos de `protodo_db` y esperar confirmación del usuario.

4. 🔍 **Diagnóstico ante Fallos:**
   - Si el contenedor no levanta, aplica el protocolo de `skills/diagnostico-docker-postgres.md` (conflicto de puerto 5432, permisos de volumen).

5. 📢 **Confirmación:**
   - Reporta el resultado de `docker compose ps` tras la operación para confirmar el estado final (`Up`, `Exited`, etc.).
