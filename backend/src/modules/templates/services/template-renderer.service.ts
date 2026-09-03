import { Injectable } from '@nestjs/common';
import Handlebars from 'handlebars';
import sanitizeHtml from 'sanitize-html';

import {
  MissingContextVariableException,
  resolvePath,
} from '@core/fsm/context/state-payload.context';

/** Namespaces acumulados contra los que se compila una plantilla. */
export type RenderNamespaces = Record<string, Record<string, unknown>>;

/**
 * Fuerza `rel="noopener noreferrer"` en los enlaces que abren pestana nueva.
 *
 * Sin `noopener`, la pagina destino recibe un `window.opener` con el que puede
 * redirigir la pestana de origen (tabnabbing). Se declara aparte porque las DOS
 * configuraciones de abajo tienen que aplicar exactamente la misma
 * transformacion; ver `PUBLISHABLE_MARKUP_PROBE_CONFIG`.
 */
const forceSafeLinkRel: sanitizeHtml.Transformer = (tagName, attribs) =>
  attribs.target === '_blank'
    ? { tagName, attribs: { ...attribs, rel: 'noopener noreferrer' } }
    : { tagName, attribs };

/**
 * Lista blanca de markup publicable.
 *
 * Handlebars escapa los VALORES interpolados, pero el HTML de la plantilla lo
 * escribe un editor y se compila tal cual: sin este filtro, un `<script>` o un
 * `onerror=` en el cuerpo de la plantilla llegaria intacto al articulo
 * publicado. Es una barrera distinta —y adicional— al `<iframe sandbox>` de la
 * vista previa, que solo protege al operador de Proto-Do, no al lector.
 */
export const TEMPLATE_SANITIZER_CONFIG: sanitizeHtml.IOptions = {
  // Etiquetas de CUERPO de articulo. Quedan fuera a proposito las de estructura
  // de pagina (`section`, `article`, `header`, `footer`, `nav`, `main`): una
  // plantilla compone el cuerpo de una noticia, no la pagina que la envuelve.
  allowedTags: [
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'p',
    'a',
    'b',
    'i',
    'strong',
    'em',
    'ul',
    'ol',
    'li',
    'table',
    'thead',
    'tbody',
    'tfoot',
    'tr',
    'th',
    'td',
    'caption',
    'div',
    'span',
    'img',
    'br',
    'hr',
    'blockquote',
    'figure',
    'figcaption',
    'code',
    'pre',
    'sub',
    'sup',
    'small',
    'time',
  ],
  allowedAttributes: {
    '*': ['class', 'style'],
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'width', 'height', 'style'],
    time: ['datetime'],
  },
  // Sin `javascript:` ni `data:`: el primero ejecuta, el segundo permite
  // incrustar un documento entero en un href.
  allowedSchemes: ['http', 'https', 'mailto'],
  disallowedTagsMode: 'discard',
  /**
   * Etiquetas cuyo CONTENIDO se descarta junto con la etiqueta.
   *
   * `disallowedTagsMode: 'discard'` por si solo elimina la etiqueta pero
   * CONSERVA su texto: `<iframe>texto</iframe>` dejaria "texto" suelto en el
   * articulo. Por eso `iframe` se anade aqui.
   *
   * Los otros cinco son los que la libreria trae por defecto y NO se pueden
   * omitir: al declarar `nonTextTags` se sustituye la lista entera, y el propio
   * codigo de `sanitize-html` advierte que dejar fuera `xmp` reabre un bypass
   * XSS (htmlparser2 lo trata como texto crudo y se reemitiria sin escapar).
   */
  nonTextTags: ['script', 'style', 'textarea', 'option', 'xmp', 'iframe'],
  transformTags: { a: forceSafeLinkRel },
};

/**
 * Sonda para detectar si la lista blanca ELIMINARIA algo de un markup dado.
 *
 * `sanitize-html` no informa de lo que quita, y comparar su salida contra el
 * HTML crudo daria falsos positivos constantes: el parser normaliza aunque no
 * filtre (`<br>` pasa a `<br />`, reordena atributos, normaliza comillas). La
 * unica comparacion fiable es entre DOS pasadas del mismo parser, una con la
 * lista blanca y otra sin ella: lo que difiera lo quito el FILTRO, no el
 * formateo.
 *
 * Aplica el mismo `transformTags` a proposito. Sin eso, un
 * `<a target="_blank">` legitimo se rechazaria, porque la pasada estricta le
 * ANADE el `rel` y la permisiva no: una diferencia por adicion, no por
 * eliminacion.
 *
 * `allowVulnerableTags` silencia el aviso de la libreria por admitir `script`.
 * Es seguro aqui y solo aqui: esta salida NUNCA se persiste ni se devuelve al
 * cliente, existe unicamente para compararla con la estricta y descartarla.
 */
export const PUBLISHABLE_MARKUP_PROBE_CONFIG: sanitizeHtml.IOptions = {
  allowedTags: false,
  allowedAttributes: false,
  allowedSchemes: [
    'http',
    'https',
    'mailto',
    'javascript',
    'data',
    'tel',
    'ftp',
  ],
  allowVulnerableTags: true,
  transformTags: { a: forceSafeLinkRel },
};

