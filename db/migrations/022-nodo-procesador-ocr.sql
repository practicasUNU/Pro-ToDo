-- =============================================================================
-- Migracion 022 · Alta de `PROCESADOR_OCR` en el catalogo de nodos
--
-- QUE ANADE. Una undecima fila a `nodos`: el nodo que transcribe los adjuntos de
-- un correo que no trae texto aprovechable —una imagen, un PDF escaneado—. Es el
-- destino de la ruta de contingencia que el `PARSER_PRE_IA` declara cuando emite
-- `ERR_PARSER_UNEXTRACTABLE_MEDIA`.
--
-- POR QUE UN TIPO APARTE Y NO UN MODO DE `PROCESADOR_IA`. Hasta ahora el rescate
-- vivia DENTRO de la estrategia de IA, que se ponia en modo vision al detectar
-- ese codigo en `error_context`. Eso hacia que un mismo nodo tuviera dos
-- trabajos —transcribir y redactar— con un solo modelo, un solo prompt y un solo
-- presupuesto, cuando son decisiones distintas: el modelo bueno redactando no
-- tiene por que ser el bueno, ni el barato, haciendo OCR.
--
-- Separarlo ademas le da namespace propio (`ocr_result`). Sin el, un segundo
-- nodo de IA en el mismo grafo chocaria con el primero en `llm_response`, que la
-- regla 5 del validador de topologia declara de un solo dueno — y por eso la
-- rama de vision no podia auto-aprovisionar su destino.
--
-- POR QUE CATEGORIA `PROCESAMIENTO`. Transforma datos que ya estan dentro del
-- sistema y se los pasa al siguiente paso. No abre nada al exterior (`DESTINO`)
-- ni decide si el flujo continua (`CONTROL`).
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
--   sudo docker exec -i protodo_postgres psql -U '<usuario_postgres>' -d '<nombre_bd_desarrollo>' \
--     < db/migrations/022-nodo-procesador-ocr.sql
-- =============================================================================

SET client_encoding = 'UTF8';

BEGIN;

INSERT INTO nodos (codigo, nombre, categoria, descripcion) VALUES
    ('PROCESADOR_OCR', 'Procesador OCR', 'PROCESAMIENTO', 'Transcribe los adjuntos de un correo sin texto aprovechable (imagen o PDF escaneado). Pensado como destino de la ruta de contingencia del parser.')
ON CONFLICT (codigo) DO NOTHING;

COMMIT;

-- Verificacion manual tras aplicar:
--   SELECT codigo, nombre, categoria FROM nodos WHERE codigo = 'PROCESADOR_OCR';
--   SELECT count(*) FROM nodos;  -- deben ser 11
