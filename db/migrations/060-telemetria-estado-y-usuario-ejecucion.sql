-- =============================================================================
-- Migracion 060 - Estado de la llamada de IA, usuario de la ejecucion y
-- atribucion por defecto
--
-- QUE ANADE.
--   1. `telemetria_tokens_ia.estado` ('SUCCESS' | 'FAILED') y
--      `telemetria_tokens_ia.mensaje_error`: cada inferencia deja fila tanto si
--      el proveedor respondio como si fallo, y el fallo se puede leer.
--   2. `ejecuciones_flujo.usuario_id`: quien lanzo o reanudo la ejecucion (JWT),
--      o el remitente de un disparo IMAP si es un usuario registrado.
--   3. El literal `PRUEBA_NODO` en `audit_eventos_accion_check`: el banco de
--      pruebas deja evento de auditoria.
--   4. `fn_usuario_respaldo()`: cuenta a la que se atribuye todo lo que no
--      tiene autor conocido, y el relleno de las filas historicas sin autor.
--
-- QUE PROBLEMA RESUELVE. La tasa de exito de Informes contaba todas las
-- ejecuciones, usaran IA o no, y no habia forma de saber que modelo fallaba:
-- una llamada caida sin `usage` no dejaba rastro. Las filas de telemetria de
-- las ejecuciones de flujo, ademas, nunca tenian usuario.
--
-- POR QUE `INICIO_SESION_FALLIDO` NO SE RELLENA. Un intento fallido con un
-- correo desconocido no tiene autor por definicion; atribuirlo a una cuenta
-- real falsearia la traza de seguridad.
--
-- IDEMPOTENTE: `IF NOT EXISTS`, restricciones soltadas con `IF EXISTS` antes de
-- reponerlas, y el relleno solo toca filas NULL. Si la cuenta de respaldo no
-- existe, la funcion devuelve NULL y el relleno no cambia nada.
-- `init.sql` queda sincronizado en el mismo commit.
--
-- Aplicar con:
--   cd backend && npm run db:migrate
-- =============================================================================

SET client_encoding = 'UTF8';

BEGIN;

-- 1. Estado y error de cada llamada de IA ------------------------------------
ALTER TABLE telemetria_tokens_ia
    ADD COLUMN IF NOT EXISTS estado VARCHAR(10) NOT NULL DEFAULT 'SUCCESS',
    ADD COLUMN IF NOT EXISTS mensaje_error VARCHAR(500) NULL;

ALTER TABLE telemetria_tokens_ia
    DROP CONSTRAINT IF EXISTS chk_telemetria_estado;

ALTER TABLE telemetria_tokens_ia
    ADD CONSTRAINT chk_telemetria_estado CHECK (estado IN ('SUCCESS', 'FAILED'));

CREATE INDEX IF NOT EXISTS idx_telemetria_tokens_modelo_estado
    ON telemetria_tokens_ia (modelo_ia, estado, creado_en);

-- 2. Usuario que lanzo la ejecucion ------------------------------------------
ALTER TABLE ejecuciones_flujo
    ADD COLUMN IF NOT EXISTS usuario_id UUID NULL
        REFERENCES usuarios(id_usuario) ON DELETE SET NULL;

-- 3. Accion de auditoria del banco de pruebas --------------------------------
ALTER TABLE audit_eventos
    DROP CONSTRAINT IF EXISTS audit_eventos_accion_check;

ALTER TABLE audit_eventos
    ADD CONSTRAINT audit_eventos_accion_check CHECK (accion IN (
        'CREAR', 'ACTUALIZAR', 'ELIMINAR', 'CAMBIO_ROL',
        'INICIO_SESION', 'INICIO_SESION_FALLIDO', 'CIERRE_SESION',
        'ACTIVAR', 'DESACTIVAR', 'REANUDAR', 'FLUJO_DESCARTADO',
        'PRUEBA_NODO'
    ));

-- 4. Atribucion por defecto ---------------------------------------------------
CREATE OR REPLACE FUNCTION fn_usuario_respaldo() RETURNS UUID
    LANGUAGE sql STABLE AS $$
        SELECT id_usuario FROM usuarios WHERE correo = 'practicas@unuware.com'
    $$;

-- El DEFAULT es lo que aplica la atribucion a las filas NUEVAS: el backend
-- omite la columna cuando no conoce al autor y PostgreSQL pone la cuenta de
-- respaldo. Quien necesite un NULL real (login fallido) lo escribe explicito.
ALTER TABLE telemetria_tokens_ia ALTER COLUMN usuario_id SET DEFAULT fn_usuario_respaldo();
ALTER TABLE ejecuciones_flujo ALTER COLUMN usuario_id SET DEFAULT fn_usuario_respaldo();
ALTER TABLE audit_eventos ALTER COLUMN usuario_id SET DEFAULT fn_usuario_respaldo();

UPDATE telemetria_tokens_ia SET usuario_id = fn_usuario_respaldo()
 WHERE usuario_id IS NULL;

UPDATE ejecuciones_flujo SET usuario_id = fn_usuario_respaldo()
 WHERE usuario_id IS NULL;

UPDATE audit_eventos SET usuario_id = fn_usuario_respaldo()
 WHERE usuario_id IS NULL AND accion <> 'INICIO_SESION_FALLIDO';

UPDATE usuarios SET creado_por = COALESCE(creado_por, fn_usuario_respaldo()),
                    actualizado_por = COALESCE(actualizado_por, fn_usuario_respaldo())
 WHERE creado_por IS NULL OR actualizado_por IS NULL;
UPDATE plantillas_html SET creado_por = COALESCE(creado_por, fn_usuario_respaldo()),
                           actualizado_por = COALESCE(actualizado_por, fn_usuario_respaldo())
 WHERE creado_por IS NULL OR actualizado_por IS NULL;
UPDATE plantillas_prompts_ia SET creado_por = COALESCE(creado_por, fn_usuario_respaldo()),
                                 actualizado_por = COALESCE(actualizado_por, fn_usuario_respaldo())
 WHERE creado_por IS NULL OR actualizado_por IS NULL;
UPDATE plantillas_flujo SET creado_por = COALESCE(creado_por, fn_usuario_respaldo()),
                            actualizado_por = COALESCE(actualizado_por, fn_usuario_respaldo())
 WHERE creado_por IS NULL OR actualizado_por IS NULL;
UPDATE flujos SET creado_por = COALESCE(creado_por, fn_usuario_respaldo()),
                  actualizado_por = COALESCE(actualizado_por, fn_usuario_respaldo())
 WHERE creado_por IS NULL OR actualizado_por IS NULL;
UPDATE allowed_ips SET creado_por = COALESCE(creado_por, fn_usuario_respaldo()),
                       actualizado_por = COALESCE(actualizado_por, fn_usuario_respaldo())
 WHERE creado_por IS NULL OR actualizado_por IS NULL;
UPDATE precios_modelos_ia SET creado_por = COALESCE(creado_por, fn_usuario_respaldo()),
                              actualizado_por = COALESCE(actualizado_por, fn_usuario_respaldo())
 WHERE creado_por IS NULL OR actualizado_por IS NULL;
UPDATE credenciales SET creado_por = COALESCE(creado_por, fn_usuario_respaldo()),
                        actualizado_por = COALESCE(actualizado_por, fn_usuario_respaldo())
 WHERE creado_por IS NULL OR actualizado_por IS NULL;

COMMIT;

-- Verificacion manual tras aplicar:
--   SELECT estado, COUNT(*) FROM telemetria_tokens_ia GROUP BY estado;
--   SELECT fn_usuario_respaldo();
-- =============================================================================
