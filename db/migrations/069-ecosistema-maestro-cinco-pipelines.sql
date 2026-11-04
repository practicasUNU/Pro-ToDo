-- =============================================================================
-- Migracion 069 · Ecosistema maestro de los cinco pipelines operativos
--
-- Garantiza, en cualquier base (desarrollo o pruebas), todo lo que los cinco
-- blueprints maestros necesitan para validarse e instanciarse:
--
--   1. ADMIN ancla (`practicas@unuware.com`, la cuenta de respaldo de la 060):
--      autor de todo lo sembrado.
--   2. Catalogo `nodos`: los 13 tipos del enum `NodeType`. Estar en la tabla
--      ES estar implementado (ver `init.sql`): no hay columna aparte.
--   3. Tarifas de referencia que faltaban. Una tarifa ACTIVA previa no se
--      reescribe: cambiar un precio es insertar una fila nueva, no esto.
--   4. Plantillas HTML de Notiweb, apertura, cierre y titulos.
--   5. Prompts corporativos, con el texto final de la 032-068 (encabezados
--      <h2>/<h3>, fecha APA y marcas {{*...}}). LICITACION_CIERRE_DEFAULT se
--      reescribe si aun pide la plantilla base: el cierre no lleva mapeador y
--      el validador rechazaria la dependencia de `rendered_html`.
--   5a. LICITACION_APERTURA_DEFAULT se reescribe entero si no tiene las
--      "REGLAS DE EXTRACCIÓN Y TITULACIÓN OBLIGATORIAS": prohibe usar el
--      asunto del correo como titulo, exige el titulo formal en
--      h3.licitacion-title, el expediente en data-expediente y los importes
--      en sus spans, sin estimar nunca un dato ausente.
--   5b. Parches de contenido sobre los prompts, ya existieran o no:
--      - Directiva de polivalencia Markdown: literal en los tres prompts con
--        PLANTILLA BASE (Notiweb, apertura, titulos) y en variante de texto
--        plano en los que no la tienen (cierre, Innodays, Innobar), donde
--        hablar de "filled_markup" empujaria al modelo a inventarse HTML.
--      - Notiweb: la seccion bibliografica va bajo <h2>, nunca <p><strong>.
--      - {{ocr_result.clean_body}} opcional junto al texto de los adjuntos o,
--        si el prompt no los cita (Innodays, Innobar), tras el correo.
--      - Contrato de marcas: solo {{*parsed_email.clean_body}} y, con
--        mapeador, {{*rendered_html.compiled_markup}} son obligatorias.
--   5c. Cardinalidad 1 a N: la "REGLA DE CARDINALIDAD FLEXIBLE" (raiz = primer
--      elemento, "items" = el resto) en los seis prompts, con lo que es un
--      elemento en cada flujo (noticia, expediente, enlace, panel).
--   5d. Prompts consolidados: Notiweb detecta el lote y sus fuentes mixtas
--      (articulo para la principal; titulo, fuente y entradilla del listado
--      para las secundarias, "Blog del dia" incluido), exige un minimo de 4
--      parrafos por noticia y el cierre <hr /><h2>Referencia bibliográfica</h2>
--      en APA 7; titulos fija h5.panel-title (la plantilla), da respaldos a sus
--      dos ranuras, prohibe inventar sin datos y elimina las frases que lo
--      contradecian. Sustituye el bloque de la version anterior de este paso.
--   6. Los cinco blueprints de `plantillas_flujo`, con el slug en `flowId` y
--      en la descripcion (`id_flujo` es UUID y no puede llevarlo).
--   6b. El escudo del maestro de apertura exige `h3.licitacion-title`: sin
--      `requiredSelectors` la compuerta ERR_POST_IA_DOM_MUTATED no corre.
--   6c. Los cinco PROCESADOR_IA con `outputCardinality: MULTIPLE`, y Notiweb
--      con el nodo `campana_acens` (DESTINO_ACENS, CREATE_CAMPAIGN) tras
--      Drupal: el boletin con el marcado ya validado de todas las noticias.
--   6d. Contingencias en los cinco maestros: `alerta_smtp` (DESTINO_SMTP) en
--      el onErrorStep de procesamiento y destinos, y el satelite `ocr_ia`
--      (PROCESADOR_OCR) al que el parser desvia solo los escaneos.
--   6e. El escudo de titulos exige .panel-title y sus dos ranuras.
--   6f. Escudos de `flujos` y `plantillas_flujo` con el atajo antiguo
--      "Estructura completa" (sin h2) pasan a la lista canonica.
--   2b. El catalogo describe el modo campana de DESTINO_ACENS.
--   7. Una fila de `audit_eventos` por cada entidad creada o parcheada, con
--      `datos_nuevos.origen = 'SEED_MASTER_DATA'`, y un resumen final.
--
-- POR QUE EXISTE: las semillas 023, 028, 031 y 032 tomaban como autor "el
-- primer ADMIN"; en una base creada antes de tenerlo no hicieron nada (solo un
-- WARNING), y las de parche posteriores tampoco encontraron filas. Esta
-- migracion cierra ese hueco insertando los textos completos.
--
-- IDEMPOTENTE: cada insercion lleva ON CONFLICT DO NOTHING o NOT EXISTS, cada
-- parche se protege con un marcador `position(...)`, y la auditoria solo
-- registra lo que realmente cambio. Reejecutarla no cambia nada.
--
-- Los UUID de paginas Drupal y las credenciales IMAP de los blueprints quedan
-- vacios a proposito: dependen del entorno y los rellena el asistente con el
-- preset al instanciar el flujo.
--
-- FUENTE UNICA: este fichero se mantiene directamente (el generador con el
-- que nacio no se versiona). Los parches de contenido de los prompts y de los
-- maestros se consolidan aqui (pasos 2b, 5a-5d y 6b-6f) y no en migraciones
-- sueltas: el runner registra la migracion por nombre, asi que una base que ya
-- la tenia la vuelve a pasar a mano (`psql -f`) y los marcadores evitan
-- duplicados.
--
-- Aplicar con:
--   npm run db:migrate          (desde backend/)
-- =============================================================================

SET client_encoding = 'UTF8';

BEGIN;

DO $migration$
DECLARE
    admin_id UUID;
    previous_role TEXT;
    previous_active BOOLEAN;
    inserted_id UUID;
    previous_text TEXT;
    template_notiweb UUID;
    template_abierta UUID;
    template_titulos UUID;
    rec RECORD;
    patched TEXT;
    insertion TEXT;
    created_prompts TEXT[] := '{}';
    pipeline JSONB;
    node_key TEXT;
    parser_key TEXT;
    old_full_structure CONSTANT TEXT[] := ARRAY['a', 'div', 'em', 'h3', 'h4', 'h5', 'hr', 'img', 'li', 'p', 'span', 'strong', 'table', 'td', 'th', 'tr', 'ul'];
    canonical_tags CONSTANT JSONB := '["h2", "h3", "h4", "h5", "h6", "p", "a", "b", "i", "strong", "em", "u", "strike", "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td", "hr", "br", "div", "span", "img"]'::JSONB;
    clause_poly_html CONSTANT TEXT := $clause$DIRECTIVA DE POLIVALENCIA Y ESTRUCTURACIÓN HTML:
