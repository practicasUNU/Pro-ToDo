-- =============================================================================
-- Migracion 039 · Estado de ejecucion `DESCARTADO`
--
-- POR QUE HACE FALTA UN ESTADO NUEVO. Desde CU-09 una ejecucion PAUSADO solo
-- tiene UNA salida: reanudarla. Cuando la causa es irrecuperable —un UUID de
-- Drupal que no existe, un buzon dado de baja, una plantilla retirada— el
-- operador no puede cerrarla, y la fila se queda en la tabla invitando a
-- reintentar algo que no va a funcionar nunca. El descarte es esa segunda
-- salida: la renuncia explicita de una persona.
--
-- POR QUE NO SE REUTILIZA `FALLIDO`. Aquel significa "el motor se rindio tras
-- agotar lo que sabia hacer" y pide atencion humana: cada FALLIDO es una
-- incidencia que alguien debe mirar. `DESCARTADO` es justo lo contrario —ya se
-- miro, y se decidio abandonar—, asi que contarlos juntos haria que el recuento
-- de incidencias creciese cada vez que alguien resuelve una. Tampoco sirve
-- `OMITIDO`, que describe una ejecucion que termino sin trabajo que hacer sin
-- que nadie interviniera.
--
-- Una fila DESCARTADO pierde el cursor (`paso_actual = NULL`): es terminal y no
-- se reanuda. Conserva `contexto_acumulado` y `ruta_archivo_log` como traza
-- forense de hasta donde llego.
--
-- POR QUE VA SOLA Y SIN BLOQUE TRANSACCIONAL. PostgreSQL no permite USAR un
-- valor de enum en la misma transaccion en la que se anade (error 55P04,
-- "unsafe use of new value of enum type"). `ALTER TYPE ... ADD VALUE` se
-- autoconfirma fuera de un bloque explicito, asi que esta migracion no abre
-- ninguno y tampoco inserta ni actualiza ninguna fila con el valor nuevo.
--
-- IF NOT EXISTS la hace idempotente: reaplicarla no falla.
--
-- Ninguna fila existente cambia de estado. Las ejecuciones que alguien cerro a
-- mano por SQL antes de que existiera este valor se quedan como estan: son
-- traza historica de lo que de verdad se escribio entonces, con el mismo
-- criterio que aplicaron las migraciones 027 y 030.
--
-- Aplicar con:
--   sudo docker exec -i protodo_postgres psql -U unuware007 -d 'DB_PRO-TODO' \
--     < db/migrations/039-estado-ejecucion-descartado.sql
-- =============================================================================

SET client_encoding = 'UTF8';

ALTER TYPE enum_estado ADD VALUE IF NOT EXISTS 'DESCARTADO';

-- Comprobacion: los siete valores del tipo, en su orden de declaracion.
SELECT enumlabel AS estado,
       enumsortorder AS orden
  FROM pg_enum
 WHERE enumtypid = 'enum_estado'::regtype
 ORDER BY enumsortorder;
