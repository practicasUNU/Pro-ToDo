import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as cheerio from 'cheerio';
import Handlebars from 'handlebars';
import sanitizeHtml from 'sanitize-html';

import {
  MissingContextVariableException,
  resolvePath,
} from '@core/fsm/context/state-payload.context';

import type { TemplateViolation } from '../dto/template-violation.dto';

/** Namespaces acumulados contra los que se compila una plantilla. */
export type RenderNamespaces = Record<string, Record<string, unknown>>;

/**
 * Namespace RESERVADO que el renderer inyecta por su cuenta.
 *
 * No lo produce ningun nodo: lo aporta el entorno, para que una plantilla pueda
 * componer la URL absoluta de una imagen sin incrustar el host. Empieza por `_`
 * a proposito, que es lo que lo distingue de los namespaces de nodo
 * (`OUTPUT_NAMESPACE_PATTERN` los obliga a empezar por `[a-z0-9]`), y sigue
 * cabiendo en `TEMPLATE_VARIABLE_PATTERN` sin tocar la gramatica del gestor.
 */
export const ASSETS_NAMESPACE = '_assets';

/** Prefijo de assets cuando `ASSETS_BASE_URL` no esta declarada. */
export const DEFAULT_ASSETS_BASE_URL = 'http://localhost:3000/static/uploads';

/**
 * Campos del contexto que se tratan como ruta relativa de asset.
 *
 * Solo estas claves se normalizan, y NO todo valor de cadena: recortar la barra
 * inicial de cualquier campo corromperia texto legitimo (un `clean_body` que
 * arranque con "/" o una URL absoluta en `source_url`). Cubre `image_path`,
 * `path`, `file_path`, `thumbnail_path`...
 */
const ASSET_PATH_KEY_PATTERN = /(?:^|_)path$/;

/** Barras iniciales de una ruta relativa; se recortan para no duplicarlas. */
const LEADING_SLASHES_PATTERN = /^\/+/;

/** Barras finales del prefijo de assets, por el mismo motivo. */
const TRAILING_SLASHES_PATTERN = /\/+$/;

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
    // Subrayado institucional: Madrid+D lo emplea para destacar plazos y fechas
    // de convocatoria ("Hasta el dia 8 de octubre"). Es presentacion pura, sin
    // superficie de ataque, y su ausencia rechazaba el marcado real completo.
    'u',
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
    // `style` sube al global: el marcado institucional lleva maquetacion en
    // linea en casi cualquier etiqueta. NO se declara `allowedStyles` a
    // proposito; hacerlo ENDURECERIA la regla actual (hoy cualquier propiedad
    // CSS pasa) y rechazaria `border`, `vertical-align` o `line-height`
    // legitimos. `data-*` usa el comodin nativo de la libreria: los clientes de
    // correo inyectan atributos propios (`data-olk-copy-source`) que son
    // metadatos inertes, no ejecutables.
    '*': ['id', 'class', 'style', 'data-*'],
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height'],
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
 * Lo que la auditoria comprueba, DERIVADO de `TEMPLATE_SANITIZER_CONFIG`.
 *
 * No hay una segunda lista blanca a proposito: dos listas que describen la misma
 * regla divergen en cuanto alguien toca una sola. Anadir `section` al saneador
 * dejaria al auditor marcandolo para siempre, y el autor recibiria un 400 por
 * algo que en realidad se publica sin problema.
 */
const ALLOWED_TAGS = new Set(
  (TEMPLATE_SANITIZER_CONFIG.allowedTags as string[]).map((tag) =>
    tag.toLowerCase(),
  ),
);

const ALLOWED_ATTRIBUTES =
  TEMPLATE_SANITIZER_CONFIG.allowedAttributes as Record<string, string[]>;

const ALLOWED_SCHEMES = new Set(
  (TEMPLATE_SANITIZER_CONFIG.allowedSchemes as string[]).map((scheme) =>
    scheme.toLowerCase(),
  ),
);

/** Atributos cuyo valor es una URL y por tanto puede portar un pseudo-protocolo. */
const URL_ATTRIBUTES = new Set(['href', 'src', 'action', 'xlink:href']);

