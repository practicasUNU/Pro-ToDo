// Replica exacta de los DTOs expuestos por TemplatesController (NestJS).
// Cualquier cambio en el backend debe reflejarse aqui: son el contrato entre
// ambos lados.

/** Fila de `plantillas_html`. */
export interface HtmlTemplate {
  id: string;
  name: string;
  description: string | null;
  htmlContent: string;
  /** Rutas `namespace.campo` detectadas y validadas por el backend al guardar. */
  requiredVariables: string[];
  createdById: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

// `requiredVariables` y `createdById` NO viajan en los payloads: la primera la
// deriva el backend del propio HTML y la segunda sale del JWT. Aceptarlas
// permitiria declarar variables que la plantilla no usa o suplantar la autoria.

export interface CreateHtmlTemplatePayload {
  name: string;
  description?: string;
  htmlContent: string;
}

export interface UpdateHtmlTemplatePayload {
  name?: string;
  description?: string;
  htmlContent?: string;
  /**
   * Disponibilidad. Es la unica via para REACTIVAR una plantilla retirada: el
   * `DELETE` solo sabe apagarla.
   */
  active?: boolean;
}

/**
 * Replica de `ViolationType` (backend, `dto/template-violation.dto.ts`).
 */
export type ViolationType = 'tag' | 'attribute' | 'protocol' | 'variable';

/**
 * Infraccion localizable que el backend adjunta a un 400 al guardar.
 *
 * ## Invariante de `target`, y de ella depende el resaltado
 *
 * - `tag`, `attribute`, `protocol`: identificador normalizado en MINUSCULAS
 *   (`body`, `onerror`, `javascript:`). En el documento puede aparecer como
 *   `<BODY>`, asi que se busca con un patron estructural insensible a mayusculas.
 * - `variable`: subcadena LITERAL del documento, espacios incluidos
 *   (`{{ bad_ns.titulo }}`, `{{{`). Se busca tal cual.
 *
 * `TemplateCodeEditor` usa esta distincion para elegir el patron de busqueda;
 * un `indexOf` unico para todo daria falsos positivos (`<p` casa dentro de
 * `<pre>`, `onerror=` dentro de `data-onerror=`).
 */
export interface TemplateViolation {
  target: string;
  type: ViolationType;
  message: string;
}

/** Cuerpo de `POST /templates/:id/preview`. */
export interface PreviewTemplatePayload {
  samplePayload?: Record<string, Record<string, unknown>>;
}

/** Respuesta de `POST /templates/:id/preview`. */
export interface TemplatePreviewResponse {
  compiledMarkup: string;
}

/**
 * Replica de `ALLOWED_NAMESPACES` (backend, `templates.service.ts`).
 *
 * Alimenta los chips Poka-Yoke del editor: el autor elige el namespace en vez
 * de teclearlo, que es la unica forma de no equivocarse antes de que el backend
 * rechace la plantilla con un 400.
 *
 * `_assets` es el unico que no produce ningun nodo: lo inyecta el backend en
 * cada render desde `ASSETS_BASE_URL`, y expone una sola clave, `base_url`,
 * para prefijar rutas relativas de imagen.
 */
export const TEMPLATE_NAMESPACES = [
  'raw_email',
  'parsed_email',
  'scraped_web',
  'llm_response',
  'validated_drupal_json',
  'rendered_html',
  '_assets',
] as const;

export type TemplateNamespace = (typeof TEMPLATE_NAMESPACES)[number];
