// Mismas dos guardas que el E2E hermano, y por el mismo motivo: van ANTES de
// los imports porque `ImapPollingService` y `CronSchedulingService` las leen en
// su `onModuleInit`, de modo que levantar el contexto con los valores del `.env`
// de desarrollo inscribiria sondeos contra buzones reales y los CRON de todos
// los flujos activos mientras dure la limpieza.
process.env.IMAP_POLLING_ENABLED = 'false';
process.env.CRON_SCHEDULING_ENABLED = 'false';

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import axios from 'axios';
import * as cheerio from 'cheerio';

import { DrupalApiConfig } from '@core/config/drupal-api.config';

import { AppModule } from '../app.module';

/**
 * Purga de los bloques que las pruebas E2E dejan publicados en el sandbox.
 *
 *   npm run drupal:cleanup                                  # /prueba-verificador-titulos
 *   npm run drupal:cleanup -- /prueba-licitaciones
 *   npm run drupal:cleanup -- /prueba-licitaciones '.mi-selector'
 *   npm run drupal:cleanup -- /prueba-verificador-titulos --dry-run
 *
 * EMPIEZA SIEMPRE POR `--dry-run`. Imprime el desglose por selector y sale sin
 * escribir. La bandera se reconoce en cualquier posicion, porque los dos
 * argumentos de verdad son posicionales y confundirla con un selector dejaria
 * correr la purga que se queria evitar (ver `splitCliArgs`).
 *
 * POR QUE EXISTE. `www.madrimasd.org` es el portal de verdad: las paginas son de
 * sandbox, pero lo que se escribe en ellas queda publicado y visible, y cada
 * corrida con `--write` anade un bloque mas. Hasta ahora habia que retirarlos a
 * mano, deuda que el propio `test-drupal-sandbox-e2e.ts` ya declaraba.
 *
 * POR QUE ERA SEGURO, Y QUE HA CAMBIADO. La purga no adivina que es contenido
 * de prueba: busca marcadores. El TSDoc decia aqui que la produccion no
 * estampaba ninguno y que esa asimetria era «la garantia entera», advirtiendo
 * de que el dia que la produccion marcase lo que inyecta este script pasaria a
 * borrar contenido legitimo.
 *
 * ESE DIA YA LLEGO. La migracion 034 siembra `data-protodo-injected="true"` en
 * la plantilla del verificador de titulos, de modo que un panel publicado por
 * un flujo REAL tambien lo lleva y `[data-protodo-injected="true"]` lo alcanza.
 * Lo que sigue distinguiendo a una corrida de prueba es `data-test-id`, que solo
 * estampan los scripts E2E.
 *
 * Mientras tanto, el selector por defecto de este script sigue siendo el par
 * completo, asi que una limpieza de sandbox puede llevarse por delante un panel
 * de produccion publicado en la misma pagina. Para retirar contenido real a
 * conciencia esta `npm run drupal:clean` (`drupal-cleanup.ts`), que simula por
 * defecto y obliga a `--write`.
 *
 * ALCANCE DE «no altera el contenido editorial». Es cierto en ESTRUCTURA, no
 * byte a byte. El PATCH reescribe el `body.value` entero con la serializacion de
 * cheerio, que normaliza —`<br/>` pasa a `<br>`, `&nbsp;` a `&#xa0;`, un
 * atributo sin comillas las gana—. No lo introduce este script: es el mismo
 * viaje de ida y vuelta que `runAppendHtmlBlock` hace en cada publicacion.
 */
const logger = new Logger('DrupalSandboxCleanup');

/** Alias por defecto, que es la pagina del verificador de titulos. */
const DEFAULT_PATH_ALIAS = '/prueba-verificador-titulos';

/** Coleccion contra la que se resuelven los alias de pagina estatica. */
const DEFAULT_BUNDLE = 'node--page';

/** Formato de texto enriquecido con el que Drupal guarda estos cuerpos. */
const DEFAULT_BODY_FORMAT = 'full_html';

/** UUID v4 canonico, para distinguir un identificador de un alias de ruta. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Alias conocido -> NOMBRE de la variable que trae su UUID.
 *
 * El mapa guarda el nombre y no el valor a proposito. Leer `process.env` aqui no
 * funcionaria: quien vuelca el `.env` es el `ConfigModule` de `AppModule`, y lo
 * hace DENTRO de `createApplicationContext`, es decir despues de que estas
 * constantes de modulo ya se evaluaron. Un mapa con valores saldria siempre con
 * el respaldo y la variable no serviria para nada.
 */