/** Esquema inicial de una URL (`javascript:`, `data:`, `https:`). */
const URL_SCHEME_PATTERN = /^\s*([a-z][a-z0-9+.-]*)\s*:/i;

/** Atributo de evento en linea (`onerror`, `onclick`). */
const EVENT_ATTRIBUTE_PATTERN = /^on[a-z]+$/i;

/**
 * Marcador de interpolacion del motor como valor COMPLETO de un atributo.
 *
 * Anclado en los dos extremos a proposito: `javascript:{{raw_email.from}}` o
 * `data:text/html;{{...}}` NO encajan, asi que siguen cayendo en la
 * comprobacion de protocolo. Solo exime al valor que es exclusivamente un
 * marcador, cuyo esquema real no se conoce hasta la interpolacion en ejecucion.
 *
 * La gramatica replica la de `TEMPLATE_VARIABLE_PATTERN` del gestor de
 * plantillas (raiz, un campo y un indice opcional), que es la unica que el
 * motor sabe resolver.
 */
const CONTEXT_MARKER_PATTERN =
  /^\{\{\s*[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+(\[[0-9]+\])?\s*\}\}$/;

/**
 * Compara un atributo contra un patron de la lista blanca admitiendo comodines
 * prefijados (`data-*`), como hace `sanitize-html`.
 *
 * Se replica aqui porque la libreria no expone su emparejador, y el auditor
 * tiene que aceptar EXACTAMENTE lo mismo que el saneador: si no, marcaria como
 * infraccion un `data-olk-copy-source` que la puerta ya deja pasar, y el autor
 * recibiria un 400 por algo que en realidad se publica.
 *
 * El comodin universal `*` se rechaza: en el mapa de `allowedAttributes` esa
 * clave designa "cualquier ETIQUETA", no "cualquier atributo", y tratarla como
 * comodin abriria la lista blanca entera.
 */
const matchesAllowedAttribute = (
  pattern: string,
  attribute: string,
): boolean => {
  if (pattern === '*') {
    return false;
  }

  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);

    return prefix.length > 0 && attribute.startsWith(prefix);
  }

  return pattern === attribute;
};

/**
 * Salida del render, como union discriminada.
 *
 * Ni lanza ni devuelve `null`: cada rama lleva el dato que su consumidor
 * necesita para construir su propia respuesta —un `NodeResult` en la estrategia,
 * una excepcion HTTP en el controlador—, sin que el renderer conozca a ninguno.
 */
/** Resultado de preparar markup para inyectarlo en el contexto de un flujo. */
export interface InjectableMarkupOutcome {
  /** Markup tras aplicar la lista blanca efectiva. */
  readonly sanitized: string;
  /** Si la lista blanca elimino algo respecto del original. */
  readonly wasFiltered: boolean;
  /**
   * Etiquetas pedidas por el llamante que la lista blanca global NO admite.
   *
   * Se informan en vez de concederse: `allowedTags` solo puede RESTAR. Ampliar
   * la lista por parametro convertiria la configuracion de un nodo en una via
   * para reintroducir etiquetas que el saneador prohibe a conciencia.
   */
  readonly unsupportedTags: string[];
}

