import { api } from '@boot/axios';

import type {
  CreateHtmlTemplatePayload,
  HtmlTemplate,
  PreviewTemplatePayload,
  TemplatePreviewResponse,
  UpdateHtmlTemplatePayload,
} from '@/types/html-template';

// Unica capa que conoce las rutas del backend NestJS (TemplatesController) y el
// tipo AxiosResponse. Todas las funciones retornan la data ya desestructurada;
// las excepciones HTTP se propagan hacia el store y de ahi al componente.

export const fetchTemplates = async (): Promise<HtmlTemplate[]> => {
  const { data } = await api.get<HtmlTemplate[]>('/templates');
  return data;
};

export const fetchTemplateById = async (id: string): Promise<HtmlTemplate> => {
  const { data } = await api.get<HtmlTemplate>(`/templates/${id}`);
  return data;
};

export const createTemplate = async (payload: CreateHtmlTemplatePayload): Promise<HtmlTemplate> => {
  const { data } = await api.post<HtmlTemplate>('/templates', payload);
  return data;
};

// PUT y no PATCH: a diferencia de /users y /allowed-ips, TemplatesController
// expone la actualizacion como PUT.
export const updateTemplate = async (
  id: string,
  payload: UpdateHtmlTemplatePayload,
): Promise<HtmlTemplate> => {
  const { data } = await api.put<HtmlTemplate>(`/templates/${id}`, payload);
  return data;
};

// Borrado logico: el endpoint DELETE solo cambia `active` a false y devuelve el
// registro actualizado, nunca elimina la fila.
export const deactivateTemplate = async (id: string): Promise<HtmlTemplate> => {
  const { data } = await api.delete<HtmlTemplate>(`/templates/${id}`);
  return data;
};

/**
 * Compila la plantilla contra un payload simulado. El backend rellena con
 * marcadores las variables que el payload no aporte, asi que un cuerpo vacio es
 * suficiente para ver la maqueta.
 */
export const previewTemplate = async (
  id: string,
  payload: PreviewTemplatePayload = {},
): Promise<TemplatePreviewResponse> => {
  const { data } = await api.post<TemplatePreviewResponse>(`/templates/${id}/preview`, payload);
  return data;
};
