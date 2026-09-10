-- =============================================================================
-- Migracion 012 · Motivo legible del fallo + saneado de ejecuciones pausadas
--
-- Dos partes: la columna `motivo_fallo` (DDL) y la limpieza de las ejecuciones
-- que quedaron residuales en PAUSADO (DML). Van juntas porque describen el
-- mismo cambio: dejar `ejecuciones_flujo` en un estado que la trazabilidad
-- pueda mostrar sin mentir.
--
-- `ejecuciones_flujo` sabia QUE una ejecucion habia fallado (`estado='FALLIDO'`)
-- y donde encontrar la autopsia (`ruta_archivo_log`), pero no POR QUE en
-- terminos que un operador pueda leer sin abrir un fichero del servidor.
--
-- Hasta ahora no hacia falta: todo FALLIDO lo decidia el motor tras agotar los
-- reintentos de un nodo, y el detalle vivia en el volcado forense que escribe
-- `HybridLoggerService`. Al desactivar un flujo aparece un fallo de otra
-- naturaleza: no lo provoca ningun nodo, sino una decision del operador, y no
-- genera volcado alguno porque no hay stack trace que volcar. Sin esta columna
-- esas filas quedarian indistinguibles de un fallo tecnico sin log asociado.
--
-- POR QUE AQUI Y NO EN `alertas_error`: esa tabla registra incidencias con
-- severidad que alguien debe resolver (`resuelto BOOLEAN`), y una desactivacion
-- deliberada no es una incidencia pendiente. El motivo pertenece a la fila de la
-- ejecucion, que es lo que la trazabilidad muestra.
--
-- VARCHAR(255) y NULLABLE: es una etiqueta corta, no un mensaje de error con
-- traza —para eso esta `ruta_archivo_log`—, y el nulo es el caso normal de toda
-- ejecucion que no ha fallado o cuyo fallo ya se explica por su volcado.
--
-- IDEMPOTENTE (`IF NOT EXISTS`): igual que el resto de migraciones de este
-- directorio, debe poder reaplicarse sobre una base que ya la tenga.
--
-- Las bases creadas desde cero no la necesitan: `init.sql` ya declara la columna
-- en el `CREATE TABLE`. Este archivo es para los volumenes de Docker ya
-- existentes.
-- =============================================================================

ALTER TABLE ejecuciones_flujo
    ADD COLUMN IF NOT EXISTS motivo_fallo VARCHAR(255);

COMMENT ON COLUMN ejecuciones_flujo.motivo_fallo IS
    'Motivo legible del fallo cuando no lo explica un volcado en ruta_archivo_log (p. ej. "Flujo padre desactivado").';

-- -----------------------------------------------------------------------------
-- Saneado de las ejecuciones residuales: PAUSADO -> INACTIVO
--
-- PAUSADO significa "se detuvo conservando el cursor culpable, para reintentar
-- desde ahi". Las filas acumuladas hasta hoy no cumplen esa promesa: proceden de
-- la reconciliacion de arranque de `FsmModule`, que pasa a PAUSADO todo lo que
-- encuentra EN_PROCESO al levantar el proceso, sin que nadie las haya reintentado
-- nunca —CU-09 todavia no tiene endpoint—. Son residuo de reinicios, no una cola
-- de trabajo, y mientras figuren como PAUSADO la trazabilidad afirma que hay
-- reintentos pendientes que no existen.
--
-- POR QUE TAMBIEN `paso_actual = NULL`, y no solo el estado: el motor arranca con
-- `execution.activeCursor ?? schema.entrypoint`. Una fila INACTIVO que conservase
-- su cursor reanudaria a media topologia en lugar de empezar por el entrypoint,
-- que es justo lo contrario de lo que INACTIVO significa ("el motor todavia no ha
-- tomado el primer paso"). Dejarlo seria un saneado a medias: el estado diria
-- "nueva" y el comportamiento seria "reanudada".
--
-- IDEMPOTENTE: el propio predicado es la guarda. Tras la primera pasada no queda
-- ninguna fila en PAUSADO, asi que una reejecucion afecta a 0 filas y termina en
-- exito. No hace falta `IF EXISTS` ni bloque `DO`.
--
-- SIN `BEGIN`/`COMMIT` MANUAL, igual que el resto del directorio (ver la nota de
-- la migracion 006): psql corre en autocommit y estas migraciones se apoyan en
-- ello. Las dos sentencias de este archivo son independientes entre si, asi que
-- no hay atomicidad que preservar.
--
-- NO TOCA `contexto_acumulado`: los namespaces ya calculados no estorban y son la
-- unica evidencia que queda de lo que esas ejecuciones llegaron a hacer.
-- -----------------------------------------------------------------------------

UPDATE ejecuciones_flujo
   SET estado = 'INACTIVO',
       paso_actual = NULL
 WHERE estado = 'PAUSADO';
