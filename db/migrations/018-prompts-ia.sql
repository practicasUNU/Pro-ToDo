-- =============================================================================
-- Migracion 018 · Repositorio de prompts de IA (PROT-15.2)
--
-- Hasta ahora la instruccion que recibe el modelo viajaba incrustada en los
-- `params` del nodo PROCESADOR_IA, dentro de `configuracion_pipeline`. Eso tenia
-- las dos consecuencias de siempre: dos flujos que comparten la misma
-- instruccion la duplican, y corregir una coma obliga a editar el JSON de cada
-- flujo por separado. `prompts_ia` la saca a su propia fila, igual que la
-- migracion 008 hizo con el HTML de las plantillas.
--
-- DESACOPLAMIENTO ESTRICTO: la tabla NO guarda proveedor, modelo, temperatura,
-- max_tokens ni referencia a ninguna plantilla HTML. Un prompt es un activo de
-- TEXTO y nada mas. Que modelo lo ejecuta lo decide la configuracion del nodo, y
-- el contexto lo aporta el `StatePayloadContext` en tiempo de ejecucion. Meter
-- aqui el modelo ataria el texto a un proveedor y haria imposible reutilizar el
-- mismo prompt con Claude y con ChatGPT, que es justo el motivo de extraerlo.
--
-- `texto_prompt TEXT` y no VARCHAR: una instruccion semantica no tiene longitud
-- previsible y cualquier limite que se eligiera aqui seria arbitrario.
--
-- `nombre VARCHAR(120) UNIQUE`: 120 como `plantillas_html`, y unico porque el
-- nombre es lo que el operador reconoce en el selector del nodo IA — dos
-- prompts homonimos serian indistinguibles ahi. Es ademas la clave por la que
-- `AiPromptsService.findByName()` los resolvera desde la estrategia.
--
-- BORRADO LOGICO (`activo`), igual que `plantillas_html` y `plantillas_flujo`:
-- un flujo ya ejecutado apunta al prompt con el que se genero su salida, y
-- borrarlo fisicamente dejaria la auditoria sin la pieza que explica el
-- resultado.
--
-- ON DELETE RESTRICT en el autor, y no CASCADE: los prompts son patrimonio del
-- equipo, no del usuario que los tecleo. Dar de baja a una persona no puede
-- llevarse por delante las instrucciones que dejo en produccion.
--
-- `init.sql` se actualiza en el mismo commit: ese archivo solo se ejecuta con el
-- volumen de Docker vacio, asi que sin la copia una base de datos nueva naceria
-- sin esta tabla.
--
-- Es idempotente: se puede reaplicar sin efectos secundarios.
--
-- Aplicar con:
--   sudo docker exec -i protodo_postgres psql -U unuware007 -d 'DB_PRO-TODO' \
--     < db/migrations/018-prompts-ia.sql
-- =============================================================================

SET client_encoding = 'UTF8';

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS prompts_ia (
    id_prompt           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Identificador humano del prompt en el selector del nodo IA.
    nombre              VARCHAR(120) NOT NULL UNIQUE,

    -- Para que sirve, en el listado administrativo. Opcional.
    descripcion         VARCHAR(255),

    -- La instruccion en si: texto puro o plantilla con marcadores
    -- {{nodo.campo}}, que resuelve el motor contra los namespaces del contexto.
    texto_prompt        TEXT NOT NULL,

    -- Borrado logico. Un prompt retirado desaparece del selector pero sigue
    -- explicando la salida de las ejecuciones que lo usaron.
    activo              BOOLEAN NOT NULL DEFAULT TRUE,

    -- Poblado desde el JWT (`@CurrentUser()`), nunca desde el DTO: el cliente
    -- no puede falsificar la autoria.
    id_usuario_creador  UUID NOT NULL REFERENCES usuarios(id_usuario) ON DELETE RESTRICT,

    fecha_creacion      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    fecha_actualizacion TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Soporta la consulta "que prompts dejo esta persona", que es la que hay que
-- responder antes de intentar darla de baja (el RESTRICT lo impedira si los hay).
CREATE INDEX IF NOT EXISTS idx_prompts_ia_id_usuario_creador
    ON prompts_ia(id_usuario_creador);

-- =============================================================================
-- Comprobacion del resultado
-- =============================================================================

SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'prompts_ia'
 ORDER BY ordinal_position;

-- La clave ajena debe salir con confdeltype = 'r' (RESTRICT).
SELECT conname, confdeltype
  FROM pg_constraint
 WHERE conrelid = 'prompts_ia'::regclass
   AND contype = 'f';
