-- =============================================================================
-- Migracion 012 · Motivo legible del fallo de una ejecucion
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