/** Resultado de comprobar que un markup conserva la estructura esperada. */
export interface StructureAudit {
  /** Selectores validos que no encuentran ningun nodo. */
  readonly missing: string[];
  /** Selectores que el motor de consultas no sabe interpretar. */
  readonly invalid: string[];
}

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
   * Prefijo de assets, resuelto UNA vez en el arranque y sin barra final.
   *
   * Se cachea en lugar de consultar `ConfigService` en cada render: el valor no
   * cambia en caliente (`backend/.env` solo se relee al reiniciar Nest) y
   * `renderStrict` se invoca una vez por nodo MAPEADOR_PLANTILLA.
   */
  private readonly assetsBaseUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.assetsBaseUrl = (
      this.configService.get<string>('ASSETS_BASE_URL') ??
      DEFAULT_ASSETS_BASE_URL
    ).replace(TRAILING_SLASHES_PATTERN, '');
  }

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
    // 0. Contexto efectivo: rutas de asset normalizadas y namespace sintetico
    //    `_assets` fusionado. Va ANTES del pre-chequeo porque
    //    `{{_assets.base_url}}` figura en `requiredVariables` de la plantilla, y
    //    comprobarlo sobre el contexto crudo lo reportaria siempre como ausente.
    const effectiveNamespaces = this.withAssetsNamespace(namespaces);

    // 1. Pre-chequeo. Handlebars en modo estricto tambien detendria el render,
    //    pero solo en la PRIMERA variable ausente: recorrer las rutas ya
    //    validadas al guardar permite informar de todas de golpe, que es lo que
    //    el operador necesita para arreglar el flujo en una sola pasada.
    const missingFields = this.findMissingVariables(
      requiredVariables,
      effectiveNamespaces,
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
      const compiledMarkup = render(effectiveNamespaces);

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
   * Prepara un markup para inyectarlo tal cual en el contexto de la ejecucion.
   *
   * Lo usa `TemplateMapperStrategy`: el nodo ya no compila la plantilla, la
   * entrega saneada para que un `PROCESADOR_IA` posterior la rellene. El
   * saneado vive aqui y no en la estrategia a proposito, para que exista UNA
   * sola lista blanca en el backend; una segunda copia divergiria del gestor en
   * cuanto alguien tocara solo una de las dos.
   *
   * @param html Markup a preparar, sin compilar.
   * @param allowedTags Subconjunto con el que ESTRECHAR la lista blanca. Vacio
   *        deja la lista completa. Nunca la amplia: lo que no este en
   *        `TEMPLATE_SANITIZER_CONFIG` se devuelve en `unsupportedTags`.
   */
  public prepareInjectableMarkup(
    html: string,
    allowedTags: readonly string[] = [],
  ): InjectableMarkupOutcome {
    const requested = allowedTags.map((tag) => tag.toLowerCase());
    const unsupportedTags = [
      ...new Set(requested.filter((tag) => !ALLOWED_TAGS.has(tag))),
    ];

    // Interseccion y no lo pedido a secas: aunque el llamante nombre una
    // etiqueta prohibida, el saneado corre igualmente con la lista recortada.
    // Quien decide si `unsupportedTags` aborta la operacion es el consumidor.
    const effectiveTags = requested.filter((tag) => ALLOWED_TAGS.has(tag));

    const options: sanitizeHtml.IOptions =
      effectiveTags.length > 0
        ? { ...TEMPLATE_SANITIZER_CONFIG, allowedTags: effectiveTags }
        : TEMPLATE_SANITIZER_CONFIG;

    const sanitized = sanitizeHtml(html, options);

    // Misma tecnica de dos pasadas que `inspectPublishableMarkup`, y no una
    // comparacion contra el original: el saneador normaliza comillas y cierres
    // aunque no filtre nada, y compararlo crudo daria `wasFiltered` siempre.
    const normalized = sanitizeHtml(html, PUBLISHABLE_MARKUP_PROBE_CONFIG);

    return { sanitized, wasFiltered: sanitized !== normalized, unsupportedTags };
  }

  /**
   * Comprueba que un markup conserva los selectores que el flujo da por hechos.
   *
   * Es el contrato estructural del nodo MAPEADOR_PLANTILLA. Hace falta porque
   * `TemplatesService` prohibe los marcadores libres: una ranura que la IA debe
   * rellenar no se puede nombrar con `{{hueco}}`, solo por su posicion en el DOM.
   *
   * No lanza, igual que `auditPublishableMarkup`: este servicio devuelve datos y
   * es el consumidor quien construye el `NodeResult` o la excepcion HTTP.
   *
   * @param html Markup a examinar, preferiblemente YA saneado: un selector que
   *        apunte a una etiqueta que la lista blanca descarta debe contar como
   *        ausente, no como presente.
   * @param requiredSelectors Selectores CSS exigidos.
   */
  public auditStructure(
    html: string,
    requiredSelectors: readonly string[],
  ): StructureAudit {
    if (requiredSelectors.length === 0) return { missing: [], invalid: [] };

    // Mismo parser y mismas banderas que `auditPublishableMarkup`; el porque
    // esta documentado en extenso en ese metodo (htmlparser2 no sintetiza
    // `<html>`/`<body>`, y `xml` como objeto evita el modo sensible a mayusculas).
    const $ = cheerio.load(html, { xml: { xmlMode: false } }, false);

    const missing: string[] = [];
    const invalid: string[] = [];

    for (const selector of requiredSelectors) {
      try {
        if ($(selector).length === 0) missing.push(selector);
      } catch {
        // Un selector que el motor no sabe parsear no es "ausente": es un error
        // de configuracion del nodo, y mezclarlo con los ausentes mandaria al
        // operador a mirar la plantilla en vez de su propia lista.
        invalid.push(selector);
      }
    }

    return { missing, invalid };
  }

  /**
   * Enumera QUE construcciones del markup rechazaria la lista blanca.
   *
   * Complementa a `inspectPublishableMarkup`, que solo responde si/no: aquella
   * es la puerta —exhaustiva por construccion, porque compara dos pasadas del
   * saneador entero— y esta es el localizador, que devuelve algo que el editor
   * puede subrayar. Se mantienen las dos: reducir la puerta a estas reglas
   * perderia cobertura (un `srcset` no es ni etiqueta, ni evento, ni protocolo).
   *
   * No lanza. Este servicio es puro y devuelve datos; construir la excepcion
   * HTTP es cosa de `TemplatesService`, que es quien conoce el transporte.
   *
   * @param html Markup a examinar, sin compilar.
   * @returns Infracciones unicas, en orden de aparicion. Vacio si no hay ninguna.
   */
  public auditPublishableMarkup(html: string): TemplateViolation[] {
    // Cambiar a htmlparser2 NO es un detalle de gusto: con el parser por
    // defecto (parse5) ninguno de sus dos modos sirve. En modo fragmento
    // (`isDocument: false`) descarta `<body>`, `<html>` y `<head>` por ser
    // invalidos en ese contexto, y la infraccion se volveria indetectable; en
    // modo documento los SINTETIZA en cualquier entrada, y marcaria el 100% de
    // las plantillas. htmlparser2 conserva el arbol tal y como se escribio.
    //
    // Ademas es el mismo parser que usa `sanitize-html`, asi que auditor y
    // saneador ven un unico DOM en vez de dos que podrian discrepar.
    //
    // `xml` como OBJETO y no `xml: true`: basta con que sea truthy para elegir
    // htmlparser2, pero `true` activa ademas el modo XML, que es sensible a
    // mayusculas y dejaria `<BODY>` como `BODY`, fuera de la lista blanca.
    const $ = cheerio.load(html, { xml: { xmlMode: false } }, false);

    // `Map` y no array: de-duplica por `target` conservando el orden de
    // aparicion. Diez `<script>` son un unico problema que resolver.
    const violations = new Map<string, TemplateViolation>();

    const register = (
      target: string,
      type: TemplateViolation['type'],
      message: string,
    ): void => {
      if (!violations.has(target)) {
        violations.set(target, { target, type, message });
      }
    };

    $('*').each((_index, element) => {
      // `$('*')` esta tipado como `AnyNode`, union que incluye `Document`. Se
      // estrecha por la presencia de `tagName` en lugar de comparar
      // `element.type === 'tag'`: domhandler etiqueta `<script>` y `<style>`
      // con su propio tipo, y esa comparacion dejaria fuera justo las dos
      // etiquetas mas peligrosas. Tampoco se importa `Element` de `domhandler`,
      // que es una dependencia transitiva y no declarada.
      if (!('tagName' in element)) {
        return;
      }

      const tagName = element.tagName.toLowerCase();

      if (!ALLOWED_TAGS.has(tagName)) {
        register(tagName, 'tag', `Etiqueta <${tagName}> no permitida`);

        // Sus atributos no se inspeccionan: el saneador descarta el elemento
        // entero, asi que senalarlos solo anadiria ruido a lo que el autor tiene
        // que corregir, que es la etiqueta.
        return;
      }

      // Array y no `Set`: la lista puede contener comodines (`data-*`), que
      // exigen comparacion por patron en vez de busqueda exacta.
      const allowedForTag = [
        ...(ALLOWED_ATTRIBUTES['*'] ?? []),
        ...(ALLOWED_ATTRIBUTES[tagName] ?? []),
      ];

      for (const [rawName, rawValue] of Object.entries(element.attribs)) {
        const attribute = rawName.toLowerCase();

        // Clausula de guarda: los eventos en linea se evaluan ANTES que la
        // lista blanca. Defensa en profundidad frente a un comodin que algun
        // dia se ampliara de mas; un `onerror` jamas debe poder colarse por
        // coincidir con un patron.
        if (EVENT_ATTRIBUTE_PATTERN.test(attribute)) {
          register(
            attribute,
            'attribute',
            `Atributo de evento '${attribute}' no permitido`,
          );
        } else if (
          !allowedForTag.some((pattern) =>
            matchesAllowedAttribute(pattern, attribute),
          )
        ) {
          register(
            attribute,
            'attribute',
            `Atributo '${attribute}' no permitido en <${tagName}>`,
          );
        }

        if (!URL_ATTRIBUTES.has(attribute)) {
          continue;
        }

        // Un marcador del motor como valor INTEGRO del atributo no se juzga
        // aqui: el esquema que acabara teniendo depende del contexto en
        // ejecucion, y el saneador del render lo revisara ya interpolado.
        if (CONTEXT_MARKER_PATTERN.test(rawValue)) {
          continue;
        }

        const [, scheme] = URL_SCHEME_PATTERN.exec(rawValue) ?? [];

        // Sin esquema no hay infraccion: `/ruta/relativa` y `#ancla` son
        // enlaces legitimos que el saneador conserva.
        if (scheme === undefined) {
          continue;
        }

        const normalizedScheme = scheme.toLowerCase();

        if (!ALLOWED_SCHEMES.has(normalizedScheme)) {
          register(
            `${normalizedScheme}:`,
            'protocol',
            `Protocolo '${normalizedScheme}:' no permitido en el atributo '${attribute}'`,
          );
        }
      }
    });

    return [...violations.values()];
  }

  /**
   * Contexto efectivo del render: rutas de asset normalizadas y `_assets` dentro.
   *
   * NORMALIZACION TEMPRANA: se hace aqui y no en la plantilla porque el gestor
   * no admite helpers de Handlebars (`security-and-scope.md` §3), asi que no hay
   * donde recortar la barra en el propio marcado. Un `image_path` que llegue
   * como `/2026/09/foto.jpg` produciria
   * `http://host/static/uploads//2026/09/foto.jpg`: la doble barra no rompe la
   * peticion, pero cambia la URL canonica del recurso y ensucia la trazabilidad.
   *
   * `_assets` se fusiona al FINAL: sobrescribe cualquier namespace homonimo que
   * viniera del contexto, de modo que un nodo no pueda suplantar el prefijo de
   * assets escribiendo en `_assets` por su cuenta.
   */
  private withAssetsNamespace(namespaces: RenderNamespaces): RenderNamespaces {
    const sanitizedNamespaces: RenderNamespaces = Object.fromEntries(
      Object.entries(namespaces).map(([namespace, data]) => [
        namespace,
        this.normalizeAssetPaths(data),
      ]),
    );

    return {
      ...sanitizedNamespaces,
      [ASSETS_NAMESPACE]: { base_url: this.assetsBaseUrl },
    };
  }

  /**
   * Recorta las barras iniciales de los campos de ruta de un namespace.
   *
   * Recorrido de UN nivel: `ASSET_PATH_KEY_PATTERN` describe claves de campo, y
   * bajar recursivamente a arreglos y subobjetos obligaria a clonar en
   * profundidad todo el contexto en cada render para respetar la inmutabilidad
   * del `StatePayloadContext`. Las rutas de asset que el pipeline produce viven
   * en la raiz del namespace del nodo (`parsed_email.image_path`).
   */
  private normalizeAssetPaths(
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(data).map(([key, value]) =>
        ASSET_PATH_KEY_PATTERN.test(key) && typeof value === 'string'
          ? [key, value.replace(LEADING_SLASHES_PATTERN, '')]
          : [key, value],
      ),
    );
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
