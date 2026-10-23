-- =============================================================================
-- Migracion 050 - Acciones de auditoria en castellano
--
-- QUE ANADE. Traduce los literales de `audit_eventos.accion` al castellano y
-- amplia el juego con las tres acciones que faltaban: `CIERRE_SESION`,
-- `ACTIVAR` y `DESACTIVAR`.
--
-- QUE PROBLEMA RESUELVE. Dos cosas a la vez:
--
--   1. IDIOMA. La columna es dato que un auditor lee en crudo —por SQL o en el
--      CSV que exporta `GET /api/audit/reports/export`—, y hasta ahora guardaba
--      `ROLE_CHANGE` mientras el informe imprimia «Cambio de rol». Traducir
--      solo en la capa de presentacion dejaba las dos lecturas divergiendo.
--   2. COBERTURA. `CIERRE_SESION` cierra el par con `INICIO_SESION`: sin el, la
--      traza decia cuando entro alguien pero nunca cuando salio. `ACTIVAR` y
--      `DESACTIVAR` separan del `ACTUALIZAR` generico las dos mutaciones que un
--      auditor busca por si mismas, que son las que dan o quitan acceso.
--
-- POR QUE UNA MIGRACION APARTE Y NO EDITAR LA 048. `schema_migrations` registra
-- cada archivo ya aplicado y el script lo salta en las corridas siguientes
-- (`scripts/apply-migrations.sh`). Cambiar la 048 en el sitio no tocaria
-- ninguna base que ya la tuviese: solo serviria a los clonados nuevos. Por eso
-- la 048 queda corregida para estos y esta 050 arregla a las que ya existian.
-- Sobre una base recien creada con la 048 nueva, esta no encuentra nada que
-- traducir y se limita a reponer una restriccion identica.
--
-- ORDEN OBLIGATORIO: primero se sueltan los datos y despues se impone la
-- restriccion. Al reves, el `UPDATE` chocaria contra el CHECK viejo —que no
-- conoce los literales nuevos— y la transaccion entera se vendria abajo.
--
-- IDEMPOTENTE: el `UPDATE` filtra por los valores en ingles (la segunda pasada
-- no encuentra ninguno) y la restriccion se suelta con `IF EXISTS`.
--
-- Aplicar con:
--   cd backend && npm run db:migrate
-- o directamente:
--   sudo docker exec -i protodo_postgres psql -U unuware007 -d 'DB_PRO-TODO' < db/migrations/050-auditoria-acciones-en-espanol.sql
-- =============================================================================

SET client_encoding = 'UTF8';

BEGIN;

-- 1. Fuera la restriccion vieja. El `IF EXISTS` cubre el caso de una base
--    creada ya con la 048 corregida, donde la restriccion se llama igual pero
--    su contenido es el definitivo.
ALTER TABLE audit_eventos
    DROP CONSTRAINT IF EXISTS audit_eventos_accion_check;

-- 2. Traduccion del historial. Se enumeran los seis literales en ingles en vez
--    de usar un CASE abierto: cualquier valor inesperado tiene que sobrevivir
--    intacto para que el paso 3 lo denuncie, en lugar de convertirse en NULL.
UPDATE audit_eventos
SET accion = CASE accion
    WHEN 'CREATE'       THEN 'CREAR'
    WHEN 'UPDATE'       THEN 'ACTUALIZAR'
    WHEN 'DELETE'       THEN 'ELIMINAR'
    WHEN 'ROLE_CHANGE'  THEN 'CAMBIO_ROL'
    WHEN 'LOGIN'        THEN 'INICIO_SESION'
    WHEN 'LOGIN_FAILED' THEN 'INICIO_SESION_FALLIDO'
    ELSE accion
END
WHERE accion IN (
    'CREATE', 'UPDATE', 'DELETE', 'ROLE_CHANGE', 'LOGIN', 'LOGIN_FAILED'
);

-- 3. La restriccion definitiva, con el juego completo de nueve acciones.
--    Si quedara alguna fila con un literal ajeno, este ALTER falla y revienta
--    la transaccion: es deliberado, porque una tabla de auditoria con valores
--    que el codigo no sabe interpretar es peor que una migracion que no pasa.
ALTER TABLE audit_eventos
    ADD CONSTRAINT audit_eventos_accion_check CHECK (accion IN (
        'CREAR', 'ACTUALIZAR', 'ELIMINAR', 'CAMBIO_ROL',
        'INICIO_SESION', 'INICIO_SESION_FALLIDO', 'CIERRE_SESION',
        'ACTIVAR', 'DESACTIVAR'
    ));

COMMIT;

-- Verificacion manual tras aplicar:
--   SELECT accion, COUNT(*) FROM audit_eventos GROUP BY accion ORDER BY accion;
--   \d audit_eventos
