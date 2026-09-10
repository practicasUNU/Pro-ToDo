import { defineStore, acceptHMRUpdate } from 'pinia';
import { computed, ref } from 'vue';

import * as templatesService from '@services/templates.service';

import type {
  CreateHtmlTemplatePayload,
  HtmlTemplate,
  UpdateHtmlTemplatePayload,
} from '@/types/html-template';

/**
 * Buffer de edicion activo del editor de plantillas.
 *
 * `description` es opcional y NUNCA se asigna como `undefined` explicito:
 * `exactOptionalPropertyTypes` lo prohibe, asi que la clave se omite (ver
 * `initDraft`). La entidad la trae como `string | null`, de ahi la conversion.
 */
export interface TemplateDraft {
  name: string;
  description?: string;
  htmlContent: string;
}

/**
 * Marcador interpolable dentro del HTML de una plantilla.
 *
 * Replica el patron del backend (`templates.service.ts`), indice `.[0]`
 * incluido: si aqui se detectaran menos variables que alli, los chips de
 * "variables detectadas" mentirian sobre lo que se va a guardar en
 * `requiredVariables`.
 */
const TEMPLATE_VARIABLE_PATTERN = /\{\{\s*([a-zA-Z0-9_]+(?:\.(?:[a-zA-Z0-9_]+|\[\d+\]))+)\s*\}\}/g;

/** Longitud del sufijo `}}`: cuanto hay que retroceder el caret tras insertar. */
const CLOSING_BRACES_LENGTH = 2;

