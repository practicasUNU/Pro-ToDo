-- =============================================================================
-- Proto-Do: Esquema inicial de base de datos (PostgreSQL 16)
-- Generado a partir del diagrama Entidad-Relación del proyecto.
-- =============================================================================

SET client_encoding = 'UTF8';

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================================================
-- Tipos ENUM
-- =============================================================================

CREATE TYPE enum_categoria AS ENUM ('TRIGGER', 'PROCESAMIENTO', 'CONTROL', 'DESTINO');

CREATE TYPE enum_estado AS ENUM ('INACTIVO', 'EN_PROCESO', 'EXITOSO', 'FALLIDO', 'PAUSADO');

CREATE TYPE enum_estado_nodo AS ENUM ('OK', 'ERROR', 'ADVERTENCIA');

CREATE TYPE enum_nivel_error AS ENUM ('URGENTE', 'GRAVE', 'LEVE');

CREATE TYPE enum_rol_usuario AS ENUM ('ADMIN', 'EDITOR');

-- =============================================================================
-- Tabla: USUARIOS
-- =============================================================================

CREATE TABLE usuarios (
    id_usuario UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    correo VARCHAR(255) NOT NULL UNIQUE,
    rol enum_rol_usuario NOT NULL,
    -- Secreto TOTP por cuenta. Nullable: la inscripción es perezosa, se genera
    -- la primera vez que el usuario pide un código (ver migración 003).
    secreto_otp VARCHAR(64),
    activo BOOLEAN DEFAULT TRUE,
    fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =============================================================================
-- Tabla: NODOS (catálogo estático)
-- Duplicada en db/migrations/011-catalogo-nodos.sql para las bases de datos ya
-- creadas: este archivo solo se ejecuta con el volumen de Docker vacío.
--
-- Es el catálogo de tipos de nodo que el motor sabe ejecutar, NO una tabla de
-- instancias: la secuencia de pasos de cada flujo vive íntegra en
-- `flujos.configuracion_pipeline` (JSONB). La tabla de instancias que antes
-- ocupaba este nombre se eliminó en la migración 011 por describir lo mismo.
--
-- `ui_schema` describe el formulario que el frontend pinta para configurar los
-- `params` de este tipo de nodo. NOT NULL con default '{}' para que el
-- consumidor no tenga que distinguir "sin descriptor" de "nulo".
--
-- Las restricciones se nombran a mano con el nombre de la columna, sin prefijos
-- (`id_nodo`, no `pk_nodos`): es la convencion del proyecto, y ademas garantiza
-- que un clonado nuevo desde este archivo y una base migrada con la 011 tengan
-- exactamente los mismos nombres.
--
-- La UNIQUE se llama `nodos_codigo` y no `codigo` a secas por una restriccion de
-- PostgreSQL: una UNIQUE (y una PRIMARY KEY) crea un indice homonimo, y los
-- indices comparten un unico espacio de nombres por esquema. `codigo` es una
-- columna que existe en varias tablas, asi que reservar ese nombre de indice
-- para `nodos` bloquearia a la siguiente que lo necesitara.
-- =============================================================================

CREATE TABLE nodos (
    id_nodo UUID DEFAULT uuid_generate_v4(),
    codigo VARCHAR(50) NOT NULL,
    nombre VARCHAR(100) NOT NULL,
    categoria enum_categoria NOT NULL,
    descripcion VARCHAR(255),
    ui_schema JSONB NOT NULL DEFAULT '{}',
    CONSTRAINT id_nodo PRIMARY KEY (id_nodo),
    CONSTRAINT nodos_codigo UNIQUE (codigo)
);

-- =============================================================================
-- Tabla: PLANTILLAS_HTML
-- =============================================================================

CREATE TABLE plantillas_html (
    id_plantilla UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    nombre VARCHAR(120) NOT NULL,
    descripcion VARCHAR(255),
    contenido_html TEXT NOT NULL,

    -- Rutas "namespace.campo" detectadas en el HTML. El servicio las recalcula
    -- en cada escritura, asi que nunca es nula: un NULL significaria "nunca se
    -- valido", estado que el gestor no permite alcanzar.
    variables_esperadas JSONB NOT NULL DEFAULT '[]'::jsonb,

    -- Poblado desde el JWT (`@CurrentUser()`), no desde el DTO: el cliente no
    -- puede falsificar la autoria.
    id_usuario_creador UUID NOT NULL REFERENCES usuarios(id_usuario),

    -- Borrado logico: una plantilla retirada se conserva para no romper la
    -- trazabilidad de las ejecuciones que la usaron.
    activo BOOLEAN NOT NULL DEFAULT TRUE,

    fecha_creacion TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    fecha_actualizacion TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- =============================================================================
-- Tabla: PLANTILLAS_FLUJO (blueprints maestros)
-- Duplicada en db/migrations/010-plantillas-flujo.sql para las bases de datos ya
-- creadas: este archivo solo se ejecuta con el volumen de Docker vacío.
--
-- Catálogo de topologías base. No se ejecuta nunca: no tiene estado, ni autor,
-- ni ejecuciones. `flujos` instancia una de estas y guarda el vínculo en
-- `id_plantilla_origen`. Va declarada ANTES de `flujos` porque su clave ajena la
-- referencia.
-- =============================================================================

CREATE TABLE plantillas_flujo (
    id_plantilla_flujo UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    -- El nombre es lo que el operador reconoce en el selector del asistente:
    -- dos maestros homónimos serían indistinguibles ahí
    nombre VARCHAR(100) NOT NULL UNIQUE,
    -- TEXT y no VARCHAR(255): describe la topología entera
    descripcion TEXT,
    -- Borrado lógico: una plantilla retirada sale del selector pero sigue
    -- explicando de dónde salieron los flujos que la instanciaron
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    -- Mismo nombre que en `flujos` porque es el mismo grafo declarativo. Aquí
    -- NOT NULL: una plantilla sin topología no es una plantilla
    configuracion_pipeline JSONB NOT NULL,
    fecha_creacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- =============================================================================
-- Tabla: FLUJOS
-- =============================================================================

CREATE TABLE flujos (
    id_flujo UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    nombre VARCHAR(100) NOT NULL,
    descripcion VARCHAR(255),
    activo BOOLEAN DEFAULT TRUE,
    configuracion_pipeline JSONB,
    -- Maestro del que nació este flujo. Nullable: los flujos anteriores a la
    -- migración 010 no vienen de ninguno, y el asistente debe poder crear uno
    -- desde cero. ON DELETE SET NULL es la red de seguridad ante un borrado
    -- físico por SQL directo; la vía prevista es el borrado lógico (`activo`)
    id_plantilla_origen UUID REFERENCES plantillas_flujo(id_plantilla_flujo) ON DELETE SET NULL,
    id_usuario_creador UUID NOT NULL REFERENCES usuarios(id_usuario),
    fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =============================================================================
-- Tabla: EJECUCIONES_FLUJO
-- =============================================================================

CREATE TABLE ejecuciones_flujo (
    id_ejecucion UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    id_flujo UUID NOT NULL REFERENCES flujos(id_flujo) ON DELETE CASCADE,
    estado enum_estado NOT NULL DEFAULT 'INACTIVO',
    paso_actual VARCHAR(50),
    contexto_acumulado JSONB NOT NULL DEFAULT '{}'::jsonb,
    retry_state JSONB NOT NULL DEFAULT '{}'::jsonb,
    ruta_archivo_log VARCHAR(255),
    -- Motivo legible cuando el fallo NO lo explica un volcado forense: lo
    -- decide un operador, no un nodo (ver db/migrations/012).
    motivo_fallo VARCHAR(255),
    fecha_inicio TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    fecha_actualizacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    fecha_fin TIMESTAMP
);

-- =============================================================================
-- Tabla: LOGS_NODO
--
-- Restricciones nombradas con el nombre de la columna, sin prefijos, igual que
-- en `nodos`.
-- =============================================================================

CREATE TABLE logs_nodo (
    id_log_nodo UUID DEFAULT uuid_generate_v4(),
    id_ejecucion UUID NOT NULL,
    -- `nodeId` del `configuracion_pipeline`, NO una clave ajena y por eso sin
    -- `REFERENCES`: el nodo es un objeto del JSONB, y `nodos` es el catálogo de
    -- TIPOS, no una tabla de instancias donde buscar esta fila. Antes de la
    -- migración 011 este par de nombres sí era una clave ajena; ya no lo es.
    --
    -- VARCHAR(50) es el límite que ya impone `PipelineNodeConfigDto.nodeId`.
    -- Nullable porque un fallo puede ocurrir antes de que el motor resuelva en
    -- qué nodo estaba.
    id_nodo VARCHAR(50),
    estado_nodo enum_estado_nodo NOT NULL,
    codigo_respuesta_http SMALLINT,
    tiempo_ejecucion_ms INTEGER,
    ruta_archivo_log VARCHAR(255),
    fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT id_log_nodo PRIMARY KEY (id_log_nodo),
    CONSTRAINT id_ejecucion FOREIGN KEY (id_ejecucion)
        REFERENCES ejecuciones_flujo(id_ejecucion) ON DELETE CASCADE
);

-- =============================================================================
-- Tabla: ALERTAS_ERROR
-- =============================================================================

CREATE TABLE alertas_error (
    id_alerta_error UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    id_ejecucion UUID NOT NULL REFERENCES ejecuciones_flujo(id_ejecucion) ON DELETE CASCADE,
    nivel enum_nivel_error NOT NULL,
    modulo_origen VARCHAR(100),
    mensaje_error TEXT,
    resuelto BOOLEAN DEFAULT FALSE,
    fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =============================================================================
-- Tabla: TOKENS_SESION (PROT-06.4)
-- Duplicada en db/migrations/001-refresh-tokens.sql (004 para la columna
-- id_dispositivo y 009 para el renombrado desde `refresh_tokens`) para las
-- bases de datos ya creadas: este archivo solo se ejecuta con el volumen de
-- Docker vacío.
--
-- Las constraints (PK, UNIQUE de hash_token y FK a usuarios) no se nombran
-- aquí: PostgreSQL las deriva del nombre de la tabla, así que un clonado nuevo
-- obtiene `tokens_sesion_pkey`, `tokens_sesion_hash_token_key` y
-- `tokens_sesion_id_usuario_fkey` sin declararlas. Por eso la migración 009
-- tiene que renombrarlas a mano en las bases ya existentes: un `RENAME TO` de
-- la tabla no las arrastra, y sin ese paso una base migrada divergiría de un
-- clonado nuevo.
-- =============================================================================

CREATE TABLE tokens_sesion (
    id_token_sesion UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    id_usuario UUID NOT NULL REFERENCES usuarios(id_usuario) ON DELETE CASCADE,
    -- Dispositivo/navegador que abrió la sesión, generado por el cliente. Agrupa
    -- los tokens por origen para revocar solo la sesión anterior de ese equipo
    id_dispositivo UUID NOT NULL,
    -- SHA-256 hexadecimal del token opaco; el valor en claro nunca se persiste
    hash_token CHAR(64) NOT NULL UNIQUE,
    expiracion TIMESTAMP NOT NULL,
    -- Se marca en vez de borrarse: reaparecer revocado delata un robo
    revocado BOOLEAN NOT NULL DEFAULT FALSE,
    fecha_creacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- =============================================================================
-- Tabla: ALLOWED_IPS (PROT-05: perímetro de red dinámico)
-- Duplicada en db/migrations/007-allowed-ips.sql para las bases de datos ya
-- creadas: este archivo solo se ejecuta con el volumen de Docker vacío.
-- =============================================================================

CREATE TABLE allowed_ips (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ip_o_cidr VARCHAR(64) NOT NULL UNIQUE,
    descripcion VARCHAR(255) NOT NULL,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- =============================================================================
-- Índices de apoyo para claves foráneas de alta consulta
-- =============================================================================

CREATE INDEX idx_tokens_sesion_id_usuario ON tokens_sesion(id_usuario);
CREATE INDEX idx_plantillas_html_id_usuario_creador ON plantillas_html(id_usuario_creador);
CREATE UNIQUE INDEX idx_plantillas_html_nombre ON plantillas_html(nombre);
CREATE INDEX idx_flujos_id_usuario_creador ON flujos(id_usuario_creador);
-- Responde "qué flujos salieron de esta plantilla", la consulta obligada antes
-- de retirar un maestro
CREATE INDEX idx_flujos_id_plantilla_origen ON flujos(id_plantilla_origen);
CREATE INDEX idx_ejecuciones_flujo_id_flujo ON ejecuciones_flujo(id_flujo);

-- Mutex de ejecucion (PROT-08): indice unico PARCIAL. Solo aplica mientras la
-- ejecucion esta EN_PROCESO, asi que un flujo no puede tener dos vivas a la vez
-- pero si todo el historico que haga falta en estados terminales.
CREATE UNIQUE INDEX idx_flujo_activo
    ON ejecuciones_flujo (id_flujo)
 WHERE estado = 'EN_PROCESO';
CREATE INDEX idx_logs_nodo_id_ejecucion ON logs_nodo(id_ejecucion);
CREATE INDEX idx_logs_nodo_id_nodo ON logs_nodo(id_nodo);
CREATE INDEX idx_alertas_error_id_ejecucion ON alertas_error(id_ejecucion);

-- =============================================================================
-- SEED: Datos iniciales
-- =============================================================================

-- Los 7 primeros codigos replican el enum `NodeType` del backend
-- (`@core/fsm/types/pipeline-schema.types`): son los unicos que un
-- `pipeline_schema` puede declarar hoy. `TRIGGER_CRON` y `DESTINO_ACENS` siguen
-- en el catalogo a la espera de su estrategia; hasta entonces no son
-- referenciables desde `flujos.configuracion_pipeline` (ver migracion 005).
INSERT INTO nodos (codigo, nombre, categoria, descripcion) VALUES
    ('TRIGGER_IMAP', 'Disparador IMAP', 'TRIGGER', 'Inicia el flujo mediante la lectura de correos entrantes'),
    ('PARSER_PRE_IA', 'Parser Pre-IA', 'PROCESAMIENTO', 'Decodifica el contenido MIME y sanitiza el texto antes de llamar al modelo'),
    ('EXTRACTOR_WEB', 'Extractor Web', 'PROCESAMIENTO', 'Extrae y sanitiza contenido desde una pagina web'),
    ('PROCESADOR_IA', 'Procesador de IA', 'PROCESAMIENTO', 'Ejecuta inferencia mediante un modelo de lenguaje'),
    ('ESCUDO_POST_IA', 'Escudo Post-IA', 'CONTROL', 'Valida la salida del modelo contra el esquema esperado antes de propagarla'),
    ('MAPEADOR_PLANTILLA', 'Mapeador de Plantilla', 'PROCESAMIENTO', 'Interpola variables dinamicas sobre una plantilla HTML'),
    ('DESTINO_HTTP', 'Destino HTTP', 'DESTINO', 'Publica el resultado final mediante una peticion HTTP (Drupal JSON:API u otro)'),
    ('TRIGGER_CRON', 'Disparador Cron', 'TRIGGER', 'Inicia el flujo mediante una programacion temporal'),
    ('DESTINO_ACENS', 'Destino Acens', 'DESTINO', 'Realiza el envio masivo a traves de Acens');
