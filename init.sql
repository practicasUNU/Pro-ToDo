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

-- `INACTIVO` lo incorporo la migracion 006, `OMITIDO` la 030 y `DESCARTADO` la
-- 039; los tres se adelantan aqui para que una base nueva nazca completa (las
-- migraciones son idempotentes y no vuelven a anadirlos).
CREATE TYPE enum_estado AS ENUM ('INACTIVO', 'EN_PROCESO', 'EXITOSO', 'OMITIDO', 'FALLIDO', 'PAUSADO', 'DESCARTADO');

-- Estado del FLUJO (migracion 040), que es otra cosa que el de la ejecucion:
-- responde a "se puede disparar", no a "como acabo". `PAUSADO` lo escribe solo
-- el motor al detener una ejecucion reanudable; la API de edicion admite
-- unicamente ACTIVO e INACTIVO.
CREATE TYPE workflow_status_enum AS ENUM ('ACTIVO', 'INACTIVO', 'PAUSADO');

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
    -- Generacion de los tokens de la cuenta (migracion 051): `JwtStrategy` la
    -- compara con el claim `tokenVersion` en cada peticion, y subirla revoca
    -- en el acto todas las sesiones vivas de esa persona.
    token_version INTEGER NOT NULL DEFAULT 0,
    -- Auditoria comun (`AuditableEntity`, migracion 045). Nullable: las filas
    -- historicas no tienen autor conocido y un usuario borrado no arrastra lo
    -- que toco.
    creado_por UUID REFERENCES usuarios(id_usuario) ON DELETE SET NULL,
    actualizado_por UUID REFERENCES usuarios(id_usuario) ON DELETE SET NULL,
    fecha_creacion TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    fecha_actualizacion TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
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
-- NO hay columna para el formulario del frontend. La `ui_schema` que la
-- migracion 011 introdujo se retiro en la 020: el formulario de cada tipo de
-- nodo lo resuelve el frontend con componentes tipados via
-- `node-config-registry.ts`, y los contratos de salida viven en `outputFields`
-- de la `INodeStrategy` correspondiente. Un descriptor jsonb paralelo solo
-- creaba una segunda definicion que se desincronizaba.
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

    -- Auditoria comun (`AuditableEntity`, migracion 045). Nullable: las filas
    -- historicas no tienen autor conocido y un usuario borrado no arrastra lo
    -- que toco.
    creado_por UUID REFERENCES usuarios(id_usuario) ON DELETE SET NULL,
    actualizado_por UUID REFERENCES usuarios(id_usuario) ON DELETE SET NULL,
    fecha_creacion TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    fecha_actualizacion TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- =============================================================================
-- Tabla: PLANTILLAS_PROMPTS_IA (PROT-15.2)
-- Duplicada en db/migrations/018-prompts-ia.sql y renombrada por la
-- 019-renombrar-plantillas-prompts-ia.sql para las bases de datos ya creadas:
-- este archivo solo se ejecuta con el volumen de Docker vacío.
--
-- Repositorio de instrucciones reutilizables para el nodo PROCESADOR_IA. Saca el
-- prompt de los `params` del nodo, igual que `plantillas_html` hizo con el HTML.
--
-- Se llama PLANTILLA y no prompt a secas porque lo que se guarda lleva
-- marcadores {{nodo.campo}} sin resolver; el prompt real es lo que sale de
-- interpolarla contra el contexto de la ejecución.
--
-- DESACOPLADA a propósito: no guarda proveedor, modelo, temperatura ni
-- max_tokens. Un prompt es un activo de TEXTO; qué modelo lo ejecuta lo decide
-- la configuración del nodo. Atarlo aquí a un proveedor impediría reutilizar el
-- mismo texto con Claude y con ChatGPT.
-- =============================================================================

