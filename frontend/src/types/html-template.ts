// Replica exacta de los DTOs expuestos por TemplatesController (NestJS).
// Cualquier cambio en el backend debe reflejarse aqui: son el contrato entre
// ambos lados.

import { NODE_OUTPUT_NAMESPACES } from '@/types/pipeline';

import type { AuditableData } from '@/types/auditable';
import type { NodeOutputField } from '@/types/node-catalog';

/** Fila de `plantillas_html`. */
export interface HtmlTemplate extends AuditableData {
  id: string;
  name: string;
  description: string | null;
  htmlContent: string;
  /** Rutas `namespace.campo` detectadas y validadas por el backend al guardar. */
  requiredVariables: string[];
  createdById: string;
  active: boolean;
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
export const ASSETS_NAMESPACE = '_assets';

export const TEMPLATE_NAMESPACES = [...NODE_OUTPUT_NAMESPACES, ASSETS_NAMESPACE] as const;

export type TemplateNamespace = (typeof TEMPLATE_NAMESPACES)[number];

/**
 * Campos de `_assets`, el unico namespace que no sale del catalogo de nodos.
 *
 * No lo publica ninguna estrategia: lo inyecta `TemplateRendererService` en cada
 * render desde `ASSETS_BASE_URL`, asi que no hay `outputFields` que preguntar y
 * la lista tiene que declararse aqui. Se escribe en el frontend a sabiendas de
 * que es una replica —la fuente es `withAssetsNamespace` en el renderer— porque
 * la alternativa es que el explorador de variables no pueda ofrecerlo y el autor
 * tenga que teclear `{{_assets.base_url}}` a mano, que es justo lo que el
 * selector determinista existe para evitar.
 */
export const ASSETS_FIELDS: readonly NodeOutputField[] = [
  {
    name: 'base_url',
    type: 'text',
    description: 'Prefijo absoluto de los archivos subidos, para rutas de imagen',
  },
];
