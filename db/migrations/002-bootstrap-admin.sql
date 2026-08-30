-- =============================================================================
-- Migracion 002 · Arranque en frio del RBAC (PROT-04.2)
--
-- El CRUD de usuarios exige rol ADMIN (@Roles(UserRole.ADMIN) en UsersController),
-- pero crear un usuario pasa por ese mismo CRUD: sin ningun ADMIN en la tabla,
-- nadie puede crear el primero. Es un bloqueo circular que solo se rompe desde
-- fuera de la API, y este es el unico lugar legitimo para hacerlo.
--
-- La migracion NO decide a quien promover por gusto: promueve la cuenta activa
-- mas antigua, y solo si no existe ya ningun ADMIN activo. Ejecutarla dos veces
-- no cambia nada.
--
-- Aplicar con:
--   sudo docker exec -i protodo_postgres psql -U unuware007 -d 'DB_PRO-TODO' \
--     < db/migrations/002-bootstrap-admin.sql
-- =============================================================================

SET client_encoding = 'UTF8';

DO $$
DECLARE
    promoted_email VARCHAR(255);
BEGIN
    -- Guarda de idempotencia: con un ADMIN activo ya no hay bloqueo que romper,
    -- y alterar roles a posteriori corresponde al CRUD, no a una migracion.
    IF EXISTS (SELECT 1 FROM usuarios WHERE rol = 'ADMIN' AND activo = TRUE) THEN
        RAISE NOTICE 'Ya existe al menos un ADMIN activo: no se modifica nada.';
        RETURN;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM usuarios WHERE activo = TRUE) THEN
        RAISE EXCEPTION
            'No hay ninguna cuenta activa que promover. Inserta primero el administrador inicial (ver el bloque comentado al final de este archivo).';
    END IF;

    UPDATE usuarios
       SET rol = 'ADMIN'
     WHERE id_usuario = (
               SELECT id_usuario
                 FROM usuarios
                WHERE activo = TRUE
                ORDER BY fecha_creacion
                LIMIT 1
           )
    RETURNING correo INTO promoted_email;

    RAISE NOTICE 'Cuenta promovida a ADMIN: %', promoted_email;
END
$$;

-- Comprobacion del resultado
SELECT correo, rol, activo FROM usuarios ORDER BY fecha_creacion;

-- =============================================================================
-- Instalacion desde cero (tabla `usuarios` vacia)
-- =============================================================================
-- En un clonado nuevo no hay ninguna cuenta que promover, asi que el bloque de
-- arriba se detiene con una excepcion. Descomenta esto y pon el correo real del
-- administrador: no se versiona ningun correo concreto a proposito.
--
-- INSERT INTO usuarios (correo, rol, activo)
-- VALUES ('admin@unuware.com', 'ADMIN', TRUE)
-- ON CONFLICT (correo) DO UPDATE SET rol = 'ADMIN', activo = TRUE;
--
-- No hay contrasena que definir: la autenticacion es por OTP contra ese correo,
-- asi que la cuenta debe existir en un buzon al que tengas acceso real.