- La información de entrada puede contener tablas, listas o textos en formato Markdown (| tabla |, # títulos, - listas, **negritas**).
- Queda TERMINANTEMENTE PROHIBIDO copiar y pegar sintaxis Markdown en "filled_markup".
- Tu tarea es transpolar y redactar la información adaptándola al 100% a la estructura HTML de la PLANTILLA BASE.
- Las tablas en Markdown deben convertirse en elementos <table>, <tr>, <td> con las clases de la plantilla; los encabezados en <h2> o <h3>; y las listas en <ul> y <li>.$clause$;
    clause_poly_text CONSTANT TEXT := $clause$DIRECTIVA DE POLIVALENCIA Y ESTRUCTURACIÓN DE TEXTO:
- La información de entrada puede contener tablas, listas o textos en formato Markdown (| tabla |, # títulos, - listas, **negritas**).
- Queda TERMINANTEMENTE PROHIBIDO copiar sintaxis Markdown en "headline", "summary" o "body_paragraphs": ni barras de tabla, ni almohadillas, ni guiones de lista, ni asteriscos.
- Este flujo no tiene PLANTILLA BASE: localiza el dato dentro de la tabla o la lista en la que aparezca y devuélvelo como texto plano, sin etiquetas HTML.$clause$;
    clause_biblio CONSTANT TEXT := $clause$ESTRUCTURA DE LA SECCIÓN BIBLIOGRÁFICA:
- La sección bibliográfica va encabezada por el título semántico <h2>Referencia bibliográfica</h2>, seguido de uno o varios párrafos <p class="notiweb-referencia">.
- Queda TERMINANTEMENTE PROHIBIDO escribir ese rótulo como párrafo, por ejemplo <p><strong>Referencia bibliográfica:</strong></p>.$clause$;
    -- Inicio de la primera seccion de material: linea en blanco, hasta dos
    -- rotulos sin llaves ("DATOS DE ENTRADA:", "Correo:") y el primer marcador.
    material_anchor CONSTANT TEXT := '\n\n((?:[^\n{]*\n){0,2})\{\{';
    summary JSONB := jsonb_build_object(
        'nodos', 0, 'tarifas', 0, 'plantillas_html', 0,
        'prompts', 0, 'blueprints', 0, 'prompts_parcheados', 0, 'blueprints_parcheados', 0,
        'nodos_parcheados', 0, 'flujos_reparados', 0);
    seed_tag CONSTANT JSONB := jsonb_build_object('origen', 'SEED_MASTER_DATA', 'recurso', 'SYSTEM_INITIALIZATION', 'migracion', '069');
BEGIN
    -- 1. ADMIN ancla ---------------------------------------------------------
    SELECT rol::TEXT, activo INTO previous_role, previous_active
      FROM usuarios WHERE correo = 'practicas@unuware.com';

    INSERT INTO usuarios (correo, rol, activo)
    VALUES ('practicas@unuware.com', 'ADMIN', TRUE)
    ON CONFLICT (correo) DO UPDATE
       SET rol = 'ADMIN', activo = TRUE, fecha_actualizacion = NOW()
    RETURNING id_usuario INTO admin_id;

    IF previous_role IS NULL THEN
        INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_nuevos)
        VALUES (admin_id, 'CREAR', 'usuarios', admin_id::TEXT,
                seed_tag || jsonb_build_object('correo', 'practicas@unuware.com', 'rol', 'ADMIN'));
    ELSIF previous_role <> 'ADMIN' OR previous_active IS DISTINCT FROM TRUE THEN
        INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_anteriores, datos_nuevos)
        VALUES (admin_id, 'CAMBIO_ROL', 'usuarios', admin_id::TEXT,
                jsonb_build_object('rol', previous_role, 'activo', previous_active),
                seed_tag || jsonb_build_object('rol', 'ADMIN', 'activo', TRUE));
    END IF;

    -- 2. Catalogo de nodos ---------------------------------------------------
    inserted_id := NULL;
    INSERT INTO nodos (codigo, nombre, categoria, descripcion)
    VALUES ('TRIGGER_IMAP', 'Disparador IMAP', 'TRIGGER', 'Inicia el flujo mediante la lectura de correos entrantes')
    ON CONFLICT (codigo) DO NOTHING
    RETURNING id_nodo INTO inserted_id;
    IF inserted_id IS NOT NULL THEN
        summary := jsonb_set(summary, '{nodos}', to_jsonb((summary->>'nodos')::INT + 1));
        INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_nuevos)
        VALUES (admin_id, 'CREAR', 'nodos', inserted_id::TEXT, seed_tag || jsonb_build_object('codigo', 'TRIGGER_IMAP'));
    END IF;
    inserted_id := NULL;
    INSERT INTO nodos (codigo, nombre, categoria, descripcion)
    VALUES ('PARSER_PRE_IA', 'Parser de Correo', 'PROCESAMIENTO', 'Procesa y limpia correos entrantes, extrayendo asunto, texto plano sin firmas y URLs de referencia.')
    ON CONFLICT (codigo) DO NOTHING
    RETURNING id_nodo INTO inserted_id;
    IF inserted_id IS NOT NULL THEN
        summary := jsonb_set(summary, '{nodos}', to_jsonb((summary->>'nodos')::INT + 1));
        INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_nuevos)
        VALUES (admin_id, 'CREAR', 'nodos', inserted_id::TEXT, seed_tag || jsonb_build_object('codigo', 'PARSER_PRE_IA'));
    END IF;
    inserted_id := NULL;
    INSERT INTO nodos (codigo, nombre, categoria, descripcion)
    VALUES ('EXTRACTOR_WEB', 'Extractor Web', 'PROCESAMIENTO', 'Extrae y sanitiza contenido desde una pagina web')
    ON CONFLICT (codigo) DO NOTHING
    RETURNING id_nodo INTO inserted_id;
    IF inserted_id IS NOT NULL THEN
        summary := jsonb_set(summary, '{nodos}', to_jsonb((summary->>'nodos')::INT + 1));
        INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_nuevos)
        VALUES (admin_id, 'CREAR', 'nodos', inserted_id::TEXT, seed_tag || jsonb_build_object('codigo', 'EXTRACTOR_WEB'));
    END IF;
    inserted_id := NULL;
    INSERT INTO nodos (codigo, nombre, categoria, descripcion)
    VALUES ('PROCESADOR_IA', 'Procesador de IA', 'PROCESAMIENTO', 'Ejecuta inferencia mediante un modelo de lenguaje')
    ON CONFLICT (codigo) DO NOTHING
    RETURNING id_nodo INTO inserted_id;
    IF inserted_id IS NOT NULL THEN
        summary := jsonb_set(summary, '{nodos}', to_jsonb((summary->>'nodos')::INT + 1));
        INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_nuevos)
        VALUES (admin_id, 'CREAR', 'nodos', inserted_id::TEXT, seed_tag || jsonb_build_object('codigo', 'PROCESADOR_IA'));
    END IF;
    inserted_id := NULL;
    INSERT INTO nodos (codigo, nombre, categoria, descripcion)
    VALUES ('ESCUDO_POST_IA', 'Escudo Post-IA', 'CONTROL', 'Valida la salida del modelo contra el esquema esperado antes de propagarla')
    ON CONFLICT (codigo) DO NOTHING
    RETURNING id_nodo INTO inserted_id;
    IF inserted_id IS NOT NULL THEN
        summary := jsonb_set(summary, '{nodos}', to_jsonb((summary->>'nodos')::INT + 1));
        INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_nuevos)
        VALUES (admin_id, 'CREAR', 'nodos', inserted_id::TEXT, seed_tag || jsonb_build_object('codigo', 'ESCUDO_POST_IA'));
    END IF;
    inserted_id := NULL;
    INSERT INTO nodos (codigo, nombre, categoria, descripcion)
    VALUES ('MAPEADOR_PLANTILLA', 'Mapeador de Plantilla', 'PROCESAMIENTO', 'Inyecta una plantilla HTML del gestor, ya saneada y sin interpolar, para que un PROCESADOR_IA posterior la rellene. Verifica que conserva los selectores estructurales exigidos.')
    ON CONFLICT (codigo) DO NOTHING
    RETURNING id_nodo INTO inserted_id;
    IF inserted_id IS NOT NULL THEN
        summary := jsonb_set(summary, '{nodos}', to_jsonb((summary->>'nodos')::INT + 1));
        INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_nuevos)
        VALUES (admin_id, 'CREAR', 'nodos', inserted_id::TEXT, seed_tag || jsonb_build_object('codigo', 'MAPEADOR_PLANTILLA'));
    END IF;
    inserted_id := NULL;
    INSERT INTO nodos (codigo, nombre, categoria, descripcion)
    VALUES ('DESTINO_DRUPAL', 'Destino Drupal', 'DESTINO', 'Publica el resultado final en el CMS Drupal mediante JSON:API')
    ON CONFLICT (codigo) DO NOTHING
    RETURNING id_nodo INTO inserted_id;
    IF inserted_id IS NOT NULL THEN
        summary := jsonb_set(summary, '{nodos}', to_jsonb((summary->>'nodos')::INT + 1));
        INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_nuevos)
        VALUES (admin_id, 'CREAR', 'nodos', inserted_id::TEXT, seed_tag || jsonb_build_object('codigo', 'DESTINO_DRUPAL'));
    END IF;
    inserted_id := NULL;
    INSERT INTO nodos (codigo, nombre, categoria, descripcion)
    VALUES ('TRIGGER_CRON', 'Disparador Cron', 'TRIGGER', 'Inicia el flujo mediante una programacion temporal')
    ON CONFLICT (codigo) DO NOTHING
    RETURNING id_nodo INTO inserted_id;
    IF inserted_id IS NOT NULL THEN
        summary := jsonb_set(summary, '{nodos}', to_jsonb((summary->>'nodos')::INT + 1));
        INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_nuevos)
        VALUES (admin_id, 'CREAR', 'nodos', inserted_id::TEXT, seed_tag || jsonb_build_object('codigo', 'TRIGGER_CRON'));
    END IF;
    inserted_id := NULL;
    INSERT INTO nodos (codigo, nombre, categoria, descripcion)
    VALUES ('DESTINO_ACENS', 'Destino Acens', 'DESTINO', 'Entrega el resultado a la API de Acens: crea la campana del boletin con el marcado ya validado del lote (CREATE_CAMPAIGN) o envia una peticion libre interpolada y desinfectada. URL base y clave salen del entorno del servidor, nunca del flujo.')
    ON CONFLICT (codigo) DO NOTHING
    RETURNING id_nodo INTO inserted_id;
    IF inserted_id IS NOT NULL THEN
        summary := jsonb_set(summary, '{nodos}', to_jsonb((summary->>'nodos')::INT + 1));
        INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_nuevos)
        VALUES (admin_id, 'CREAR', 'nodos', inserted_id::TEXT, seed_tag || jsonb_build_object('codigo', 'DESTINO_ACENS'));
    END IF;
    inserted_id := NULL;
    INSERT INTO nodos (codigo, nombre, categoria, descripcion)
    VALUES ('DESTINO_SMTP', 'Alerta por Correo', 'DESTINO', 'Envia un correo de aviso interpolando datos del flujo. Pensado como destino de las rutas de recuperacion ante error.')
    ON CONFLICT (codigo) DO NOTHING
    RETURNING id_nodo INTO inserted_id;
    IF inserted_id IS NOT NULL THEN
        summary := jsonb_set(summary, '{nodos}', to_jsonb((summary->>'nodos')::INT + 1));
        INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_nuevos)
        VALUES (admin_id, 'CREAR', 'nodos', inserted_id::TEXT, seed_tag || jsonb_build_object('codigo', 'DESTINO_SMTP'));
    END IF;
    inserted_id := NULL;
    INSERT INTO nodos (codigo, nombre, categoria, descripcion)
    VALUES ('PROCESADOR_OCR', 'Procesador OCR', 'PROCESAMIENTO', 'Transcribe los adjuntos de un correo sin texto aprovechable (imagen o PDF escaneado). Pensado como destino de la ruta de contingencia del parser.')
    ON CONFLICT (codigo) DO NOTHING
    RETURNING id_nodo INTO inserted_id;
    IF inserted_id IS NOT NULL THEN
        summary := jsonb_set(summary, '{nodos}', to_jsonb((summary->>'nodos')::INT + 1));
        INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_nuevos)
        VALUES (admin_id, 'CREAR', 'nodos', inserted_id::TEXT, seed_tag || jsonb_build_object('codigo', 'PROCESADOR_OCR'));
    END IF;
    inserted_id := NULL;
    INSERT INTO nodos (codigo, nombre, categoria, descripcion)
    VALUES ('PAUSA_FLOW', 'Pausa de Flujo', 'CONTROL', 'Detiene el flujo de forma deliberada y lo deja reanudable por un operador (CU-09). Admite pausa inmediata o tras un retardo, y puede avisar por correo.')
    ON CONFLICT (codigo) DO NOTHING
    RETURNING id_nodo INTO inserted_id;
    IF inserted_id IS NOT NULL THEN
        summary := jsonb_set(summary, '{nodos}', to_jsonb((summary->>'nodos')::INT + 1));
        INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_nuevos)
        VALUES (admin_id, 'CREAR', 'nodos', inserted_id::TEXT, seed_tag || jsonb_build_object('codigo', 'PAUSA_FLOW'));
    END IF;
    inserted_id := NULL;
    INSERT INTO nodos (codigo, nombre, categoria, descripcion)
    VALUES ('DESTINO_HTTP_GENERICO', 'Destino HTTP Generico', 'DESTINO', 'Envia el resultado del flujo a una API REST publica (GET, POST, PUT, PATCH o DELETE) con cabeceras, parametros y cuerpo interpolados. Se autentica con una credencial cifrada de la boveda y rechaza destinos de redes privadas.')
    ON CONFLICT (codigo) DO NOTHING
    RETURNING id_nodo INTO inserted_id;
    IF inserted_id IS NOT NULL THEN
        summary := jsonb_set(summary, '{nodos}', to_jsonb((summary->>'nodos')::INT + 1));
        INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_nuevos)
        VALUES (admin_id, 'CREAR', 'nodos', inserted_id::TEXT, seed_tag || jsonb_build_object('codigo', 'DESTINO_HTTP_GENERICO'));
    END IF;

    -- 2b. Catalogo: DESTINO_ACENS describe tambien el modo campana ----------
    UPDATE nodos
       SET descripcion = 'Entrega el resultado a la API de Acens: crea la campana del boletin con el marcado ya validado del lote (CREATE_CAMPAIGN) o envia una peticion libre interpolada y desinfectada. URL base y clave salen del entorno del servidor, nunca del flujo.'
     WHERE codigo = 'DESTINO_ACENS'
       AND descripcion IS DISTINCT FROM 'Entrega el resultado a la API de Acens: crea la campana del boletin con el marcado ya validado del lote (CREATE_CAMPAIGN) o envia una peticion libre interpolada y desinfectada. URL base y clave salen del entorno del servidor, nunca del flujo.'
    RETURNING id_nodo INTO inserted_id;
    IF FOUND THEN
        summary := jsonb_set(summary, '{nodos_parcheados}', to_jsonb((summary->>'nodos_parcheados')::INT + 1));
        INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_nuevos)
        VALUES (admin_id, 'ACTUALIZAR', 'nodos', inserted_id::TEXT,
                seed_tag || jsonb_build_object('codigo', 'DESTINO_ACENS', 'parche', 'modo_campana'));
    END IF;

    -- 3. Tarifas de referencia (USD por millon de tokens) ---------------------
    -- NOT EXISTS y no ON CONFLICT: el indice parcial admite UNA tarifa vigente
    -- por par, y una tarifa activa previa no se reescribe.
    IF NOT EXISTS (SELECT 1 FROM precios_modelos_ia WHERE proveedor_ia = 'ANTHROPIC' AND modelo_ia = 'claude-sonnet-5-5' AND activo) THEN
        INSERT INTO precios_modelos_ia (proveedor_ia, modelo_ia, tarifa_prompt_usd_mtok,
                                        tarifa_completacion_usd_mtok, tarifa_razonamiento_usd_mtok,
                                        creado_por, actualizado_por)
        VALUES ('ANTHROPIC', 'claude-sonnet-5-5', 2.00, 10.00, 10.00, admin_id, admin_id)
        RETURNING id_precio_modelo_ia INTO inserted_id;
        summary := jsonb_set(summary, '{tarifas}', to_jsonb((summary->>'tarifas')::INT + 1));
        INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_nuevos)
        VALUES (admin_id, 'CREAR', 'precios_modelos_ia', inserted_id::TEXT, seed_tag || jsonb_build_object('proveedor', 'ANTHROPIC', 'modelo', 'claude-sonnet-5-5'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM precios_modelos_ia WHERE proveedor_ia = 'ANTHROPIC' AND modelo_ia = 'claude-haiku-5-5' AND activo) THEN
        INSERT INTO precios_modelos_ia (proveedor_ia, modelo_ia, tarifa_prompt_usd_mtok,
                                        tarifa_completacion_usd_mtok, tarifa_razonamiento_usd_mtok,
                                        creado_por, actualizado_por)
        VALUES ('ANTHROPIC', 'claude-haiku-5-5', 0.50, 2.50, 2.50, admin_id, admin_id)
        RETURNING id_precio_modelo_ia INTO inserted_id;
        summary := jsonb_set(summary, '{tarifas}', to_jsonb((summary->>'tarifas')::INT + 1));
        INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_nuevos)
        VALUES (admin_id, 'CREAR', 'precios_modelos_ia', inserted_id::TEXT, seed_tag || jsonb_build_object('proveedor', 'ANTHROPIC', 'modelo', 'claude-haiku-5-5'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM precios_modelos_ia WHERE proveedor_ia = 'GEMINI' AND modelo_ia = 'gemini-1.5-flash' AND activo) THEN
        INSERT INTO precios_modelos_ia (proveedor_ia, modelo_ia, tarifa_prompt_usd_mtok,
                                        tarifa_completacion_usd_mtok, tarifa_razonamiento_usd_mtok,
                                        creado_por, actualizado_por)
        VALUES ('GEMINI', 'gemini-1.5-flash', 0.075, 0.30, 0.30, admin_id, admin_id)
        RETURNING id_precio_modelo_ia INTO inserted_id;
        summary := jsonb_set(summary, '{tarifas}', to_jsonb((summary->>'tarifas')::INT + 1));
        INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_nuevos)
        VALUES (admin_id, 'CREAR', 'precios_modelos_ia', inserted_id::TEXT, seed_tag || jsonb_build_object('proveedor', 'GEMINI', 'modelo', 'gemini-1.5-flash'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM precios_modelos_ia WHERE proveedor_ia = 'GEMINI' AND modelo_ia = 'gemini-2.0-flash' AND activo) THEN
        INSERT INTO precios_modelos_ia (proveedor_ia, modelo_ia, tarifa_prompt_usd_mtok,
                                        tarifa_completacion_usd_mtok, tarifa_razonamiento_usd_mtok,
                                        creado_por, actualizado_por)
        VALUES ('GEMINI', 'gemini-2.0-flash', 0.075, 0.30, 0.30, admin_id, admin_id)
        RETURNING id_precio_modelo_ia INTO inserted_id;
        summary := jsonb_set(summary, '{tarifas}', to_jsonb((summary->>'tarifas')::INT + 1));
        INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_nuevos)
        VALUES (admin_id, 'CREAR', 'precios_modelos_ia', inserted_id::TEXT, seed_tag || jsonb_build_object('proveedor', 'GEMINI', 'modelo', 'gemini-2.0-flash'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM precios_modelos_ia WHERE proveedor_ia = 'OPENAI' AND modelo_ia = 'gpt-4o-mini' AND activo) THEN
        INSERT INTO precios_modelos_ia (proveedor_ia, modelo_ia, tarifa_prompt_usd_mtok,
                                        tarifa_completacion_usd_mtok, tarifa_razonamiento_usd_mtok,
                                        creado_por, actualizado_por)
        VALUES ('OPENAI', 'gpt-4o-mini', 0.15, 0.60, 0.60, admin_id, admin_id)
        RETURNING id_precio_modelo_ia INTO inserted_id;
        summary := jsonb_set(summary, '{tarifas}', to_jsonb((summary->>'tarifas')::INT + 1));
        INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_nuevos)
        VALUES (admin_id, 'CREAR', 'precios_modelos_ia', inserted_id::TEXT, seed_tag || jsonb_build_object('proveedor', 'OPENAI', 'modelo', 'gpt-4o-mini'));
    END IF;

    -- 4. Plantillas HTML -----------------------------------------------------
    inserted_id := NULL;
    INSERT INTO plantillas_html (nombre, descripcion, contenido_html, variables_esperadas,
                                 id_usuario_creador, creado_por, actualizado_por)
    VALUES ('Notiweb · Noticia institucional', 'Cuerpo de una noticia de Notiweb: parrafos de desarrollo y referencia bibliografica. Titular y entradilla viajan aparte (title y body.summary).',
            $html$<div class="notiweb-cuerpo">
  <hr />
  <h2>Referencia bibliográfica</h2>
  <p class="notiweb-referencia"></p>
</div>$html$,
            '[]'::JSONB, admin_id, admin_id, admin_id)
    ON CONFLICT (nombre) DO NOTHING
    RETURNING id_plantilla INTO inserted_id;
    IF inserted_id IS NOT NULL THEN
        summary := jsonb_set(summary, '{plantillas_html}', to_jsonb((summary->>'plantillas_html')::INT + 1));
        INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_nuevos)
        VALUES (admin_id, 'CREAR', 'plantillas_html', inserted_id::TEXT, seed_tag || jsonb_build_object('nombre', 'Notiweb · Noticia institucional'));
    END IF;
    inserted_id := NULL;
    INSERT INTO plantillas_html (nombre, descripcion, contenido_html, variables_esperadas,
                                 id_usuario_creador, creado_por, actualizado_por)
    VALUES ('Licitaciones · Convocatoria abierta (Madrid+D) V1', 'Esqueleto de un bloque de licitacion para la pagina agregadora de convocatorias abiertas. Lo rellena el PROCESADOR_IA; el destino es el preset ABRIR_LICITACION (APPEND_HTML_BLOCK sobre node--page 55937).',
            $html$<div class="licitacion-entry pd-licitacion-block" data-expediente="">
  <hr class="licitacion-separator" />
  <h3 class="licitacion-title"></h3>
  <ul class="licitacion-pliegos"></ul>
  <p><strong>Presupuesto base de licitación:</strong></p>
  <ul class="licitacion-presupuesto">
    <li><strong>Base Imponible:
      </strong> <span class="base-imponible"></span></li>
    <li><strong>Importe del I.V.A.:</strong> <span class="iva"></span></li>
    <li><strong>Importe total:</strong> <span class="total"></span></li>
  </ul>
  <p class="valor-estimado"></p>
  <p>Plazo de recepción de ofertas: <strong class="plazo"></strong></p>
  <p class="duracion-contrato"></p>
  <p class="direccion-postal"></p>
  <p><a class="link-consulta" href="" target="_blank" rel="noopener"><strong>Link de consulta</strong></a></p>
</div>$html$,
            '[]'::JSONB, admin_id, admin_id, admin_id)
    ON CONFLICT (nombre) DO NOTHING
    RETURNING id_plantilla INTO inserted_id;
    IF inserted_id IS NOT NULL THEN
        summary := jsonb_set(summary, '{plantillas_html}', to_jsonb((summary->>'plantillas_html')::INT + 1));
        INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_nuevos)
        VALUES (admin_id, 'CREAR', 'plantillas_html', inserted_id::TEXT, seed_tag || jsonb_build_object('nombre', 'Licitaciones · Convocatoria abierta (Madrid+D) V1'));
    END IF;
    inserted_id := NULL;
    INSERT INTO plantillas_html (nombre, descripcion, contenido_html, variables_esperadas,
                                 id_usuario_creador, creado_por, actualizado_por)
    VALUES ('Licitaciones · Convocatoria cerrada (Madrid+D)', 'Esqueleto del bloque de licitacion ya resuelta, para la pagina agregadora de convocatorias cerradas. Lo rellena el PROCESADOR_IA; el destino es el preset CERRAR_LICITACION (TRANSFER_HTML_BLOCK sobre node--page).',
            $html$<div class="licitacion-entry licitacion-cerrada" data-expediente="">
  <hr class="licitacion-separator" />
  <h3 class="licitacion-title"></h3>
  <p><strong>Expediente:</strong> <span class="expediente"></span></p>
  <p>Fecha de cierre del plazo: <strong class="fecha-cierre"></strong></p>
  <p class="estado-resolucion"></p>
  <p class="adjudicatario"></p>
  <p><strong>Importe de adjudicación:</strong> <span class="importe-adjudicacion"></span></p>
  <ul class="licitacion-resolucion"></ul>
  <p><a class="link-consulta" target="_blank"><strong>Link de consulta</strong></a></p>
</div>$html$,
            '[]'::JSONB, admin_id, admin_id, admin_id)
    ON CONFLICT (nombre) DO NOTHING
    RETURNING id_plantilla INTO inserted_id;
    IF inserted_id IS NOT NULL THEN
        summary := jsonb_set(summary, '{plantillas_html}', to_jsonb((summary->>'plantillas_html')::INT + 1));
        INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_nuevos)
        VALUES (admin_id, 'CREAR', 'plantillas_html', inserted_id::TEXT, seed_tag || jsonb_build_object('nombre', 'Licitaciones · Convocatoria cerrada (Madrid+D)'));
    END IF;
    inserted_id := NULL;
    INSERT INTO plantillas_html (nombre, descripcion, contenido_html, variables_esperadas,
                                 id_usuario_creador, creado_por, actualizado_por)
    VALUES ('Verificación de Títulos · Panel de evaluación', 'Esqueleto del panel colapsable de Bootstrap para la pagina agregadora de verificacion de titulos. Lo rellena el PROCESADOR_IA; el destino es el preset VERIFICACION_TITULOS (APPEND_HTML_BLOCK sobre node--page, dentro de #accordionCEU).',
            $html$<div class="panel panel-default" data-protodo-injected="true" aria-expanded="false">
  <div class="panel-heading">
    <h5 class="panel-title">
      <a class="panel-toggle-link" aria-expanded="false" data-parent="#accordion" data-bs-toggle="collapse" href="#collapsePanelId">
        <strong class="panel-comite-codigo"></strong>&nbsp;<span class="panel-facultad-nombre"></span>
      </a>
    </h5>
  </div>
  <div class="collapse" id="collapsePanelId">
    <div class="panel-body">
      <div class="pane">
        <table class="tableform">
          <tbody class="panel-titulos-body"></tbody>
          <tbody>
            <tr>
              <th>&nbsp;</th>
              <th style="background-color:#A9BCF5;">Evaluador</th>
              <th style="background-color:#A9BCF5;">Institución</th>
            </tr>
            <tr><th>Presidente:</th><th class="eval-presidente"></th><th class="inst-presidente"></th></tr>
            <tr><th>Secretario:</th><th class="eval-secretario"></th><th class="inst-secretario"></th></tr>
            <tr><th>Vocal:</th><th class="eval-vocal"></th><th class="inst-vocal"></th></tr>
            <tr><th>Estudiante:</th><th class="eval-estudiante"></th><th class="inst-estudiante"></th></tr>
            <tr>
              <th style="background-color:#C6E0B4;border:1px solid black;" colspan="3">
                Fecha Visita:&nbsp;&nbsp;<span class="panel-fecha-visita"></span>
              </th>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</div>$html$,
            '[]'::JSONB, admin_id, admin_id, admin_id)
    ON CONFLICT (nombre) DO NOTHING
    RETURNING id_plantilla INTO inserted_id;
    IF inserted_id IS NOT NULL THEN
        summary := jsonb_set(summary, '{plantillas_html}', to_jsonb((summary->>'plantillas_html')::INT + 1));
        INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_nuevos)
        VALUES (admin_id, 'CREAR', 'plantillas_html', inserted_id::TEXT, seed_tag || jsonb_build_object('nombre', 'Verificación de Títulos · Panel de evaluación'));
    END IF;

    -- 5. Prompts corporativos ------------------------------------------------
    inserted_id := NULL;
    INSERT INTO plantillas_prompts_ia (codigo, nombre, descripcion, texto_prompt,
                                       id_usuario_creador, creado_por, actualizado_por)
    VALUES ('NOTIWEB_DEFAULT', 'Notiweb · Redaccion institucional', 'Redacta la noticia de Notiweb a partir de la directiva del correo y el articulo original.',
            $prompt$Eres el redactor jefe de Madrid+D y maquetador del portal. Redacta una noticia institucional para Notiweb, dirigida a la comunidad cientifica e investigadora de la Comunidad de Madrid, a partir del material que se te da mas abajo, y vuelcala sobre la plantilla base.

Reglas de estilo, de obligado cumplimiento:
- Registro formal e impersonal. Tercera persona, nunca primera ni segunda.
- El titular es institucional y sobrio. NUNCA termina en punto, y no usa interrogaciones, exclamaciones ni reclamos.
- La entradilla resume la noticia en menos de 600 caracteres y responde a que, quien y cuando. Tampoco termina en punto.
- El desarrollo se entrega en parrafos, sin vinetas, organizado en secciones con encabezados semanticos (ver "Maquetacion del cuerpo").
- Los nombres de centros, institutos y programas se citan completos la primera vez, con su sigla entre parentesis si la tienen.
- No inventes datos, cifras ni declaraciones que no esten en el material. Una cita entrecomillada solo puede reproducir literalmente lo que ya figura en el.

Maquetacion del cuerpo:
- La plantilla base NO lleva titular ni entradilla: el portal los muestra aparte a partir de "headline" y "summary". No los repitas dentro del marcado.
- Escribe cada parrafo de desarrollo como un elemento <p> dentro de div.notiweb-cuerpo, en orden y delante del <hr>.
- Estructura el desarrollo con AL MENOS DOS encabezados intermedios dentro de div.notiweb-cuerpo, intercalados entre los <p> y nunca antes del primer parrafo: <h2> para cada apartado principal y <h3> para sus subsecciones. Cada encabezado resume en pocas palabras la seccion que introduce; no repitas el titular.
- Queda estrictamente prohibido usar parrafos <p> o etiquetas <strong> huerfanas como titulos o separadores de seccion: toda division tematica es un <h2> o un <h3>.
- Los encabezados solo van en el marcado: "body_paragraphs" contiene unicamente los parrafos.

Referencia bibliografica:
- Si el material cita un estudio, articulo o publicacion cientifica, escribe su referencia en p.notiweb-referencia en formato APA 7 estricto: Apellido, I. I., Apellido, I. I. y Apellido, I. I. (Año). Titulo del articulo. <em>Nombre de la Revista</em>, <em>volumen</em>(numero), paginas. https://doi.org/xxxx
- APA 7: hasta 20 autores, todos con apellido e iniciales separados por comas y el ultimo precedido de "y"; titulo del articulo en tipo normal y solo con mayuscula inicial; revista y volumen en cursiva (<em>); el DOI como URL https://doi.org/ completa, o la URL del articulo si no hay DOI.
- Referencia autonoma, por este orden de prioridad:
  1. Si el material cita estudios o publicaciones (incluidas las "Referencias citadas" del articulo original), referencia esas obras con los datos que figuren en el.
  2. Si no cita ninguna, referencia el propio articulo original en APA 7 para paginas web: Apellido, I. (Año, dia de mes). Titulo del articulo. <em>Nombre del sitio</em>. URL. Toma autor, fecha, titulo y URL de "Metadatos del articulo original".
  3. Si el extractor web fallo o vino vacio (sin titulo ni URL), reconstruye la referencia APA 7 a partir de la URL que aparece en la directiva del editor y de tu conocimiento del tema.
- La referencia incluye obligatoriamente el año y, si estan disponibles, el dia y el mes, con la forma (2026, 24 de febrero). Toma la fecha de "Fecha de publicacion" y, si viene vacia, de la ruta de la URL del articulo (por ejemplo /2026/02/24/). Queda prohibido escribir (s. f.) cuando exista una fecha en cualquiera de las dos fuentes; usalo solo si no hay fecha en ningun sitio.
- Si falta el autor, empieza la referencia por el titulo. Nunca inventes DOI, volumen ni paginas.
- Si cita varios estudios, una referencia por parrafo <p class="notiweb-referencia">, en el orden en que aparecen.
- Elimina del marcado el <hr>, el encabezado <h2>Referencia bibliográfica</h2> y su parrafo SOLO si no hay estudio citado, ni articulo original, ni URL en la directiva del editor.
- La referencia no forma parte de "body_paragraphs".

Coloca el titular en "headline", la entradilla en "summary" y los parrafos de desarrollo en "body_paragraphs".

Directiva del editor:
{{*parsed_email.clean_body}}

Articulo original:
{{scraped_web.full_article_content}}

Metadatos del articulo original:
Autor: {{scraped_web.author}}
Fecha de publicacion: {{scraped_web.published_at}}
Titulo: {{scraped_web.article_title}}
URL: {{scraped_web.source_url}}
Referencias citadas:
{{scraped_web.references_text}}

Documentos adjuntos:
{{parsed_email.extracted_documents_text}}

PLANTILLA BASE:
{{*rendered_html.compiled_markup}}$prompt$,
            admin_id, admin_id, admin_id)
    ON CONFLICT (codigo) DO NOTHING
    RETURNING id_plantilla_prompt_ia INTO inserted_id;
    IF inserted_id IS NOT NULL THEN
        summary := jsonb_set(summary, '{prompts}', to_jsonb((summary->>'prompts')::INT + 1));
        created_prompts := created_prompts || 'NOTIWEB_DEFAULT'::TEXT;
        INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_nuevos)
        VALUES (admin_id, 'CREAR', 'plantillas_prompts_ia', inserted_id::TEXT, seed_tag || jsonb_build_object('codigo', 'NOTIWEB_DEFAULT'));
    END IF;
    inserted_id := NULL;
    INSERT INTO plantillas_prompts_ia (codigo, nombre, descripcion, texto_prompt,
                                       id_usuario_creador, creado_por, actualizado_por)
    VALUES ('LICITACION_APERTURA_DEFAULT', 'Licitaciones · Apertura de convocatoria', 'Extrae expediente, importes desglosados, fechas limite y enlaces de contratacion, y rellena la plantilla base de convocatoria abierta.',
            $prompt$Eres un tecnico de contratacion administrativa publica de Madrid+D y maquetador oficial del portal. Se anuncia la APERTURA de una convocatoria de contratacion. Debes extraer los datos del expediente del material suministrado y volcarlos con estricta rigurosidad sobre la PLANTILLA BASE.

REGLAS DE EXTRACCIÓN Y TITULACIÓN OBLIGATORIAS:
1. EXTRACCIÓN DEL TÍTULO Y EXPEDIENTE:
   - El título formal del contrato SIEMPRE se ubica en el cuerpo del correo o en el pliego adjunto (ej. "S_2026_015_LICITACIÓN DEL CONTRATO DE SERVICIOS DE APOYO A LA GESTIÓN DE ACTIVIDADES DEL EMPRENDIMIENTO INNOVADOR A LA FUNDACIÓN").
   - QUEDA TERMINANTEMENTE PROHIBIDO utilizar como título el asunto del correo (subject), nombres de prueba, saludos o expresiones coloquiales (ej. "Abrir licitación V5", "PRUEBILLA", "Prueba de abrir licitación").
   - El código de expediente suele tener formato estructurado (ej. "S_2026_015", "LIC-2026-X"). Asígnalo a "headline" y al atributo data-expediente del bloque.

2. ASIGNACIÓN EN EL JSON DE SALIDA:
   - "headline": Debe contener ÚNICAMENTE el código del expediente (ej. "S_2026_015"). Si no hay código formal, usa el título abreviado de la licitación. NUNCA el asunto del correo.
   - "summary": Debe contener el objeto completo del contrato de la licitación.
   - "body_paragraphs": Array estructurado con las líneas "campo: valor" para base_imponible, iva, importe_total, valor_estimado, plazo_recepcion, duracion_meses, direccion_postal y enlace_consulta.

3. INYECCIÓN OBLIGATORIA EN "filled_markup" (PLANTILLA BASE):
   - En la etiqueta <h3 class="licitacion-title">: DEBES inyectar obligatoriamente el título formal completo del contrato. NUNCA la dejes vacía ni borres la etiqueta o su clase CSS.
   - En el contenedor raíz <div class="licitacion-entry pd-licitacion-block" data-expediente>: inyecta el código en el atributo data-expediente (ej. data-expediente="S_2026_015").
   - En las etiquetas de presupuesto: inyecta las cantidades numéricas correspondientes dentro de:
     * <span class="base-imponible">: la base imponible con euros (ej. "33.000,00 euros").
     * <span class="iva">: el importe del IVA (ej. "6.390,00 euros").
     * <span class="total">: el importe total de adjudicación (ej. "39.930,00 euros").
   - En <p class="valor-estimado">: "Valor estimado del contrato: [monto] euros".
   - En <strong class="plazo">: inyecta la fecha y hora límite en formato legible.
   - En <a class="link-consulta">: asigna la URL oficial al atributo href y mantén el texto visible.
   - En <p class="duracion-contrato">: inyecta la duración indicada en el material.
   - Un importe o dato que no figure en el material se deja vacío en su etiqueta: NUNCA lo calcules, lo deduzcas ni lo estimes (por ejemplo, no derives la base imponible ni el IVA a partir del total).

DIRECTIVA DE POLIVALENCIA Y RESTRICCIÓN DE MARKDOWN:
- Si recibes tablas o listas en Markdown desde los adjuntos, transfórmalas a marcado HTML nativo compatible con la plantilla. Queda TERMINANTEMENTE PROHIBIDO copiar sintaxis Markdown cruda (| tablas |, # títulos, - listas) dentro de "filled_markup".

Correo:
{{*parsed_email.clean_body}}

Documentos adjuntos (texto documental):
{{parsed_email.extracted_documents_text}}

Texto recuperado por OCR (imágenes/pliegos escaneados):
{{ocr_result.clean_body}}

PLANTILLA BASE:
{{*rendered_html.compiled_markup}}$prompt$,
            admin_id, admin_id, admin_id)
    ON CONFLICT (codigo) DO NOTHING
    RETURNING id_plantilla_prompt_ia INTO inserted_id;
    IF inserted_id IS NOT NULL THEN
        summary := jsonb_set(summary, '{prompts}', to_jsonb((summary->>'prompts')::INT + 1));
        created_prompts := created_prompts || 'LICITACION_APERTURA_DEFAULT'::TEXT;
        INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_nuevos)
        VALUES (admin_id, 'CREAR', 'plantillas_prompts_ia', inserted_id::TEXT, seed_tag || jsonb_build_object('codigo', 'LICITACION_APERTURA_DEFAULT'));
    END IF;
    inserted_id := NULL;
    -- El cierre no lleva mapeador: la version que aun pide la plantilla base
    -- se reescribe; una editada a mano sin ella se respeta.
    SELECT texto_prompt INTO previous_text FROM plantillas_prompts_ia WHERE codigo = 'LICITACION_CIERRE_DEFAULT';
    INSERT INTO plantillas_prompts_ia (codigo, nombre, descripcion, texto_prompt,
                                       id_usuario_creador, creado_por, actualizado_por)
    VALUES ('LICITACION_CIERRE_DEFAULT', 'Licitaciones · Cierre de convocatoria', 'Identifica de forma univoca el expediente que se traslada a la pagina de convocatorias cerradas.',
            $prompt$Eres un tecnico de contratacion administrativa publica de Madrid+D. En el material de mas abajo se comunica el CIERRE de una convocatoria. Tu tarea es identificar de forma univoca el expediente cuyo bloque hay que trasladar de la pagina de convocatorias abiertas a la de cerradas.

El traslado lo hace el destino Drupal moviendo el bloque ya publicado: no redactes ni maquetes HTML.

Datos que debes localizar:
- expediente (codigo identificador; es el dato que permite encontrar el bloque a trasladar)
- objeto_contrato
- fecha_cierre: fecha de fin del plazo, en formato ISO 8601
- estado_resolucion: adjudicada, desierta o anulada
- adjudicatario (nombre de la entidad; vacio si quedo desierta o anulada)
- importe_adjudicacion en euros
- enlace_consulta

Reglas:
- El EXPEDIENTE es el dato critico: sin el, el bloque no se puede localizar en la pagina de origen. Copialo LITERALMENTE tal y como aparece en el material; si no aparece, dejalo vacio en vez de componerlo a partir de otros campos.
- Un dato que no aparezca en el material se deja vacio. NUNCA lo estimes ni lo deduzcas.
- Los importes van en euros, con punto decimal y sin separador de millares.
- Una convocatoria desierta o anulada no tiene adjudicatario ni importe: dejalos vacios, no escribas "ninguno".

Coloca SOLO el codigo de expediente en "headline", sin ningun texto adicional; el objeto del contrato en "summary" y, en "body_paragraphs", una entrada por cada dato restante con el formato "campo: valor".

Correo:
{{*parsed_email.clean_body}}

Documentos adjuntos:
{{parsed_email.extracted_documents_text}}$prompt$,
            admin_id, admin_id, admin_id)
    ON CONFLICT (codigo) DO UPDATE
       SET texto_prompt = EXCLUDED.texto_prompt,
           descripcion = EXCLUDED.descripcion,
           actualizado_por = admin_id,
           fecha_actualizacion = NOW()
     WHERE position('{{rendered_html.compiled_markup}}' IN plantillas_prompts_ia.texto_prompt) > 0
    RETURNING id_plantilla_prompt_ia INTO inserted_id;
    IF inserted_id IS NOT NULL THEN
        summary := jsonb_set(summary, '{prompts}', to_jsonb((summary->>'prompts')::INT + 1));
        created_prompts := created_prompts || 'LICITACION_CIERRE_DEFAULT'::TEXT;
        INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_anteriores, datos_nuevos)
        VALUES (admin_id, CASE WHEN previous_text IS NULL THEN 'CREAR' ELSE 'ACTUALIZAR' END,
                'plantillas_prompts_ia', inserted_id::TEXT,
                CASE WHEN previous_text IS NULL THEN NULL ELSE jsonb_build_object('texto_prompt', previous_text) END,
                seed_tag || jsonb_build_object('codigo', 'LICITACION_CIERRE_DEFAULT'));
    END IF;
    inserted_id := NULL;
    INSERT INTO plantillas_prompts_ia (codigo, nombre, descripcion, texto_prompt,
                                       id_usuario_creador, creado_por, actualizado_por)
    VALUES ('INNODAYS_ENLACE_DEFAULT', 'Innodays · Enlace de jornada sectorial', 'Extrae el nombre literal de la jornada (headline) y el enlace a publicar (summary). Destino: preset INNODAYS (UPDATE_LINK_SOURCE).',
            $prompt$Eres el gestor de la agenda de Innodays e Innobar de Madrid+D. A partir del correo que se te proporciona a continuacion, identifica el nombre de la jornada o encuentro sectorial y la URL que debe publicarse en la tabla del portal.

Datos a localizar:
- Nombre del evento: Identifica el nombre propio o tematica principal del encuentro (por ejemplo "Agrifood", "Deeptech", "Talento Emprendedor"). Si el correo dice "encuentro sectorial de Agrifood" o "InnoDay Agrifood", extrae unicamente la palabra clave del evento ("Agrifood"). Conserva sus mayusculas y tildes exactas.
- Enlace: La URL completa (http:// o https://) enviada en el correo para la inscripcion o publicacion.

Reglas:
- No inventes URLs ni nombres.
- Si el correo menciona la tematica o nombre del evento, NUNCA dejes el campo de nombre vacio.

Formato de salida:
- Coloca el nombre del evento en "headline".
- Coloca la URL completa en "summary".
- Deja "body_paragraphs" como una lista vacia.

Correo:
{{parsed_email.clean_body}}$prompt$,
            admin_id, admin_id, admin_id)
    ON CONFLICT (codigo) DO NOTHING
    RETURNING id_plantilla_prompt_ia INTO inserted_id;
    IF inserted_id IS NOT NULL THEN
        summary := jsonb_set(summary, '{prompts}', to_jsonb((summary->>'prompts')::INT + 1));
        created_prompts := created_prompts || 'INNODAYS_ENLACE_DEFAULT'::TEXT;
        INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_nuevos)
        VALUES (admin_id, 'CREAR', 'plantillas_prompts_ia', inserted_id::TEXT, seed_tag || jsonb_build_object('codigo', 'INNODAYS_ENLACE_DEFAULT'));
    END IF;
    inserted_id := NULL;
    INSERT INTO plantillas_prompts_ia (codigo, nombre, descripcion, texto_prompt,
                                       id_usuario_creador, creado_por, actualizado_por)
    VALUES ('INNOBAR_ENLACE_DEFAULT', 'Innobar · Enlace de encuentro de networking', 'Extrae el nombre literal del encuentro (headline) y el enlace a publicar (summary). Destino: preset INNOBAR (UPDATE_LINK_SOURCE).',
            $prompt$Eres el gestor de la agenda de Innobar de Madrid+D, los afterworks y encuentros de networking informal entre investigadores, empresas y emprendedores. A partir del correo que se te da mas abajo, identifica el encuentro al que se refiere y el enlace que debe publicarse para el en la tabla de eventos del portal.

Datos que debes localizar:
- evento_nombre (el nombre del encuentro EXACTAMENTE como figura en el correo, con sus mayusculas, tildes y signos, sin comillas ni prefijos como "Encuentro:")
- enlace (la URL completa de inscripcion o de la convocatoria del encuentro que el correo pide publicar)

Reglas:
- No reformules, abrevies ni traduzcas el nombre: la tabla del portal se busca por ese texto literal y cualquier variacion deja el enlace sin actualizar.
- El enlace empieza por https:// o http://. Si el correo trae varios, elige el que el remitente pide publicar; si no lo indica, el de inscripcion.
- Si falta alguno de los dos datos, deja su campo vacio. No inventes ni completes URLs.

Coloca el nombre del encuentro en "headline", el enlace en "summary" y deja "body_paragraphs" como una lista vacia.

Correo:
{{parsed_email.clean_body}}$prompt$,
            admin_id, admin_id, admin_id)
    ON CONFLICT (codigo) DO NOTHING
    RETURNING id_plantilla_prompt_ia INTO inserted_id;
    IF inserted_id IS NOT NULL THEN
        summary := jsonb_set(summary, '{prompts}', to_jsonb((summary->>'prompts')::INT + 1));
        created_prompts := created_prompts || 'INNOBAR_ENLACE_DEFAULT'::TEXT;
        INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_nuevos)
        VALUES (admin_id, 'CREAR', 'plantillas_prompts_ia', inserted_id::TEXT, seed_tag || jsonb_build_object('codigo', 'INNOBAR_ENLACE_DEFAULT'));
    END IF;
    inserted_id := NULL;
    INSERT INTO plantillas_prompts_ia (codigo, nombre, descripcion, texto_prompt,
                                       id_usuario_creador, creado_por, actualizado_por)
    VALUES ('VERIFICADOR_TITULOS_DEFAULT', 'Verificador de titulos · Paneles de acreditacion', 'Extrae comites, evaluadores, universidades y fechas de visita de los paneles de renovacion de acreditacion.',
            $prompt$Eres un asistente de estructuracion tecnica para la Fundacion para el Conocimiento madri+d. Tu objetivo es procesar la informacion de los comites de evaluacion para la acreditacion de titulos universitarios recibida en el correo y los documentos, y rellenar exactamente la PLANTILLA BASE.

INSTRUCCIONES DE EXTRACCION Y RELLENO:
1. Identificador de despliegue: en el atributo href de "a.panel-toggle-link" y en el id de "div.collapse", asigna el MISMO identificador alfanumerico unico derivado del codigo del comite (ej. href="#collapseESIC1" e id="collapseESIC1", con almohadilla solo en el href). La plantilla trae el valor de relleno "collapsePanelId" en los dos sitios: SUSTITUYELO. Si los dos valores no coinciden exactamente, el boton colapsable no despliega.
2. Codigo y centro: rellena ".panel-comite-codigo" con el identificador del comite (ej. "ESIC 1", "CEU 2") y ".panel-facultad-nombre" con el nombre del centro o facultad (ej. "Facultad de Ciencias Juridicas y Sociales").
3. Titulaciones (.panel-titulos-body): genera exactamente una fila <tr> por cada titulacion evaluada, con la estructura <tr><th>[CODIGO_RUCT]</th><th colspan="2">[NOMBRE_OFICIAL_TITULO]</th></tr>. Ni una de mas ni una de menos.
4. Comite de evaluadores: rellena el nombre y la institucion de procedencia para Presidente, Secretario, Vocal y Estudiante en sus respectivas celdas (.eval-* e .inst-*). Si algun rol no existe en el material, coloca &nbsp; en sus dos celdas. No elimines filas de la tabla.
5. Fecha de visita (.panel-fecha-visita): transcribe las fechas exactas de la visita tecnica (ej. "28 y 29 de mayo").

REGLAS ESTRICTAS:
- No utilices bloques de codigo Markdown (prohibido abrir con tres acentos graves, con o sin la palabra html detras).
- Devuelve unica y exclusivamente el marcado HTML inyectable resultante.
- Respeta integramente las clases de Bootstrap (.panel, .panel-default, .panel-heading, .panel-title, .collapse, .tableform) y los estilos de fondo (#A9BCF5, #C6E0B4), asi como los atributos data-bs-toggle, data-parent, aria-expanded y colspan que la plantilla ya trae. Son el contrato que se verifica despues de ti: a un fragmento al que le falte una de esas clases se le rechaza entero.
- Respeta la grafia de los nombres propios y de las instituciones tal y como figuran en el material. Un apellido mal transcrito en un panel de evaluacion es un error con nombre y apellidos.
- Un dato que no aparezca en el material se deja vacio. NUNCA lo estimes ni lo deduzcas.
- No fusiones comites distintos aunque compartan centro o universidad.

Ademas del marcado, resume la ejecucion: en "headline" el centro y el numero de comites encontrados, en "summary" el rango de fechas de visita, y en "body_paragraphs" una entrada por comite con sus titulaciones y su fecha.

DATOS DE ENTRADA:
Correo:
{{parsed_email.clean_body}}

Documentacion adjunta:
{{parsed_email.extracted_documents_text}}

PLANTILLA BASE:
{{rendered_html.compiled_markup}}
- Si el material de partida trae tablas en Markdown (GitHub Flavored Markdown, con celdas separadas por | y una fila de guiones bajo la cabecera), NUNCA las copies tal cual ni las publiques como texto: conviertelas al marcado institucional. Cada tabla pasa a ser un <table class="tableform"> con su <thead> y su <tbody>, y cada celda combinada que el origen repita se vuelve a combinar con colspan o rowspan.
- Si esas tablas vienen agrupadas por secciones o epigrafes, envuelve cada seccion en un panel: <div class="panel panel-default"> con el titulo en <div class="panel-heading"><h4 class="panel-title">...</h4></div> y el contenido en <div class="panel-body">. Respeta las clases exactamente como estan escritas aqui: son las que el portal sabe pintar y las que audita el nodo de validacion posterior.
- La etiqueta <tbody class="panel-titulos-body"> debe mantenerse intacta en cada panel: las filas <tr> de las titulaciones van DENTRO de ella. Nunca la fusiones con el otro <tbody> de la tabla, no la renombres ni la elimines, y deja sin modificar el <tbody> estatico de evaluadores.$prompt$,
            admin_id, admin_id, admin_id)
    ON CONFLICT (codigo) DO NOTHING
    RETURNING id_plantilla_prompt_ia INTO inserted_id;
    IF inserted_id IS NOT NULL THEN
        summary := jsonb_set(summary, '{prompts}', to_jsonb((summary->>'prompts')::INT + 1));
        created_prompts := created_prompts || 'VERIFICADOR_TITULOS_DEFAULT'::TEXT;
        INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_nuevos)
        VALUES (admin_id, 'CREAR', 'plantillas_prompts_ia', inserted_id::TEXT, seed_tag || jsonb_build_object('codigo', 'VERIFICADOR_TITULOS_DEFAULT'));
    END IF;
    inserted_id := NULL;
    INSERT INTO plantillas_prompts_ia (codigo, nombre, descripcion, texto_prompt,
                                       id_usuario_creador, creado_por, actualizado_por)
    VALUES ('PROMPT_OCR_MULTIMODAL', 'OCR · Transcripcion multimodal (referencia)', 'Copia de referencia del prompt por defecto del PROCESADOR_OCR. El nodo usa la constante del codigo; esta fila permite consultarlo y reutilizarlo.',
            $prompt$Eres un motor de transcripcion documental. Transcribe integramente el texto visible en los documentos adjuntos usando Markdown GFM.

1. TEXTO CORRIDO: parrafos separados por una linea en blanco. Usa encabezados (# y ##) solo donde el documento original tenga titulos.
2. TABLAS: sintaxis GFM, con fila de cabecera y separador (|---|). Si una celda esta combinada verticalmente y abarca varias filas, REPITE su valor en cada una de esas filas; no dejes huecos.
3. UN SOLO BLOQUE: devuelve la transcripcion completa como un unico elemento, con sus saltos de linea dentro. No la repartas en fragmentos.
4. PROHIBIDO: saludos, notas introductorias, comentarios sobre lo que has hecho y delimitadores de bloque de codigo (```), salvo que el documento original los contenga.
5. No resumas, no interpretes y no completes lo que no se lea. Respeta el orden de lectura y la grafia de nombres propios tal y como figuran.$prompt$,
            admin_id, admin_id, admin_id)
    ON CONFLICT (codigo) DO NOTHING
    RETURNING id_plantilla_prompt_ia INTO inserted_id;
    IF inserted_id IS NOT NULL THEN
        summary := jsonb_set(summary, '{prompts}', to_jsonb((summary->>'prompts')::INT + 1));
        created_prompts := created_prompts || 'PROMPT_OCR_MULTIMODAL'::TEXT;
        INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_nuevos)
        VALUES (admin_id, 'CREAR', 'plantillas_prompts_ia', inserted_id::TEXT, seed_tag || jsonb_build_object('codigo', 'PROMPT_OCR_MULTIMODAL'));
    END IF;

    -- 5a. Reescritura canonica del prompt de apertura -----------------------
    -- Texto completo y no un parche: el anterior dejaba usar el asunto del
    -- correo como titulo y no exigia los importes. Se protege por marcador,
    -- asi que una segunda pasada no lo vuelve a tocar.
    SELECT id_plantilla_prompt_ia, texto_prompt INTO inserted_id, previous_text
      FROM plantillas_prompts_ia WHERE codigo = 'LICITACION_APERTURA_DEFAULT';
    IF FOUND AND position('REGLAS DE EXTRACCIÓN Y TITULACIÓN OBLIGATORIAS' IN previous_text) = 0 THEN
        UPDATE plantillas_prompts_ia
           SET texto_prompt = $prompt$Eres un tecnico de contratacion administrativa publica de Madrid+D y maquetador oficial del portal. Se anuncia la APERTURA de una convocatoria de contratacion. Debes extraer los datos del expediente del material suministrado y volcarlos con estricta rigurosidad sobre la PLANTILLA BASE.

REGLAS DE EXTRACCIÓN Y TITULACIÓN OBLIGATORIAS:
1. EXTRACCIÓN DEL TÍTULO Y EXPEDIENTE:
   - El título formal del contrato SIEMPRE se ubica en el cuerpo del correo o en el pliego adjunto (ej. "S_2026_015_LICITACIÓN DEL CONTRATO DE SERVICIOS DE APOYO A LA GESTIÓN DE ACTIVIDADES DEL EMPRENDIMIENTO INNOVADOR A LA FUNDACIÓN").
   - QUEDA TERMINANTEMENTE PROHIBIDO utilizar como título el asunto del correo (subject), nombres de prueba, saludos o expresiones coloquiales (ej. "Abrir licitación V5", "PRUEBILLA", "Prueba de abrir licitación").
   - El código de expediente suele tener formato estructurado (ej. "S_2026_015", "LIC-2026-X"). Asígnalo a "headline" y al atributo data-expediente del bloque.

2. ASIGNACIÓN EN EL JSON DE SALIDA:
   - "headline": Debe contener ÚNICAMENTE el código del expediente (ej. "S_2026_015"). Si no hay código formal, usa el título abreviado de la licitación. NUNCA el asunto del correo.
   - "summary": Debe contener el objeto completo del contrato de la licitación.
   - "body_paragraphs": Array estructurado con las líneas "campo: valor" para base_imponible, iva, importe_total, valor_estimado, plazo_recepcion, duracion_meses, direccion_postal y enlace_consulta.

3. INYECCIÓN OBLIGATORIA EN "filled_markup" (PLANTILLA BASE):
   - En la etiqueta <h3 class="licitacion-title">: DEBES inyectar obligatoriamente el título formal completo del contrato. NUNCA la dejes vacía ni borres la etiqueta o su clase CSS.
   - En el contenedor raíz <div class="licitacion-entry pd-licitacion-block" data-expediente>: inyecta el código en el atributo data-expediente (ej. data-expediente="S_2026_015").
   - En las etiquetas de presupuesto: inyecta las cantidades numéricas correspondientes dentro de:
     * <span class="base-imponible">: la base imponible con euros (ej. "33.000,00 euros").
     * <span class="iva">: el importe del IVA (ej. "6.390,00 euros").
     * <span class="total">: el importe total de adjudicación (ej. "39.930,00 euros").
   - En <p class="valor-estimado">: "Valor estimado del contrato: [monto] euros".
   - En <strong class="plazo">: inyecta la fecha y hora límite en formato legible.
   - En <a class="link-consulta">: asigna la URL oficial al atributo href y mantén el texto visible.
   - En <p class="duracion-contrato">: inyecta la duración indicada en el material.
   - Un importe o dato que no figure en el material se deja vacío en su etiqueta: NUNCA lo calcules, lo deduzcas ni lo estimes (por ejemplo, no derives la base imponible ni el IVA a partir del total).

DIRECTIVA DE POLIVALENCIA Y RESTRICCIÓN DE MARKDOWN:
- Si recibes tablas o listas en Markdown desde los adjuntos, transfórmalas a marcado HTML nativo compatible con la plantilla. Queda TERMINANTEMENTE PROHIBIDO copiar sintaxis Markdown cruda (| tablas |, # títulos, - listas) dentro de "filled_markup".

Correo:
{{*parsed_email.clean_body}}

Documentos adjuntos (texto documental):
{{parsed_email.extracted_documents_text}}

Texto recuperado por OCR (imágenes/pliegos escaneados):
{{ocr_result.clean_body}}

PLANTILLA BASE:
{{*rendered_html.compiled_markup}}$prompt$,
               actualizado_por = admin_id,
               fecha_actualizacion = NOW()
         WHERE codigo = 'LICITACION_APERTURA_DEFAULT';
        summary := jsonb_set(summary, '{prompts_parcheados}', to_jsonb((summary->>'prompts_parcheados')::INT + 1));
        IF NOT ('LICITACION_APERTURA_DEFAULT' = ANY (created_prompts)) THEN
            INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_anteriores, datos_nuevos)
            VALUES (admin_id, 'ACTUALIZAR', 'plantillas_prompts_ia', inserted_id::TEXT,
                    jsonb_build_object('texto_prompt', previous_text),
                    seed_tag || jsonb_build_object('codigo', 'LICITACION_APERTURA_DEFAULT', 'parche', 'apertura_titulo_e_importes'));
        END IF;
    END IF;

    -- 5b. Parches de contenido de los prompts maestros ----------------------
    -- Corren tambien sobre filas que ya existian (desarrollo): cada uno se
    -- protege con su marcador, de modo que reejecutar no duplica nada. Las
    -- marcas se normalizan ANTES de anadir el OCR para que una forma
    -- {{*ocr_result.clean_body}} puesta a mano cuente como ya presente.
    FOR rec IN
        SELECT * FROM (VALUES
            ('NOTIWEB_DEFAULT', TRUE, TRUE),
            ('LICITACION_APERTURA_DEFAULT', TRUE, TRUE),
            ('VERIFICADOR_TITULOS_DEFAULT', TRUE, TRUE),
            ('LICITACION_CIERRE_DEFAULT', FALSE, TRUE),
            ('INNODAYS_ENLACE_DEFAULT', FALSE, TRUE),
            ('INNOBAR_ENLACE_DEFAULT', FALSE, TRUE)
        ) AS t(codigo, with_template, with_documents)
    LOOP
        SELECT id_plantilla_prompt_ia, texto_prompt INTO inserted_id, previous_text
          FROM plantillas_prompts_ia WHERE codigo = rec.codigo;
        IF NOT FOUND THEN
            CONTINUE;
        END IF;

        -- Contrato de marcas: obligatoria la directiva y, con mapeador, la
        -- plantilla base; el resto, opcional.
        patched := regexp_replace(previous_text, '\{\{\s*\*?\s*parsed_email\.clean_body\s*\}\}', '{{*parsed_email.clean_body}}', 'g');
        IF rec.with_template THEN
            patched := regexp_replace(patched, '\{\{\s*\*?\s*rendered_html\.compiled_markup\s*\}\}', '{{*rendered_html.compiled_markup}}', 'g');
        END IF;
        patched := regexp_replace(patched, '\{\{\s*\*\s*(ocr_result\.clean_body|parsed_email\.extracted_documents_text|scraped_web\.[a-z_]+)\s*\}\}', '{{\1}}', 'g');

        -- Directivas, insertadas antes de la primera seccion de material.
        insertion := '';
        IF position('DIRECTIVA DE POLIVALENCIA' IN patched) = 0 THEN
            insertion := CASE WHEN rec.with_template THEN clause_poly_html ELSE clause_poly_text END;
        END IF;
        IF rec.codigo = 'NOTIWEB_DEFAULT'
           AND position('ESTRUCTURA DE LA SECCIÓN BIBLIOGRÁFICA' IN patched) = 0 THEN
            insertion := concat_ws(E'\n\n', NULLIF(insertion, ''), clause_biblio);
        END IF;
        IF insertion <> '' THEN
            IF patched ~ material_anchor THEN
                patched := regexp_replace(patched, material_anchor, E'\n\n' || insertion || E'\n\n\\1{{');
            ELSE
                -- Texto editado a mano sin secciones reconocibles: la directiva
                -- se anade al final, que el modelo tambien lee.
                patched := patched || E'\n\n' || insertion;
                RAISE WARNING '069: % no tiene una seccion de material reconocible; las directivas se anaden al final.', rec.codigo;
            END IF;
        END IF;

        -- OCR opcional junto al texto de los adjuntos (misma cadena de
        -- degradacion: OCR -> adjuntos -> cuerpo).
        IF rec.with_documents AND position('{{ocr_result.clean_body}}' IN patched) = 0 THEN
            IF position('{{parsed_email.extracted_documents_text}}' IN patched) > 0 THEN
                patched := regexp_replace(patched, '\{\{parsed_email\.extracted_documents_text\}\}',
                                          '{{parsed_email.extracted_documents_text}} o {{ocr_result.clean_body}}');
            ELSE
                -- Sin seccion de adjuntos (Innodays, Innobar): el OCR va en una
                -- seccion propia justo detras del cuerpo del correo.
                patched := regexp_replace(patched, '\{\{\*parsed_email\.clean_body\}\}',
                                          E'{{*parsed_email.clean_body}}\n\nTexto recuperado por OCR (imágenes o documentos escaneados):\n{{ocr_result.clean_body}}');
            END IF;
        END IF;

        IF patched IS DISTINCT FROM previous_text THEN
            UPDATE plantillas_prompts_ia
               SET texto_prompt = patched, actualizado_por = admin_id, fecha_actualizacion = NOW()
             WHERE codigo = rec.codigo;
            summary := jsonb_set(summary, '{prompts_parcheados}', to_jsonb((summary->>'prompts_parcheados')::INT + 1));
            -- Un prompt creado en este mismo pase ya tiene su fila CREAR.
            IF NOT (rec.codigo = ANY (created_prompts)) THEN
                INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_anteriores, datos_nuevos)
                VALUES (admin_id, 'ACTUALIZAR', 'plantillas_prompts_ia', inserted_id::TEXT,
                        jsonb_build_object('texto_prompt', previous_text),
                        seed_tag || jsonb_build_object('codigo', rec.codigo, 'parche', 'polivalencia_markdown_ocr_marcas'));
            END IF;
        END IF;
    END LOOP;

    -- 5c. Cardinalidad 1 a N en los prompts maestros -------------------------
    -- La regla asimetrica que exige `outputCardinality: MULTIPLE`, con lo que
    -- es un elemento en cada flujo. Por marcador y antes del material, como 5b.
    FOR rec IN
        SELECT * FROM (VALUES
            ('NOTIWEB_DEFAULT', $rule$REGLA DE CARDINALIDAD FLEXIBLE (1 A 1 Y 1 A N):
- El material de entrada puede contener una sola solicitud o un lote de varios registros.
- Si contiene un unico elemento, colocalo en la raiz del JSON y deja "items" como array vacio [].
- Si contiene varios, coloca en la raiz el PRIMER elemento y en "items" un objeto completo por cada elemento RESTANTE (del segundo en adelante). Nunca repitas el primero dentro de "items".
- Cada noticia es un elemento, con su "headline", "summary", "body_paragraphs", su "filled_markup" (su propia copia de la PLANTILLA BASE, con sus encabezados <h2> y su <h2>Referencia bibliográfica</h2> seguido de <p class="notiweb-referencia">) y "source_url" con el enlace de esa noticia.$rule$),
            ('LICITACION_APERTURA_DEFAULT', $rule$REGLA DE CARDINALIDAD FLEXIBLE (1 A 1 Y 1 A N):
- El material de entrada puede contener una sola solicitud o un lote de varios registros.
- Si contiene un unico elemento, colocalo en la raiz del JSON y deja "items" como array vacio [].
- Si contiene varios, coloca en la raiz el PRIMER elemento y en "items" un objeto completo por cada elemento RESTANTE (del segundo en adelante). Nunca repitas el primero dentro de "items".
- Cada expediente de licitacion es un elemento: su bloque HTML integro en "filled_markup", con <h3 class="licitacion-title"> relleno, "data-expediente" con su codigo y los spans de presupuesto. Nunca uses el asunto del correo ni saludos como titulo.$rule$),
            ('LICITACION_CIERRE_DEFAULT', $rule$REGLA DE CARDINALIDAD FLEXIBLE (1 A 1 Y 1 A N):
- El material de entrada puede contener una sola solicitud o un lote de varios registros.
- Si contiene un unico elemento, colocalo en la raiz del JSON y deja "items" como array vacio [].
- Si contiene varios, coloca en la raiz el PRIMER elemento y en "items" un objeto completo por cada elemento RESTANTE (del segundo en adelante). Nunca repitas el primero dentro de "items".
- Cada expediente que se cierra es un elemento, en texto plano: SOLO su codigo en "headline" y el objeto del contrato en "summary".$rule$),
            ('INNODAYS_ENLACE_DEFAULT', $rule$REGLA DE CARDINALIDAD FLEXIBLE (1 A 1 Y 1 A N):
- El material de entrada puede contener una sola solicitud o un lote de varios registros.
- Si contiene un unico elemento, colocalo en la raiz del JSON y deja "items" como array vacio [].
- Si contiene varios, coloca en la raiz el PRIMER elemento y en "items" un objeto completo por cada elemento RESTANTE (del segundo en adelante). Nunca repitas el primero dentro de "items".
- Cada enlace o imagen a sincronizar es un elemento, en texto plano: el nombre del evento en "headline" y la URL nueva en "summary".$rule$),
            ('INNOBAR_ENLACE_DEFAULT', $rule$REGLA DE CARDINALIDAD FLEXIBLE (1 A 1 Y 1 A N):
- El material de entrada puede contener una sola solicitud o un lote de varios registros.
- Si contiene un unico elemento, colocalo en la raiz del JSON y deja "items" como array vacio [].
- Si contiene varios, coloca en la raiz el PRIMER elemento y en "items" un objeto completo por cada elemento RESTANTE (del segundo en adelante). Nunca repitas el primero dentro de "items".
- Cada enlace o imagen a sincronizar es un elemento, en texto plano: el nombre del encuentro en "headline" y la URL nueva en "summary".$rule$),
            ('VERIFICADOR_TITULOS_DEFAULT', $rule$REGLA DE CARDINALIDAD FLEXIBLE (1 A 1 Y 1 A N):
- El material de entrada puede contener una sola solicitud o un lote de varios registros.
- Si contiene un unico elemento, colocalo en la raiz del JSON y deja "items" como array vacio [].
- Si contiene varios, coloca en la raiz el PRIMER elemento y en "items" un objeto completo por cada elemento RESTANTE (del segundo en adelante). Nunca repitas el primero dentro de "items".
- Cada panel de comite (una universidad o centro) es un elemento: su panel completo en "filled_markup", con su matriz de evaluadores, su universidad y sus titulaciones.$rule$)
        ) AS t(codigo, rule_text)
    LOOP
        SELECT id_plantilla_prompt_ia, texto_prompt INTO inserted_id, previous_text
          FROM plantillas_prompts_ia WHERE codigo = rec.codigo;
        IF NOT FOUND OR position('REGLA DE CARDINALIDAD FLEXIBLE' IN previous_text) > 0 THEN
            CONTINUE;
        END IF;

        IF previous_text ~ material_anchor THEN
            patched := regexp_replace(previous_text, material_anchor, E'\n\n' || rec.rule_text || E'\n\n\\1{{');
        ELSE
            patched := previous_text || E'\n\n' || rec.rule_text;
            RAISE WARNING '069: % no tiene una seccion de material reconocible; la regla de cardinalidad se anade al final.', rec.codigo;
        END IF;

        UPDATE plantillas_prompts_ia
           SET texto_prompt = patched, actualizado_por = admin_id, fecha_actualizacion = NOW()
         WHERE codigo = rec.codigo;
        summary := jsonb_set(summary, '{prompts_parcheados}', to_jsonb((summary->>'prompts_parcheados')::INT + 1));
        IF NOT (rec.codigo = ANY (created_prompts)) THEN
            INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_anteriores, datos_nuevos)
            VALUES (admin_id, 'ACTUALIZAR', 'plantillas_prompts_ia', inserted_id::TEXT,
                    jsonb_build_object('texto_prompt', previous_text),
                    seed_tag || jsonb_build_object('codigo', rec.codigo, 'parche', 'cardinalidad_1_a_n'));
        END IF;
    END LOOP;

    -- 5d. Prompts consolidados de Notiweb y de verificacion de titulos ------
    -- Notiweb: deteccion de lote y fuentes mixtas (la noticia del articulo y
    -- las secundarias desde su titulo, fuente y entradilla del listado), un
    -- minimo de 4 parrafos por noticia y cierre bibliografico APA 7. Titulos:
    -- h5.panel-title como la plantilla, respaldos para sus dos ranuras y la
    -- regla de no inventar si no hay datos (la valida el escudo).
    --
    -- Tres estados posibles de la base: sin bloque (se inserta antes del
    -- material), con el bloque de una version anterior de este paso (se
    -- SUSTITUYE entero, `old_rule`) o ya consolidada (marcador presente).
    FOR rec IN
        SELECT * FROM (VALUES
            ('NOTIWEB_DEFAULT', 'DETECCIÓN DE LOTE Y FUENTES MIXTAS', $old_rule$DESARROLLO MÍNIMO Y CIERRE DE CADA NOTICIA:
- Cada noticia —la de la raíz y cada una de "items"— desarrolla su cuerpo en un MÍNIMO DE 3 Y UN MÁXIMO DE 4 párrafos <p> dentro de div.notiweb-cuerpo, sin contar los encabezados <h2>/<h3> ni la referencia. Sus "body_paragraphs" contienen esos mismos 3 o 4 párrafos.
- Si el material de una noticia es escaso, desarrolla el contexto institucional y el alcance de lo anunciado con los datos que sí figuran; nunca inventes cifras, nombres ni declaraciones para alcanzar el mínimo.
- Cada "filled_markup" termina OBLIGATORIAMENTE con <hr /><h2>Referencia bibliográfica</h2><p class="notiweb-referencia">...</p>, con la referencia en formato APA 7 estricto según las reglas de "Referencia bibliografica". Nunca la escribas como <p><strong>...</strong></p>.$old_rule$, $rule$DETECCIÓN DE LOTE Y FUENTES MIXTAS (NOTIWEB):
- El correo puede traer una sola noticia o un listado (tabla del correo o de los documentos adjuntos) con varias. Cada fila del listado es una noticia independiente: la primera va en la raíz del JSON y cada una de las restantes es un objeto de "items".
- La noticia cuya URL coincide con la "URL" de "Metadatos del articulo original" se redacta a partir de "Articulo original" (el texto completo del artículo extraído).
- Cada noticia secundaria del listado sin texto en el artículo original se desarrolla OBLIGATORIAMENTE usando como único insumo factual su Título, su Fuente y su Entradilla tal como figuran en la tabla del correo o en los adjuntos. Nunca la omitas ni la fusiones con otra.
- Las filas especiales del listado, como "Blog del día", son un elemento más de "items" y se redactan con las mismas reglas.
- EXTENSIÓN: cada noticia —la de la raíz y cada una de "items", haya una sola o un lote— se desarrolla con un MÍNIMO DE 4 PÁRRAFOS <p> dentro de div.notiweb-cuerpo, sin contar los encabezados <h2>/<h3> ni la referencia bibliográfica. Sus "body_paragraphs" contienen esos mismos párrafos.
- Cuando el insumo de una noticia es escaso (solo título, fuente y entradilla), alcanza el mínimo desarrollando el contexto institucional, el ámbito y el alcance de lo anunciado con los datos que sí figuran; nunca inventes cifras, nombres, fechas ni declaraciones.
- Cada "filled_markup" termina OBLIGATORIAMENTE con <hr /><h2>Referencia bibliográfica</h2><p class="notiweb-referencia">...</p>, con la referencia en formato APA 7 estricto según las reglas de "Referencia bibliografica". En las noticias secundarias, construye la referencia de página web con la fuente, la fecha y el título que figuran en el listado. Nunca la escribas como <p><strong>...</strong></p>.$rule$),
            ('VERIFICADOR_TITULOS_DEFAULT', 'RESPALDO DEL ENCABEZADO DEL PANEL', $old_rule$CONTRATO DE PANEL (VERIFICACIÓN DE TÍTULOS):
- Cada panel —el de la raíz y cada uno de "items"— conserva el encabezado de la PLANTILLA BASE tal cual: <h5 class="panel-title"> con su <a class="panel-toggle-link">. Nunca lo cambies por <h4> ni por otro nivel.
- Rellena SIEMPRE las tres ranuras del encabezado: el href de "a.panel-toggle-link" (igual al id de su "div.collapse"), ".panel-comite-codigo" con el código del comité y ".panel-facultad-nombre" con el centro o la facultad. Si el material no nombra la facultad, usa el nombre del centro o de la universidad tal como figure. Un panel con cualquiera de esas ranuras vacía se rechaza entero; esta obligación prevalece sobre la regla de dejar vacío un dato ausente, que sigue valiendo para el resto de celdas.
- Cardinalidad tolerante 1 a N: un panel por comité. Si el material trae un solo comité, va en la raíz y "items" es []; si trae varios, el primero en la raíz y uno por cada comité restante en "items", sin repetir el primero.$old_rule$, $rule$RESPALDO DEL ENCABEZADO DEL PANEL (VERIFICACIÓN DE TÍTULOS):
- Cada panel —el de la raíz y cada uno de "items"— conserva el encabezado de la PLANTILLA BASE tal cual: <h5 class="panel-title"> con su <a class="panel-toggle-link">. Nunca lo cambies por <h4> ni por otro nivel.
- Cuando el material trae un comité, <h5 class="panel-title"> y su <a class="panel-toggle-link"> NUNCA quedan vacíos de texto. Rellena SIEMPRE sus dos ranuras con estos respaldos:
  - ".panel-comite-codigo": el identificador del comité (ej. "UPM 1", "ESIC 1"). Si en el material no figura un número de comité, usa las siglas de la universidad (ej. "UPM").
  - ".panel-facultad-nombre": el nombre del centro o la facultad. Si no figura de forma explícita, usa la titulación principal evaluada y, en su defecto, el nombre de la universidad.
- El href de "a.panel-toggle-link" y el id de su "div.collapse" se derivan del valor final de ".panel-comite-codigo" (ej. "#collapseUPM1" e id="collapseUPM1") y deben coincidir exactamente.
- SIN DATOS, NO INVENTES: si el material no contiene NINGÚN comité, universidad ni titulación (por ejemplo, porque la tabla venía en una imagen que no se pudo leer), no fabriques ningún encabezado ni texto de relleno: deja el panel sin rellenar para que la validación posterior detenga la publicación.
- Cardinalidad tolerante 1 a N: un panel por comité. Si el material trae un solo comité, va en la raíz y "items" es []; si trae varios, el primero en la raíz y uno por cada comité restante en "items", sin repetir el primero.$rule$)
        ) AS t(codigo, marker, old_rule, rule_text)
    LOOP
        SELECT id_plantilla_prompt_ia, texto_prompt INTO inserted_id, previous_text
          FROM plantillas_prompts_ia WHERE codigo = rec.codigo;
        IF NOT FOUND OR position(rec.marker IN previous_text) > 0 THEN
            CONTINUE;
        END IF;

        patched := previous_text;
        IF rec.codigo = 'VERIFICADOR_TITULOS_DEFAULT' THEN
            patched := replace(patched,
                $old$- Devuelve unica y exclusivamente el marcado HTML inyectable resultante.$old$,
                $new$- En "filled_markup" devuelve unicamente el marcado HTML inyectable resultante, sin texto alrededor; el resto de claves del JSON se rellenan como se indica al final.$new$);
            patched := replace(patched,
                $old$- Si esas tablas vienen agrupadas por secciones o epigrafes, envuelve cada seccion en un panel: <div class="panel panel-default"> con el titulo en <div class="panel-heading"><h4 class="panel-title">...</h4></div> y el contenido en <div class="panel-body">. Respeta las clases exactamente como estan escritas aqui: son las que el portal sabe pintar y las que audita el nodo de validacion posterior.$old$,
                $new$- Si esas tablas vienen agrupadas por comites, cada comite es un panel independiente con la estructura EXACTA de la PLANTILLA BASE (<div class="panel panel-default">, encabezado <h5 class="panel-title"> y contenido en <div class="panel-body">). Respeta las clases exactamente como estan escritas en la plantilla: son las que el portal sabe pintar y las que audita el nodo de validacion posterior.$new$);
            -- La regla general de dejar vacio un dato ausente contradecia la
            -- obligacion de rellenar el encabezado: queda con su salvedad.
            patched := replace(patched,
                $old$- Un dato que no aparezca en el material se deja vacio. NUNCA lo estimes ni lo deduzcas.$old$,
                $new$- Un dato que no aparezca en el material se deja vacio. NUNCA lo estimes ni lo deduzcas. La unica salvedad son las dos ranuras del encabezado del panel, que siguen el RESPALDO DEL ENCABEZADO DEL PANEL.$new$);
        ELSE
            -- El cierre bibliografico es obligatorio: la vieja excepcion que
            -- permitia eliminarlo lo contradecia.
            patched := replace(patched,
                $old$- Elimina del marcado el <hr>, el encabezado <h2>Referencia bibliográfica</h2> y su parrafo SOLO si no hay estudio citado, ni articulo original, ni URL en la directiva del editor.$old$,
                $new$- No elimines nunca el cierre bibliografico (<hr>, <h2>Referencia bibliográfica</h2> y su parrafo): sin estudio citado ni articulo original, referencia la fuente que figura en el listado del correo.$new$);
        END IF;

        IF position(rec.old_rule IN patched) > 0 THEN
            patched := replace(patched, rec.old_rule, rec.rule_text);
        ELSIF patched ~ material_anchor THEN
            patched := regexp_replace(patched, material_anchor, E'\n\n' || rec.rule_text || E'\n\n\\1{{');
        ELSE
            patched := patched || E'\n\n' || rec.rule_text;
            RAISE WARNING '069: % no tiene una seccion de material reconocible; el bloque consolidado se anade al final.', rec.codigo;
        END IF;

        UPDATE plantillas_prompts_ia
           SET texto_prompt = patched, actualizado_por = admin_id, fecha_actualizacion = NOW()
         WHERE codigo = rec.codigo;
        summary := jsonb_set(summary, '{prompts_parcheados}', to_jsonb((summary->>'prompts_parcheados')::INT + 1));
        IF NOT (rec.codigo = ANY (created_prompts)) THEN
            INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_anteriores, datos_nuevos)
            VALUES (admin_id, 'ACTUALIZAR', 'plantillas_prompts_ia', inserted_id::TEXT,
                    jsonb_build_object('texto_prompt', previous_text),
                    seed_tag || jsonb_build_object('codigo', rec.codigo, 'parche', 'prompts_consolidados'));
        END IF;
    END LOOP;

    -- 6. Blueprints maestros -------------------------------------------------
    SELECT id_plantilla INTO template_notiweb FROM plantillas_html WHERE nombre = 'Notiweb · Noticia institucional';
    SELECT id_plantilla INTO template_abierta FROM plantillas_html WHERE nombre = 'Licitaciones · Convocatoria abierta (Madrid+D) V1';
    SELECT id_plantilla INTO template_titulos FROM plantillas_html WHERE nombre = 'Verificación de Títulos · Panel de evaluación';

    inserted_id := NULL;
    INSERT INTO plantillas_flujo (nombre, descripcion, activo, configuracion_pipeline, creado_por, actualizado_por)
    VALUES ('Maestro · Notiweb', '[wf-notiweb-madridmasd] Redaccion de una noticia institucional a partir del correo del editor y del articulo enlazado, con aprobacion humana antes de crearla en Drupal (CREATE_NODE, despublicada). Si el correo solo trae un escaneo, el parser desvia al OCR (ocr_ia), que se reincorpora en el extractor web; cualquier otro fallo avisa por correo (alerta_smtp).', TRUE,
            replace(replace(replace(
                $pipeline${
  "flowId": "wf-notiweb-madridmasd",
  "name": "Notiweb",
  "version": "1.0.0",
  "entrypoint": "disparador_imap",
  "nodes": {
    "disparador_imap": {
      "nodeId": "disparador_imap",
      "nodeType": "TRIGGER_IMAP",
      "outputNamespace": "raw_email",
      "nextStep": "parser",
      "onErrorStep": null,
      "params": {
        "mailbox": "INBOX",
        "includeAttachments": true
      }
    },
    "parser": {
      "nodeId": "parser",
      "nodeType": "PARSER_PRE_IA",
      "outputNamespace": "parsed_email",
      "nextStep": "extractor_web",
      "onErrorStep": {
        "targetNode": "ocr_ia",
        "catchErrors": [
          "ERR_PARSER_UNEXTRACTABLE_MEDIA"
        ]
      },
      "params": {
        "failOnUnextractableMedia": true
      }
    },
    "extractor_web": {
      "nodeId": "extractor_web",
      "nodeType": "EXTRACTOR_WEB",
      "outputNamespace": "scraped_web",
      "nextStep": "mapeador",
      "onErrorStep": "alerta_smtp",
      "params": {
        "targetUrl": "{{parsed_email.extracted_urls}}",
        "skipIfEmpty": true
      }
    },
    "mapeador": {
      "nodeId": "mapeador",
      "nodeType": "MAPEADOR_PLANTILLA",
      "outputNamespace": "rendered_html",
      "nextStep": "redaccion_ia",
      "onErrorStep": "alerta_smtp",
      "params": {
        "templateId": "__TPL_NOTIWEB__"
      }
    },
    "redaccion_ia": {
      "nodeId": "redaccion_ia",
      "nodeType": "PROCESADOR_IA",
      "outputNamespace": "llm_response",
      "nextStep": "escudo",
      "onErrorStep": "alerta_smtp",
      "params": {
        "promptCode": "NOTIWEB_DEFAULT",
        "outputCardinality": "MULTIPLE"
      }
    },
    "escudo": {
      "nodeId": "escudo",
      "nodeType": "ESCUDO_POST_IA",
      "outputNamespace": "validated_drupal_json",
      "nextStep": "aprobacion",
      "onErrorStep": "alerta_smtp",
      "params": {
        "contentMode": "HTML",
        "sourceNamespace": "llm_response",
        "sourceField": "filled_markup"
      }
    },
    "aprobacion": {
      "nodeId": "aprobacion",
      "nodeType": "PAUSA_FLOW",
      "outputNamespace": "pause_context",
      "nextStep": "destino_drupal",
      "onErrorStep": null,
      "params": {
        "pauseMode": "IMMEDIATE"
      }
    },
    "destino_drupal": {
      "nodeId": "destino_drupal",
      "nodeType": "DESTINO_DRUPAL",
      "outputNamespace": "http_result",
      "nextStep": "campana_acens",
      "onErrorStep": "alerta_smtp",
      "params": {
        "operationMode": "CREATE_NODE",
        "bundle": "node--noticias",
        "sourceNamespace": "validated_drupal_json",
        "sourceField": "validated_markup",
        "titleTemplate": "{{llm_response.headline}}",
        "summaryTemplate": "{{llm_response.summary}}",
        "publishStatus": false
      }
    },
    "campana_acens": {
      "nodeId": "campana_acens",
      "nodeType": "DESTINO_ACENS",
      "outputNamespace": "acens_result",
      "nextStep": null,
      "onErrorStep": "alerta_smtp",
      "params": {
        "operation": "CREATE_CAMPAIGN",
        "contentNamespace": "validated_drupal_json"
      }
    },
    "ocr_ia": {
      "nodeId": "ocr_ia",
      "nodeType": "PROCESADOR_OCR",
      "outputNamespace": "ocr_result",
      "nextStep": "extractor_web",
      "onErrorStep": "alerta_smtp",
      "params": {}
    },
    "alerta_smtp": {
      "nodeId": "alerta_smtp",
      "nodeType": "DESTINO_SMTP",
      "outputNamespace": "smtp_result",
      "nextStep": null,
      "onErrorStep": null,
      "params": {}
    }
  }
}$pipeline$,
                '__TPL_NOTIWEB__', template_notiweb::TEXT),
                '__TPL_ABIERTA__', template_abierta::TEXT),
                '__TPL_TITULOS__', template_titulos::TEXT)::JSONB,
            admin_id, admin_id)
    ON CONFLICT (nombre) DO NOTHING
    RETURNING id_plantilla_flujo INTO inserted_id;
    IF inserted_id IS NOT NULL THEN
        summary := jsonb_set(summary, '{blueprints}', to_jsonb((summary->>'blueprints')::INT + 1));
        INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_nuevos)
        VALUES (admin_id, 'CREAR', 'plantillas_flujo', inserted_id::TEXT, seed_tag || jsonb_build_object('slug', 'wf-notiweb-madridmasd', 'nombre', 'Maestro · Notiweb'));
    END IF;
    inserted_id := NULL;
    INSERT INTO plantillas_flujo (nombre, descripcion, activo, configuracion_pipeline, creado_por, actualizado_por)
    VALUES ('Maestro · Apertura de licitación', '[wf-licitacion-abrir] Alta de una convocatoria: el parser extrae los pliegos adjuntos, el mapeador entrega el bloque base, la IA lo rellena y el destino lo antepone en la pagina de convocatorias abiertas (APPEND_HTML_BLOCK).', TRUE,
            replace(replace(replace(
                $pipeline${
  "flowId": "wf-licitacion-abrir",
  "name": "Apertura de licitación",
  "version": "1.0.0",
  "entrypoint": "disparador_imap",
  "nodes": {
    "disparador_imap": {
      "nodeId": "disparador_imap",
      "nodeType": "TRIGGER_IMAP",
      "outputNamespace": "raw_email",
      "nextStep": "parser",
      "onErrorStep": null,
      "params": {
        "mailbox": "INBOX",
        "includeAttachments": true
      }
    },
    "parser": {
      "nodeId": "parser",
      "nodeType": "PARSER_PRE_IA",
      "outputNamespace": "parsed_email",
      "nextStep": "mapeador",
      "onErrorStep": {
        "targetNode": "ocr_ia",
        "catchErrors": [
          "ERR_PARSER_UNEXTRACTABLE_MEDIA"
        ]
      },
      "params": {
        "failOnUnextractableMedia": true
      }
    },
    "mapeador": {
      "nodeId": "mapeador",
      "nodeType": "MAPEADOR_PLANTILLA",
      "outputNamespace": "rendered_html",
      "nextStep": "extraccion_ia",
      "onErrorStep": "alerta_smtp",
      "params": {
        "templateId": "__TPL_ABIERTA__"
      }
    },
    "extraccion_ia": {
      "nodeId": "extraccion_ia",
      "nodeType": "PROCESADOR_IA",
      "outputNamespace": "llm_response",
      "nextStep": "escudo",
      "onErrorStep": "alerta_smtp",
      "params": {
        "promptCode": "LICITACION_APERTURA_DEFAULT",
        "outputCardinality": "MULTIPLE"
      }
    },
    "escudo": {
      "nodeId": "escudo",
      "nodeType": "ESCUDO_POST_IA",
      "outputNamespace": "validated_drupal_json",
      "nextStep": "destino_drupal",
      "onErrorStep": "alerta_smtp",
      "params": {
        "contentMode": "HTML",
        "sourceNamespace": "llm_response",
        "sourceField": "filled_markup",
        "requiredSelectors": [
          "h3.licitacion-title"
        ]
      }
    },
    "destino_drupal": {
      "nodeId": "destino_drupal",
      "nodeType": "DESTINO_DRUPAL",
      "outputNamespace": "http_result",
      "nextStep": null,
      "onErrorStep": "alerta_smtp",
      "params": {
        "operationMode": "APPEND_HTML_BLOCK",
        "bundle": "node--page",
        "sourceNamespace": "validated_drupal_json",
        "sourceField": "validated_markup",
        "containerSelector": "#collapse2 > .panel-body",
        "insertPosition": "PREPEND",
        "expedienteTemplate": "{{llm_response.headline}}"
      }
    },
    "ocr_ia": {
      "nodeId": "ocr_ia",
      "nodeType": "PROCESADOR_OCR",
      "outputNamespace": "ocr_result",
      "nextStep": "mapeador",
      "onErrorStep": "alerta_smtp",
      "params": {}
    },
    "alerta_smtp": {
      "nodeId": "alerta_smtp",
      "nodeType": "DESTINO_SMTP",
      "outputNamespace": "smtp_result",
      "nextStep": null,
      "onErrorStep": null,
      "params": {}
    }
  }
}$pipeline$,
                '__TPL_NOTIWEB__', template_notiweb::TEXT),
                '__TPL_ABIERTA__', template_abierta::TEXT),
                '__TPL_TITULOS__', template_titulos::TEXT)::JSONB,
            admin_id, admin_id)
    ON CONFLICT (nombre) DO NOTHING
    RETURNING id_plantilla_flujo INTO inserted_id;
    IF inserted_id IS NOT NULL THEN
        summary := jsonb_set(summary, '{blueprints}', to_jsonb((summary->>'blueprints')::INT + 1));
        INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_nuevos)
        VALUES (admin_id, 'CREAR', 'plantillas_flujo', inserted_id::TEXT, seed_tag || jsonb_build_object('slug', 'wf-licitacion-abrir', 'nombre', 'Maestro · Apertura de licitación'));
    END IF;
    inserted_id := NULL;
    INSERT INTO plantillas_flujo (nombre, descripcion, activo, configuracion_pipeline, creado_por, actualizado_por)
    VALUES ('Maestro · Cierre de licitación', '[wf-licitacion-cerrar] Cierre de una convocatoria sin mapeador de plantilla: la IA identifica el expediente, el escudo lo valida como texto y el destino traslada su bloque de la pagina de abiertas a la de cerradas (TRANSFER_HTML_BLOCK).', TRUE,
            replace(replace(replace(
                $pipeline${
  "flowId": "wf-licitacion-cerrar",
  "name": "Cierre de licitación",
  "version": "1.0.0",
  "entrypoint": "disparador_imap",
  "nodes": {
    "disparador_imap": {
      "nodeId": "disparador_imap",
      "nodeType": "TRIGGER_IMAP",
      "outputNamespace": "raw_email",
      "nextStep": "parser",
      "onErrorStep": null,
      "params": {
        "mailbox": "INBOX",
        "includeAttachments": true
      }
    },
    "parser": {
      "nodeId": "parser",
      "nodeType": "PARSER_PRE_IA",
      "outputNamespace": "parsed_email",
      "nextStep": "identificacion_ia",
      "onErrorStep": {
        "targetNode": "ocr_ia",
        "catchErrors": [
          "ERR_PARSER_UNEXTRACTABLE_MEDIA"
        ]
      },
      "params": {
        "failOnUnextractableMedia": true
      }
    },
    "identificacion_ia": {
      "nodeId": "identificacion_ia",
      "nodeType": "PROCESADOR_IA",
      "outputNamespace": "llm_response",
      "nextStep": "escudo",
      "onErrorStep": "alerta_smtp",
      "params": {
        "promptCode": "LICITACION_CIERRE_DEFAULT",
        "outputCardinality": "MULTIPLE"
      }
    },
    "escudo": {
      "nodeId": "escudo",
      "nodeType": "ESCUDO_POST_IA",
      "outputNamespace": "validated_drupal_json",
      "nextStep": "destino_drupal",
      "onErrorStep": "alerta_smtp",
      "params": {
        "contentMode": "TEXT",
        "sourceNamespace": "llm_response",
        "sourceFields": [
          "headline",
          "summary"
        ]
      }
    },
    "destino_drupal": {
      "nodeId": "destino_drupal",
      "nodeType": "DESTINO_DRUPAL",
      "outputNamespace": "http_result",
      "nextStep": null,
      "onErrorStep": "alerta_smtp",
      "params": {
        "operationMode": "TRANSFER_HTML_BLOCK",
        "bundle": "node--page",
        "itemSelector": "[data-expediente=\"{{validated_drupal_json.validated_fields.headline}}\"]",
        "targetContainerSelector": "#collapse2 > .panel-body",
        "insertPosition": "PREPEND"
      }
    },
    "ocr_ia": {
      "nodeId": "ocr_ia",
      "nodeType": "PROCESADOR_OCR",
      "outputNamespace": "ocr_result",
      "nextStep": "identificacion_ia",
      "onErrorStep": "alerta_smtp",
      "params": {}
    },
    "alerta_smtp": {
      "nodeId": "alerta_smtp",
      "nodeType": "DESTINO_SMTP",
      "outputNamespace": "smtp_result",
      "nextStep": null,
      "onErrorStep": null,
      "params": {}
    }
  }
}$pipeline$,
                '__TPL_NOTIWEB__', template_notiweb::TEXT),
                '__TPL_ABIERTA__', template_abierta::TEXT),
                '__TPL_TITULOS__', template_titulos::TEXT)::JSONB,
            admin_id, admin_id)
    ON CONFLICT (nombre) DO NOTHING
    RETURNING id_plantilla_flujo INTO inserted_id;
    IF inserted_id IS NOT NULL THEN
        summary := jsonb_set(summary, '{blueprints}', to_jsonb((summary->>'blueprints')::INT + 1));
        INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_nuevos)
        VALUES (admin_id, 'CREAR', 'plantillas_flujo', inserted_id::TEXT, seed_tag || jsonb_build_object('slug', 'wf-licitacion-cerrar', 'nombre', 'Maestro · Cierre de licitación'));
    END IF;
    inserted_id := NULL;
    INSERT INTO plantillas_flujo (nombre, descripcion, activo, configuracion_pipeline, creado_por, actualizado_por)
    VALUES ('Maestro · Innodays / Innobar', '[wf-innodays-sync] Actualizacion del enlace de una jornada sin mapeador de plantilla: la IA extrae el nombre del evento y la URL, el escudo los valida como texto y el destino cambia solo el href de esa fila (UPDATE_LINK_SOURCE). Para Innobar basta cambiar el prompt a INNOBAR_ENLACE_DEFAULT.', TRUE,
            replace(replace(replace(
                $pipeline${
  "flowId": "wf-innodays-sync",
  "name": "Innodays / Innobar",
  "version": "1.0.0",
  "entrypoint": "disparador_imap",
  "nodes": {
    "disparador_imap": {
      "nodeId": "disparador_imap",
      "nodeType": "TRIGGER_IMAP",
      "outputNamespace": "raw_email",
      "nextStep": "parser",
      "onErrorStep": null,
      "params": {
        "mailbox": "INBOX",
        "includeAttachments": true
      }
    },
    "parser": {
      "nodeId": "parser",
      "nodeType": "PARSER_PRE_IA",
      "outputNamespace": "parsed_email",
      "nextStep": "enlace_ia",
      "onErrorStep": {
        "targetNode": "ocr_ia",
        "catchErrors": [
          "ERR_PARSER_UNEXTRACTABLE_MEDIA"
        ]
      },
      "params": {
        "failOnUnextractableMedia": true
      }
    },
    "enlace_ia": {
      "nodeId": "enlace_ia",
      "nodeType": "PROCESADOR_IA",
      "outputNamespace": "llm_response",
      "nextStep": "escudo",
      "onErrorStep": "alerta_smtp",
      "params": {
        "promptCode": "INNODAYS_ENLACE_DEFAULT",
        "outputCardinality": "MULTIPLE"
      }
    },
    "escudo": {
      "nodeId": "escudo",
      "nodeType": "ESCUDO_POST_IA",
      "outputNamespace": "validated_drupal_json",
      "nextStep": "destino_drupal",
      "onErrorStep": "alerta_smtp",
      "params": {
        "contentMode": "TEXT",
        "sourceNamespace": "llm_response",
        "sourceFields": [
          "headline",
          "summary"
        ]
      }
    },
    "destino_drupal": {
      "nodeId": "destino_drupal",
      "nodeType": "DESTINO_DRUPAL",
      "outputNamespace": "http_result",
      "nextStep": null,
      "onErrorStep": "alerta_smtp",
      "params": {
        "operationMode": "UPDATE_LINK_SOURCE",
        "bundle": "node--page",
        "linkSelector": "table tr:contains('{{validated_drupal_json.validated_fields.headline}}') a",
        "linkAttribute": "href",
        "linkValueTemplate": "{{validated_drupal_json.validated_fields.summary}}"
      }
    },
    "ocr_ia": {
      "nodeId": "ocr_ia",
      "nodeType": "PROCESADOR_OCR",
      "outputNamespace": "ocr_result",
      "nextStep": "enlace_ia",
      "onErrorStep": "alerta_smtp",
      "params": {}
    },
    "alerta_smtp": {
      "nodeId": "alerta_smtp",
      "nodeType": "DESTINO_SMTP",
      "outputNamespace": "smtp_result",
      "nextStep": null,
      "onErrorStep": null,
      "params": {}
    }
  }
}$pipeline$,
                '__TPL_NOTIWEB__', template_notiweb::TEXT),
                '__TPL_ABIERTA__', template_abierta::TEXT),
                '__TPL_TITULOS__', template_titulos::TEXT)::JSONB,
            admin_id, admin_id)
    ON CONFLICT (nombre) DO NOTHING
    RETURNING id_plantilla_flujo INTO inserted_id;
    IF inserted_id IS NOT NULL THEN
        summary := jsonb_set(summary, '{blueprints}', to_jsonb((summary->>'blueprints')::INT + 1));
        INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_nuevos)
        VALUES (admin_id, 'CREAR', 'plantillas_flujo', inserted_id::TEXT, seed_tag || jsonb_build_object('slug', 'wf-innodays-sync', 'nombre', 'Maestro · Innodays / Innobar'));
    END IF;
    inserted_id := NULL;
    INSERT INTO plantillas_flujo (nombre, descripcion, activo, configuracion_pipeline, creado_por, actualizado_por)
    VALUES ('Maestro · Verificación de títulos', '[wf-titulos-verificacion] Panel de un comite de acreditacion: el parser lee la tabla del adjunto (.xlsx o .docx), el mapeador entrega el panel colapsable, la IA lo rellena y el destino lo inserta en el acordeon de la pagina de titulos (APPEND_HTML_BLOCK).', TRUE,
            replace(replace(replace(
                $pipeline${
  "flowId": "wf-titulos-verificacion",
  "name": "Verificación de títulos",
  "version": "1.0.0",
  "entrypoint": "disparador_imap",
  "nodes": {
    "disparador_imap": {
      "nodeId": "disparador_imap",
      "nodeType": "TRIGGER_IMAP",
      "outputNamespace": "raw_email",
      "nextStep": "parser",
      "onErrorStep": null,
      "params": {
        "mailbox": "INBOX",
        "includeAttachments": true
      }
    },
    "parser": {
      "nodeId": "parser",
      "nodeType": "PARSER_PRE_IA",
      "outputNamespace": "parsed_email",
      "nextStep": "mapeador",
      "onErrorStep": {
        "targetNode": "ocr_ia",
        "catchErrors": [
          "ERR_PARSER_UNEXTRACTABLE_MEDIA"
        ]
      },
      "params": {
        "failOnUnextractableMedia": true
      }
    },
    "mapeador": {
      "nodeId": "mapeador",
      "nodeType": "MAPEADOR_PLANTILLA",
      "outputNamespace": "rendered_html",
      "nextStep": "estructuracion_ia",
      "onErrorStep": "alerta_smtp",
      "params": {
        "templateId": "__TPL_TITULOS__"
      }
    },
    "estructuracion_ia": {
      "nodeId": "estructuracion_ia",
      "nodeType": "PROCESADOR_IA",
      "outputNamespace": "llm_response",
      "nextStep": "escudo",
      "onErrorStep": "alerta_smtp",
      "params": {
        "promptCode": "VERIFICADOR_TITULOS_DEFAULT",
        "outputCardinality": "MULTIPLE"
      }
    },
    "escudo": {
      "nodeId": "escudo",
      "nodeType": "ESCUDO_POST_IA",
      "outputNamespace": "validated_drupal_json",
      "nextStep": "destino_drupal",
      "onErrorStep": "alerta_smtp",
      "params": {
        "contentMode": "HTML",
        "sourceNamespace": "llm_response",
        "sourceField": "filled_markup",
        "requiredSelectors": [
          ".panel-title",
          ".panel-comite-codigo",
          ".panel-facultad-nombre"
        ]
      }
    },
    "destino_drupal": {
      "nodeId": "destino_drupal",
      "nodeType": "DESTINO_DRUPAL",
      "outputNamespace": "http_result",
      "nextStep": null,
      "onErrorStep": "alerta_smtp",
      "params": {
        "operationMode": "APPEND_HTML_BLOCK",
        "bundle": "node--page",
        "sourceNamespace": "validated_drupal_json",
        "sourceField": "validated_markup",
        "containerSelector": "#accordion",
        "itemSelector": ".panel-default",
        "insertPosition": "APPEND"
      }
    },
    "ocr_ia": {
      "nodeId": "ocr_ia",
      "nodeType": "PROCESADOR_OCR",
      "outputNamespace": "ocr_result",
      "nextStep": "mapeador",
      "onErrorStep": "alerta_smtp",
      "params": {}
    },
    "alerta_smtp": {
      "nodeId": "alerta_smtp",
      "nodeType": "DESTINO_SMTP",
      "outputNamespace": "smtp_result",
      "nextStep": null,
      "onErrorStep": null,
      "params": {}
    }
  }
}$pipeline$,
                '__TPL_NOTIWEB__', template_notiweb::TEXT),
                '__TPL_ABIERTA__', template_abierta::TEXT),
                '__TPL_TITULOS__', template_titulos::TEXT)::JSONB,
            admin_id, admin_id)
    ON CONFLICT (nombre) DO NOTHING
    RETURNING id_plantilla_flujo INTO inserted_id;
    IF inserted_id IS NOT NULL THEN
        summary := jsonb_set(summary, '{blueprints}', to_jsonb((summary->>'blueprints')::INT + 1));
        INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_nuevos)
        VALUES (admin_id, 'CREAR', 'plantillas_flujo', inserted_id::TEXT, seed_tag || jsonb_build_object('slug', 'wf-titulos-verificacion', 'nombre', 'Maestro · Verificación de títulos'));
    END IF;

    -- 6b. Ranura DOM obligatoria en el escudo del maestro de apertura -------
    UPDATE plantillas_flujo
       SET configuracion_pipeline = jsonb_set(configuracion_pipeline,
               '{nodes,escudo,params,requiredSelectors}', '["h3.licitacion-title"]'::JSONB),
           actualizado_por = admin_id,
           fecha_actualizacion = NOW()
     WHERE configuracion_pipeline->>'flowId' = 'wf-licitacion-abrir'
       AND configuracion_pipeline #> '{nodes,escudo,params}' IS NOT NULL
       AND NOT (configuracion_pipeline #> '{nodes,escudo,params}' ? 'requiredSelectors')
    RETURNING id_plantilla_flujo INTO inserted_id;
    IF FOUND THEN
        summary := jsonb_set(summary, '{blueprints_parcheados}', to_jsonb((summary->>'blueprints_parcheados')::INT + 1));
        INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_nuevos)
        VALUES (admin_id, 'ACTUALIZAR', 'plantillas_flujo', inserted_id::TEXT,
                seed_tag || jsonb_build_object('slug', 'wf-licitacion-abrir', 'requiredSelectors', '["h3.licitacion-title"]'::JSONB));
    END IF;

    -- 6c. Lote en los maestros existentes y campana de Acens en Notiweb -----
    FOR rec IN
        SELECT * FROM (VALUES
            ('wf-notiweb-madridmasd', 'redaccion_ia'),
            ('wf-licitacion-abrir', 'extraccion_ia'),
            ('wf-licitacion-cerrar', 'identificacion_ia'),
            ('wf-innodays-sync', 'enlace_ia'),
            ('wf-titulos-verificacion', 'estructuracion_ia')
        ) AS t(slug, ia_node)
    LOOP
        UPDATE plantillas_flujo
           SET configuracion_pipeline = jsonb_set(configuracion_pipeline,
                   ARRAY['nodes', rec.ia_node, 'params', 'outputCardinality'], '"MULTIPLE"'::JSONB),
               actualizado_por = admin_id,
               fecha_actualizacion = NOW()
         WHERE configuracion_pipeline->>'flowId' = rec.slug
           AND configuracion_pipeline #> ARRAY['nodes', rec.ia_node, 'params'] IS NOT NULL
           AND NOT (configuracion_pipeline #> ARRAY['nodes', rec.ia_node, 'params'] ? 'outputCardinality')
        RETURNING id_plantilla_flujo INTO inserted_id;
        IF FOUND THEN
            summary := jsonb_set(summary, '{blueprints_parcheados}', to_jsonb((summary->>'blueprints_parcheados')::INT + 1));
            INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_nuevos)
            VALUES (admin_id, 'ACTUALIZAR', 'plantillas_flujo', inserted_id::TEXT,
                    seed_tag || jsonb_build_object('slug', rec.slug, 'outputCardinality', 'MULTIPLE'));
        END IF;
    END LOOP;

    -- Solo si Drupal sigue siendo el ultimo paso: un maestro editado a mano
    -- que ya continua tras Drupal no se toca.
    UPDATE plantillas_flujo
       SET configuracion_pipeline = jsonb_set(
               jsonb_set(configuracion_pipeline, '{nodes,destino_drupal,nextStep}', '"campana_acens"'::JSONB),
               '{nodes,campana_acens}',
               '{"nodeId": "campana_acens", "nodeType": "DESTINO_ACENS", "outputNamespace": "acens_result", "nextStep": null, "onErrorStep": null, "params": {"operation": "CREATE_CAMPAIGN", "contentNamespace": "validated_drupal_json"}}'::JSONB),
           actualizado_por = admin_id,
           fecha_actualizacion = NOW()
     WHERE configuracion_pipeline->>'flowId' = 'wf-notiweb-madridmasd'
       AND NOT (configuracion_pipeline->'nodes' ? 'campana_acens')
       AND configuracion_pipeline #> '{nodes,destino_drupal}' IS NOT NULL
       AND jsonb_typeof(configuracion_pipeline #> '{nodes,destino_drupal,nextStep}') IS DISTINCT FROM 'string'
    RETURNING id_plantilla_flujo INTO inserted_id;
    IF FOUND THEN
        summary := jsonb_set(summary, '{blueprints_parcheados}', to_jsonb((summary->>'blueprints_parcheados')::INT + 1));
        INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_nuevos)
        VALUES (admin_id, 'ACTUALIZAR', 'plantillas_flujo', inserted_id::TEXT,
                seed_tag || jsonb_build_object('slug', 'wf-notiweb-madridmasd', 'nodo_anadido', 'campana_acens'));
    END IF;

    -- 6d. Contingencias en los cinco maestros: alerta SMTP y rescate OCR ----
    -- Un unico DESTINO_SMTP (`alerta_smtp`, regla 12) recibe el onErrorStep de
    -- cada nodo de procesamiento y destino. Con un GRAVE el motor pausa en el
    -- nodo que fallo tras avisar, asi que la reanudacion sigue funcionando. El
    -- parser desvia SOLO los escaneos (ERR_PARSER_UNEXTRACTABLE_MEDIA, con
    -- `failOnUnextractableMedia`, regla 10) al satelite `ocr_ia`, que se
    -- reincorpora en el paso nominal siguiente al parser. Marcador: el mapa de
    -- nodos ya tiene `alerta_smtp`.
    FOR rec IN
        SELECT id_plantilla_flujo, configuracion_pipeline
          FROM plantillas_flujo
         WHERE configuracion_pipeline->>'flowId' IN (
               'wf-notiweb-madridmasd', 'wf-licitacion-abrir', 'wf-licitacion-cerrar',
               'wf-innodays-sync', 'wf-titulos-verificacion')
           AND NOT (configuracion_pipeline->'nodes' ? 'alerta_smtp')
    LOOP
        pipeline := rec.configuracion_pipeline;

        SELECT n.key INTO parser_key
          FROM jsonb_each(pipeline->'nodes') n
         WHERE n.value->>'nodeType' = 'PARSER_PRE_IA'
         ORDER BY n.key
         LIMIT 1;
        IF parser_key IS NULL THEN
            RAISE WARNING '069: el maestro % no tiene parser; se omiten sus contingencias.', pipeline->>'flowId';
            CONTINUE;
        END IF;

        -- Notiweb ya traia el satelite como `ocr`: se renombra.
        IF (pipeline->'nodes' ? 'ocr') AND NOT (pipeline->'nodes' ? 'ocr_ia') THEN
            pipeline := jsonb_set(pipeline, '{nodes}',
                ((pipeline->'nodes') - 'ocr')
                || jsonb_build_object('ocr_ia', (pipeline #> '{nodes,ocr}') || '{"nodeId": "ocr_ia"}'::JSONB));
        END IF;

        IF NOT (pipeline->'nodes' ? 'ocr_ia') THEN
            pipeline := jsonb_set(pipeline, '{nodes,ocr_ia}', jsonb_build_object(
                'nodeId', 'ocr_ia',
                'nodeType', 'PROCESADOR_OCR',
                'outputNamespace', 'ocr_result',
                'nextStep', pipeline #> ARRAY['nodes', parser_key, 'nextStep'],
                'onErrorStep', NULL,
                'params', '{}'::JSONB));
        END IF;

        pipeline := jsonb_set(pipeline, ARRAY['nodes', parser_key, 'onErrorStep'],
            '{"targetNode": "ocr_ia", "catchErrors": ["ERR_PARSER_UNEXTRACTABLE_MEDIA"]}'::JSONB);
        pipeline := jsonb_set(pipeline, ARRAY['nodes', parser_key, 'params'],
            COALESCE(pipeline #> ARRAY['nodes', parser_key, 'params'], '{}'::JSONB)
            || '{"failOnUnextractableMedia": true}'::JSONB);

        FOR node_key IN
            SELECT n.key
              FROM jsonb_each(pipeline->'nodes') n
             WHERE n.value->>'nodeType' IN ('EXTRACTOR_WEB', 'MAPEADOR_PLANTILLA', 'PROCESADOR_IA',
                                            'ESCUDO_POST_IA', 'DESTINO_DRUPAL', 'DESTINO_ACENS',
                                            'PROCESADOR_OCR')
               AND jsonb_typeof(n.value->'onErrorStep') IS DISTINCT FROM 'string'
               AND jsonb_typeof(n.value->'onErrorStep') IS DISTINCT FROM 'object'
        LOOP
            pipeline := jsonb_set(pipeline, ARRAY['nodes', node_key, 'onErrorStep'], '"alerta_smtp"'::JSONB);
        END LOOP;

        pipeline := jsonb_set(pipeline, '{nodes,alerta_smtp}',
            '{"nodeId": "alerta_smtp", "nodeType": "DESTINO_SMTP", "outputNamespace": "smtp_result", "nextStep": null, "onErrorStep": null, "params": {}}'::JSONB);

        UPDATE plantillas_flujo
           SET configuracion_pipeline = pipeline, actualizado_por = admin_id, fecha_actualizacion = NOW()
         WHERE id_plantilla_flujo = rec.id_plantilla_flujo;
        summary := jsonb_set(summary, '{blueprints_parcheados}', to_jsonb((summary->>'blueprints_parcheados')::INT + 1));
        INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_anteriores, datos_nuevos)
        VALUES (admin_id, 'ACTUALIZAR', 'plantillas_flujo', rec.id_plantilla_flujo::TEXT,
                jsonb_build_object('configuracion_pipeline', rec.configuracion_pipeline),
                seed_tag || jsonb_build_object('slug', pipeline->>'flowId', 'parche', 'contingencias_ocr_smtp'));
    END LOOP;

    -- 6e. Encabezado del panel obligatorio en el maestro de titulos --------
    -- Con estos selectores la auditoria `empty` del escudo rechaza
    -- (ERR_POST_IA_DOM_MUTATED) un panel con el h5.panel-title sin rellenar.
    UPDATE plantillas_flujo
       SET configuracion_pipeline = jsonb_set(configuracion_pipeline,
               '{nodes,escudo,params,requiredSelectors}',
               '[".panel-title", ".panel-comite-codigo", ".panel-facultad-nombre"]'::JSONB),
           actualizado_por = admin_id,
           fecha_actualizacion = NOW()
     WHERE configuracion_pipeline->>'flowId' = 'wf-titulos-verificacion'
       AND configuracion_pipeline #> '{nodes,escudo,params}' IS NOT NULL
       AND NOT (configuracion_pipeline #> '{nodes,escudo,params}' ? 'requiredSelectors')
    RETURNING id_plantilla_flujo INTO inserted_id;
    IF FOUND THEN
        summary := jsonb_set(summary, '{blueprints_parcheados}', to_jsonb((summary->>'blueprints_parcheados')::INT + 1));
        INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_nuevos)
        VALUES (admin_id, 'ACTUALIZAR', 'plantillas_flujo', inserted_id::TEXT,
                seed_tag || jsonb_build_object('slug', 'wf-titulos-verificacion',
                    'requiredSelectors', '[".panel-title", ".panel-comite-codigo", ".panel-facultad-nombre"]'::JSONB));
    END IF;

    -- 6f. Reparacion del atajo "Estructura completa" del escudo ------------
    -- El asistente escribia un `allowedTags` sin h2, b, i, u, ol, br, thead ni
    -- tbody, y el escudo borraba los encabezados de seccion y la cabecera
    -- "Referencia bibliografica". Solo se tocan las listas IDENTICAS a ese
    -- atajo (comparadas como conjunto): una lista escrita a mano es una
    -- decision del operador y se respeta.
    FOR rec IN
        SELECT f.id_flujo AS id, 'flujos' AS tabla, n.key AS escudo_key, f.configuracion_pipeline
          FROM flujos f, jsonb_each(f.configuracion_pipeline->'nodes') n
         WHERE n.value->>'nodeType' = 'ESCUDO_POST_IA'
           AND jsonb_typeof(n.value #> '{params,allowedTags}') = 'array'
           AND ARRAY(SELECT DISTINCT t FROM jsonb_array_elements_text(n.value #> '{params,allowedTags}') t ORDER BY t) = old_full_structure
        UNION ALL
        SELECT p.id_plantilla_flujo, 'plantillas_flujo', n.key, p.configuracion_pipeline
          FROM plantillas_flujo p, jsonb_each(p.configuracion_pipeline->'nodes') n
         WHERE n.value->>'nodeType' = 'ESCUDO_POST_IA'
           AND jsonb_typeof(n.value #> '{params,allowedTags}') = 'array'
           AND ARRAY(SELECT DISTINCT t FROM jsonb_array_elements_text(n.value #> '{params,allowedTags}') t ORDER BY t) = old_full_structure
    LOOP
        IF rec.tabla = 'flujos' THEN
            UPDATE flujos
               SET configuracion_pipeline = jsonb_set(configuracion_pipeline,
                       ARRAY['nodes', rec.escudo_key, 'params', 'allowedTags'], canonical_tags),
                   actualizado_por = admin_id,
                   fecha_actualizacion = NOW()
             WHERE id_flujo = rec.id;
        ELSE
            UPDATE plantillas_flujo
               SET configuracion_pipeline = jsonb_set(configuracion_pipeline,
                       ARRAY['nodes', rec.escudo_key, 'params', 'allowedTags'], canonical_tags),
                   actualizado_por = admin_id,
                   fecha_actualizacion = NOW()
             WHERE id_plantilla_flujo = rec.id;
        END IF;
        summary := jsonb_set(summary, '{flujos_reparados}', to_jsonb((summary->>'flujos_reparados')::INT + 1));
        INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_anteriores, datos_nuevos)
        VALUES (admin_id, 'ACTUALIZAR', rec.tabla, rec.id::TEXT,
                jsonb_build_object('allowedTags', rec.configuracion_pipeline #> ARRAY['nodes', rec.escudo_key, 'params', 'allowedTags']),
                seed_tag || jsonb_build_object('nodo', rec.escudo_key, 'parche', 'escudo_lista_canonica', 'allowedTags', canonical_tags));
    END LOOP;

    -- 7. Resumen de la siembra ----------------------------------------------
    -- Solo si se creo algo: una reejecucion no deja rastro nuevo.
    IF (summary->>'nodos')::INT + (summary->>'tarifas')::INT + (summary->>'plantillas_html')::INT
       + (summary->>'prompts')::INT + (summary->>'blueprints')::INT
       + (summary->>'prompts_parcheados')::INT + (summary->>'blueprints_parcheados')::INT
       + (summary->>'nodos_parcheados')::INT + (summary->>'flujos_reparados')::INT > 0 THEN
        INSERT INTO audit_eventos (usuario_id, accion, tabla_afectada, registro_id, datos_nuevos)
        VALUES (admin_id, 'CREAR', 'plantillas_flujo', NULL, seed_tag || jsonb_build_object('resumen', summary));
    END IF;

    RAISE NOTICE '069: ecosistema maestro sembrado: %', summary;
END $migration$;

COMMIT;

-- =============================================================================
-- Comprobacion del resultado.
-- =============================================================================

SELECT nombre, configuracion_pipeline->>'flowId' AS slug
  FROM plantillas_flujo
 WHERE configuracion_pipeline->>'flowId' IN (
       'wf-notiweb-madridmasd', 'wf-licitacion-abrir', 'wf-licitacion-cerrar',
       'wf-innodays-sync', 'wf-titulos-verificacion')
 ORDER BY nombre;
