// Mismas dos guardas que los scripts hermanos, y por el mismo motivo: van ANTES
// de los imports porque `ImapPollingService` y `CronSchedulingService` las leen
// en su `onModuleInit`, de modo que levantar el contexto con los valores del
// `.env` de desarrollo inscribiria sondeos contra buzones reales y los CRON de
// todos los flujos activos mientras dure la limpieza.
process.env.IMAP_POLLING_ENABLED = 'false';
process.env.CRON_SCHEDULING_ENABLED = 'false';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import axios from 'axios';
import * as cheerio from 'cheerio';

import { DrupalApiConfig } from '@core/config/drupal-api.config';

import { AppModule } from '../app.module';
import { purgeMarkedBlocks } from './cleanup-drupal-sandbox';

import type { DrupalNodeResponse } from './cleanup-drupal-sandbox';

/**
 * Purga QUIRURGICA de bloques en una pagina de Drupal, por JSON:API.
 *
 *   npm run drupal:clean -- --uuid=<uuid> --remove-root-panels
 *   npm run drupal:clean -- --uuid=<uuid> --injected-only --write
 *   npm run drupal:clean -- --uuid=<uuid> --selector='.panel-default:has(.panel-heading:contains("UAM 9"))' --write
 *
 * EN QUE SE DIFERENCIA DE `drupal:cleanup`. Aquel retira los rastros que dejan
 * las pruebas E2E y su seguridad se apoyaba en una asimetria: solo los scripts
 * de prueba estampaban `data-protodo-injected`, de modo que el contenido
 * publicado por un flujo real le era invisible. Esa asimetria YA NO EXISTE —la
 * plantilla sembrada por la migracion 034 lleva el marcador, asi que los flujos
 * reales tambien lo escriben—. Esta herramienta asume eso de frente: su trabajo
 * es retirar contenido REAL que se publico donde no debia.
 *
 * DE AHI QUE SIMULE POR DEFECTO. Sin `--write` no se emite ningun PATCH: se
 * lista lo que se quitaria y se termina. Es la convencion que ya siguen
 * `test-titulos-e2e.ts` y `test-drupal-sandbox-e2e.ts`, y aqui pesa mas que en
 * ninguno: un selector de mas no falla, borra contenido editorial de un portal
 * publicado y devuelve exito. `--dry-run` se acepta como forma explicita del
 * comportamiento por defecto.
 *
 * ALCANCE DE «no altera el contenido editorial». Es cierto en ESTRUCTURA, no
 * byte a byte: el PATCH reescribe el `body.value` entero con la serializacion
 * de cheerio, que normaliza —`<br/>` pasa a `<br>`, `&nbsp;` a `&#xa0;`—. No lo
 * introduce este script: es el mismo viaje de ida y vuelta que hace cada
 * publicacion del nodo DESTINO_DRUPAL.
 */
const logger = new Logger('DrupalCleanup');

/** Coleccion contra la que se resuelven las paginas estaticas del portal. */
const DEFAULT_BUNDLE = 'node--page';

/** Formato de texto enriquecido con el que Drupal guarda estos cuerpos. */
const DEFAULT_BODY_FORMAT = 'full_html';

/** Acordeon raiz de la pagina agregadora, salvo que se diga otro. */
const DEFAULT_ROOT_SELECTOR = '#accordion';

/** Marca que estampan la plantilla de titulos y los scripts de prueba. */
export const INJECTED_MARKER_SELECTOR = '[data-protodo-injected="true"]';

/** Lo que el operador pidio en la linea de comandos. */
export interface CleanupFlags {
  readonly uuid: string | null;
  readonly injectedOnly: boolean;
  readonly selector: string | null;
  readonly removeRootPanels: boolean;
  readonly dedupCommittees: boolean;
  readonly rootSelector: string;
  readonly write: boolean;
}

/**
 * Traduce `process.argv` a banderas.
 *
 * `process.argv` y no `yargs`: no es dependencia del proyecto y los cinco
 * scripts operativos ya parsean a mano. Anadir una libreria para seis banderas
 * seria pagar un paquete por un `split`.
 */
export const parseFlags = (argv: readonly string[]): CleanupFlags => {
  const valueOf = (name: string): string | null => {
    const prefix = `--${name}=`;
    const found = argv.find((arg) => arg.startsWith(prefix));

    return found === undefined ? null : found.slice(prefix.length).trim();
  };

  const has = (name: string): boolean => argv.includes(`--${name}`);

  const root = valueOf('root');

  return {
    uuid: valueOf('uuid'),
    injectedOnly: has('injected-only'),
    selector: valueOf('selector'),
    removeRootPanels: has('remove-root-panels'),
    dedupCommittees: has('dedup-committees'),
    rootSelector:
      root === null || root.length === 0 ? DEFAULT_ROOT_SELECTOR : root,
    // `--dry-run` NO se consulta: simular es el defecto y la bandera solo
    // existe para que quien la escriba obtenga lo que espera. Que ademas
    // CANCELE un `--write` es deliberado: ante dos banderas contradictorias,
    // la opcion segura es la que no borra.
    write: has('write') && !has('dry-run'),
  };
};

