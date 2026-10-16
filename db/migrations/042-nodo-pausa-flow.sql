-- =============================================================================
-- Migracion 042 · Alta de `PAUSA_FLOW` en el catalogo de nodos
--
-- QUE ANADE. Una duodecima fila a `nodos`: el nodo que detiene el flujo A
-- PROPOSITO, dejandolo reanudable. No es un destino ni un fallo.
--
-- QUE PROBLEMA RESUELVE. Hasta ahora la UNICA forma de que una ejecucion
-- quedara en PAUSADO era que algo se rompiera. Un flujo que debe esperar a una
-- validacion humana —el visto bueno de redaccion antes de publicar— no tenia
-- como expresarlo: o se publicaba solo, o alguien daba de baja el flujo entero
-- y perdia el contexto de la ejecucion en curso. Este nodo da a esa espera un
-- sitio en el grafo, con su propio `pause_context` que explica en trazabilidad
-- por que una ejecucion termina a medias sin ningun error asociado.
--
-- POR QUE CATEGORIA `CONTROL` Y NO `DESTINO`. No entrega nada fuera del
-- sistema, y sobre todo conserva su `nextStep`: ahi es donde queda el cursor
-- para que un operador reanude por CU-09. Un `DESTINO` tiene que cerrar el
-- flujo (regla 11 del validador de topologia), que es justo lo contrario.
--
-- NO HAY AUTO-REANUDACION, y su ausencia es una decision. De PAUSADO solo se
-- sale por `POST /api/executions/:id/resume`, con una persona delante. Lo que el
-- nodo parametriza es CUANDO entra la pausa —en el acto o tras un retardo—, no
-- quien la deshace.
--
-- POR QUE `INSERT ... ON CONFLICT` Y NO UN `UPDATE`. La fila no existe en
-- ninguna de las dos vias de siembra, asi que hay que crearla. El
-- `ON CONFLICT (codigo)` la hace reaplicable: `nodos_codigo` es la UNIQUE que la
-- migracion 011 dejo con ese nombre canonico.
--
-- `init.sql` se actualiza en el mismo commit. Sin eso, un volumen de Docker
-- nuevo naceria sin la fila y esta migracion haria falta para siempre, que es
-- justo el error que la 013 documenta haber cometido antes.
--
-- Idempotente: se puede reaplicar sin efectos secundarios.
--
-- Aplicar con:
--   sudo docker exec -i protodo_postgres psql -U unuware007 -d 'DB_PRO-TODO' \
--     < db/migrations/042-nodo-pausa-flow.sql
-- =============================================================================

SET client_encoding = 'UTF8';

BEGIN;

INSERT INTO nodos (codigo, nombre, categoria, descripcion) VALUES
    ('PAUSA_FLOW', 'Pausa de Flujo', 'CONTROL', 'Detiene el flujo de forma deliberada y lo deja reanudable por un operador (CU-09). Admite pausa inmediata o tras un retardo, y puede avisar por correo.')
ON CONFLICT (codigo) DO NOTHING;

COMMIT;

-- Verificacion manual tras aplicar:
--   SELECT codigo, nombre, categoria FROM nodos WHERE codigo = 'PAUSA_FLOW';
--   SELECT count(*) FROM nodos;  -- deben ser 12