// Logica de negocio y estado compartido del dominio Plantillas HTML. Esta capa
// no conoce Axios ni rutas del backend (ver frontend-architecture.md §2.1): solo
// invoca al servicio y muta el estado de forma inmutable con su resultado.
export const useTemplatesStore = defineStore('templates', () => {
  const templates = ref<HtmlTemplate[]>([]);
  const selectedTemplate = ref<HtmlTemplate | null>(null);
  const isLoading = ref(false);

  /**
   * Borrador en edicion. Hay UNO solo por aplicacion: `TemplateEditorDialog`
   * puede estar montado en varios sitios a la vez (el futuro asistente tendra un
   * configurador por nodo), pero los `<q-dialog>` son modales y solo uno esta
   * abierto en cada momento, e `initDraft` se llama AL ABRIR. No construir
   * encima la suposicion contraria sin cambiar esto a un mapa por identificador.
   */
  const activeDraft = ref<TemplateDraft>({ name: '', htmlContent: '' });

  /**
   * Indice de insercion dentro de `htmlContent`.
   *
   * Es un ESPEJO del cursor de CodeMirror, que es quien manda: el editor lo
   * empuja con su evento `cursorChange`. Solo lo consume `insertMarker`, y solo
   * cuando el editor todavia no esta montado.
   */
  const cursorPosition = ref(0);

  /** Minimo que el backend exige: nombre y contenido no vacios. */
  const isDraftValid = computed<boolean>(
    () =>
      activeDraft.value.name.trim().length > 0 && activeDraft.value.htmlContent.trim().length > 0,
  );

  /**
   * Rutas `namespace.campo` presentes en el borrador, sin duplicados.
   *
   * Espejo en vivo de lo que el backend guardara en `requiredVariables`. NO
   * valida contra la lista blanca: detecta la FORMA, no la validez. Un
   * `{{contacto.telefono}}` aparece aqui y aun asi el backend lo rechazara con
   * un 400 — que es lo correcto, porque el gestor de plantillas es la unica
   * autoridad sobre que namespaces existen.
   */
  const detectedVariables = computed<string[]>(() => {
    // El regex es global y con estado (`lastIndex`); `matchAll` lo recorre desde
    // cero en cada evaluacion, a diferencia de `exec` en bucle.
    const matches = activeDraft.value.htmlContent.matchAll(TEMPLATE_VARIABLE_PATTERN);

    // `Set` preserva el orden de aparicion: la lista se lee igual que el HTML.
    return [...new Set([...matches].map(([, path]) => path ?? ''))].filter(Boolean);
  });

  /**
   * Carga el borrador para editar una plantilla, o lo deja vacio para crear.
   *
   * @param template Plantilla a editar; omitido para un alta.
   */
  const initDraft = (template?: HtmlTemplate): void => {
    activeDraft.value = {
      name: template?.name ?? '',
      htmlContent: template?.htmlContent ?? '',
      // `exactOptionalPropertyTypes`: la clave se OMITE en vez de asignarse como
      // `undefined`, que el tipo opcional no admite. La entidad la trae como
      // `string | null` y el borrador la quiere `string | undefined`.
      ...(template?.description ? { description: template.description } : {}),
    };
    cursorPosition.value = 0;
  };

  const updateHtmlContent = (content: string): void => {
    activeDraft.value = { ...activeDraft.value, htmlContent: content };
  };

  /** Espejo del cursor de CodeMirror, que es quien manda. */
  const setCursorPosition = (position: number): void => {
    cursorPosition.value = position;
  };

  /**
   * Inserta `{{namespace.}}` en `cursorPosition` y deja el caret antes de `}}`.
   *
   * FALLBACK: en condiciones normales el chip despacha una transaccion sobre el
   * `EditorView`, que es el dueno del cursor. Esto solo entra cuando el editor
   * aun no esta montado, y por eso empalma strings: sin vista, no hay
   * transaccion que despachar.
   */
  const insertMarker = (namespace: string): void => {
    const snippet = `{{${namespace}.}}`;
    const { htmlContent } = activeDraft.value;

    // El espejo puede haber quedado por delante del contenido (p. ej. tras un
    // initDraft con texto mas corto): se acota en vez de producir un hueco.
    const position = Math.min(Math.max(cursorPosition.value, 0), htmlContent.length);

    activeDraft.value = {
      ...activeDraft.value,
      htmlContent: `${htmlContent.slice(0, position)}${snippet}${htmlContent.slice(position)}`,
    };
    cursorPosition.value = position + snippet.length - CLOSING_BRACES_LENGTH;
  };

  /**
   * Carga el catalogo.
   *
   * @param includeInactive `true` en la tabla administrativa, que muestra las
   *        retiradas con su badge y permite reactivarlas.
   */
  const fetchTemplates = async (includeInactive = false): Promise<void> => {
    isLoading.value = true;

    try {
      templates.value = await templatesService.fetchTemplates(includeInactive);
    } finally {
      isLoading.value = false;
    }
  };

  const createTemplate = async (payload: CreateHtmlTemplatePayload): Promise<HtmlTemplate> => {
    isLoading.value = true;

    try {
      const created = await templatesService.createTemplate(payload);
      templates.value = [...templates.value, created];
      return created;
    } finally {
      isLoading.value = false;
    }
  };

  const updateTemplate = async (
    id: string,
    payload: UpdateHtmlTemplatePayload,
  ): Promise<HtmlTemplate> => {
    isLoading.value = true;

    try {
      const updated = await templatesService.updateTemplate(id, payload);
      templates.value = templates.value.map((template) =>
        template.id === id ? updated : template,
      );
      return updated;
    } finally {
      isLoading.value = false;
    }
  };

  /**
   * Borrado logico. El backend devuelve la plantilla con `active: false`, pero
   * el listado solo muestra las activas: se retira de la coleccion en vez de
   * reemplazarla, para que desaparezca de la tabla sin recargar.
   */
  const deactivateTemplate = async (id: string): Promise<HtmlTemplate> => {
    isLoading.value = true;

    try {
      const deactivated = await templatesService.deactivateTemplate(id);
      templates.value = templates.value.filter((template) => template.id !== id);

      if (selectedTemplate.value?.id === id) {
        selectedTemplate.value = null;
      }

      return deactivated;
    } finally {
      isLoading.value = false;
    }
  };

  /** Compila contra un payload simulado. No toca el estado: solo devuelve. */
  const previewTemplate = async (id: string): Promise<string> => {
    isLoading.value = true;

    try {
      const { compiledMarkup } = await templatesService.previewTemplate(id);
      return compiledMarkup;
    } finally {
      isLoading.value = false;
    }
  };

  const selectTemplate = (template: HtmlTemplate | null): void => {
    selectedTemplate.value = template;
  };

  return {
    templates,
    selectedTemplate,
    isLoading,
    activeDraft,
    cursorPosition,
    isDraftValid,
    detectedVariables,
    initDraft,
    updateHtmlContent,
    setCursorPosition,
    insertMarker,
    fetchTemplates,
    createTemplate,
    updateTemplate,
    deactivateTemplate,
    previewTemplate,
    selectTemplate,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useTemplatesStore, import.meta.hot));
}