/**
 * Salida del render, como union discriminada.
 *
 * Ni lanza ni devuelve `null`: cada rama lleva el dato que su consumidor
 * necesita para construir su propia respuesta —un `NodeResult` en la estrategia,
 * una excepcion HTTP en el controlador—, sin que el renderer conozca a ninguno.
 */
export type RenderOutcome =
  | { readonly markup: string }
  | { readonly missingFields: string[] }
  | { readonly failure: string; readonly stackTrace?: string };

/**
 * Compilacion estricta de plantillas Handlebars contra un contexto de namespaces.
 *
 * Existe como servicio propio, y no como metodo privado de la estrategia, porque
 * tiene DOS consumidores: `TemplateMapperStrategy` en tiempo de ejecucion y el
 * endpoint de previsualizacion del gestor. Con dos implementaciones, la vista
 * previa podria divergir del render real y acabar mintiendo al editor sobre lo
 * que se va a publicar; con una sola, eso no puede pasar.
 *
 * Es un servicio PURO: sin repositorio, sin red y sin estado. De ahi que las
 * pruebas puedan instanciarlo con `new` en vez de mockearlo.
 */
@Injectable()
export class TemplateRendererService {
  /**
   * Compila `htmlContent` sustituyendo las variables por su valor en `namespaces`.
   *
   * @param htmlContent Plantilla a compilar.
   * @param requiredVariables Rutas que se comprueban ANTES de compilar. Vacio
   *        omite el pre-chequeo y deja el corte al modo estricto de Handlebars.
   * @param namespaces Volcado del contexto.
   */
  public renderStrict(
    htmlContent: string,
    requiredVariables: readonly string[],
    namespaces: RenderNamespaces,
  ): RenderOutcome {
    // 1. Pre-chequeo. Handlebars en modo estricto tambien detendria el render,
    //    pero solo en la PRIMERA variable ausente: recorrer las rutas ya
    //    validadas al guardar permite informar de todas de golpe, que es lo que
    //    el operador necesita para arreglar el flujo en una sola pasada.
    const missingFields = this.findMissingVariables(
      requiredVariables,
      namespaces,
    );

    if (missingFields.length > 0) {
      return { missingFields };
    }

    try {
      // `strict: true` frente al `false` por defecto de Handlebars: una variable
      // ausente debe detener el flujo, no interpolarse como cadena vacia. Un
      // titular en blanco se publicaria sin que nadie se enterase, y el fallo
      // apareceria lejos de su causa.
      const render = Handlebars.compile(htmlContent, { strict: true });

      // El escapado de HTML por defecto de `{{ }}` se conserva a proposito: el
      // gestor prohibe el triple-stash, asi que ningun valor del contexto puede
      // inyectar markup en el articulo publicado.
      const compiledMarkup = render(namespaces);

      // Ultima linea de defensa, sobre el markup YA compilado: el escapado de
      // Handlebars cubre los valores del contexto, pero no el HTML que el editor
      // escribio en la propia plantilla. Se sanea aqui y no en el consumidor
      // porque los dos —la estrategia FSM y la vista previa— deben ver
      // exactamente el mismo resultado.
      return {
        markup: sanitizeHtml(compiledMarkup, TEMPLATE_SANITIZER_CONFIG),
      };
    } catch (error) {
      return {
        failure: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && error.stack !== undefined
          ? { stackTrace: error.stack }
          : {}),
      };
    }
  }

  /**
   * Indica si la lista blanca eliminaria algo del markup dado.
   *
   * Lo usa `TemplatesService` para rechazar al guardar en vez de dejar que el
   * recorte ocurra en silencio al compilar: el autor se entera al instante, como
   * ya pasa con los namespaces fuera de la lista blanca.
   *
   * @param html Markup a examinar, sin compilar.
   * @returns El resultado saneado y si difiere del original por un filtrado.
   */
  public inspectPublishableMarkup(html: string): {
    readonly sanitized: string;
    readonly wasFiltered: boolean;
  } {
    const sanitized = sanitizeHtml(html, TEMPLATE_SANITIZER_CONFIG);
    const normalized = sanitizeHtml(html, PUBLISHABLE_MARKUP_PROBE_CONFIG);

    return { sanitized, wasFiltered: sanitized !== normalized };
  }

  /**
   * Rutas que el contexto no puede resolver.
   *
   * Reutiliza `resolvePath`, la funcion pura del contexto FSM, para que la
   * comprobacion siga exactamente la misma gramatica de navegacion que la
   * interpolacion del motor.
   */
  private findMissingVariables(
    requiredVariables: readonly string[],
    namespaces: RenderNamespaces,
  ): string[] {
    return requiredVariables.filter((path) => {
      try {
        resolvePath(namespaces, path);
        return false;
      } catch (error) {
        if (error instanceof MissingContextVariableException) {
          return true;
        }

        // Cualquier otra cosa es imprevista: se deja subir en vez de
        // disfrazarla de variable ausente.
        throw error;
      }
    });
  }
}