CREATE TABLE plantillas_prompts_ia (
    id_plantilla_prompt_ia UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Clave de MÁQUINA (migración 023): mayúsculas, inmutable, es lo que cita
    -- `promptCode` en los `params` del nodo PROCESADOR_IA. El UUID cambia en
    -- cada clonado y `nombre` lo edita el operador; ninguno de los dos sirve
    -- para que un flujo versionado se refiera a un prompt.
    codigo VARCHAR(50) NOT NULL UNIQUE,

    -- Etiqueta HUMANA: es lo que el operador reconoce en el selector del nodo
    -- IA, y la clave por la que lo resuelve `AiPromptTemplatesService.findByName()`.
    nombre VARCHAR(120) NOT NULL UNIQUE,
    descripcion VARCHAR(255),

    -- La instrucción: texto puro o plantilla con marcadores {{nodo.campo}}.
    -- TEXT y no VARCHAR porque no tiene longitud previsible.
    texto_prompt TEXT NOT NULL,

    -- Borrado lógico: un prompt retirado sigue explicando la salida de las
    -- ejecuciones que lo usaron.
    activo BOOLEAN NOT NULL DEFAULT TRUE,

    -- Poblado desde el JWT (`@CurrentUser()`), no desde el DTO.
    -- RESTRICT y no CASCADE: los prompts son patrimonio del equipo, y dar de
    -- baja a una persona no puede borrar las instrucciones que dejó en producción.
    id_usuario_creador UUID NOT NULL REFERENCES usuarios(id_usuario) ON DELETE RESTRICT,

    -- Auditoria comun (`AuditableEntity`, migracion 045). Nullable: las filas
    -- historicas no tienen autor conocido y un usuario borrado no arrastra lo
    -- que toco.
    creado_por UUID REFERENCES usuarios(id_usuario) ON DELETE SET NULL,
    actualizado_por UUID REFERENCES usuarios(id_usuario) ON DELETE SET NULL,
    fecha_creacion TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    fecha_actualizacion TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_plantillas_prompts_ia_id_usuario_creador
    ON plantillas_prompts_ia(id_usuario_creador);

CREATE INDEX idx_plantillas_prompts_ia_codigo
    ON plantillas_prompts_ia(codigo);

-- LAS SEMILLAS DE PROMPTS NO VAN AQUÍ. `id_usuario_creador` es NOT NULL con FK
-- RESTRICT y este archivo no crea ningún usuario, así que no hay autor al que
-- atribuirlas. Viven en db/migrations/023-codigo-plantillas-prompts-ia.sql, que
-- se aplica DESPUÉS de 002-bootstrap-admin.sql.

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
    -- Auditoria comun (`AuditableEntity`, migracion 045). Nullable: las filas
    -- historicas no tienen autor conocido y un usuario borrado no arrastra lo
    -- que toco.
    creado_por UUID REFERENCES usuarios(id_usuario) ON DELETE SET NULL,
    actualizado_por UUID REFERENCES usuarios(id_usuario) ON DELETE SET NULL,
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
    -- Nace INACTIVO a proposito (migracion 040): un flujo que se armase solo
    -- empezaria a consumir el buzon corporativo sin que nadie revisara su
    -- configuracion.
    status workflow_status_enum NOT NULL DEFAULT 'INACTIVO',
    configuracion_pipeline JSONB,
    -- Maestro del que nació este flujo. Nullable: los flujos anteriores a la
    -- migración 010 no vienen de ninguno, y el asistente debe poder crear uno
    -- desde cero. ON DELETE SET NULL es la red de seguridad ante un borrado
    -- físico por SQL directo; la vía prevista es el borrado lógico (`status`)
    id_plantilla_origen UUID REFERENCES plantillas_flujo(id_plantilla_flujo) ON DELETE SET NULL,
    id_usuario_creador UUID NOT NULL REFERENCES usuarios(id_usuario),
    -- Auditoria comun (`AuditableEntity`, migracion 045). Nullable: las filas
    -- historicas no tienen autor conocido y un usuario borrado no arrastra lo
    -- que toco.
    creado_por UUID REFERENCES usuarios(id_usuario) ON DELETE SET NULL,
    actualizado_por UUID REFERENCES usuarios(id_usuario) ON DELETE SET NULL,
    fecha_creacion TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    fecha_actualizacion TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
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
    -- Tipo del nodo ejecutado. VARCHAR y no enum: el catalogo de tipos vive en
    -- la tabla `nodos`, y duplicarlo aqui como enum obligaria a una migracion
    -- por cada tipo nuevo.
    tipo_nodo VARCHAR(50),
    -- Severidad del fallo. Nula cuando el nodo termino con exito: rellenarla con
    -- un valor de relleno seria inventarse un dato. Reutiliza
    -- `enum_nivel_error`, que ya coincide 1:1 con `NodeErrorSeverity`.
    nivel_severidad enum_nivel_error,
    -- Codigo estable del fallo (`ERR_IMAP_TIMEOUT`...). Va aparte del mensaje
    -- porque es lo que compara el `catchErrors` de `onErrorStep`: el mensaje se
    -- puede reescribir, el codigo es contrato.
    codigo_error VARCHAR(100),
    mensaje TEXT,
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

-- Incidencia que ALGUIEN debe atender, y por eso es una tabla aparte de
-- `logs_nodo`: aquella es el caudal continuo —una fila por nodo ejecutado,
-- incluidos los cientos que terminan bien—; esta es solo la senal. Un fallo
-- LEVE no llega aqui: es el que cierra sin pausar porque se reintenta solo, y
-- anotarlo saturaria la bandeja con ruido que nadie tiene que mirar.
--
-- Duplicada en db/migrations/015-alertas-error-log-nodo.sql para las bases ya
-- creadas: este archivo solo se ejecuta con el volumen de Docker vacio.
CREATE TABLE alertas_error (
    id_alerta_error UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    -- NULLABLE, y no por comodidad: el sondeo IMAP puede fallar ANTES de que
    -- exista ejecucion alguna —si la conexion no responde, el worker ni llega a
    -- despachar el flujo—, y obligar a esa alerta a inventarse una clave ajena
    -- seria falsear el dato. Ese caso se atribuye por `id_flujo`.
    id_ejecucion UUID REFERENCES ejecuciones_flujo(id_ejecucion) ON DELETE CASCADE,
    -- Flujo afectado cuando el fallo ocurre FUERA de una ejecucion. Nulo en las
    -- alertas nacidas dentro de un nodo, que ya se atribuyen por `id_ejecucion`.
    id_flujo UUID,
    -- Traza que la origino. Nullable a proposito: si la escritura en logs_nodo
    -- falla, la alerta se registra igual y huerfana. Perder el aviso de un fallo
    -- URGENTE porque no se pudo anotar la traza seria el peor canje posible.
    --
    -- Constraint NOMBRADA a mano y no derivada por PostgreSQL: la migracion 015
    -- la declara con este mismo nombre, y nombrarla en un sitio y derivarla en
    -- el otro es exactamente como diverge una base clonada de una migrada.
    --
    -- SET NULL y no CASCADE: borrar la ejecucion ya se lleva esta fila por la
    -- clave ajena de arriba. La diferencia aparece el dia que se pode logs_nodo
    -- por retencion; con CASCADE desapareceria de paso una alerta sin resolver.
    id_log_nodo UUID,
    nivel enum_nivel_error NOT NULL,
    mensaje_error TEXT,
    -- NOT NULL: es el filtro de la bandeja, y un tercer valor (NULL) no
    -- significaria nada que FALSE no diga ya.
    resuelto BOOLEAN NOT NULL DEFAULT FALSE,
    fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_alertas_error_log_nodo FOREIGN KEY (id_log_nodo)
        REFERENCES logs_nodo(id_log_nodo) ON DELETE SET NULL,
    CONSTRAINT fk_alertas_error_flujo FOREIGN KEY (id_flujo)
        REFERENCES flujos(id_flujo) ON DELETE CASCADE,
    -- Una alerta sin ejecucion NI flujo seria inatribuible: el operador leeria
    -- "algo fallo" sin saber donde. Que lo impida la base es la unica garantia
    -- que sobrevive a cualquier llamante futuro.
    CONSTRAINT chk_alertas_error_origen
        CHECK (id_ejecucion IS NOT NULL OR id_flujo IS NOT NULL)
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
    -- `creado_en` / `actualizado_en` hasta la migracion 045, que los alineo con
    -- el resto del esquema.
    -- Auditoria comun (`AuditableEntity`, migracion 045). Nullable: las filas
    -- historicas no tienen autor conocido y un usuario borrado no arrastra lo
    -- que toco.
    creado_por UUID REFERENCES usuarios(id_usuario) ON DELETE SET NULL,
    actualizado_por UUID REFERENCES usuarios(id_usuario) ON DELETE SET NULL,
    fecha_creacion TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    fecha_actualizacion TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- =============================================================================
-- Tabla: PRECIOS_MODELOS_IA (migracion 045)
-- Duplicada en db/migrations/045-auditoria-y-telemetria-tokens-ia.sql para las
-- bases de datos ya creadas.
--
-- Tarifas en USD por millon de tokens, VERSIONADAS por `vigente_desde`: cambiar
-- un precio es insertar una fila nueva. `modelo_ia = '*'` es la tarifa generica
-- del proveedor para modelos sin fila propia (coste marcado como estimado).
-- =============================================================================

CREATE TABLE precios_modelos_ia (
    id_precio_modelo_ia UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    proveedor_ia VARCHAR(30) NOT NULL,
    modelo_ia VARCHAR(100) NOT NULL,
    tarifa_prompt_usd_mtok NUMERIC(12, 6) NOT NULL CHECK (tarifa_prompt_usd_mtok >= 0),
    tarifa_completacion_usd_mtok NUMERIC(12, 6) NOT NULL CHECK (tarifa_completacion_usd_mtok >= 0),
    -- Solo la usa Gemini, que factura el razonamiento aparte de la salida.
    tarifa_razonamiento_usd_mtok NUMERIC(12, 6) NOT NULL CHECK (tarifa_razonamiento_usd_mtok >= 0),
    vigente_desde TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    -- Auditoria comun (`AuditableEntity`, migracion 045). Nullable: las filas
    -- historicas no tienen autor conocido y un usuario borrado no arrastra lo
    -- que toco.
    creado_por UUID REFERENCES usuarios(id_usuario) ON DELETE SET NULL,
    actualizado_por UUID REFERENCES usuarios(id_usuario) ON DELETE SET NULL,
    fecha_creacion TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    fecha_actualizacion TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_precios_modelos_ia_vigencia UNIQUE (proveedor_ia, modelo_ia, vigente_desde)
);

-- Una sola tarifa VIGENTE por par (migracion 052): el historico repite el par,
-- la vigente no. Para la carrera de dos altas simultaneas sin vigente previa.
CREATE UNIQUE INDEX uq_precios_modelos_ia_activa
    ON precios_modelos_ia (proveedor_ia, modelo_ia)
 WHERE activo;

-- A diferencia de las plantillas, estas semillas SI van aqui: no dependen de
-- ningun usuario, y sin ellas toda la telemetria naceria marcada como estimada.
INSERT INTO precios_modelos_ia (
    proveedor_ia, modelo_ia,
    tarifa_prompt_usd_mtok, tarifa_completacion_usd_mtok, tarifa_razonamiento_usd_mtok,
    vigente_desde
) VALUES
    ('ANTHROPIC', 'claude-opus-5-5',   4.00, 20.00, 20.00, '2026-10-01 00:00:00+00'),
    ('ANTHROPIC', 'claude-sonnet-5-5', 2.00, 10.00, 10.00, '2026-10-01 00:00:00+00'),
    ('ANTHROPIC', 'claude-haiku-4-5',  1.00,  5.00,  5.00, '2026-10-01 00:00:00+00'),
    ('ANTHROPIC', '*',                 4.00, 20.00, 20.00, '2026-10-01 00:00:00+00'),
    ('OPENAI',    'gpt-4o',            2.50, 10.00, 10.00, '2026-10-01 00:00:00+00'),
    -- Gemini (migracion 046). Razonamiento a tarifa de salida, como lo factura.
    ('GEMINI',    'gemini-1.5-flash',  0.075, 0.30,  0.30, '2026-10-01 00:00:00+00'),
    ('GEMINI',    'gemini-3.6-flash',  0.075, 0.30,  0.30, '2026-10-01 00:00:00+00'),
    ('GEMINI',    'gemini-1.5-pro',    1.25,  5.00,  5.00, '2026-10-01 00:00:00+00'),
    ('GEMINI',    'gemini-3.8-flash',  1.25,  5.00,  5.00, '2026-10-01 00:00:00+00'),
    ('GEMINI',    '*',                 0.10,  0.40,  0.40, '2026-10-01 00:00:00+00');

-- =============================================================================
-- Tabla: TELEMETRIA_TOKENS_IA (migracion 045)
-- Duplicada en db/migrations/045-auditoria-y-telemetria-tokens-ia.sql para las
-- bases de datos ya creadas.
--
-- Una fila por inferencia facturada de PROCESADOR_IA / PROCESADOR_OCR.
-- INMUTABLE: guarda una fotografia de las tarifas aplicadas, no una referencia
-- a `precios_modelos_ia`, para que el coste historico no cambie con los precios.
-- =============================================================================

CREATE TABLE telemetria_tokens_ia (
    id_telemetria_tokens_ia UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    -- Ejecucion, flujo y nodo son NULL en el consumo del asistente de prompts,
    -- que no ocurre dentro de ninguna ejecucion (migracion 049).
    ejecucion_id UUID NULL REFERENCES ejecuciones_flujo(id_ejecucion) ON DELETE CASCADE,
    -- Redundante con `ejecucion_id` a proposito: eje de agregacion sin JOIN.
    flujo_id UUID NULL REFERENCES flujos(id_flujo) ON DELETE CASCADE,
    -- `nodeId` del pipeline: sin FK, igual que `logs_nodo.id_nodo`.
    nodo_id VARCHAR(50) NULL,
    -- 'EJECUCION_FLUJO' | 'PROMPT_OPTIMIZATION' (migracion 049).
    origen_operacion VARCHAR(30) NOT NULL DEFAULT 'EJECUCION_FLUJO',
    -- Quien pidio la inferencia fuera de una ejecucion.
    usuario_id UUID NULL REFERENCES usuarios(id_usuario) ON DELETE SET NULL,
    proveedor_ia VARCHAR(30) NOT NULL,
    modelo_ia VARCHAR(100) NOT NULL,
    tokens_prompt INTEGER NOT NULL DEFAULT 0 CHECK (tokens_prompt >= 0),
    tokens_completacion INTEGER NOT NULL DEFAULT 0 CHECK (tokens_completacion >= 0),
    tokens_razonamiento INTEGER NOT NULL DEFAULT 0 CHECK (tokens_razonamiento >= 0),
    tokens_totales INTEGER NOT NULL DEFAULT 0 CHECK (tokens_totales >= 0),
    tarifa_prompt_usd NUMERIC(12, 6) NOT NULL DEFAULT 0 CHECK (tarifa_prompt_usd >= 0),
    tarifa_completacion_usd NUMERIC(12, 6) NOT NULL DEFAULT 0 CHECK (tarifa_completacion_usd >= 0),
    tarifa_razonamiento_usd NUMERIC(12, 6) NOT NULL DEFAULT 0 CHECK (tarifa_razonamiento_usd >= 0),
    costo_estimado_usd NUMERIC(12, 6) NOT NULL DEFAULT 0 CHECK (costo_estimado_usd >= 0),
    es_estimado BOOLEAN NOT NULL DEFAULT FALSE,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Cada origen trae sus columnas: sin filas a medias.
    CONSTRAINT chk_telemetria_origen_coherente CHECK (
        (origen_operacion = 'EJECUCION_FLUJO'
            AND ejecucion_id IS NOT NULL AND flujo_id IS NOT NULL AND nodo_id IS NOT NULL)
        OR (origen_operacion = 'PROMPT_OPTIMIZATION' AND usuario_id IS NOT NULL)
    )
);

CREATE INDEX idx_telemetria_tokens_ejecucion ON telemetria_tokens_ia (ejecucion_id);
CREATE INDEX idx_telemetria_tokens_flujo_fecha ON telemetria_tokens_ia (flujo_id, creado_en);
CREATE INDEX idx_telemetria_tokens_proveedor_modelo ON telemetria_tokens_ia (proveedor_ia, modelo_ia, creado_en);
CREATE INDEX idx_telemetria_tokens_origen_fecha ON telemetria_tokens_ia (origen_operacion, creado_en);

-- =============================================================================
-- Tabla: audit_eventos (migracion 048)
-- Duplicada en db/migrations/048-crear-tabla-audit-eventos.sql para las bases
-- de datos ya creadas.
--
-- Historial de acciones humanas: logins, cambios de rol y mutaciones CRUD de
-- las maestras, con fotografias JSONB antes y despues. Solo insercion.
-- =============================================================================

CREATE TABLE audit_eventos (
    id_audit_evento UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    -- NULL en un login fallido con un correo que no existe.
    usuario_id UUID NULL REFERENCES usuarios(id_usuario) ON DELETE SET NULL,
    -- Literales en castellano (migracion 050). El nombre de la restriccion es
    -- explicito para que la 050 pueda soltarla y reponerla por nombre.
    accion VARCHAR(30) NOT NULL
        CONSTRAINT audit_eventos_accion_check CHECK (accion IN (
            'CREAR', 'ACTUALIZAR', 'ELIMINAR', 'CAMBIO_ROL',
            'INICIO_SESION', 'INICIO_SESION_FALLIDO', 'CIERRE_SESION',
            'ACTIVAR', 'DESACTIVAR'
        )),
    tabla_afectada VARCHAR(60) NOT NULL,
    registro_id VARCHAR(64) NULL,
    datos_anteriores JSONB NULL,
    datos_nuevos JSONB NULL,
    ip_origen VARCHAR(45) NULL,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_audit_eventos_creado_en ON audit_eventos (creado_en);
CREATE INDEX idx_audit_eventos_usuario_fecha ON audit_eventos (usuario_id, creado_en);
CREATE INDEX idx_audit_eventos_tabla_registro ON audit_eventos (tabla_afectada, registro_id);

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
CREATE INDEX idx_alertas_error_id_log_nodo ON alertas_error(id_log_nodo);
CREATE INDEX idx_alertas_error_id_flujo ON alertas_error(id_flujo);

-- PARCIAL y no un indice plano sobre `resuelto`: con dos valores posibles el
-- planificador no lo usaria. La consulta real de la bandeja es "las pendientes,
-- las mas recientes primero", y eso es justo lo que este indice resuelve.
CREATE INDEX idx_alertas_error_pendientes
    ON alertas_error (fecha_creacion DESC)
 WHERE resuelto = FALSE;

-- =============================================================================
-- SEED: Datos iniciales
--
-- SOLO EL CATALOGO DE NODOS. Las semillas de `plantillas_prompts_ia` (los tres
-- casos de Madrid+D) NO pueden ir aqui: `id_usuario_creador` es NOT NULL con FK
-- RESTRICT y en este punto no existe ningun usuario todavia —el ADMIN lo siembra
-- la migracion 002—. Viven en `db/migrations/023` y `024`, que se aplican
-- despues. Un volumen recien creado nace, por tanto, sin prompts.
-- =============================================================================

-- Los 10 codigos con estrategia replican el enum `NodeType` del backend
-- (`@core/fsm/types/pipeline-schema.types`): son los unicos que un
-- `pipeline_schema` puede declarar hoy. `DESTINO_ACENS` sigue en el catalogo a
-- la espera de su estrategia; hasta entonces no es referenciable desde
-- `flujos.configuracion_pipeline` (ver migracion 005).
INSERT INTO nodos (codigo, nombre, categoria, descripcion) VALUES
    ('TRIGGER_IMAP', 'Disparador IMAP', 'TRIGGER', 'Inicia el flujo mediante la lectura de correos entrantes'),
    ('PARSER_PRE_IA', 'Parser de Correo', 'PROCESAMIENTO', 'Procesa y limpia correos entrantes, extrayendo asunto, texto plano sin firmas y URLs de referencia.'),
    ('EXTRACTOR_WEB', 'Extractor Web', 'PROCESAMIENTO', 'Extrae y sanitiza contenido desde una pagina web'),
    ('PROCESADOR_IA', 'Procesador de IA', 'PROCESAMIENTO', 'Ejecuta inferencia mediante un modelo de lenguaje'),
    ('ESCUDO_POST_IA', 'Escudo Post-IA', 'CONTROL', 'Valida la salida del modelo contra el esquema esperado antes de propagarla'),
    ('MAPEADOR_PLANTILLA', 'Mapeador de Plantilla', 'PROCESAMIENTO', 'Inyecta una plantilla HTML del gestor, ya saneada y sin interpolar, para que un PROCESADOR_IA posterior la rellene. Verifica que conserva los selectores estructurales exigidos.'),
    ('DESTINO_DRUPAL', 'Destino Drupal', 'DESTINO', 'Publica el resultado final en el CMS Drupal mediante JSON:API'),
    ('TRIGGER_CRON', 'Disparador Cron', 'TRIGGER', 'Inicia el flujo mediante una programacion temporal'),
    ('DESTINO_ACENS', 'Destino Acens', 'DESTINO', 'Realiza el envio masivo a traves de Acens'),
    ('DESTINO_SMTP', 'Alerta por Correo', 'DESTINO', 'Envia un correo de aviso interpolando datos del flujo. Pensado como destino de las rutas de recuperacion ante error.'),
    ('PROCESADOR_OCR', 'Procesador OCR', 'PROCESAMIENTO', 'Transcribe los adjuntos de un correo sin texto aprovechable (imagen o PDF escaneado). Pensado como destino de la ruta de contingencia del parser.'),
    ('PAUSA_FLOW', 'Pausa de Flujo', 'CONTROL', 'Detiene el flujo de forma deliberada y lo deja reanudable por un operador (CU-09). Admite pausa inmediata o tras un retardo, y puede avisar por correo.');