const SANDBOX_UUID_VARS: Readonly<Record<string, string>> = {
  '/prueba-licitaciones': 'DRUPAL_SANDBOX_LICITACIONES_UUID',
  '/prueba-verificador-titulos': 'DRUPAL_SANDBOX_TITULOS_UUID',
};

/**
 * Respaldo cableado de los dos nodos de sandbox confirmados en produccion.
 *
 * Son identificadores PUBLICOS, no credenciales. El respaldo existe porque los
 * valores del `.env.example` son marcadores falsos (`00000000-0000-4000-...`):
 * un `.env` copiado de la plantilla daria un 404 opaco en vez de funcionar. La
 * variable sigue mandando cuando trae algo, que es lo que permite apuntar a otra
 * instalacion sin tocar este archivo.
 */
/**
 * Suelo del timeout de este script, en milisegundos.
 *
 * La pagina agregadora de titulos ronda los 250 KB de cuerpo y el portal tarda
 * del orden de ochenta segundos en servirla. El defecto de `DrupalApiConfig`
 * —quince segundos, dimensionado para las llamadas de un nodo en ejecucion—
 * corta la lectura antes de empezar. Se toma el MAYOR de los dos para que subir
 * `DRUPAL_API_TIMEOUT_MS` en el entorno siga mandando.
 */
const CLEANUP_MIN_TIMEOUT_MS = 120_000;

const SANDBOX_UUID_FALLBACKS: Readonly<Record<string, string>> = {
  '/prueba-licitaciones': '7f1700bf-b54b-4c12-b71a-8a71f1f0ee38',
  '/prueba-verificador-titulos': 'b17d69d8-6998-4883-b8dc-153b55dbd9c5',
};

/**
 * Prefijo que ANCLA la purga al segundo nivel del acordeon.
 *
 * NO ES DECORATIVO, Y ESTA LINEA SE PAGO CARA. La pagina agregadora es un
 * acordeon de dos niveles: catorce paneles de universidad y, dentro de cada
 * uno, un `.panel-group` con sus comites. Los dos llevan la MISMA clase
 * `.panel`, de modo que un `.panel:has(#loQueSea)` casa tambien con el panel de
 * la universidad que contiene el comite buscado, y el `.remove()` se lleva el
 * contenedor entero con todos sus hijos.
 *
 * Fue exactamente lo que le paso a `ESIC Universidad`: desaparecio de la pagina
 * por un selector que pretendia quitar UN panel de comite duplicado. Exigir que
 * el `.panel-group` este a su vez DENTRO de otro `.panel-group` deja fuera el
 * primer nivel, que es donde viven los padres.
 */
const COMMITTEE_PANEL_SCOPE = '.panel-group .panel-group > .panel';

/**
 * Selectores de purga, en orden de aplicacion.
 *
 * El orden NO es indiferente. Los que se llevan el panel entero van primero;
 * cuando les toca el turno a los demas, sus nodos ya estan desconectados del
 * arbol y no vuelven a contarse.
 *
 * POR QUE SE ANCLA EN LAS CLASES DE LA PLANTILLA y no en el marcador. El
 * atributo `data-protodo-injected` NO SOBREVIVE AL VIAJE: Drupal lo filtra al
 * guardar el cuerpo, y en la pagina de titulos da hoy cero coincidencias pese a
 * seguir ahi los catorce paneles que lo llevaban al publicarse. `panel-toggle-link`
 * y `panel-comite-codigo`, en cambio, son clases y sobreviven. Los paneles
 * nativos del portal no las llevan —sus enlaces van sin clase—, asi que
 * distinguen lo que publico Proto-Do de lo que ya estaba.
 *
 * Los de `.licitacion-entry` cubren los bloques de licitacion de prueba, que se
 * marcan por expediente en vez de por atributo porque esa es la forma que ya
 * tenian antes de que existiera este script.
 */
const DEFAULT_PURGE_SELECTORS: readonly string[] = [
  `${COMMITTEE_PANEL_SCOPE}:has(a.panel-toggle-link)`,
  `${COMMITTEE_PANEL_SCOPE}:has(.panel-comite-codigo)`,
  `${COMMITTEE_PANEL_SCOPE}:has(#collapseUFV1Duplicado)`,
  `${COMMITTEE_PANEL_SCOPE}:has(#collapseCEU_TEST)`,
  '[data-protodo-injected="true"]',
  '[data-test-id="PROTODO-E2E-TITULOS"]',
  '.licitacion-entry[data-expediente^="TEST_"]',
  '.licitacion-entry[data-expediente^="EXP-SANDBOX-"]',
  '.licitacion-entry[data-expediente="S_2026_015_TEST"]',
  '.licitacion-entry[data-expediente="S_2026_015"]', // Limpieza de pruebas reales E2E
  '.licitacion-entry', // Todo bloque generado por TemplateMapperStrategy
];