/**
 * Selectores que se van a purgar, segun las banderas.
 *
 * Es una funcion pura y tiene spec propia por el mismo motivo que
 * `purgeMarkedBlocks`: es donde vive el riesgo de toda la herramienta. Un
 * selector de mas no falla, borra contenido ajeno y devuelve exito.
 */
export const buildPurgeSelectors = (flags: CleanupFlags): readonly string[] => {
  const selectors: string[] = [];

  if (flags.injectedOnly) {
    selectors.push(INJECTED_MARKER_SELECTOR);
  }

  if (flags.removeRootPanels) {
    // EL MATIZ MAS IMPORTANTE DE TODO EL SCRIPT. El selector que pide el cuerpo
    // —`#accordion > .panel.panel-default`— BORRARIA LA PAGINA ENTERA: los
    // catorce paneles de universidad son precisamente hijos directos del
    // acordeon raiz. Lo unico que distingue a un comite mal colocado de una
    // universidad es el marcador, de ahi que se exija.
    //
    // Tampoco sirve `:not(:has(.panel))`, que parecia la via elegante: una
    // universidad a la que todavia no se le ha inyectado ningun comite no anida
    // ningun panel y caeria con los demas.
    selectors.push(
      `${flags.rootSelector} > .panel.panel-default${INJECTED_MARKER_SELECTOR}`,
    );
  }

  if (flags.selector !== null && flags.selector.length > 0) {
    selectors.push(flags.selector);
  }

  return selectors;
};

/** Un elemento que seria purgado, descrito para que una persona lo reconozca. */
export interface PurgeTargetSummary {
  readonly selector: string;
  readonly matches: readonly string[];
}

/** Carga de cheerio con las banderas CANONICAS del proyecto. */
const loadFragment = (html: string): cheerio.CheerioAPI =>
  cheerio.load(html, { xml: { xmlMode: false } }, false);

/** Recorta un texto para que quepa en una linea de consola. */
const clip = (value: string, limit = 80): string => {
  const flat = value.replace(/\s+/g, ' ').trim();

  return flat.length > limit ? `${flat.slice(0, limit)}...` : flat;
};

/**
 * Inventario de lo que cada selector se llevaria por delante.
 *
 * Es lo que se imprime en el simulacro, y por eso describe cada elemento con su
 * texto y no solo lo cuenta: «3 elementos» no permite decidir si seguir
 * adelante, y decidir es justo lo que el simulacro existe para que ocurra.
 */
export const describePurgeTargets = (
  html: string,
  selectors: readonly string[],
): readonly PurgeTargetSummary[] => {
  const $ = loadFragment(html);

  return selectors.map((selector) => ({
    selector,
    matches: $(selector)
      .toArray()
      .map((element) => {
        const node = $(element);
        const code = node.find('.panel-comite-codigo').first().text().trim();

        return clip(code.length > 0 ? code : node.text());
      }),
  }));
};

/**
 * Ambito de un panel de COMITE, anclado al segundo nivel del acordeon.
 *
 * REPLICA DELIBERADA de `COMMITTEE_PANEL_SCOPE` (`cleanup-drupal-sandbox.ts`), y
 * la duplicacion se asume por la misma razon por la que aquel existe: la pagina
 * es un acordeon de DOS niveles cuyos paneles de universidad y de comite
 * comparten la clase `.panel`. Un `.panel:has(.panel-comite-codigo)` sin anclar
 * casa tambien con la universidad que CONTIENE el comite, y el `.remove()` se
 * lleva el contenedor entero: le paso a `ESIC Universidad`, que desaparecio de
 * la pagina por un selector que pretendia quitar un solo duplicado.
 *
 * Exigir que el `.panel-group` este a su vez dentro de otro `.panel-group` deja
 * fuera el primer nivel, que es donde viven los padres.
 */
const COMMITTEE_PANEL_SCOPE = '.panel-group .panel-group > .panel';

/** Paneles de comite, ya acotados al nivel seguro del acordeon. */
const COMMITTEE_PANEL_SELECTOR = `${COMMITTEE_PANEL_SCOPE}:has(.panel-comite-codigo)`;

