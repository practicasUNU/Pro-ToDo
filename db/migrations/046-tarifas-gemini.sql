-- =============================================================================
-- Migracion 046 - Tarifas de Gemini en `precios_modelos_ia`
--
-- QUE ANADE. Las tarifas de Gemini que la migracion 045 dejo pendientes (bloque
-- TODO). Sin ellas, cada inferencia de Gemini -el proveedor por defecto de los
-- nodos PROCESADOR_IA y PROCESADOR_OCR- se registraba con coste 0 y
-- `es_estimado = TRUE`.
--
-- POR QUE UNA MIGRACION NUEVA Y NO EDITAR LA 045. `apply-migrations.sh` salta
-- todo fichero ya registrado en `schema_migrations` (compara solo el nombre):
-- en una base que ya tenga la 045, editarla no tendria ningun efecto.
--
-- TARIFAS (USD por millon de tokens, prompt / completacion / razonamiento):
--   gemini-1.5-flash, gemini-3.6-flash   0.075 / 0.30 / 0.30
--   gemini-1.5-pro,   gemini-3.8-flash   1.25  / 5.00 / 5.00
--   '*' (generica de GEMINI)             0.10  / 0.40 / 0.40
-- El razonamiento (`thoughtsTokenCount`) se cobra a tarifa de salida. Para la
-- generica no se especifico, asi que toma la de completacion. La generica se
-- aplica a cualquier modelo de Gemini sin fila propia y deja el coste marcado
-- como estimado.
--
-- `init.sql` se actualiza en el mismo commit.
--
-- IDEMPOTENTE: `ON CONFLICT (proveedor_ia, modelo_ia, vigente_desde) DO NOTHING`.
--
-- Aplicar con:
--   cd backend && npm run db:migrate
-- o directamente:
--   sudo docker exec -i protodo_postgres psql -U unuware007 -d 'DB_PRO-TODO' < db/migrations/046-tarifas-gemini.sql
-- =============================================================================

SET client_encoding = 'UTF8';

BEGIN;

INSERT INTO precios_modelos_ia (
    proveedor_ia, modelo_ia,
    tarifa_prompt_usd_mtok, tarifa_completacion_usd_mtok, tarifa_razonamiento_usd_mtok,
    vigente_desde
) VALUES
    ('GEMINI', 'gemini-1.5-flash', 0.075, 0.30, 0.30, '2026-10-01 00:00:00+00'),
    ('GEMINI', 'gemini-3.6-flash', 0.075, 0.30, 0.30, '2026-10-01 00:00:00+00'),
    ('GEMINI', 'gemini-1.5-pro',   1.25,  5.00, 5.00, '2026-10-01 00:00:00+00'),
    ('GEMINI', 'gemini-3.8-flash', 1.25,  5.00, 5.00, '2026-10-01 00:00:00+00'),
    ('GEMINI', '*',                0.10,  0.40, 0.40, '2026-10-01 00:00:00+00')
ON CONFLICT (proveedor_ia, modelo_ia, vigente_desde) DO NOTHING;

COMMIT;

-- Verificacion manual tras aplicar:
--   SELECT modelo_ia, tarifa_prompt_usd_mtok, tarifa_completacion_usd_mtok,
--          tarifa_razonamiento_usd_mtok
--     FROM precios_modelos_ia WHERE proveedor_ia = 'GEMINI' ORDER BY modelo_ia;
