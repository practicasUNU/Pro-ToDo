-- =============================================================================
-- Migracion 028 · Semillas de `plantillas_html` para los dos flujos operativos
--
-- Hasta ahora `plantillas_html` nacia VACIA: ni `init.sql` ni ninguna migracion
-- sembraba una sola fila, de modo que el `<q-select>` del nodo
-- MAPEADOR_PLANTILLA no ofrecia nada y el asistente no se podia completar sin
-- redactar antes una plantilla a mano desde el gestor.
--
-- POR QUE LAS PLANTILLAS NO LLEVAN MARCADORES. Es la parte que mas sorprende al
-- leerlas, y no es un olvido. El MAPEADOR_PLANTILLA ya NO interpola: desde el
-- cambio de semantica entrega el esqueleto saneado para que lo rellene un
-- PROCESADOR_IA posterior, y rechaza con ERR_TEMPLATE_PENDING_VARS cualquier
-- plantilla cuya columna `variables_esperadas` no venga vacia. Una semilla con
-- `{{llm_response.expediente}}` dejaria el flujo PAUSADO en la primera
-- ejecucion. Ademas `TemplatesService.assertDeterministicSyntax` prohibe las
-- formas de bloque `{{#if}}` y `{{#each}}`, de modo que una condicional o un
-- bucle no son expresables aqui ni aunque el nodo los admitiera.
--
-- Por eso cada hueco se nombra por CLASE y se deja VACIO: un hueco a rellenar
-- solo es expresable como posicion del DOM. Esas mismas clases son las que el
-- ESCUDO_POST_IA autodetecta desde el marcado del mapeador para proponer sus
-- `requiredSelectors`, asi que nombrarlas bien tiene premio aguas abajo.
--
-- `variables_esperadas` se escribe a '[]' explicitamente aunque sea el DEFAULT
-- de la columna: es exactamente lo que `TemplatesService` recalcularia desde
-- este HTML, y dejarlo escrito evita que una futura edicion desde el gestor
-- parezca haber cambiado algo que en realidad ya valia eso.
--
-- `id_usuario_creador` es NOT NULL con clave ajena a `usuarios`, asi que la
-- semilla resuelve el autor en tiempo de aplicacion (mismo patron que la
-- migracion 023). Sin ADMIN activo AVISA y no inserta, en vez de reventar.
--
-- Idempotente: `nombre` tiene indice unico (`idx_plantillas_html_nombre`) y el
-- INSERT cierra con ON CONFLICT (nombre) DO NOTHING. Si el equipo ya ajusto una
-- plantilla desde el gestor, reaplicar la migracion NO se lo pisa: curar
-- plantillas es trabajo del CRUD, no de una migracion.
--
-- Aplicar con:
--   sudo docker exec -i protodo_postgres psql -U '<usuario_postgres>' -d '<nombre_bd_desarrollo>' \
--     < db/migrations/028-seed-plantillas-operativas.sql
-- =============================================================================

SET client_encoding = 'UTF8';

DO $$
DECLARE
    autor UUID;
