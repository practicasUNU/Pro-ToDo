// Las guardas de `ImapPollingService` y `CronSchedulingService` leen estas dos
// variables en su `onModuleInit`, asi que tienen que estar puestas ANTES de que
// Nest construya el grafo. Con los valores del `.env` de desarrollo
// (`IMAP_POLLING_ENABLED=true`, `CRON_SCHEDULING_ENABLED=true`) levantar el
// contexto inscribiria sondeos contra buzones reales y los CRON de los flujos
// activos, que seguirian corriendo mientras dure este script.
//
// Va arriba del todo, antes incluso de los imports de Nest, porque un import
// con efectos secundarios podria adelantarse a cualquier linea de `main()`.
process.env.IMAP_POLLING_ENABLED = 'false';
process.env.CRON_SCHEDULING_ENABLED = 'false';

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import axios from 'axios';
import * as cheerio from 'cheerio';

import { generateDevJwt } from '@common/utils/dev-jwt.util';
import { DrupalApiConfig } from '@core/config/drupal-api.config';
import { NodeStrategyFactory } from '@core/fsm/factories/node-strategy.factory';
import { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { DrupalOperationMode } from '@modules/nodes/dto/drupal-http-config.dto';
import { UserRole } from '@modules/users/enums/user-role.enum';

import { AppModule } from '../app.module';

import type { NodeResult } from '@core/fsm/types/node-strategy.types';

/**
 * Prueba E2E EN CALIENTE del tramo final del pipeline, contra el Drupal real.
 *
 *   npm run test:drupal:e2e             # simulacion: NO escribe nada
 *   npm run test:drupal:e2e -- --write  # escribe en PRODUCCION
 *
 * Encadena a mano `ESCUDO_POST_IA` -> `DESTINO_HTTP` sobre la pagina de pruebas
 * de licitaciones. Existe porque las suites unitarias tienen PROHIBIDO llamar
 * por red (`testing-standards.md` §2): el circuito completo contra el CMS no se
 * puede cubrir alli, y hasta que alguien lo ejerce no se sabe si el HTML que
 * sale del escudo es el que Drupal acepta.
 *
 * ## Escribe en produccion
 *
 * `www.madrimasd.org` es el portal de verdad. La pagina es de sandbox, pero el
 * bloque queda publicado y visible, y cada corrida con `--write` anade uno mas:
 * se acumulan y hay que retirarlos a mano. Por eso la escritura NO es el
 * comportamiento por defecto.
 *
 * ## Efecto secundario que no se puede desactivar
 *
 * `FsmModule.onModuleInit` pasa INCONDICIONALMENTE toda ejecucion `EN_PROCESO` a
 * `PAUSADO` al arrancar cualquier contexto de Nest. Si el backend de desarrollo
 * esta ejecutando un flujo, este script se lo pausa. No ejecutar con flujos en
 * vuelo.
 *
 * ## El token que imprime no lo usa el circuito
 *
 * Las estrategias se invocan EN PROCESO, sin peticion HTTP, asi que ningun guard
 * llega a ejecutarse —`IpWhitelistGuard`, `JwtAuthGuard` y `RolesGuard` son
 * `CanActivate` del router—. El JWT se emite como comodidad para probar
 * endpoints a mano con curl, no porque haga falta aqui.
 */
const logger = new Logger('DrupalSandboxE2E');

/** Bandera que habilita la escritura real. */
const WRITE_FLAG = '--write';

/** Sufijo obligatorio de la raiz de la API; ver la guarda de `assertPreflight`. */
const JSONAPI_SUFFIX = '/jsonapi';

/** Pagina agregadora de licitaciones en el sandbox, y su bundle. */
const SANDBOX_UUID_VAR = 'DRUPAL_SANDBOX_LICITACIONES_UUID';
const SANDBOX_BUNDLE = 'node--page';

/** Marcador del bloque inyectado. Es tambien el `itemSelector` de un traslado. */
const BLOCK_CLASS = 'licitacion-entry';

/**
 * Respuesta de JSON:API recortada a lo que lee este script.
 *
 * Se tipa en vez de usar `any` para que el acceso a `body.value` no dispare
 * `no-unsafe-member-access`, y sobre todo para que un cambio de forma en la
 * respuesta salga al compilar y no como `undefined` silencioso.
 */
interface DrupalNodeResponse {
  data?: {
    attributes?: {
      body?: { value?: string };
    };
  };
}

/**
 * Comprueba el entorno ANTES de levantar nada.
 *
 * Corre DESPUES del bootstrap y lee por `ConfigService`, no por `process.env`
 * antes de arrancar. Es la diferencia entre comprobar algo y comprobar nada:
 * quien vuelca el `.env` sobre `process.env` es el `ConfigModule.forRoot()` de
 * `AppModule`, asi que una guarda anterior veria todas las variables vacias y
 * aprobaria cualquier entorno. Leer de `DrupalApiConfig` tiene ademas la
 * ventaja de mirar exactamente la misma fuente que mirara la estrategia.
 *
 * La guarda del sufijo no es cosmetica. `DrupalApiConfig.baseUrl` documenta que
 * `/jsonapi` viaja DENTRO del valor de la variable, y su defecto lo incluye;
 * pero el defecto solo entra si la variable esta vacia. Una raiz sin sufijo se
 * usa tal cual y compone `https://www.madrimasd.org/node/page/{uuid}`, que es
 * una ruta de front-end: Drupal responde HTML y el fallo aparece como un error
 * de parseo tres pasos mas abajo, sin pista de donde vino.
 */
const assertPreflight = (
  drupalApiConfig: DrupalApiConfig,
  configService: ConfigService,
): string => {
  const uuid = configService.get<string>(SANDBOX_UUID_VAR)?.trim() ?? '';

  if (!drupalApiConfig.isUsable) {
    throw new Error(
      'DRUPAL_API_TOKEN no esta definida en backend/.env: sin ella toda peticion a Drupal es un 401.',
    );
  }

  if (!drupalApiConfig.baseUrl.endsWith(JSONAPI_SUFFIX)) {
    throw new Error(
      `DRUPAL_API_BASE_URL vale "${drupalApiConfig.baseUrl}" y debe terminar en "${JSONAPI_SUFFIX}": ` +
        'es la raiz de TODAS las rutas del modulo (/node/page/{uuid}, /node/noticias). ' +
        `Corrigelo en backend/.env a "${drupalApiConfig.baseUrl}${JSONAPI_SUFFIX}".`,
    );
  }

  if (uuid === '') {
    throw new Error(
      `${SANDBOX_UUID_VAR} no esta definida en backend/.env: es el identificador de la pagina de pruebas.`,
    );
  }

  return uuid;
};

/**
 * Bloque de licitacion simulado, con un expediente unico por corrida.
 *
 * El envoltorio es un `<div>` y NO un `<article>`, y la diferencia decide si la
 * prueba sirve: `TEMPLATE_SANITIZER_CONFIG` excluye a proposito las etiquetas de
 * estructura de pagina (`section`, `article`, `header`, `footer`, `nav`, `main`),
 * y con `disallowedTagsMode: 'discard'` la etiqueta se DESENVUELVE —su contenido
 * sobrevive, el elemento y su `class` no—. Con un `<article>`, la verificacion
 * final no encontraria nunca el bloque y toda corrida exitosa se leeria como
 * fallida.
 *
 * `class` y `data-*` son atributos globales de la lista blanca, asi que el
 * marcador del expediente sobrevive al saneado. Eso es ademas lo que haria
 * localizable el bloque por `itemSelector` si luego se quisiera ejercitar
 * `TRANSFER_HTML_BLOCK`.
 */
const buildSandboxMarkup = (
  expediente: string,
  publishedAt: string,
): string => `
  <div class="${BLOCK_CLASS}" data-expediente="${expediente}">
    <h3 class="licitacion-title">Suministro de Infraestructura de Computo UNUWARE</h3>
    <span class="expediente-badge">Expediente: ${expediente}</span>
    <p class="licitacion-desc">
      Adquisicion y despliegue de servidores para orquestacion FSM automatizada.
    </p>
    <a class="pliego-link" href="https://www.madrimasd.org/sites/default/files/pliego_sandbox.pdf">
      Descargar Pliego Tecnico (PDF)
    </a>
    <time datetime="${publishedAt}">Fecha de publicacion: ${publishedAt}</time>
  </div>
`;

/** Lee el `body.value` actual de la pagina. Solo lectura: no muta nada. */
const fetchRemoteBody = async (
  drupalApiConfig: DrupalApiConfig,
  uuid: string,
): Promise<string> => {
  const { data } = await axios.get<DrupalNodeResponse>(
    `${drupalApiConfig.baseUrl}/${SANDBOX_BUNDLE.replace('--', '/')}/${uuid}`,
    {
      headers: {
        Authorization: `Bearer ${drupalApiConfig.token}`,
        Accept: 'application/vnd.api+json',
      },
      timeout: drupalApiConfig.timeoutMs,
    },
  );

  return data.data?.attributes?.body?.value ?? '';
};

/**
 * Lee una clave del payload de un nodo como texto imprimible.
 *
 * `NodeResult.data` es `Record<string, unknown>`, y pasar un `unknown` por
 * `String()` seria un `[object Object]` en el informe el dia que una clave
 * cambie de forma. Se estrecha a los primitivos que de verdad publican estas
 * dos estrategias y lo demas se marca como no imprimible.
 */
const asText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value.toString();
  }

  return '(no imprimible)';
};

