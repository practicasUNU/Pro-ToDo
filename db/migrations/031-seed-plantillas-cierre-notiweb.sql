-- =============================================================================
-- Migracion 031 · Semillas de `plantillas_html` para los dos flujos restantes
--
-- La migracion 028 sembro las plantillas de los dos flujos que entonces estaban
-- operativos (apertura de licitacion y panel de verificacion de titulos). Esta
-- completa el cuadro con los otros dos canales de Madrid+D: el CIERRE de una
-- licitacion y la noticia de Notiweb.
--
-- Se aplican LAS MISMAS RESTRICCIONES que la 028 documenta, y no son de estilo:
--
--   · SIN marcadores. El MAPEADOR_PLANTILLA ya no interpola: entrega el
--     esqueleto saneado para que lo rellene un PROCESADOR_IA posterior, y
--     rechaza con ERR_TEMPLATE_PENDING_VARS cualquier plantilla cuya columna
--     `variables_esperadas` no venga vacia. Cada hueco se nombra por CLASE y se
--     deja VACIO, que es la unica forma de expresar "a rellenar" sin logica.
--   · SIN `{{#if}}` ni `{{#each}}`: `assertDeterministicSyntax` los prohibe, de
--     modo que una condicional o un bucle no son expresables ni aunque el nodo
--     los admitiera. Donde habria hecho falta un bucle se deja un contenedor
--     vacio y la IA emite dentro una entrada por elemento.
--   · Envoltorio <div> y NO <article>: la lista blanca del saneador excluye a
--     proposito las etiquetas de estructura de pagina, y con
--     `disallowedTagsMode: discard` se desenvolverian llevandose la clase por
--     delante. Sin esa clase, ningun `itemSelector` encontraria el bloque.
--   · Los <a> van SIN `href` y las <img> SIN `src`: el saneador descarta un
--     atributo vacio, de modo que escribirlo solo daria una diferencia entre lo
--     sembrado y lo que el nodo publica. El destino lo pone la IA al rellenar.
--   · Nada de `scope` en los <th>: los unicos atributos globales que el
--     saneador conserva son `id`, `class`, `style` y `data-*`.
--
-- Esas mismas clases son las que el ESCUDO_POST_IA autodetecta despues desde el
-- marcado del mapeador para proponer sus `requiredSelectors`, asi que nombrarlas
-- bien tiene premio aguas abajo.
--
-- `.licitacion-entry` en la plantilla de CIERRE no es casual: es exactamente el
-- `itemSelector` que declara el preset CERRAR_LICITACION
-- (`drupal-http.types.ts`), porque el bloque que se traslada a la pagina de
-- cerradas es el que sembro la plantilla de apertura. La de cierre describe la
-- forma que ese bloque debe tener una vez archivado.
--
-- `id_usuario_creador` es NOT NULL con clave ajena a `usuarios`, asi que la
-- semilla resuelve el autor en tiempo de aplicacion (mismo patron que la 023 y
-- la 028). Sin ADMIN activo AVISA y no inserta, en vez de reventar.
--
-- Idempotente: `nombre` tiene indice unico y el INSERT cierra con
-- ON CONFLICT (nombre) DO NOTHING. Si el equipo ya ajusto una plantilla desde
-- el gestor, reaplicar la migracion NO se lo pisa: curar plantillas es trabajo
-- del CRUD, no de una migracion.
--
-- Aplicar con:
--   sudo docker exec -i protodo_postgres psql -U '<usuario_postgres>' -d '<nombre_bd_desarrollo>' \
--     < db/migrations/031-seed-plantillas-cierre-notiweb.sql
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
            'Licitaciones · Convocatoria cerrada (Madrid+D)',
            'Esqueleto del bloque de licitacion ya resuelta, para la pagina agregadora de convocatorias cerradas. Lo rellena el PROCESADOR_IA; el destino es el preset CERRAR_LICITACION (TRANSFER_HTML_BLOCK sobre node--page).',
            -- MISMA clase de envoltorio que la plantilla de apertura
            -- (`.licitacion-entry`) y mismo `data-expediente`: el traslado busca
            -- el bloque por esa clase, y el expediente es lo que permite afinar
            -- el selector a una convocatoria concreta
            -- (`[data-expediente="..."]`) en vez de mover el primero que haya.
            '<div class="licitacion-entry licitacion-cerrada" data-expediente="">' || E'\n' ||
            '  <hr class="licitacion-separator" />' || E'\n' ||
            -- Expediente y objeto del contrato, en el mismo h3 que en apertura.
            '  <h3 class="licitacion-title"></h3>' || E'\n' ||
            '  <p><strong>Expediente:</strong> <span class="expediente"></span></p>' || E'\n' ||
            '  <p>Fecha de cierre del plazo: <strong class="fecha-cierre"></strong></p>' || E'\n' ||
            -- Resolucion y adjudicatario quedan SIEMPRE presentes y vacios: una
            -- licitacion cerrada sin adjudicar es un caso real, y decidir si se
            -- rellenan es de la IA, que es quien ve el expediente.
            '  <p class="estado-resolucion"></p>' || E'\n' ||
            '  <p class="adjudicatario"></p>' || E'\n' ||
            '  <p><strong>Importe de adjudicación:</strong> <span class="importe-adjudicacion"></span></p>' || E'\n' ||
            -- Documentos de la resolucion. Va vacia: el numero de documentos
            -- cambia en cada expediente y un bucle no es expresable aqui.
            '  <ul class="licitacion-resolucion"></ul>' || E'\n' ||
            '  <p><a class="link-consulta" target="_blank"><strong>Link de consulta</strong></a></p>' || E'\n' ||
            '</div>',
            '[]'::jsonb,
            autor
        ),
        (
            'Notiweb · Noticia institucional',
            'Esqueleto de una noticia de Notiweb para la comunidad cientifica de Madrid+D. Lo rellena el PROCESADOR_IA; el destino es el preset NOTIWEB (CREATE_NODE sobre node--noticias).',
            '<div class="notiweb-entry">' || E'\n' ||
            '  <h3 class="notiweb-titular"></h3>' || E'\n' ||
            -- La entradilla va aparte del cuerpo y en <strong>: es el resumen
            -- que el portal muestra en los listados, y mezclarla con los
            -- parrafos la haria indistinguible del primero de ellos.
            '  <p class="notiweb-entradilla"><strong></strong></p>' || E'\n' ||
            -- <figure> y <figcaption> estan en la lista blanca del saneador. La
            -- <img> va SIN `src`: la pone la IA, o el nodo de destino cuando
            -- sube el adjunto del correo y le inyecta el enlace.
            '  <figure class="notiweb-imagen">' || E'\n' ||
            '    <img class="notiweb-imagen-src" alt="" />' || E'\n' ||
            '    <figcaption class="notiweb-imagen-pie"></figcaption>' || E'\n' ||
            '  </figure>' || E'\n' ||
            -- Contenedor vacio del cuerpo: el numero de parrafos lo decide la
            -- extension de la noticia, asi que la IA emite un <p> por parrafo
            -- aqui dentro. Es lo que en una plantilla con logica habria sido un
            -- bucle.
            '  <div class="notiweb-cuerpo"></div>' || E'\n' ||
            '  <p class="notiweb-fuente"></p>' || E'\n' ||
            '  <p><a class="notiweb-enlace" target="_blank"><strong>Más información</strong></a></p>' || E'\n' ||
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
         'Licitaciones · Convocatoria cerrada (Madrid+D)',
         'Notiweb · Noticia institucional'
       )
 ORDER BY nombre;
