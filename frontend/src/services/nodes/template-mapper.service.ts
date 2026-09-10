import * as templatesService from '@services/templates.service';

import type {
  HtmlTemplate,
  PreviewTemplatePayload,
  TemplatePreviewResponse,
} from '@/types/html-template';

// Frontera HTTP del nodo MAPEADOR_PLANTILLA (regla frontend-quasar.md §3.1).
//
// Delega en `templates.service.ts` en lugar de reescribir las rutas `/templates`:
// el nodo consume el mismo recurso que el gestor, y duplicar aqui las URLs
// crearia dos sitios que actualizar cuando el backend cambie una. La regla exige
// que el servicio sea la unica capa que conoce las rutas, y se cumple con una
// sola fuente. Lo que aporta este archivo es el vocabulario del nodo.

/**
 * Plantillas ofrecibles en el selector Poka-Yoke del nodo.
 *
 * Se llama SIN `includeInactive`: el default del servicio pide solo las activas,
 * que es justo lo que este selector debe ofrecer. La tabla administrativa es la
 * unica que pasa `true`, y por eso el filtro sigue siendo del backend.
 */
export const fetchSelectableTemplates = async (): Promise<HtmlTemplate[]> =>
  templatesService.fetchTemplates();

/** Prueba de compilacion con un payload simulado, para el boton de vista previa. */
export const compilePreview = async (
  templateId: string,
  payload: PreviewTemplatePayload = {},
): Promise<TemplatePreviewResponse> => templatesService.previewTemplate(templateId, payload);
