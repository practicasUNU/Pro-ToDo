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

  if (selectors.length === 0) {
    throw new Error(
      'No se ha pedido nada que purgar. Usa --injected-only, --remove-root-panels o --selector=<css>.',
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

    const matched = reportTargets(describePurgeTargets(html, selectors));

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

    const purged = purgeMarkedBlocks(html, selectors);

    await cleaner.patchBody(flags.uuid, purged.html, format);

    logger.log(
      `[DRUPAL_CLEAN_SUCCESS] Purgados: ${purged.purgedCount} elemento(s) | UUID: ${flags.uuid}`,
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
