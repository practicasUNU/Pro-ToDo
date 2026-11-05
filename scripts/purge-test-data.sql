-- =============================================================================
-- Purga de datos de prueba - flujos, ejecuciones y telemetria
--
-- QUE HACE. Borra TODOS los flujos salvo los cinco de referencia de la tabla
-- `keep_flujos`. Sus ejecuciones, logs de nodo, alertas y telemetria caen en
-- cascada (`ON DELETE CASCADE`, verificado en `pg_constraint` el 2026-10-23):
--
--   flujos <- ejecuciones_flujo <- logs_nodo
--          <- alertas_error (por flujo y por ejecucion)
--          <- telemetria_tokens_ia (por flujo y por ejecucion)
--
-- QUE NO TOCA, a proposito:
--   - El historial (ejecuciones, logs, alertas, telemetria) de los flujos que
--     se conservan.
--   - La telemetria del asistente de prompts (`PROMPT_OPTIMIZATION`): no cuelga
--     de ningun flujo.
--   - `audit_eventos`: es evidencia, y sus `registro_id` no son FK.
--   - Usuarios, plantillas HTML, plantillas de flujo, prompts y tarifas.
--
-- POR QUE POR ID Y NO POR NOMBRE. Los nombres se repiten (hay catorce
-- "[E2E] Pipeline dummy") y llevan erratas ("TODOSO LOS NODOS"); un ILIKE
-- amplio podria conservar de mas o borrar de menos. Los ids salen de una
-- consulta a la base real del 2026-10-23. Antes de borrar, el script comprueba
-- que los cinco existen CON EL NOMBRE esperado; si alguno no casa, aborta.
--
-- ============================ ANTES DE EJECUTAR ==============================
--
-- 1. DETENER el backend (`npm run start:dev`): hay flujos "[E2E] Pipeline
--    dummy" en ACTIVO con cron programado, y un disparo en mitad de la purga
--    insertaria ejecuciones nuevas de un flujo que se esta borrando.
--
-- 2. RESPALDO COMPLETO (obligatorio). Formato custom, restaurable por tabla:
--
--      cd backend && set -a && . ./.env && set +a
--      mkdir -p ~/backups/protodo
--      PGPASSWORD="$DB_PASSWORD" pg_dump -h localhost -p "$DB_PORT" -U "$DB_USER" \
--        -Fc -f ~/backups/protodo/protodo-$(date +%Y%m%d-%H%M).dump "$DB_NAME"
--
--    Comprobar que el volcado se lee ANTES de seguir:
--
--      pg_restore -l ~/backups/protodo/protodo-<fecha>.dump | head
--
--    Restaurar (solo si hiciera falta deshacer la purga):
--
--      PGPASSWORD="$DB_PASSWORD" pg_restore -h localhost -p "$DB_PORT" -U "$DB_USER" \
--        -d "$DB_NAME" --clean --if-exists ~/backups/protodo/protodo-<fecha>.dump
--
-- 3. EN SECO (por defecto): muestra que se borraria y termina con ROLLBACK.
--
--      PGPASSWORD="$DB_PASSWORD" psql -h localhost -p "$DB_PORT" -U "$DB_USER" \
--        -d "$DB_NAME" -f scripts/purge-test-data.sql
--
-- 4. DE VERDAD, solo tras revisar los recuentos del paso 3:
--
--      PGPASSWORD="$DB_PASSWORD" psql -h localhost -p "$DB_PORT" -U "$DB_USER" \
--        -d "$DB_NAME" -v confirmar=yes -f scripts/purge-test-data.sql
-- =============================================================================

\set ON_ERROR_STOP on

-- Sin `-v confirmar=yes`, la transaccion termina en ROLLBACK.
\if :{?confirmar}
\else
  \set confirmar no
\endif

SET client_encoding = 'UTF8';

BEGIN;

CREATE TEMP TABLE keep_flujos (
    id_flujo UUID PRIMARY KEY,
    nombre_esperado VARCHAR(100) NOT NULL
) ON COMMIT DROP;