BEGIN
    SELECT id_usuario
      INTO autor
      FROM usuarios
     WHERE rol = 'ADMIN' AND activo = TRUE
     ORDER BY fecha_creacion
     LIMIT 1;

    IF autor IS NULL THEN
        RAISE WARNING 'Sin ningun usuario ADMIN activo no se pueden sembrar las plantillas (id_usuario_creador es NOT NULL). Aplica db/migrations/002-bootstrap-admin.sql y vuelve a lanzar esta migracion.';
        RETURN;
    END IF;

    INSERT INTO plantillas_html (nombre, descripcion, contenido_html, variables_esperadas, id_usuario_creador)
    VALUES
        (
            'Licitaciones · Convocatoria abierta (Madrid+D)',
            'Esqueleto de un bloque de licitacion para la pagina agregadora de convocatorias abiertas. Lo rellena el PROCESADOR_IA; el destino es el preset ABRIR_LICITACION (APPEND_HTML_BLOCK sobre node--page 55937).',
            -- El envoltorio es un <div> y NO un <article>: la lista blanca del
            -- saneador excluye a proposito las etiquetas de estructura de
            -- pagina, y con `disallowedTagsMode: discard` se desenvolverian
            -- llevandose la clase por delante. Sin esa clase, el itemSelector
            -- del cierre no encontraria nunca el bloque que tiene que mover.
            '<div class="licitacion-entry" data-expediente="">' || E'\n' ||
            '  <hr class="licitacion-separator" />' || E'\n' ||
            -- Titular: expediente y objeto del contrato, en el mismo h3.
            '  <h3 class="licitacion-title"></h3>' || E'\n' ||
            -- Lista de pliegos. Va vacia: cada <li><a class="pliego-link"> lo
            -- genera la IA, porque el numero de pliegos cambia en cada
            -- convocatoria y un bucle no es expresable en una plantilla base.
            '  <ul class="licitacion-pliegos"></ul>' || E'\n' ||
            '  <p><strong>Presupuesto base de licitación:</strong></p>' || E'\n' ||
            '  <ul class="licitacion-presupuesto">' || E'\n' ||
            '    <li><strong>Base Imponible:</strong> <span class="base-imponible"></span></li>' || E'\n' ||
            '    <li><strong>Importe del I.V.A.:</strong> <span class="iva"></span></li>' || E'\n' ||
            '    <li><strong>Importe total:</strong> <span class="total"></span></li>' || E'\n' ||
            '  </ul>' || E'\n' ||
            -- Las tres ranuras que el marcado original traia como condicionales
            -- quedan SIEMPRE presentes y vacias. Decidir si se rellenan pasa a
            -- ser de la IA, que es quien ve el expediente; una plantilla base no
            -- puede ramificar.
            '  <p class="valor-estimado"></p>' || E'\n' ||
            '  <p>Plazo de recepción de ofertas: <strong class="plazo"></strong></p>' || E'\n' ||
            '  <p class="duracion-contrato"></p>' || E'\n' ||
            '  <p class="direccion-postal"></p>' || E'\n' ||
            -- El <a> va SIN `href`: el saneador descarta un `href=""` vacio, de
            -- modo que escribirlo solo daria una diferencia entre lo sembrado y
            -- lo que el nodo publica. La IA pone el destino al rellenar.
            '  <p><a class="link-consulta" target="_blank"><strong>Link de consulta</strong></a></p>' || E'\n' ||
            '</div>',
            '[]'::jsonb,
            autor
        ),
        (
            'Verificación de Títulos · Panel de evaluación',
            'Esqueleto del panel de evaluacion para la renovacion de acreditacion de titulos universitarios. Lo rellena el PROCESADOR_IA; el destino es el preset VERIFICACION_TITULOS (node--acreditacion_evaluacion_panel 55938).',
            '<div class="panel-evaluacion">' || E'\n' ||
            '  <h3 class="panel-titulo"></h3>' || E'\n' ||
            -- Tabla de identificacion del titulo. `table`, `caption`, `thead`,
            -- `tbody`, `tr`, `th` y `td` estan todas en la lista blanca del
            -- saneador, de modo que la estructura sobrevive intacta.
            --
            -- Las celdas de cabecera van SIN `scope`: los unicos atributos
            -- globales que el saneador conserva son `id`, `class`, `style` y
            -- `data-*`, de modo que un `scope="row"` se descarta en silencio.
            -- Escribirlo aqui seria sembrar markup que el propio sistema poda.
            '  <table class="panel-identificacion">' || E'\n' ||
            '    <caption>Datos del título evaluado</caption>' || E'\n' ||
            '    <tbody>' || E'\n' ||
            '      <tr><th>Universidad</th><td class="panel-universidad"></td></tr>' || E'\n' ||
            '      <tr><th>Centro</th><td class="panel-centro"></td></tr>' || E'\n' ||
            '      <tr><th>Código RUCT</th><td class="panel-ruct"></td></tr>' || E'\n' ||
            '    </tbody>' || E'\n' ||
            '  </table>' || E'\n' ||
            '  <table class="panel-composicion">' || E'\n' ||
            '    <caption>Composición del panel de evaluación</caption>' || E'\n' ||
            '    <thead>' || E'\n' ||
            '      <tr><th>Rol</th><th>Nombre</th><th>Afiliación</th></tr>' || E'\n' ||
            '    </thead>' || E'\n' ||
            '    <tbody>' || E'\n' ||
            '      <tr><th>Presidente/a</th><td class="panel-presidente"></td><td class="panel-presidente-afiliacion"></td></tr>' || E'\n' ||
            '      <tr><th>Secretario/a</th><td class="panel-secretario"></td><td class="panel-secretario-afiliacion"></td></tr>' || E'\n' ||
            '    </tbody>' || E'\n' ||
            -- Segundo <tbody>, vacio y a proposito: el numero de vocales varia
            -- por panel. La IA emite una <tr> por vocal dentro de este cuerpo,
            -- que es lo que en una plantilla con logica habria sido un bucle.
            '    <tbody class="panel-vocales"></tbody>' || E'\n' ||
            '  </table>' || E'\n' ||
            '  <p class="panel-observaciones"></p>' || E'\n' ||
            '</div>',
            '[]'::jsonb,
            autor
        )
    ON CONFLICT (nombre) DO NOTHING;
END $$;

-- Comprobacion: las dos filas, activas y sin variables pendientes. Una
-- `variables_esperadas` distinta de '[]' aqui significaria que alguien edito la
-- plantilla metiendo marcadores, y que el nodo va a rechazarla en ejecucion.
SELECT nombre,
       activo,
       jsonb_array_length(variables_esperadas) AS variables_pendientes,
       length(contenido_html)                  AS bytes_markup
  FROM plantillas_html
 WHERE nombre IN (
         'Licitaciones · Convocatoria abierta (Madrid+D)',
         'Verificación de Títulos · Panel de evaluación'
       )
 ORDER BY nombre;