/** Respuesta de JSON:API para una entidad suelta. */
export interface DrupalNodeResponse {
  readonly data?: {
    readonly id?: string;
    readonly attributes?: {
      readonly body?: {
        readonly value?: string;
        readonly format?: string;
      };
    };
  };
}

/** Respuesta de JSON:API para una coleccion filtrada. */
interface DrupalCollectionResponse {
  readonly data?: ReadonlyArray<{ readonly id?: string }>;
}

export interface CleanupOptions {
  /** Alias de la pagina, con o sin barra inicial. */
  readonly pathAlias: string;

  /** Atajo: si se conoce el UUID, se ahorra el GET de resolucion. */
  readonly nodeUuid?: string;

  /** Coleccion donde vive la pagina. Por defecto `node--page`. */
  readonly bundle?: string;

  /** Selector adicional, que se evalua ANTES que los de serie. */
  readonly customSelector?: string;

  /**
   * Inventaria y sale, sin emitir el PATCH.
   *
   * Por defecto `false`, que es el comportamiento historico del script. Se
   * declara como opcion del servicio y no como un `if` en el CLI para que la
   * decision de escribir viva en el mismo sitio que la escritura.
   */
  readonly dryRun?: boolean;
}

export interface CleanupResult {
  readonly purgedCount: number;
  readonly updated: boolean;
  readonly targetUuid: string;

  /** Desglose por selector. Solo se rellena en simulacro. */
  readonly matches?: readonly PurgeMatch[];

  /** Titulos de los paneles de universidad repuestos en esta corrida. */
  readonly restored?: readonly string[];
}

/** Resultado de la poda en memoria, sin tocar la red. */
export interface PurgeOutcome {
  readonly html: string;
  readonly purgedCount: number;
}

/**
 * Quita del marcado los elementos que casen con los selectores dados.
 *
 * Se extrae del servicio a proposito: es la unica pieza de todo esto que se
 * puede verificar sin credenciales ni salida a internet, y es justo donde vive
 * el riesgo —un selector de mas no falla, borra contenido ajeno y devuelve
 * exito—. Como funcion pura entra en una prueba unitaria; dentro del metodo que
 * hace el GET y el PATCH, no.
 *
 * Las banderas de carga son las CANONICAS del proyecto: `isDocument: false`
 * carga como fragmento, sin sintetizar `<html>`/`<body>` alrededor del cuerpo, y
 * el `xml` truthy fuerza htmlparser2 sin activar el modo XML sensible a
 * mayusculas.
 */
export const purgeMarkedBlocks = (
  html: string,
  selectors: readonly string[],
): PurgeOutcome => {
  const $ = cheerio.load(html, { xml: { xmlMode: false } }, false);
  let purgedCount = 0;

  for (const selector of selectors) {
    const targets = $(selector);

    if (targets.length > 0) {
      purgedCount += targets.length;
      targets.remove();
    }
  }

  // Si no habia nada que quitar se devuelve el original SIN serializar: el
  // llamante corta ahi y no emite PATCH, de modo que una pagina ya limpia no
  // recibe la normalizacion de cheerio por el mero hecho de haberla revisado.
  return purgedCount === 0
    ? { html, purgedCount }
    : { html: $.html(), purgedCount };
};

/** Cuantos elementos casa cada selector, sin tocar el documento. */
export interface PurgeMatch {
  readonly selector: string;
  readonly matches: number;
}

/**
 * Inventario de lo que una purga se llevaria, SIN llevarselo.
 *
 * Es el respaldo del simulacro: un recuento total no sirve para decidir, porque
 * lo que el operador necesita saber es CUAL de los selectores esta mordiendo. El
 * de serie `.licitacion-entry` alcanza todo bloque generado por
 * `TemplateMapperStrategy`, tambien el de produccion, y la diferencia entre una
 * limpieza y un destrozo esta en esa linea del inventario.
 *
 * Cuenta sobre una carga PROPIA y no reutiliza la de `purgeMarkedBlocks` porque
 * aquella va quitando a medida que recorre: alli un selector generico desconecta
 * los nodos que el siguiente habria contado, y ese solapamiento —deseable al
 * purgar, ver el orden de `DEFAULT_PURGE_SELECTORS`— falsearia el inventario.
 * Por eso aqui la suma de `matches` puede superar al `purgedCount` real.
 */
