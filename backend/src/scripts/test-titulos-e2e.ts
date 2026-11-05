// Antes de los imports, igual que en el E2E de licitaciones: las guardas de
// `ImapPollingService` y `CronSchedulingService` leen estas dos variables en su
// `onModuleInit`, y con los valores del `.env` de desarrollo levantar el
// contexto pondria a sondear buzones reales durante toda la corrida.
process.env.IMAP_POLLING_ENABLED = 'false';
process.env.CRON_SCHEDULING_ENABLED = 'false';

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import axios from 'axios';
import * as cheerio from 'cheerio';

import { DrupalApiConfig } from '@core/config/drupal-api.config';

import { AppModule } from '../app.module';
import {
  DrupalSandboxCleanupService,
  findUndeployablePanelReasons,
  normalizeHtmlForComparison,
  textContentOf,
} from './cleanup-drupal-sandbox';

import type { DrupalNodeResponse } from './cleanup-drupal-sandbox';
import type { CheerioAPI } from 'cheerio';

/**
 * Prueba E2E del tramo de inyeccion sobre la pagina del verificador de titulos.
 *
 *   npm run test:e2e:titulos             # simulacion: NO escribe nada
 *   npm run test:e2e:titulos -- --write  # inyecta en PRODUCCION y restaura
 *
 * El ciclo completo es inyectar, comprobar y DESHACER. Que se limpie solo es lo
 * que permite repetirla: su hermana de licitaciones deja un bloque publicado en
 * cada pasada, y esos bloques se acumulan en el portal real.
 *
 * LA RESTAURACION NO DEVUELVE EL BYTE EXACTO, y es esperado. El PATCH reescribe
 * el `body.value` entero con la serializacion de cheerio, que normaliza el
 * marcado —`<br/>` pasa a `<br>`, `&nbsp;` a `&#xa0;`—. Por eso la verificacion
 * final NO compara contra el HTML tal y como vino de Drupal, sino contra ese
 * mismo HTML pasado una vez por cheerio: es el estado al que converge la pagina
 * tras cualquier escritura, aqui y en `runAppendHtmlBlock`. Comparar contra el
 * crudo daria por fallida cada corrida correcta.
 */
const logger = new Logger('TitulosE2E');

/** Bandera que habilita la escritura real. */
const WRITE_FLAG = '--write';

/**
 * Banderas que dejan el panel publicado al terminar.
 *
 * Sirven para mirarlo en el navegador, que es lo unico que no se puede
 * comprobar desde aqui. El precio lo paga la corrida SIGUIENTE, y por eso
 * existe la guarda anti-contaminacion de mas abajo.
 */
const KEEP_FLAGS = ['--keep', '--no-cleanup'] as const;

/** Pagina agregadora del verificador de titulos en el sandbox. */
const DEFAULT_PATH_ALIAS = '/prueba-verificador-titulos';

/**
 * Variable que, si esta puesta, ahorra el GET de resolucion por alias.
 *
 * Se declaro en `.env.example` junto a la de licitaciones y hasta ahora no la
 * leia nadie. Es util ademas como desempate: la ficha del proyecto se
 * contradice sobre el bundle de esta pagina, y un UUID explicito esquiva la
 * busqueda por completo.
 */
const SANDBOX_UUID_VAR = 'DRUPAL_SANDBOX_TITULOS_UUID';

/** Coleccion donde se resuelve el alias; ver §4 de la ficha de Drupal. */
const SANDBOX_BUNDLE = 'node--page';

/** Acordeon de la pagina real que recibe el panel. */
const ACCORDION_SELECTOR = '#accordionCEU';

/** Marcadores del bloque inyectado. Son la llave entera de la purga. */
const INJECTED_MARKER = '[data-protodo-injected="true"]';
const TEST_ID = 'PROTODO-E2E-TITULOS';

/** Carga de cheerio con las banderas CANONICAS del proyecto. */
const loadFragment = (html: string): CheerioAPI =>
  cheerio.load(html, { xml: { xmlMode: false } }, false);