/**
 * Agrupa los paneles de comite por su codigo y devuelve los SOBRANTES.
 *
 * NO ES EXPRESABLE COMO SELECTOR CSS, y por eso no vive en
 * `buildPurgeSelectors`: "conserva uno por grupo" exige mirar el conjunto, no
 * cada elemento por separado. De ahi que sea una funcion propia, pura y con
 * spec, igual que sus hermanas.
 *
 * SE CONSERVA EL PRIMERO (`nodes[0]`) por un motivo concreto: cheerio recorre el
 * documento en orden, de modo que el primero es el que lleva mas tiempo
 * publicado y, en una pagina editorial, el que es mas probable que sea el
 * original frente a las copias que inyecto un flujo repetido.
 *
 * Los paneles cuyo `.panel-comite-codigo` esta vacio se IGNORAN: sin codigo no
 * hay forma de saber de que comite son copia, y agruparlos todos bajo la cadena
 * vacia borraria paneles sin relacion entre si.
 */
export const collectDuplicateCommitteePanels = (
  $: cheerio.CheerioAPI,
): cheerio.Cheerio<never>[] => {
  const byCode = new Map<string, cheerio.Cheerio<never>[]>();

  for (const element of $(COMMITTEE_PANEL_SELECTOR).toArray()) {
    const panel = $(element) as unknown as cheerio.Cheerio<never>;
    const code = panel.find('.panel-comite-codigo').first().text().trim();

    if (code === '') {
      continue;
    }

    byCode.set(code, [...(byCode.get(code) ?? []), panel]);
  }

  const duplicates: cheerio.Cheerio<never>[] = [];

  for (const panels of byCode.values()) {
    if (panels.length > 1) {
      duplicates.push(...panels.slice(1));
    }
  }

  return duplicates;
};

/** Inventario de los duplicados, con la misma forma que el de los selectores. */
export const describeDuplicateCommittees = (
  html: string,
): PurgeTargetSummary => {
  const $ = loadFragment(html);

  return {
    selector: `${COMMITTEE_PANEL_SELECTOR} (duplicados)`,
    matches: collectDuplicateCommitteePanels($).map((panel) =>
      clip(panel.find('.panel-comite-codigo').first().text().trim()),
    ),
  };
};

/**
 * Quita los duplicados y devuelve el cuerpo resultante.
 *
 * Como `purgeMarkedBlocks`, devuelve el HTML ORIGINAL sin serializar cuando no
 * hubo nada que quitar: asi una pagina ya limpia no recibe la normalizacion de
 * cheerio por el mero hecho de haberla revisado.
 */
export const purgeDuplicateCommittees = (
  html: string,
): { html: string; purgedCount: number } => {
  const $ = loadFragment(html);
  const duplicates = collectDuplicateCommitteePanels($);

  if (duplicates.length === 0) {
    return { html, purgedCount: 0 };
  }

  for (const panel of duplicates) {
    panel.remove();
  }

  return { html: $.html(), purgedCount: duplicates.length };
};

/** Cliente minimo de JSON:API para leer y reescribir el cuerpo de una pagina. */
class DrupalPageCleaner {
  private readonly headers: Record<string, string>;

  constructor(private readonly drupalApiConfig: DrupalApiConfig) {
    this.headers = {
      Accept: 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
      Authorization: drupalApiConfig.authHeader,
    };
  }

  /** Cuerpo actual de la pagina y el formato con que Drupal lo guarda. */
  public async fetchBody(
    uuid: string,
  ): Promise<{ html: string; format: string }> {
    const { data } = await axios.get<DrupalNodeResponse>(
      `${this.drupalApiConfig.baseUrl}/${DEFAULT_BUNDLE.replace('--', '/')}/${uuid}`,
      { headers: this.headers, timeout: this.drupalApiConfig.timeoutMs },
    );

    const body = data.data?.attributes?.body;

    return {
      html: body?.value ?? '',
      format: body?.format ?? DEFAULT_BODY_FORMAT,
    };
  }

  /** Reescribe el cuerpo entero. Solo se invoca con `--write`. */
  public async patchBody(
    uuid: string,
    html: string,
    format: string,
  ): Promise<void> {
    await axios.patch(
      `${this.drupalApiConfig.baseUrl}/${DEFAULT_BUNDLE.replace('--', '/')}/${uuid}`,
      {
        data: {
          type: DEFAULT_BUNDLE,
          // `id` es OBLIGATORIO en un PATCH de JSON:API; omitirlo devuelve un
          // 422 cuyo cuerpo no dice que falta.
          id: uuid,
          attributes: { body: { value: html, format } },
        },
      },
      { headers: this.headers, timeout: this.drupalApiConfig.timeoutMs },
    );
  }
}

