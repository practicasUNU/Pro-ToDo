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
-- Tabla: TIPOS_NODO
-- =============================================================================

CREATE TABLE tipos_nodo (
    id_tipo_nodo UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    codigo VARCHAR(50) NOT NULL UNIQUE,
    nombre VARCHAR(100) NOT NULL,
    categoria enum_categoria NOT NULL,
    descripcion VARCHAR(255)
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
-- Tabla: FLUJOS
-- =============================================================================

CREATE TABLE flujos (
    id_flujo UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    nombre VARCHAR(100) NOT NULL,
    descripcion VARCHAR(255),
    activo BOOLEAN DEFAULT TRUE,
    configuracion_pipeline JSONB,
    id_usuario_creador UUID NOT NULL REFERENCES usuarios(id_usuario),
    fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =============================================================================
-- Tabla: NODOS
-- =============================================================================

CREATE TABLE nodos (
    id_nodo UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    id_flujo UUID NOT NULL REFERENCES flujos(id_flujo) ON DELETE CASCADE,
    id_tipo_nodo UUID NOT NULL REFERENCES tipos_nodo(id_tipo_nodo),
    id_plantilla UUID REFERENCES plantillas_html(id_plantilla) ON DELETE SET NULL,
    orden_paso SMALLINT NOT NULL,
    nombre VARCHAR(100) NOT NULL,
    configuracion_parametros JSONB
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
    fecha_inicio TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    fecha_actualizacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    fecha_fin TIMESTAMP
);

-- =============================================================================
-- Tabla: LOGS_NODO
-- =============================================================================

CREATE TABLE logs_nodo (
    id_log_nodo UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    id_ejecucion UUID NOT NULL REFERENCES ejecuciones_flujo(id_ejecucion) ON DELETE CASCADE,
    id_nodo UUID NOT NULL REFERENCES nodos(id_nodo) ON DELETE CASCADE,
    estado_nodo enum_estado_nodo NOT NULL,
    codigo_respuesta_http SMALLINT,
    tiempo_ejecucion_ms INTEGER,
    ruta_archivo_log VARCHAR(255),
    fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
CREATE INDEX idx_nodos_id_flujo ON nodos(id_flujo);
CREATE INDEX idx_nodos_id_tipo_nodo ON nodos(id_tipo_nodo);
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
INSERT INTO tipos_nodo (codigo, nombre, categoria, descripcion) VALUES
    ('TRIGGER_IMAP', 'Disparador IMAP', 'TRIGGER', 'Inicia el flujo mediante la lectura de correos entrantes'),
    ('PARSER_PRE_IA', 'Parser Pre-IA', 'PROCESAMIENTO', 'Decodifica el contenido MIME y sanitiza el texto antes de llamar al modelo'),
    ('EXTRACTOR_WEB', 'Extractor Web', 'PROCESAMIENTO', 'Extrae y sanitiza contenido desde una pagina web'),
    ('PROCESADOR_IA', 'Procesador de IA', 'PROCESAMIENTO', 'Ejecuta inferencia mediante un modelo de lenguaje'),
    ('ESCUDO_POST_IA', 'Escudo Post-IA', 'CONTROL', 'Valida la salida del modelo contra el esquema esperado antes de propagarla'),
    ('MAPEADOR_PLANTILLA', 'Mapeador de Plantilla', 'PROCESAMIENTO', 'Interpola variables dinamicas sobre una plantilla HTML'),
    ('DESTINO_HTTP', 'Destino HTTP', 'DESTINO', 'Publica el resultado final mediante una peticion HTTP (Drupal JSON:API u otro)'),
    ('TRIGGER_CRON', 'Disparador Cron', 'TRIGGER', 'Inicia el flujo mediante una programacion temporal'),
    ('DESTINO_ACENS', 'Destino Acens', 'DESTINO', 'Realiza el envio masivo a traves de Acens');
