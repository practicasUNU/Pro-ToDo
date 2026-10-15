// Mismas dos guardas que los scripts hermanos, y por el mismo motivo: van ANTES
// de los imports porque `ImapPollingService` y `CronSchedulingService` las leen
// en su `onModuleInit`, de modo que levantar el contexto con los valores del
// `.env` de desarrollo inscribiria sondeos contra buzones reales y los CRON de
// todos los flujos activos mientras dure la inyeccion.
process.env.IMAP_POLLING_ENABLED = 'false';
process.env.CRON_SCHEDULING_ENABLED = 'false';

import { readFileSync } from 'node:fs';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import * as cheerio from 'cheerio';

import { DrupalApiConfig } from '@core/config/drupal-api.config';
import { selectVisibleTarget } from '@modules/nodes/utils/visible-target.util';

import { AppModule } from '../app.module';
import { DrupalPageCleaner } from './drupal-cleanup';

/**
 * Inyeccion de marcado HTML en una pagina de Drupal, por JSON:API.
 *
 *   npm run drupal:inject -- --uuid=<uuid> --file=bloque.html --target='#accordionESIC'
 *   npm run drupal:inject -- --uuid=<uuid> --html='<div>...</div>' --write
 *
 * POR QUE EXISTE. Cada vez que habia que colocar un bloque en el portal se
 * escribia un script desechable con el UUID y el marcado cableados. El ultimo
 * —`drupal-inject-block.ts`, que este sustituye— escribia sin simulacro, caia
 * en silencio a `#accordion` cuando no encontraba su contenedor y cortaba el
 * `app.close()` con un `process.exit(1)`. Las tres cosas son fallos de la
 * herramienta, no del operador, y se arreglan una vez aqui.
 *
 * SIMULA POR DEFECTO, como `drupal:clean` y al contrario que `drupal:cleanup`.
 * Sin `--write` no se emite ningun PATCH: se comprueba que el destino existe,
 * se dice cuantas veces casa y se imprime una vista previa. La razon es la
 * misma que alla: `DRUPAL_API_BASE_URL` apunta al portal real y lo que se
 * escribe queda publicado.
 */
const logger = new Logger('DrupalInject');

/** Acordeon raiz de la pagina agregadora, salvo que se diga otro. */
const DEFAULT_TARGET_SELECTOR = '#accordion';

/**
 * Clases con las que el portal oculta un subarbol entero.
 *
 * Se retiran del contenedor elegido tras inyectar, igual que hace
 * `insertDispatchedPanels` en `DrupalHttpStrategy`: un sub-acordeon al que
 * todavia no se le habia colgado nada viene oculto, y publicar dentro sin
 * destaparlo produce el peor desenlace posible —PATCH 200, todo en verde y
 * nadie ve el bloque—.
 */
const HIDDEN_UTILITY_CLASSES = 'd-none hidden';

/** Modos de insercion admitidos. */
export type InjectMode = 'append' | 'prepend' | 'replace';

const INJECT_MODES: readonly InjectMode[] = ['append', 'prepend', 'replace'];

/** Lo que el operador pidio en la linea de comandos. */
export interface InjectFlags {
  readonly uuid: string | null;
  readonly html: string | null;
  readonly file: string | null;
  readonly target: string;
  readonly mode: InjectMode;
  readonly write: boolean;
}

/**
 * Traduce `process.argv` a banderas.
 *
 * `process.argv` y no `yargs`, por la misma razon que los cinco scripts
 * operativos hermanos: anadir una libreria para seis banderas seria pagar un
 * paquete por un `split`.
 */
export const parseFlags = (argv: readonly string[]): InjectFlags => {
  const valueOf = (name: string): string | null => {
    const prefix = `--${name}=`;
    const found = argv.find((arg) => arg.startsWith(prefix));

    return found === undefined ? null : found.slice(prefix.length);
  };

  const rawMode = valueOf('mode');

  if (rawMode !== null && !INJECT_MODES.includes(rawMode as InjectMode)) {
    throw new Error(
      `--mode debe ser uno de: ${INJECT_MODES.join(', ')}. Recibido: "${rawMode}".`,
    );
  }

  const target = valueOf('target');

  return {
    uuid: valueOf('uuid'),
    // El marcado NO se recorta: un `--html` con espacios al principio puede
    // tenerlos a proposito, y `trim()` sobre contenido ajeno es la clase de
    // ayuda que luego nadie entiende.
    html: valueOf('html'),
    file: valueOf('file'),
    target:
      target === null || target.length === 0 ? DEFAULT_TARGET_SELECTOR : target,
    mode: (rawMode ?? 'append') as InjectMode,
    write: argv.includes('--write') && !argv.includes('--dry-run'),
  };
};

/**
 * El marcado a inyectar, venga de `--html` o de `--file`.
 *
 * EXACTAMENTE UNO de los dos, y los dos errores se nombran por separado: "no
 * has dicho que inyectar" y "has dicho dos cosas distintas" son equivocaciones
 * diferentes y el mensaje que resuelve una no ayuda con la otra.
 */
export const resolveMarkup = (
  flags: InjectFlags,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): string => {
  if (flags.html !== null && flags.file !== null) {
    throw new Error(
      'Usa --html=<marcado> o --file=<ruta>, pero no los dos a la vez.',
    );
  }

  if (flags.html !== null) {
    return flags.html;
  }

  if (flags.file !== null) {
    return readFile(flags.file);
  }

  throw new Error(
    'Falta el marcado a inyectar. Usa --html=<marcado> o --file=<ruta>.',
  );
};