INSERT INTO keep_flujos (id_flujo, nombre_esperado) VALUES
    ('40bbc4ef-2802-4dfb-8b07-cfe055f30aa6', 'VERIFICACION DE TITULOS SANDBOX DEF'),
    ('35bd1b4f-29b3-41c3-b1b6-a27a37441bbc', 'PRUEBA DE TODOS LOS NODOS - DRUPAL'),
    ('6b487b31-6829-471c-b202-7ceaf7ba0436', 'FLUJO DE DRUPAL E2E V2'),
    ('a1ab3480-4ced-4c81-910c-eb8e69f979c1', 'TODOSO LOS NODOS - DRUPAL + PAUSA'),
    ('67bfa06d-0668-4dc3-b73f-e7e94d05ca22', 'Abrir Licitacion SANDBOX DEF');

-- Guarda: los cinco existen y se llaman como se espera. Un id equivocado no
-- conservaria nada y el DELETE se llevaria por delante el flujo que se queria
-- guardar.
DO $$
DECLARE
    encontrados INTEGER;
BEGIN
    SELECT count(*) INTO encontrados
      FROM flujos f
      JOIN keep_flujos k ON k.id_flujo = f.id_flujo AND k.nombre_esperado = f.nombre;

    IF encontrados <> (SELECT count(*) FROM keep_flujos) THEN
        RAISE EXCEPTION
            'Purga abortada: solo % de % flujos a conservar existen con su nombre esperado.',
            encontrados, (SELECT count(*) FROM keep_flujos);
    END IF;
END $$;

\echo '== Flujos que se CONSERVAN'
SELECT f.id_flujo, f.nombre, f.status,
       (SELECT count(*) FROM ejecuciones_flujo e WHERE e.id_flujo = f.id_flujo) AS ejecuciones
  FROM flujos f
  JOIN keep_flujos k USING (id_flujo)
 ORDER BY f.nombre;

\echo '== Lo que se va a BORRAR'
SELECT
    (SELECT count(*) FROM flujos
      WHERE id_flujo NOT IN (SELECT id_flujo FROM keep_flujos)) AS flujos,
    (SELECT count(*) FROM ejecuciones_flujo
      WHERE id_flujo NOT IN (SELECT id_flujo FROM keep_flujos)) AS ejecuciones,
    (SELECT count(*) FROM logs_nodo l
       JOIN ejecuciones_flujo e ON e.id_ejecucion = l.id_ejecucion
      WHERE e.id_flujo NOT IN (SELECT id_flujo FROM keep_flujos)) AS logs_nodo,
    (SELECT count(*) FROM alertas_error a
       LEFT JOIN ejecuciones_flujo e ON e.id_ejecucion = a.id_ejecucion
      WHERE COALESCE(a.id_flujo, e.id_flujo) NOT IN (SELECT id_flujo FROM keep_flujos)) AS alertas,
    (SELECT count(*) FROM telemetria_tokens_ia
      WHERE flujo_id NOT IN (SELECT id_flujo FROM keep_flujos)) AS telemetria;

DELETE FROM flujos
 WHERE id_flujo NOT IN (SELECT id_flujo FROM keep_flujos);

\echo '== Estado DESPUES de la purga (dentro de la transaccion)'
SELECT
    (SELECT count(*) FROM flujos)               AS flujos,
    (SELECT count(*) FROM ejecuciones_flujo)    AS ejecuciones,
    (SELECT count(*) FROM logs_nodo)            AS logs_nodo,
    (SELECT count(*) FROM alertas_error)        AS alertas,
    (SELECT count(*) FROM telemetria_tokens_ia) AS telemetria,
    (SELECT count(*) FROM audit_eventos)        AS audit_eventos_intactos;

\if :confirmar
    COMMIT;
    \echo '== PURGA CONFIRMADA (COMMIT).'
\else
    ROLLBACK;
    \echo '== EN SECO: nada se ha borrado (ROLLBACK). Repite con -v confirmar=yes para aplicar.'
\endif