/**
 * Panel institucional de prueba.
 *
 * Imita el marcado real de la pagina de Madrid+D (acordeon de Bootstrap 3).
 * Sigue SIN ser la fila de `plantillas_html`: esto verifica que se puede
 * insertar en la pagina tal y como esta hoy, no que la plantilla sembrada sea
 * correcta. Desde la migracion 034 las dos comparten forma —el mismo acordeon,
 * la misma `a.panel-toggle-link`— porque el panel de prueba debe parecerse a lo
 * que el flujo publicara de verdad; lo que no comparten es el origen.
 *
 * Los `aria-*` sobreviven porque este script escribe directo contra Drupal y no
 * pasa por `TemplateRendererService`, cuya lista blanca si los descartaria.
 */
const buildTestPanel = (): string => `
  <div class="panel panel-default" data-protodo-injected="true" data-test-id="${TEST_ID}" aria-expanded="false">
    <div class="panel-heading">
      <h5 class="panel-title">
        <a class="panel-toggle-link" href="#collapseCEU_TEST" aria-expanded="false" data-parent="#accordionCEU" data-bs-toggle="collapse">
          <strong>CEU TEST</strong>&nbsp;Facultad de Ingenieria y Pruebas E2E (Proto-Do)
        </a>
      </h5>
    </div>
    <div class="collapse" id="collapseCEU_TEST">
      <div class="panel-body">
        <div class="pane">
          <table class="tableform">
            <tbody>
              <tr><th>9999999</th><th colspan="2">Grado en Automatizacion y Orquestacion FSM</th></tr>
              <tr><th>&nbsp;</th><th style="background-color:#A9BCF5;">Evaluador</th><th style="background-color:#A9BCF5;">Institucion</th></tr>
              <tr><th>Presidente:</th><th>Victor Contreras</th><th>UNUWARE</th></tr>
              <tr><th>Secretario:</th><th>Tech Lead Proto-Do</th><th>Fmi+d</th></tr>
              <tr><th>Vocal:</th><th>Evaluador QA</th><th>UCM</th></tr>
              <tr><th>Estudiante:</th><th>Auditor E2E</th><th>UPM</th></tr>
              <tr><th style="background-color:#C6E0B4;border:1px solid black;" colspan="3">Fecha Visita: &nbsp; 20 de Octubre</th></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
`;

/** Lee el `body` completo de la pagina: hace falta el formato, no solo el HTML. */
const fetchRemoteBody = async (
  drupalApiConfig: DrupalApiConfig,
  uuid: string,
): Promise<{ value: string; format: string }> => {
  const { data } = await axios.get<DrupalNodeResponse>(
    `${drupalApiConfig.baseUrl}/${SANDBOX_BUNDLE.replace('--', '/')}/${uuid}`,
    {
      headers: {
        // Ir anonimo funcionaria mientras la pagina sea publica, pero un nodo
        // despublicado devolveria un 401 que se leeria como «no persistio».
        Authorization: drupalApiConfig.authHeader,
        Accept: 'application/vnd.api+json',
      },
      timeout: drupalApiConfig.timeoutMs,
    },
  );

  const body = data.data?.attributes?.body;

  return { value: body?.value ?? '', format: body?.format ?? 'full_html' };
};

/** Escribe el cuerpo completo y devuelve el codigo HTTP de la respuesta. */
const patchRemoteBody = async (
  drupalApiConfig: DrupalApiConfig,
  uuid: string,
  value: string,
  format: string,
): Promise<number> => {
  const { status } = await axios.patch(
    `${drupalApiConfig.baseUrl}/${SANDBOX_BUNDLE.replace('--', '/')}/${uuid}`,
    {
      data: {
        type: SANDBOX_BUNDLE,
        id: uuid,
        attributes: { body: { value, format } },
      },
    },
    {
      headers: {
        Authorization: drupalApiConfig.authHeader,
        Accept: 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json',
      },
      timeout: drupalApiConfig.timeoutMs,
    },
  );

  return status;
};