export const describePurgeMatches = (
  html: string,
  selectors: readonly string[],
): readonly PurgeMatch[] => {
  const $ = cheerio.load(html, { xml: { xmlMode: false } }, false);

  return selectors
    .map((selector) => ({ selector, matches: $(selector).length }))
    .filter((match) => match.matches > 0);
};

/** Un panel de universidad que la pagina debe tener, con su titulo. */
export interface UniversityPanelRestoration {
  /** Texto exacto del enlace de cabecera. Es la clave de la idempotencia. */
  readonly title: string;

  /** El panel de primer nivel completo, listo para colgar de `#accordion`. */
  readonly html: string;
}

/**
 * Paneles de universidad que esta pagina debe tener SIEMPRE.
 *
 * Hoy solo ESIC, y es deliberado que no este tambien Francisco de Vitoria: ese
 * sigue publicado. Meterlo aqui "por simetria" lo duplicaria en cuanto alguien
 * confundiera la comprobacion por panel con una comprobacion por bloque.
 *
 * IDENTIFICADORES PROPIOS, Y NO LOS DE UFV. El bloque del que sale esto
 * reutilizaba `collapseUFV`, `accordionUFV` y `collapseUFV1` para ESIC, que son
 * los que ya ocupa el panel de Francisco de Vitoria. Pegarlo asi habria dejado
 * tres `#accordionUFV` en la pagina y una cabecera de ESIC que despliega el
 * colapsable de otra universidad.
 */
const UNIVERSITY_PANELS_TO_RESTORE: readonly UniversityPanelRestoration[] = [
  {
    title: 'ESIC Universidad',
    html: '<div class="panel panel-default" aria-expanded="false"><div class="panel-heading"><h4 class="panel-title"><a href="#collapseESIC" aria-expanded="true" data-parent="#accordion" data-bs-toggle="collapse">ESIC Universidad</a></h4><div class="collapse" id="collapseESIC"><div class="panel-body accordion-inner"><div class="panel-group" id="accordionESIC"><div class="panel panel-default" aria-expanded="false"><div class="panel-heading"><h5 class="panel-title"><a href="#collapseESIC1" aria-expanded="false" data-parent="#accordionESIC" data-bs-toggle="collapse"><strong>ESIC 1 &nbsp;</strong> Facultad de Ciencias Jurídicas y Sociales</a></h5></div><div class="collapse" id="collapseESIC1"><div class="panel-body"><div class="pane"><table class="tableform"><tbody><tr><th>4317229</th><th colspan="2">Máster Universitario en Dirección de Personas y Desarrollo Organizativo por la ESIC Universidad</th></tr><tr><th>4317233</th><th colspan="2">Máster Universitario en Dirección de Marketing por la ESIC Universidad</th></tr><tr><th>4317235</th><th colspan="2">Máster Universitario en Dirección de Comunicación y Nuevas Tecnologías por la ESIC Universidad</th></tr><tr><th>&nbsp;</th><th style="background-color:#A9BCF5;">Evaluador</th><th style="background-color:#A9BCF5;">Institución</th></tr><tr><th>Presidente: &nbsp; &nbsp; &nbsp;</th><th>Manuel Sánchez Pérez</th><th>UAL</th></tr><tr><th>Secretario:</th><th>María Brígido Mero</th><th>Fmi+d</th></tr><tr><th>Vocal:</th><th>Teresa Fayos Gardó</th><th>UV</th></tr><tr><th>Estudiante:</th><th>Laura Cordero Martínez</th><th>EFV</th></tr><tr><th style="background-color:#C6E0B4;border:1px solid black;" colspan="3">Fecha Visita: &nbsp; &nbsp;28 y 29 de mayo</th></tr></tbody></table></div></div></div></div></div></div></div></div>',
  },
];

/** Lo que la restauracion devuelve: el HTML y que paneles ha repuesto. */
export interface RestorationOutcome {
  readonly html: string;
  readonly restored: readonly string[];
}

/**
 * Repone los paneles de universidad que falten, y solo esos.
 *
 * SE COMPRUEBA UNO A UNO, no el conjunto. La tentacion es preguntar "¿falta
 * alguno?" y reinyectar el bloque entero; con eso, faltando ESIC se repondria
 * tambien Francisco de Vitoria, que esta, y la pagina acabaria con dos. La
 * idempotencia de esta funcion es lo unico que hace seguro llamarla en cada
 * corrida del script.
 *
 * Si no hay `#accordion` no inventa nada: esta funcion repone lo que falta
 * dentro de una estructura que existe, no construye la estructura.
 */