/** Traza legible del resultado de un nodo, con el codigo de error si fallo. */
const reportNodeFailure = (nodeName: string, result: NodeResult): void => {
  logger.error(
    `${nodeName} fallo: ${result.error?.code ?? 'SIN_CODIGO'} (${result.error?.level ?? 'SIN_NIVEL'})`,
  );
  logger.error(result.error?.message ?? 'Sin mensaje');

  if (result.error?.missingFields !== undefined) {
    logger.error(`Campos implicados: ${result.error.missingFields.join(', ')}`);
  }
};

const main = async (): Promise<void> => {
  const shouldWrite = process.argv.includes(WRITE_FLAG);

  logger.log(
    '--- PRUEBA E2E: ESCUDO_POST_IA -> DESTINO_HTTP (sandbox Drupal) ---',
  );

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const strategyFactory = app.get(NodeStrategyFactory);
    // `strict: false` porque `DrupalApiConfig` es provider de `NodesModule` y no
    // del scope raiz; sin ello `app.get` no lo encuentra.
    const drupalApiConfig = app.get(DrupalApiConfig, { strict: false });
    const sandboxUuid = assertPreflight(
      drupalApiConfig,
      app.get(ConfigService),
    );

    // Cortesia para pruebas manuales con curl. El circuito de abajo NO lo usa.
    const devToken = generateDevJwt(app.get(JwtService), {
      role: UserRole.ADMIN,
    });
    logger.log('JWT ADMIN para pruebas manuales (este script no lo consume):');
    console.log(devToken);

    // --- 1. Contexto con la salida simulada del PROCESADOR_IA.
    const stamp = Date.now();
    const executionId = `e2e-exec-${stamp}`;
    const expediente = `EXP-SANDBOX-2026-${stamp}`;
    const publishedAt = new Date().toISOString();
    const markup = buildSandboxMarkup(expediente, publishedAt);

    const context = new StatePayloadContext(executionId, 'e2e-flow', 'escudo');
    context.setNamespace('llm_response', {
      filled_markup: markup,
      headline: 'Suministro de Infraestructura UNUWARE',
    });

    // --- 2. ESCUDO_POST_IA. `sourceNamespace` y `sourceField` se dejan al
    //        defecto: ya valen `llm_response` / `filled_markup`.
    logger.log('-> Ejecutando ESCUDO_POST_IA...');

    const shieldResult = await strategyFactory
      .getStrategy(NodeType.ESCUDO_POST_IA)
      .execute(context, {
        requiredSelectors: [
          `.${BLOCK_CLASS}`,
          'h3',
          '.expediente-badge',
          '.pliego-link',
        ],
      });

    if (!shieldResult.success || shieldResult.data === undefined) {
      reportNodeFailure('ESCUDO_POST_IA', shieldResult);
      process.exitCode = 1;
      return;
    }

    const validatedMarkup = asText(shieldResult.data.validated_markup);

    logger.log(
      `ESCUDO_POST_IA ok · ${asText(shieldResult.data.character_count)} caracteres · auditoria ${asText(shieldResult.data.audit_status)}`,
    );
    console.log('\n----- markup saneado que se va a publicar -----');
    console.log(validatedMarkup);

    // --- 3. Puente entre nodos. Es lo unico que hace el motor entre un paso y
    //        el siguiente (`FsmEngineService` llama a `setNamespace` con el
    //        `outputNamespace` del nodo). El namespace NO es arbitrario:
    //        `validated_drupal_json` es el que el destino lee por defecto, de
    //        modo que los dos encajan sin configuracion extra.
    context.setNamespace('validated_drupal_json', shieldResult.data);

    const currentBody = await fetchRemoteBody(drupalApiConfig, sandboxUuid);

    // --- 4a. Simulacion: se informa de lo que se enviaria y se para aqui.
    //         No se invoca la estrategia porque su `APPEND_HTML_BLOCK` hace GET
    //         y PATCH como una sola unidad y no tiene modo de solo lectura.
    if (!shouldWrite) {
      logger.warn(
        `MODO SIMULACION (sin ${WRITE_FLAG}): no se escribira en Drupal.`,
      );
      console.table([
        {
          operacion: DrupalOperationMode.APPEND_HTML_BLOCK,
          url: `${drupalApiConfig.baseUrl}/node/page/${sandboxUuid}`,
          bytes_actuales: currentBody.length,
          bytes_bloque: validatedMarkup.length,
          bytes_resultantes: currentBody.length + validatedMarkup.length,
        },
      ]);
      logger.log(
        `Para escribir de verdad: npm run test:drupal:e2e -- ${WRITE_FLAG}`,
      );
      return;
    }

    // --- 4b. Escritura real.
    logger.warn(
      `ESCRIBIENDO EN PRODUCCION: ${drupalApiConfig.baseUrl} (${sandboxUuid})`,
    );

    const drupalResult = await strategyFactory
      .getStrategy(NodeType.DESTINO_HTTP)
      .execute(context, {
        operationMode: DrupalOperationMode.APPEND_HTML_BLOCK,
        bundle: SANDBOX_BUNDLE,
        targetNodeUuid: sandboxUuid,
        insertPosition: 'PREPEND',
      });

    if (!drupalResult.success || drupalResult.data === undefined) {
      reportNodeFailure('DESTINO_HTTP', drupalResult);
      process.exitCode = 1;
      return;
    }

    logger.log(
      `DESTINO_HTTP ok · HTTP ${asText(drupalResult.data.http_status)} · nid ${asText(drupalResult.data.drupal_internal__nid)}`,
    );

    // --- 5. Verificacion contra el DOM remoto. Es la unica prueba de que el
    //        PATCH persistio: la respuesta del propio PATCH dice lo que Drupal
    //        acepto, no lo que quedo guardado.
    logger.log('-> Verificando persistencia con un GET...');

    const persistedBody = await fetchRemoteBody(drupalApiConfig, sandboxUuid);
    const $ = cheerio.load(persistedBody, { xml: { xmlMode: false } }, false);

    const totalBlocks = $(`.${BLOCK_CLASS}`).length;
    // Se busca el expediente de ESTA corrida y no solo la clase: la pagina
    // acumula los bloques de corridas anteriores, y contarlos todos no
    // distingue "se escribio ahora" de "ya habia algo".
    const ownBlock = $(`[data-expediente="${expediente}"]`).length;

    console.table([
      {
        expediente,
        bloque_de_esta_corrida: ownBlock,
        bloques_totales_en_la_pagina: totalBlocks,
      },
    ]);

    if (ownBlock > 0) {
      logger.log('PRUEBA E2E EXITOSA: el circuito cerro de extremo a extremo.');
    } else {
      logger.error(
        'El PATCH respondio correctamente pero el bloque NO aparece en el cuerpo remoto.',
      );
      process.exitCode = 1;
    }
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