/** Imprime el inventario del simulacro. */
const reportTargets = (targets: readonly PurgeTargetSummary[]): number => {
  let total = 0;

  for (const target of targets) {
    total += target.matches.length;

    logger.log(`  ${target.selector} -> ${target.matches.length} elemento(s)`);

    for (const match of target.matches) {
      logger.log(`    · ${match}`);
    }
  }

  return total;
};

const main = async (): Promise<void> => {
  const flags = parseFlags(process.argv.slice(2));

  if (flags.uuid === null || flags.uuid.length === 0) {
    throw new Error(
      'Falta --uuid=<uuid de la pagina>. Ejemplo: npm run drupal:clean -- --uuid=b17d69d8-... --remove-root-panels',
    );
  }

  const selectors = buildPurgeSelectors(flags);

  if (selectors.length === 0 && !flags.dedupCommittees) {
    throw new Error(
      'No se ha pedido nada que purgar. Usa --injected-only, --remove-root-panels, --dedup-committees o --selector=<css>.',
    );
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    // `strict: false` porque `DrupalApiConfig` es provider de `NodesModule` y
    // no del scope raiz; sin ello `app.get` no lo encuentra.
    const drupalApiConfig = app.get(DrupalApiConfig, { strict: false });

    if (!drupalApiConfig.isUsable) {
      throw new Error(
        'Credenciales de Drupal incompletas. Bajo BASIC hacen falta DRUPAL_API_USER y ' +
          'DRUPAL_API_TOKEN en backend/.env.',
      );
    }

    const cleaner = new DrupalPageCleaner(drupalApiConfig);
    const { html, format } = await cleaner.fetchBody(flags.uuid);

    logger.log(`Pagina ${flags.uuid} | ${html.length} caracteres de cuerpo.`);
    logger.log('Elementos que coinciden con los selectores pedidos:');

    // La deduplicacion se inventaria APARTE porque no nace de un selector: el
    // suyo describe de donde salen los candidatos, no lo que se va a quitar.
    const targets = [
      ...describePurgeTargets(html, selectors),
      ...(flags.dedupCommittees ? [describeDuplicateCommittees(html)] : []),
    ];

    const matched = reportTargets(targets);

    if (matched === 0) {
      logger.log(
        '[DRUPAL_CLEAN_NOOP] Nada que purgar. La pagina queda intacta.',
      );

      return;
    }

    if (!flags.write) {
      logger.log(
        `[DRUPAL_CLEAN_DRY_RUN] ${matched} elemento(s) se purgarian. ` +
          'No se ha emitido ningun PATCH. Repite con --write para aplicarlo.',
      );

      return;
    }

    // Guard NEUTRO, y es una decision sobre que es esta herramienta. El script
    // de sandbox corre solo y con una lista de serie, asi que necesita una red
    // que le impida despublicar el unico ejemplar de un comite. Esta es
    // manual: exige `--uuid`, simula por defecto y ENUMERA lo que se va a
    // llevar antes de tocar nada. Aqui el operador ya ha visto la lista, de
    // modo que una heuristica que le ignore el selector seria un estorbo, no
    // una proteccion.
    const purged = purgeMarkedBlocks(html, selectors, () => false);

    // La dedup corre DESPUES y sobre el resultado de la anterior: si un selector
    // ya se llevo una de las copias, el grupo puede haber quedado con un unico
    // ejemplar y entonces no hay nada que deduplicar. Al reves se contarian
    // elementos que el otro paso iba a borrar de todos modos.
    const deduped = flags.dedupCommittees
      ? purgeDuplicateCommittees(purged.html)
      : { html: purged.html, purgedCount: 0 };

    const purgedCount = purged.purgedCount + deduped.purgedCount;

    if (purgedCount === 0) {
      logger.log(
        '[DRUPAL_CLEAN_NOOP] El inventario no sobrevivio a la purga: nada que escribir.',
      );

      return;
    }

    await cleaner.patchBody(flags.uuid, deduped.html, format);

    logger.log(
      `[DRUPAL_CLEAN_SUCCESS] Purgados: ${purgedCount} elemento(s)` +
        (flags.dedupCommittees
          ? ` (${deduped.purgedCount} duplicado(s) de comite)`
          : '') +
        ` | UUID: ${flags.uuid}`,
    );
  } finally {
    // Sin esto el proceso queda colgado del pool de conexiones de TypeORM.
    await app.close();
  }
};

if (require.main === module) {
  main().catch((error: unknown) => {
    logger.error(
      `[DRUPAL_CLEAN_ERROR] ${error instanceof Error ? error.message : 'Error desconocido'}`,
      error instanceof Error ? error.stack : undefined,
    );
    // `exitCode` y no `process.exit()`: este ultimo cortaria el `await
    // app.close()` del `finally` a medias.
    process.exitCode = 1;
  });
}
