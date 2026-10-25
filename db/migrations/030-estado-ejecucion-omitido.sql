-- =============================================================================
-- Migracion 030 · Estado de ejecucion `OMITIDO`
--
-- POR QUE HACE FALTA UN ESTADO NUEVO. El contrato `NodeResult.halt` ya existe y
-- el motor ya lo honra: cuando una estrategia pide parada ordenada —el buzon no
-- traia correos (`NO_MESSAGES_FOUND`), o el asunto no casaba con el filtro
-- (`SUBJECT_FILTERED`)— el bucle anula el cursor y cae en el cierre terminal
-- comun. El problema es el DESENLACE: ese cierre escribia `EXITOSO`, de modo
-- que un sondeo en vacio y un correo publicado en Drupal quedaban en la tabla
-- EXACTAMENTE igual. Con un sondeo por minuto, cualquier recuento de exitos
-- medía sobre todo buzones vacios.
--
-- `haltReason` distinguia los dos casos, pero es una marca TRANSITORIA en
-- memoria —no hay columna— que solo ve quien despacha la ejecucion dentro del
-- mismo proceso. Nadie que consulte `ejecuciones_flujo` despues puede saberlo.
--
-- `OMITIDO` NO es un fallo. Significa "termino sin trabajo que hacer": nada
-- reventó, no hay `.log` que leer, no hay cursor que reintentar y nadie tiene
-- que intervenir. Por eso no se reutiliza `FALLIDO`, que pide atencion humana,
-- ni `INACTIVO`, que describe una fila que aun no arranco.
--
-- POR QUE VA SOLA Y SIN BLOQUE TRANSACCIONAL. PostgreSQL no permite USAR un
-- valor de enum en la misma transaccion en la que se anade (error 55P04,
-- "unsafe use of new value of enum type"). `ALTER TYPE ... ADD VALUE` se
-- autoconfirma fuera de un bloque explicito, asi que esta migracion no abre
-- ninguno y tampoco inserta ni actualiza ninguna fila con el valor nuevo.
--
-- IF NOT EXISTS la hace idempotente: reaplicarla no falla.
--
-- Ninguna fila existente cambia de estado. Las ejecuciones ya cerradas en
-- EXITOSO por un `halt` se quedan como estan: son traza historica de lo que de
-- verdad se escribio entonces, y reescribirla falsearia la auditoria con el
-- mismo criterio que la migracion 027 aplico a `logs_nodo.tipo_nodo`.
--
-- Aplicar con:
--   sudo docker exec -i protodo_postgres psql -U '<usuario_postgres>' -d '<nombre_bd_desarrollo>' \
--     < db/migrations/030-estado-ejecucion-omitido.sql
-- =============================================================================

SET client_encoding = 'UTF8';

ALTER TYPE enum_estado ADD VALUE IF NOT EXISTS 'OMITIDO';

-- Comprobacion: los seis valores del tipo, en su orden de declaracion.
SELECT enumlabel AS estado,
       enumsortorder AS orden
  FROM pg_enum
 WHERE enumtypid = 'enum_estado'::regtype
 ORDER BY enumsortorder;
