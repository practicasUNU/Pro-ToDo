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
 */
export const TEMPLATE_NAMESPACES = [
  'raw_email',
  'parsed_email',
  'scraped_web',
  'llm_response',
  'validated_drupal_json',
  'rendered_html',
] as const;

export type TemplateNamespace = (typeof TEMPLATE_NAMESPACES)[number];