export const restoreMissingUniversityPanels = (
  html: string,
  panels: readonly UniversityPanelRestoration[] = UNIVERSITY_PANELS_TO_RESTORE,
): RestorationOutcome => {
  const $ = cheerio.load(html, { xml: { xmlMode: false } }, false);
  const root = $('#accordion').first();

  if (root.length === 0) {
    return { html, restored: [] };
  }

  const present = new Set(
    $('#accordion > .panel')
      .toArray()
      .map((element) =>
        $(element).find('.panel-title > a').first().text().trim(),
      ),
  );

  const restored: string[] = [];

  for (const panel of panels) {
    if (present.has(panel.title)) {
      continue;
    }

    root.append(panel.html);
    restored.push(panel.title);
  }

  // Sin reposiciones se devuelve el ORIGINAL sin serializar, por el mismo
  // motivo que `purgeMarkedBlocks`: una pagina intacta no debe recibir la
  // normalizacion de cheerio por el mero hecho de haberla revisado.
  return restored.length === 0
    ? { html, restored: [] }
    : { html: $.html(), restored };
};

/** Un UUID v4, en oposicion a un alias de ruta. */
export const isUuid = (value: string): boolean =>
  UUID_PATTERN.test(value.trim());

/**
 * Deja dos HTML comparables pese a la cosmetica del viaje por Drupal.
 *
 * Unifica las TRES formas del espacio duro, que es la trampa de este caso:
 * cheerio serializa a `&#xa0;` y no a `&nbsp;`, de modo que normalizar solo la
 * entidad con nombre deja la diferencia intacta.
 */
export const normalizeHtmlForComparison = (raw: string): string =>
  raw
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(?:xa0|160);/gi, ' ')
    .replace(/\u00a0/g, ' ')
    // El espacio ENTRE etiquetas se borra, no se colapsa: una reindentacion de
    // Drupal mete saltos y sangrias ahi, y dejarlos reducidos a un espacio
    // seguiria marcando como distinto un cuerpo identicamente estructurado.
    .replace(/>\s+</g, '><')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Texto plano del fragmento, colapsado.
 *
 * Es la medida que distingue «Drupal reescribio el formato» de «falta
 * contenido»: la cosmetica no cambia lo que se lee, un borrado si.
 */
export const textContentOf = (html: string): string =>
  cheerio
    .load(html, { xml: { xmlMode: false } }, false)
    .root()
    .text()
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Literal que la plantilla base siembra en el `href` y en el `id` del panel.
 *
 * Es deliberadamente inverosimil: su unico cometido es ser RECONOCIBLE si el
 * modelo no lo sustituye. Un valor creible como `collapse1` habria hecho ese
 * fallo invisible tambien aqui.
 */
export const COLLAPSE_PLACEHOLDER = 'collapsePanelId';

/**
 * Literal que la plantilla siembra en el `data-parent` del enlace.
 *
 * Hermano del anterior y con el mismo cometido: ser RECONOCIBLE si el modelo no
 * lo sustituye por el acordeon de la universidad que toca. Antes de la
 * migracion 035 ese atributo venia cableado a `#accordionCEU`, que es un valor
 * perfectamente creible —y que el modelo copiaba tal cual—, de modo que los
 * comites de las otras trece universidades acababan apuntando a CEU sin que
 * nada lo delatase.
 */
export const ACCORDION_PLACEHOLDER = '#accordionPadreId';

/**
 * Motivos por los que un panel no desplegaria al pulsarlo.
 *
 * POR QUE NO LO VE EL ESCUDO_POST_IA. `auditFilledSlots` responde a «quedo algo
 * en esta ranura», y un placeholder sin sustituir la deja rellena: el escudo lo
 * aprueba. El sintoma tampoco aparece al publicar —el fragmento se inyecta
 * entero y bien formado— sino al pulsar el panel en la pagina real, donde
 * Bootstrap busca por `id` y encuentra el del vecino. Esta es, por tanto, la
 * unica comprobacion del sistema que lo caza.
 *
 * Devuelve los motivos en vez de lanzar para que quien la llame decida: el E2E
 * aborta, y un futuro consumidor podria querer solo avisar.
 */
