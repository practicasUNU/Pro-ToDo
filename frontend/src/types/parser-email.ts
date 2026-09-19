import type { NodeErrorSeverity } from '@/types/pipeline';

// Replica de los contratos del nodo PARSER_PRE_IA. Fuentes en el backend:
//  - `ParsedEmailPayload` -> @modules/nodes/utils/parsed-email-payload.util.ts
//  - `ParserEmailConfigDto` -> @modules/nodes/dto/parser-email-config.dto.ts
//  - `CheckParser*` -> @modules/wizard/dto/check-parser*.dto.ts
// Cualquier cambio alli debe reflejarse aqui.
//
// Fichero propio y no dentro de `@/types/pipeline`: aquel declara ser "replica
// exacta de los contratos del motor FSM", y esto no lo es. El payload vive en
// `@modules/nodes` justamente porque el motor no debe conocer el formato de un
// correo, y esa estratificacion se replica aqui separando los archivos.

/** Origen del cuerpo textual que el parser saneo. */
export type BodySource = 'text' | 'html' | 'none';

/** Inventario de un adjunto SIN su binario. Replica de `RawEmailAttachmentMetadata`. */
export interface ParsedEmailAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
}

/**
 * Payload determinista que el nodo deposita en `parsed_email`.
 *
 * Doce claves SIEMPRE presentes y con su tipo. El ORDEN es parte del contrato:
 * la prueba 1.1 del backend lo compara posicionalmente.
 *
 * Las claves van en `snake_case` porque asi viajan: son las que una plantilla
 * interpola como `{{parsed_email.clean_body}}`, y camelizarlas aqui haria que el
 * banco de pruebas mostrase nombres que ninguna plantilla puede escribir.
 */
export interface ParsedEmailPayload {
  readonly subject: string;
  readonly clean_title: string;
  readonly clean_body: string;
  readonly body_source: BodySource;
  readonly character_count: number;
  readonly original_character_count: number;
  readonly reduction_percentage: number;
  readonly extracted_urls: readonly string[];
  readonly attachment_count: number;
  readonly attachments: readonly ParsedEmailAttachment[];
  /**
   * Texto NATIVO de los adjuntos legibles (.pdf, .docx, .xlsx, .csv, .txt).
   *
   * Sin OCR: una imagen o un PDF escaneado no aportan nada aqui, y es
   * precisamente eso lo que levanta `requires_multimodal_fallback`.
   *
   * SIEMPRE vacio en la respuesta del banco de pruebas, que no recibe los
   * binarios de los adjuntos. El backend lo advierte en `warnings`.
   */
  readonly extracted_documents_text: string;
  readonly requires_multimodal_fallback: boolean;
  readonly multimodal_reason: string;
}

/**
 * `params` que el nodo PARSER_PRE_IA aporta al `pipeline_schema`.
 *
 * Replica de `ParserEmailConfigDto`. `sourceNamespace` es opcional en el
 * backend, que aplica `raw_email` por defecto; aqui se mantiene obligatorio
 * dentro del store para que el formulario no tenga que lidiar con un campo
 * indefinido, y es `toNodeParams()` quien decide si llega a publicarse.
 */
export interface ParserEmailConfigDto {
  minBodyLength: number;
  sourceNamespace: string;
}

/**
 * Cuerpo de `POST /api/wizard/check-parser`.
 *
 * NO lleva `sourceNamespace`: el correo viaja en el propio cuerpo, no hay
 * contexto del que leer, y el backend valida con `forbidNonWhitelisted`, asi que
 * incluirlo devolveria un 400.
 */
export interface CheckParserPayload {
  readonly subject?: string;
  readonly text?: string;
  readonly html?: string;
  readonly attachments?: readonly ParsedEmailAttachment[];
  readonly minBodyLength?: number;
}

/**
 * Resultado del banco de pruebas del parser.
 *
 * `warnings` es lo unico que este endpoint anade sobre la ejecucion real: son
 * los avisos que la estrategia manda a su `Logger` y que aqui si se ven.
 *
 * Un correo sin texto aprovechable NO llega como `success: false`, sino como
 * `parsed.body_source === 'none'`, igual que en produccion. El `success: false`
 * queda reservado a un fallo inesperado de la composicion.
 */
export interface CheckParserResult {
  readonly success: boolean;
  readonly parsed?: ParsedEmailPayload;
  readonly warnings?: readonly string[];
  readonly error?: {
    readonly level: NodeErrorSeverity;
    readonly message: string;
  };
}