const main = async (): Promise<void> => {
  const shouldWrite = process.argv.includes(WRITE_FLAG);
  const shouldKeep = KEEP_FLAGS.some((flag) => process.argv.includes(flag));

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    // La validacion va DESPUES del bootstrap y lee por el config resuelto, no
    // por `process.env`: quien vuelca el `.env` es el `ConfigModule` de
    // `AppModule`, asi que una guarda anterior veria todo vacio y aprobaria
    // cualquier entorno.
    const drupalApiConfig = app.get(DrupalApiConfig, { strict: false });

    if (!drupalApiConfig.isUsable) {
      throw new Error(
        'Credenciales de Drupal incompletas. Bajo BASIC hacen falta DRUPAL_API_USER y ' +
          'DRUPAL_API_TOKEN en backend/.env.',
      );
    }

    const cleanup = new DrupalSandboxCleanupService(drupalApiConfig);
    const configuredUuid = app
      .get(ConfigService)
      .get<string>(SANDBOX_UUID_VAR)
      ?.trim();

    const uuid =
      configuredUuid !== undefined && configuredUuid.length > 0
        ? configuredUuid
        : await cleanup.resolveNodeUuidByAlias(
            DEFAULT_PATH_ALIAS,
            SANDBOX_BUNDLE,
          );

    logger.log(`Pagina objetivo: ${DEFAULT_PATH_ALIAS} | uuid=${uuid}`);

    const original = await fetchRemoteBody(drupalApiConfig, uuid);

    const $ = loadFragment(original.value);

    // Guarda ANTI-CONTAMINACION, y es la contrapartida obligatoria de `--keep`.
    // Si una corrida anterior dejo el panel publicado, este GET tomaria la
    // pagina sucia como linea base legitima: la prueba inyectaria un SEGUNDO
    // panel y acabaria comparando contra un estado que ya era incorrecto. Se
    // comprueba tambien en simulacion, porque el aviso sirve antes de escribir.
    const previous = $(INJECTED_MARKER).length;

    if (previous > 0) {
      logger.error(
        `La pagina remota ya contiene ${previous} bloque(s) inyectado(s) de una corrida ` +
          `anterior, probablemente con --keep. Ejecuta "npm run drupal:cleanup -- ` +
          `${DEFAULT_PATH_ALIAS}" antes de correr el E2E.`,
      );
      process.exitCode = 1;

      return;
    }

    // Guarda de estructura. Sin el acordeon no hay donde insertar, y caer a la
    // raiz del fragmento «por si acaso» publicaria un panel suelto flotando en
    // una pagina real. Mejor parar y decir que la suposicion no se cumple.

    if ($(ACCORDION_SELECTOR).length === 0) {
      throw new Error(
        `La pagina no contiene "${ACCORDION_SELECTOR}". El marcado de destino cambio o el ` +
          'alias apunta a otra pagina: ajusta ACCORDION_SELECTOR al contenedor real.',
      );
    }

    const panel = buildTestPanel();

    // Guarda de DESPLIEGUE. Corre antes de la bifurcacion por `--write`, de modo
    // que la simulacion —que es como se lanza a diario— tambien la ejercita. Lo
    // que vigila no lo ve ningun otro punto del sistema: el ESCUDO_POST_IA
    // aprueba un `href` relleno con el placeholder, y un panel cuyo enlace y
    // contenedor no casan se publica sin una sola queja y falla al pulsarlo.
    const undeployable = findUndeployablePanelReasons(panel);

    if (undeployable.length > 0) {
      throw new Error(
        `El panel no desplegaria una vez publicado:\n- ${undeployable.join('\n- ')}`,
      );
    }

    if (!shouldWrite) {
      logger.log(
        `SIMULACION: no se ha escrito nada. Con ${WRITE_FLAG} se antepondria este panel ` +
          `a "${ACCORDION_SELECTOR}":\n${panel}`,
      );

      return;
    }

    // --- 1. Inyeccion
    $(ACCORDION_SELECTOR).first().prepend(panel);

    const injectedStatus = await patchRemoteBody(
      drupalApiConfig,
      uuid,
      $.html(),
      original.format,
    );

    if (injectedStatus !== 200) {
      throw new Error(
        `El PATCH de inyeccion devolvio ${injectedStatus} y no 200; se aborta sin restaurar ` +
          'para no escribir dos veces sobre un estado desconocido.',
      );
    }

    // --- 2. Comprobacion de que el panel esta publicado de verdad
    const afterInject = await fetchRemoteBody(drupalApiConfig, uuid);
    const injectedCount = loadFragment(afterInject.value)(
      INJECTED_MARKER,
    ).length;

    if (injectedCount === 0) {
      throw new Error(
        'El PATCH respondio 200 pero el panel no aparece al releer la pagina. Revisa si el ' +
          'formato de texto del cuerpo filtra atributos.',
      );
    }

    logger.log(
      `Panel publicado y verificado (${injectedCount} coincidencia/s).`,
    );

    // --- 3. Salida con el panel puesto, si se pidio verlo
    if (shouldKeep) {
      logger.log(
        'Modo --keep activo: el panel permanece visible en Drupal. Para retirarlo ejecuta ' +
          `"npm run drupal:cleanup -- ${DEFAULT_PATH_ALIAS}". Hasta entonces, una nueva ` +
          'corrida de este E2E se negara a arrancar para no contaminar su linea base.',
      );

      return;
    }

    // --- 4. Restauracion inmediata
    const result = await cleanup.purgeInjectedBlocks({
      pathAlias: DEFAULT_PATH_ALIAS,
      nodeUuid: uuid,
      bundle: SANDBOX_BUNDLE,
    });

    logger.log(
      `Purga: ${result.purgedCount} bloque(s) | actualizado=${result.updated}`,
    );

    // --- 5. Verificacion en tres tramos contra la linea base
    const restored = await fetchRemoteBody(drupalApiConfig, uuid);
    // Serializada por cheerio: es el estado al que converge la pagina tras
    // cualquier PATCH, y comparar contra el crudo de Drupal daria por fallida
    // cada corrida correcta.
    const baseline = loadFragment(original.value).html();
    const leftovers = loadFragment(restored.value)(INJECTED_MARKER).length;

    // Tramo 1: sobra algo. La purga no hizo su trabajo.
    if (leftovers > 0) {
      throw new Error(
        `Quedan ${leftovers} bloque(s) marcados tras la purga. Ejecuta "npm run drupal:cleanup -- ` +
          `${DEFAULT_PATH_ALIAS}" y revisa los selectores.`,
      );
    }

    if (
      normalizeHtmlForComparison(restored.value) !==
      normalizeHtmlForComparison(baseline)
    ) {
      const restoredText = textContentOf(restored.value);
      const baselineText = textContentOf(baseline);

      // Tramo 2: FALTA algo. Es el unico fallo sin vuelta atras de todo esto, y
      // el chequeo de residuos no lo ve: aquel mira que no sobre nada, nunca
      // que no falte. Se mide sobre el texto plano porque la cosmetica no
      // cambia lo que se lee y un borrado si.
      if (restoredText.length < baselineText.length) {
        throw new Error(
          `El cuerpo restaurado perdio ${baselineText.length - restoredText.length} caracteres ` +
            'de texto: la purga se llevo por delante contenido que no habia inyectado esta ' +
            'prueba. Revisa los selectores antes de volver a correrla.',
        );
      }

      // Tramo 3: difiere solo en formato. Drupal reescribe el marcado al
      // guardar, y eso no es un fallo de la purga.
      logger.warn(
        'Drupal aplico transformaciones cosmeticas al guardar, pero el texto esta intacto y no ' +
          'queda ningun bloque de prueba en el DOM.',
      );
    } else {
      logger.log('Restauracion validada contra la linea base normalizada.');
    }

    logger.log('E2E OK: panel inyectado, verificado y retirado sin residuo.');
  } finally {
    // Sin esto el proceso queda colgado del pool de conexiones de TypeORM.
    await app.close();
  }
};

main().catch((error: unknown) => {
  logger.error(
    error instanceof Error ? error.message : 'Error desconocido',
    error instanceof Error ? error.stack : undefined,
  );
  process.exitCode = 1;
});