/** Carga de cheerio con las banderas CANONICAS del proyecto. */
const loadFragment = (html: string): cheerio.CheerioAPI =>
  cheerio.load(html, { xml: { xmlMode: false } }, false);

/** Recorta un texto para que quepa en una linea de consola. */
const clip = (value: string, limit = 120): string => {
  const flat = value.replace(/\s+/g, ' ').trim();

  return flat.length > limit ? `${flat.slice(0, limit)}...` : flat;
};

/** Lo que el simulacro necesita saber del destino antes de tocar nada. */
export interface TargetInspection {
  readonly matches: number;
  readonly preview: string;
  readonly hidden: boolean;
}

/** Cuantas veces casa el destino y que aspecto tiene el elegido. */
export const inspectTarget = (
  html: string,
  selector: string,
): TargetInspection => {
  const $ = loadFragment(html);
  const matches = $(selector);
  const chosen = selectVisibleTarget($, selector);

  return {
    matches: matches.length,
    preview: matches.length === 0 ? '' : clip(chosen.html() ?? ''),
    // Se informa de si el elegido viene oculto porque la inyeccion lo destapa,
    // y destapar un contenedor es un cambio visible de la pagina que el
    // operador tiene derecho a ver venir en el simulacro.
    hidden: matches.length > 0 && chosen.closest('.d-none, .hidden').length > 0,
  };
};

/**
 * Inserta el marcado y devuelve el cuerpo resultante.
 *
 * EL DESTINO AUSENTE ES UN FALLO, NO UN FALLBACK. El script al que esto
 * sustituye caia a `#accordion` cuando no encontraba su contenedor, que es
 * precisamente la averia "el comite acaba colgando de la raiz del acordeon en
 * vez de de su universidad". Un bloque en el sitio equivocado no se distingue
 * de uno bien puesto hasta que alguien mira la pagina, de modo que aqui se
 * para antes de escribir.
 *
 * Se elige el destino con `selectVisibleTarget` y no con `$(selector).first()`:
 * la plantilla de muestra del portal cuelga de un `.d-none` y deja un duplicado
 * exacto de cada contenedor, y es ese duplicado escondido el que encuentra
 * primero una busqueda ingenua.
 */
export const injectMarkup = (
  html: string,
  markup: string,
  selector: string,
  mode: InjectMode,
): string => {
  const $ = loadFragment(html);

  if ($(selector).length === 0) {
    throw new Error(
      `El destino "${selector}" no existe en la pagina: no se inyecta nada. Revisa el selector.`,
    );
  }

  const target = selectVisibleTarget($, selector);

  if (mode === 'replace') {
    // `replaceWith` deja fuera al propio contenedor, de modo que no tiene
    // sentido destaparlo: lo que quede es el marcado nuevo y sus clases.
    target.replaceWith(markup);

    return $.html();
  }

  target.removeClass(HIDDEN_UTILITY_CLASSES);

  if (mode === 'prepend') {
    target.prepend(markup);
  } else {
    target.append(markup);
  }

  return $.html();
};

const main = async (): Promise<void> => {
  const flags = parseFlags(process.argv.slice(2));

  if (flags.uuid === null || flags.uuid.length === 0) {
    throw new Error(
      'Falta --uuid=<uuid de la pagina>. Ejemplo: npm run drupal:inject -- --uuid=b17d69d8-... --file=bloque.html',
    );
  }

  const markup = resolveMarkup(flags);

  if (markup.trim().length === 0) {
    throw new Error('El marcado a inyectar esta vacio.');
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

    const client = new DrupalPageCleaner(drupalApiConfig);
    const { html, format } = await client.fetchBody(flags.uuid);

    logger.log(`Pagina ${flags.uuid} | ${html.length} caracteres de cuerpo.`);
    logger.log(
      `Marcado a inyectar: ${markup.length} caracteres | modo: ${flags.mode} | destino: ${flags.target}`,
    );

    const inspection = inspectTarget(html, flags.target);

    if (inspection.matches === 0) {
      throw new Error(
        `El destino "${flags.target}" no existe en la pagina: no se inyecta nada. Revisa el selector.`,
      );
    }

    logger.log(
      `  El destino casa ${inspection.matches} vez(ces).` +
        (inspection.hidden ? ' El elegido viene OCULTO y se destapara.' : ''),
    );
    logger.log(`    · destino actual: ${inspection.preview}`);
    logger.log(`    · marcado nuevo:  ${clip(markup)}`);

    if (!flags.write) {
      logger.log(
        '[DRUPAL_INJECT_DRY_RUN] No se ha emitido ningun PATCH. ' +
          'Repite con --write para aplicarlo.',
      );

      return;
    }

    const injected = injectMarkup(html, markup, flags.target, flags.mode);

    await client.patchBody(flags.uuid, injected, format);

    logger.log(
      `[DRUPAL_INJECT_SUCCESS] Marcado inyectado en "${flags.target}" (${flags.mode}) | UUID: ${flags.uuid}`,
    );
  } finally {
    // Sin esto el proceso queda colgado del pool de conexiones de TypeORM.
    await app.close();
  }
};

if (require.main === module) {
  main().catch((error: unknown) => {
    logger.error(
      `[DRUPAL_INJECT_ERROR] ${error instanceof Error ? error.message : 'Error desconocido'}`,
      error instanceof Error ? error.stack : undefined,
    );
    // `exitCode` y no `process.exit()`: este ultimo cortaria el `await
    // app.close()` del `finally` a medias, que es justo el fallo que tenia el
    // script desechable al que esto sustituye.
    process.exitCode = 1;
  });
}
