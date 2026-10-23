-- =============================================================================
-- Migracion 048 - Auditoria de acciones humanas (`audit_eventos`)
--
-- QUE ANADE. La tabla `audit_eventos`: una fila por accion humana relevante
-- (inicio de sesion correcto o fallido, cambio de rol y altas, modificaciones y
-- bajas en usuarios, flujos, plantillas e IPs autorizadas), con quien actuo,
-- desde que IP, sobre que registro y las fotografias JSONB antes y despues.
--
-- QUE PROBLEMA RESUELVE. `creado_por` / `actualizado_por` (045) solo conservan
-- el ULTIMO cambio de cada fila: no responden a "quien cambio el rol de esta
-- cuenta el martes" ni registran accesos. Esta tabla es el historial completo;
-- las columnas de la 045 se mantienen como resumen rapido en cada maestra.
--
-- DISENO.
--   - Solo insercion: nadie la edita (no hereda las columnas de la 045).
--   - `usuario_id` admite NULL: un login fallido con un correo inexistente no
--     tiene usuario. `ON DELETE SET NULL` para que el historial sobreviva.
--   - `registro_id` es texto y no UUID: no todas las tablas tienen por que
--     usar UUID, y no lleva FK porque el registro puede borrarse (allowed_ips).
--   - `creado_en` TIMESTAMPTZ, como toda columna nueva desde la 045.
--
--   - `accion` guarda los literales EN CASTELLANO. La columna es dato que un
--     auditor lee en crudo por SQL o en el CSV exportado, de modo que traducir
--     solo en la capa de informes dejaba el dato en un idioma y su
--     presentacion en otro. La restriccion se nombra
--     `audit_eventos_accion_check` para que la 050 pueda sustituirla sin
--     depender del nombre que PostgreSQL habria inventado.
--
-- OJO AL CLONAR: esta migracion nacio con los literales en ingles. Una base que
-- ya la tenia aplicada NO vuelve a ejecutarla —`schema_migrations` la da por
-- hecha—, asi que el cambio de idioma viaja en la 050. Las dos dejan el mismo
-- resultado; esta sirve a las bases nuevas y aquella a las que ya existian.
--
-- IDEMPOTENTE: `IF NOT EXISTS` en tabla e indices.
--
-- Aplicar con:
--   cd backend && npm run db:migrate
-- o directamente:
--   sudo docker exec -i protodo_postgres psql -U unuware007 -d 'DB_PRO-TODO' < db/migrations/048-crear-tabla-audit-eventos.sql
-- =============================================================================

SET client_encoding = 'UTF8';

BEGIN;

CREATE TABLE IF NOT EXISTS audit_eventos (
    id_audit_evento UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    usuario_id UUID NULL REFERENCES usuarios(id_usuario) ON DELETE SET NULL,
    accion VARCHAR(30) NOT NULL
        CONSTRAINT audit_eventos_accion_check CHECK (accion IN (
            'CREAR', 'ACTUALIZAR', 'ELIMINAR', 'CAMBIO_ROL',
            'INICIO_SESION', 'INICIO_SESION_FALLIDO', 'CIERRE_SESION',
            'ACTIVAR', 'DESACTIVAR'
        )),
    tabla_afectada VARCHAR(60) NOT NULL,
    registro_id VARCHAR(64) NULL,
    datos_anteriores JSONB NULL,
    datos_nuevos JSONB NULL,
    ip_origen VARCHAR(45) NULL,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_eventos_creado_en
    ON audit_eventos (creado_en);
CREATE INDEX IF NOT EXISTS idx_audit_eventos_usuario_fecha
    ON audit_eventos (usuario_id, creado_en);
CREATE INDEX IF NOT EXISTS idx_audit_eventos_tabla_registro
    ON audit_eventos (tabla_afectada, registro_id);

COMMIT;

-- Verificacion manual tras aplicar:
--   \d audit_eventos