export const findUndeployablePanelReasons = (
  markup: string,
): readonly string[] => {
  const $ = cheerio.load(markup, { xml: { xmlMode: false } }, false);
  const reasons: string[] = [];

  if (markup.includes(COLLAPSE_PLACEHOLDER)) {
    reasons.push(
      `El marcado conserva el valor de relleno "${COLLAPSE_PLACEHOLDER}": el modelo no lo ` +
        'sustituyo por un identificador derivado del comite.',
    );
  }

  // Mismo modo de fallo que el anterior, un nivel mas arriba: el panel se
  // publica bien formado y el escudo lo aprueba, pero `DrupalHttpStrategy` no
  // encuentra el sub-acordeon y el comite no llega a su universidad. Aqui se
  // caza antes de gastar la publicacion.
  if (markup.includes(ACCORDION_PLACEHOLDER)) {
    reasons.push(
      `El marcado conserva el valor de relleno "${ACCORDION_PLACEHOLDER}": el modelo no asigno ` +
        'el acordeon de la universidad que corresponde al comite.',
    );
  }

  const toggle = $('a.panel-toggle-link').first();

  if (toggle.length === 0) {
    reasons.push(
      'No hay ningun "a.panel-toggle-link" que despliegue el panel.',
    );

    return reasons;
  }

  const href = (toggle.attr('href') ?? '').trim();

  if (!href.startsWith('#') || href.length <= 1) {
    reasons.push(
      `El href del enlace ("${href}") no apunta a un fragmento de la propia pagina.`,
    );

    return reasons;
  }

  // `#collapseCEU1` -> `collapseCEU1`. Se busca por atributo y no con el
  // selector de id, porque un identificador con caracteres que CSS reserva
  // haria estallar el selector en vez de reportar el fallo.
  const targetId = href.slice(1);

  if ($(`.collapse[id="${targetId}"]`).length === 0) {
    reasons.push(
      `El href apunta a "#${targetId}" pero ningun ".collapse" del panel lleva ese id. ` +
        'Bootstrap no encontraria el contenedor y el panel no desplegaria.',
    );
  }

  return reasons;
};

/** `node--page` -> `node/page`. */
const toEntityPath = (bundle: string): string => bundle.replace('--', '/');

/** Alias normalizado con barra inicial, que es como lo guarda Drupal. */
const toCanonicalAlias = (pathAlias: string): string =>
  pathAlias.startsWith('/') ? pathAlias : `/${pathAlias}`;

export class DrupalSandboxCleanupService {
  /**
   * Recibe el config YA RESUELTO en vez de leer el entorno por su cuenta.
   *
   * Las credenciales viven en `backend/.env` y las vuelca `ConfigModule`, no
   * `dotenv`: una clase que leyera `process.env` en su constructor veria todo
   * vacio si alguien la instancia antes del bootstrap. Ademas la cabecera Basic
   * la compone un unico sitio en todo el proyecto, el getter `authHeader`, y
   * duplicarla aqui es exactamente como se cuela un `Bearer` contra una
   * instalacion que monta `basic_auth` —que no devuelve 401: responde 200 como
   * anonimo y no escribe—.
   */
  constructor(private readonly drupalApiConfig: DrupalApiConfig) {}

