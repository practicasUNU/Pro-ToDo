-- =============================================================================
-- Migracion 021 · Alta de `DESTINO_SMTP` en el catalogo de nodos
--
-- QUE ANADE. Una decima fila a `nodos`: el nodo de alerta por correo que da
-- destino a las rutas de recuperacion de `onErrorStep`. Hasta ahora el motor
-- sabia desviar ante un fallo, pero no habia ningun nodo al que desviar que
-- pudiera avisar a un humano, de modo que la rama de recuperacion solo servia
-- para reintentar por otro camino automatico.
--
-- POR QUE CATEGORIA `DESTINO` Y NO `CONTROL`. El criterio de la familia
-- `DESTINO` es escribir FUERA del sistema, y eso es exactamente lo que hace:
-- abre una conexion SMTP y entrega un mensaje. Que su contenido sea un aviso de
-- incidencia y no una publicacion de contenido es una diferencia de proposito,
-- no de papel en el grafo. `CONTROL` agrupa a los nodos que deciden si el flujo
-- sigue —hoy solo `ESCUDO_POST_IA`— y este no decide nada: es terminal.
--
-- POR QUE `INSERT ... ON CONFLICT` Y NO UN `UPDATE`. La fila no existe en
-- ninguna de las dos vias de siembra (`init.sql` ni la migracion 005), asi que
-- hay que crearla. El `ON CONFLICT (codigo)` la hace reaplicable: `nodos_codigo`
-- es la UNIQUE que la migracion 011 dejo con ese nombre canonico.
--
-- `ui_schema` NO se menciona: la migracion 020 elimino esa columna.
--
-- `init.sql` se actualiza en el mismo commit. Sin eso, un volumen de Docker
-- nuevo naceria sin la fila y esta migracion haria falta para siempre, que es
-- justo el error que la 013 documenta haber cometido antes.
--
-- Idempotente: se puede reaplicar sin efectos secundarios.
--
-- Aplicar con:
--   sudo docker exec -i protodo_postgres psql -U '<usuario_postgres>' -d '<nombre_bd_desarrollo>' \
--     < db/migrations/021-nodo-destino-smtp.sql
-- =============================================================================

SET client_encoding = 'UTF8';

BEGIN;

INSERT INTO nodos (codigo, nombre, categoria, descripcion) VALUES
    ('DESTINO_SMTP', 'Alerta por Correo', 'DESTINO', 'Envia un correo de aviso interpolando datos del flujo. Pensado como destino de las rutas de recuperacion ante error.')
ON CONFLICT (codigo) DO NOTHING;

COMMIT;

-- Verificacion manual tras aplicar:
--   SELECT codigo, nombre, categoria FROM nodos WHERE codigo = 'DESTINO_SMTP';
--   SELECT count(*) FROM nodos;  -- deben ser 10