  /**
   * Timeout de las llamadas de ESTE script, con el suelo aplicado.
   *
   * Se toma el mayor de los dos y no el constante a secas: asi, subir
   * `DRUPAL_API_TIMEOUT_MS` en el entorno para una instalacion mas lenta sigue
   * mandando, y bajarlo no puede volver a cortar la lectura de la pagina.
   */
  private get requestTimeoutMs(): number {
    return Math.max(this.drupalApiConfig.timeoutMs, CLEANUP_MIN_TIMEOUT_MS);
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: this.drupalApiConfig.authHeader,
      Accept: 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
    };
  }

  /**
   * Resuelve el UUID de una pagina a partir de su alias de ruta.
   *
   * ULTIMO RECURSO, y no la via normal. Filtrar por `path.alias` es fragil en
   * esta instalacion —`path` es un campo calculado y el Entity Query devuelve
   * 500—, asi que quien llama deberia traer el UUID resuelto. Se conserva para
   * un alias que no este en los mapas conocidos.
   *
   * Un UUID pasado como alias se devuelve tal cual, sin tocar la red: es lo que
   * permite `npm run drupal:cleanup -- <uuid>` cuando la consulta falla.
   */
  public async resolveNodeUuidByAlias(
    pathAlias: string,
    bundle: string = DEFAULT_BUNDLE,
  ): Promise<string> {
    if (isUuid(pathAlias)) {
      return pathAlias.trim();
    }

    const alias = toCanonicalAlias(pathAlias);
    const url =
      `${this.drupalApiConfig.baseUrl}/${toEntityPath(bundle)}` +
      `?filter[path.alias]=${encodeURIComponent(alias)}`;

    let data: DrupalCollectionResponse;

    try {
      ({ data } = await axios.get<DrupalCollectionResponse>(url, {
        headers: this.headers,
        timeout: this.drupalApiConfig.timeoutMs,
      }));
    } catch (error) {
      // El 500 crudo de axios no dice nada util aqui. El diagnostico es
      // conocido y la salida tambien, asi que se cuentan las dos.
      const status = axios.isAxiosError(error)
        ? (error.response?.status ?? 'sin respuesta')
        : 'desconocido';

      throw new Error(
        `Drupal respondio ${status} al filtrar "${bundle}" por path.alias="${alias}". ` +
          'Esa consulta no es fiable en esta instalacion: `path` es un campo calculado. ' +
          'Pasa el UUID directamente como argumento, o declara el alias en SANDBOX_UUID_VARS.',
      );
    }

    const uuid = data.data?.[0]?.id;

    if (uuid === undefined) {
      throw new Error(
        `No se encontro ningun nodo de "${bundle}" con el alias "${alias}". ` +
          'Comprueba el alias y la coleccion: una pagina de otro bundle no aparece en este filtro.',
      );
    }

    return uuid;
  }

  /**
   * Retira los bloques de prueba de una pagina y persiste el resultado.
   *
   * Idempotente por construccion: sin coincidencias no emite PATCH y devuelve
   * `updated: false`. Reaplicarlo sobre una pagina ya limpia no escribe nada.
   */
  public async purgeInjectedBlocks(
    options: CleanupOptions,
  ): Promise<CleanupResult> {
    const bundle = options.bundle ?? DEFAULT_BUNDLE;
    const nodeUuid =
      options.nodeUuid ??
      (await this.resolveNodeUuidByAlias(options.pathAlias, bundle));
    const url = `${this.drupalApiConfig.baseUrl}/${toEntityPath(bundle)}/${nodeUuid}`;

    const { data } = await axios.get<DrupalNodeResponse>(url, {
      headers: this.headers,
      timeout: this.requestTimeoutMs,
    });

    const body = data.data?.attributes?.body;

    if (body?.value === undefined || body.value.length === 0) {
      return { purgedCount: 0, updated: false, targetUuid: nodeUuid };
    }

    const selectors =
      options.customSelector === undefined
        ? DEFAULT_PURGE_SELECTORS
        : [options.customSelector, ...DEFAULT_PURGE_SELECTORS];

    const purge = purgeMarkedBlocks(body.value, selectors);

    // La reposicion va DESPUES de podar, y en ese orden por una razon: lo que se
    // repone no debe pasar por los selectores. Un panel restaurado trae sus
    // propias clases de plantilla y la purga se lo llevaria en la misma corrida.
    const restoration = restoreMissingUniversityPanels(purge.html);

    const { purgedCount } = purge;
    const { restored } = restoration;

    // Se escribe si hubo poda O reposicion. Comprobar solo la poda dejaria una
    // pagina a la que solo le falta un padre sin arreglar.
    if (purgedCount === 0 && restored.length === 0) {
      return { purgedCount: 0, updated: false, targetUuid: nodeUuid, restored };
    }

    // El corte va DESPUES de podar y ANTES de escribir: asi el simulacro informa
    // del recuento real —el que produce el solapamiento de los selectores— y no
    // de una estimacion. Lo unico que no ocurre es el PATCH.
    if (options.dryRun === true) {
      return {
        purgedCount,
        updated: false,
        targetUuid: nodeUuid,
        matches: describePurgeMatches(body.value, selectors),
        restored,
      };
    }

    const html = restoration.html;

    await axios.patch(
      url,
      {
        data: {
          type: bundle,
          // `id` es OBLIGATORIO en un PATCH de JSON:API y debe coincidir con el
          // UUID de la URL; omitirlo devuelve un 422 cuyo cuerpo no deja claro
          // que es eso lo que falta.
          id: nodeUuid,
          attributes: {
            body: { value: html, format: body.format ?? DEFAULT_BODY_FORMAT },
          },
        },
      },
      { headers: this.headers, timeout: this.requestTimeoutMs },
    );

    return { purgedCount, updated: true, targetUuid: nodeUuid, restored };
  }
}

/**
 * Entrada CLI.
 *
 * Va bajo `require.main === module` porque este archivo tambien se IMPORTA
 * desde `test-titulos-e2e.ts`: sin la guarda, pedirle el servicio dispararia
 * una limpieza completa como efecto secundario del import.
 */
/**
 * UUID de un alias conocido, o `null` si hay que resolverlo por la via larga.
 *
 * Precedencia: un UUID pasado a pelo manda sobre todo; despues la variable de
 * entorno, que es lo que permite apuntar a otra instalacion; y por ultimo el
 * respaldo cableado, para que la corrida tipica no exija configuracion.
 */
const resolveKnownUuid = (
  pathAlias: string,
  configService: ConfigService,
): string | null => {
  if (isUuid(pathAlias)) {
    return pathAlias.trim();
  }

  const alias = toCanonicalAlias(pathAlias);
  const varName = SANDBOX_UUID_VARS[alias];

  if (varName === undefined) {
    return null;
  }

  const fromEnv = configService.get<string>(varName)?.trim();

  return fromEnv !== undefined && fromEnv.length > 0
    ? fromEnv
    : (SANDBOX_UUID_FALLBACKS[alias] ?? null);
};

/**
 * Separa banderas de posicionales.
 *
 * NO es un adorno. Los dos argumentos de este script son POSICIONALES —alias y
 * selector adicional—, de modo que un `--dry-run` escrito en tercera posicion se
 * tomaria como un selector CSS, no casaria con nada y la purga se ejecutaria
 * igualmente: exactamente lo contrario de lo que el operador acaba de pedir.
 */
export const splitCliArgs = (
  argv: readonly string[],
): {
  readonly positionals: readonly string[];
  readonly flags: ReadonlySet<string>;
} => ({
  positionals: argv.filter((arg) => !arg.startsWith('--')),
  flags: new Set(argv.filter((arg) => arg.startsWith('--'))),
});

const main = async (): Promise<void> => {
  const { positionals, flags } = splitCliArgs(process.argv.slice(2));

  const pathAlias = positionals[0] ?? DEFAULT_PATH_ALIAS;
  const customSelector = positionals[1];
  const dryRun = flags.has('--dry-run');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    // `strict: false` porque `DrupalApiConfig` es provider de `NodesModule` y no
    // del scope raiz; sin ello `app.get` no lo encuentra.
    const drupalApiConfig = app.get(DrupalApiConfig, { strict: false });

    if (!drupalApiConfig.isUsable) {
      throw new Error(
        'Credenciales de Drupal incompletas. Bajo BASIC hacen falta DRUPAL_API_USER y ' +
          'DRUPAL_API_TOKEN en backend/.env.',
      );
    }

    const service = new DrupalSandboxCleanupService(drupalApiConfig);

    // Resolucion AQUI y no dentro del servicio: `ConfigService` solo tiene los
    // valores del `.env` una vez levantado el contexto, y es el unico momento en
    // que se pueden leer. Con los dos alias conocidos la consulta por
    // `path.alias` —la que devuelve 500— no llega a emitirse.
    const resolvedUuid = resolveKnownUuid(pathAlias, app.get(ConfigService));

    if (resolvedUuid !== null) {
      logger.log(`Alias conocido: ${pathAlias} | uuid=${resolvedUuid}`);
    }

    const result = await service.purgeInjectedBlocks({
      pathAlias,
      ...(resolvedUuid === null ? {} : { nodeUuid: resolvedUuid }),
      ...(customSelector === undefined ? {} : { customSelector }),
      dryRun,
    });

    const restored = result.restored ?? [];

    if (dryRun) {
      for (const { selector, matches } of result.matches ?? []) {
        logger.log(`  ${selector} -> ${matches} coincidencia(s)`);
      }

      for (const title of restored) {
        logger.log(`  + se repondria el panel de universidad "${title}"`);
      }

      logger.log(
        `[DRUPAL_CLEANUP_DRY_RUN] Se purgarian ${result.purgedCount} bloque(s) | ` +
          `Se repondrian ${restored.length} panel(es) | ` +
          `Escrituras: 0 | UUID: ${result.targetUuid}`,
      );

      return;
    }

    for (const title of restored) {
      logger.log(`Panel de universidad repuesto: "${title}".`);
    }

    logger.log(
      `[DRUPAL_CLEANUP_SUCCESS] Purgados: ${result.purgedCount} bloque(s) | ` +
        `Repuestos: ${restored.length} panel(es) | ` +
        `Actualizado: ${result.updated} | UUID: ${result.targetUuid}`,
    );
  } finally {
    // Sin esto el proceso queda colgado del pool de conexiones de TypeORM.
    await app.close();
  }
};

if (require.main === module) {
  main().catch((error: unknown) => {
    logger.error(
      `[DRUPAL_CLEANUP_ERROR] ${error instanceof Error ? error.message : 'Error desconocido'}`,
      error instanceof Error ? error.stack : undefined,
    );
    // `exitCode` y no `process.exit()`: este ultimo cortaria el `await
    // app.close()` del `finally` a medias.
    process.exitCode = 1;
  });
}
