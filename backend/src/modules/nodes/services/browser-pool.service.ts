import { Injectable, Logger } from '@nestjs/common';
// Import de VALOR: `ConfigService` se inyecta por constructor, y con
// `emitDecoratorMetadata` un `import type` se borra al transpilar dejando a Nest
// sin el token que necesita para resolver la dependencia.
import { ConfigService } from '@nestjs/config';
import { chromium } from 'playwright';

import type { OnModuleDestroy } from '@nestjs/common';
import type { Browser, BrowserContext } from 'playwright';

/** Clave de entorno con el `User-Agent` institucional del extractor. */
export const SCRAPER_USER_AGENT_KEY = 'SCRAPER_USER_AGENT';

/**
 * `User-Agent` por defecto.
 *
 * El que Playwright pone de serie contiene literalmente "HeadlessChrome", que es
 * lo primero que miran los filtros anti-bot: con el, buena parte de los medios
 * devuelve el intersticial y el nodo falla con `ERR_ACCESS_DENIED_BLOCK_DETECTED`
 * sin haber llegado nunca al articulo.
 */
export const DEFAULT_SCRAPER_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Argumentos de arranque de Chromium.
 *
 * `--no-sandbox` es obligatorio dentro de un contenedor sin privilegios, donde
 * el sandbox de Chromium no puede crear los espacios de nombres que necesita.
 * `--disable-dev-shm-usage` lo es aun mas: `/dev/shm` son 64 MB por defecto en
 * Docker, y al agotarse el navegador muere a media navegacion con un "Target
 * closed" que no dice nada de su causa real.
 */
const LAUNCH_ARGS = ['--no-sandbox', '--disable-dev-shm-usage'];

/** Tipos de recurso que se abortan por no aportar nada al texto del articulo. */
const BLOCKED_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  'image',
  'media',
  'font',
]);

/** Ventana declarada al sitio. Un escritorio comun, no un movil. */
const VIEWPORT = { width: 1280, height: 800 };

/**
 * Instancia unica y reutilizable de Chromium para los nodos que navegan.
 *
 * RAZON DE SER: lanzar un navegador cuesta entre 300 ms y un segundo y deja un
 * proceso de ~200 MB. Hacerlo por ejecucion convertiria cada flujo en un arranque
 * completo y, lo que es peor, cualquier camino que no cierre —una excepcion, un
 * apagado brusco— dejaria el proceso huerfano: la fuga de memoria clasica de
 * Playwright en produccion.
 *
 * El aislamiento entre ejecuciones NO lo da el navegador sino el
 * `BrowserContext`: cada `createContext()` devuelve uno con sus propias cookies,
 * su `localStorage` y su cache, equivalente a una ventana de incognito. Quien lo
 * pide es quien debe cerrarlo, en un `finally`.
 *
 * Vive como servicio propio y no dentro de la estrategia para que esta se pruebe
 * con un doble, sin navegador real, y para que los futuros nodos que necesiten
 * navegacion headless compartan el mismo proceso en vez de abrir el suyo.
 */
@Injectable()
export class BrowserPoolService implements OnModuleDestroy {
  private readonly logger = new Logger(BrowserPoolService.name);

  private browser: Browser | null = null;

  /**
   * Arranque en vuelo.
   *
   * Se guarda la PROMESA y no el resultado: sin este cerrojo, dos ejecuciones
   * concurrentes que llegasen antes de que la primera terminara de lanzar
   * abririan dos procesos de Chromium, y uno de los dos quedaria huerfano para
   * siempre porque solo una referencia sobrevive en `this.browser`.
   */
  private launching: Promise<Browser> | null = null;

  constructor(private readonly configService: ConfigService) {}

  /**
   * Contexto aislado, listo para abrir paginas.
   *
   * El llamante es responsable de cerrarlo (`await context.close()`) en un
   * bloque `finally`. Un contexto sin cerrar retiene su cache y sus paginas en
   * la memoria del proceso de Chromium, que es residente: la fuga no se ve en el
   * heap de Node y solo aparece como crecimiento sostenido del contenedor.
   */
  public async createContext(): Promise<BrowserContext> {
    const browser = await this.resolveBrowser();

    const context = await browser.newContext({
      userAgent: this.resolveUserAgent(),
      locale: 'es-ES',
      viewport: VIEWPORT,
    });

    // Imagenes, video y tipografias no aportan NADA al texto que extrae
    // Readability y son el grueso del peso de un portal de noticias. Abortarlas
    // recorta la navegacion a una fraccion y reduce la probabilidad de agotar
    // `timeoutMs` en una pagina que, en lo que importa, ya estaba lista.
    await context.route('**/*', (route) => {
      if (BLOCKED_RESOURCE_TYPES.has(route.request().resourceType())) {
        return route.abort();
      }

      return route.continue();
    });

    return context;
  }

  public async onModuleDestroy(): Promise<void> {
    const browser = this.browser;

    this.browser = null;
    this.launching = null;

    if (browser === null) {
      return;
    }

    // Un fallo al cerrar no debe impedir el apagado de Nest: el proceso del
    // navegador muere igualmente con su padre.
    try {
      await browser.close();
    } catch (error) {
      this.logger.warn(
        `No se pudo cerrar Chromium limpiamente: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Devuelve el navegador vivo, lanzandolo si hace falta.
   *
   * El arranque es PEREZOSO: un despliegue que nunca ejecute un flujo con
   * `EXTRACTOR_WEB` no paga los ~200 MB del proceso. Se comprueba ademas
   * `isConnected()`: si Chromium murio por su cuenta —lo hace al agotarse
   * `/dev/shm`, o si el supervisor del contenedor lo mata por memoria— la
   * referencia sigue ahi pero ya no sirve, y sin este relanzamiento TODAS las
   * ejecuciones posteriores fallarian con "Target closed" hasta reiniciar el
   * backend a mano.
   */
  private async resolveBrowser(): Promise<Browser> {
    if (this.browser !== null && this.browser.isConnected()) {
      return this.browser;
    }

    this.launching ??= this.launchBrowser();

    try {
      this.browser = await this.launching;
    } finally {
      this.launching = null;
    }

    return this.browser;
  }

  private async launchBrowser(): Promise<Browser> {
    this.logger.log('Lanzando la instancia compartida de Chromium headless.');

    return chromium.launch({ headless: true, args: LAUNCH_ARGS });
  }

  /**
   * `User-Agent` del entorno, con el institucional por defecto.
   *
   * Se lee en cada llamada y no se cachea en el constructor a proposito: el
   * coste es un acceso a un mapa, y a cambio un cambio de la variable surte
   * efecto en la siguiente ejecucion sin reiniciar el proceso.
   */
  private resolveUserAgent(): string {
    const configured = this.configService
      .get<string>(SCRAPER_USER_AGENT_KEY)
      ?.trim();

    return configured !== undefined && configured.length > 0
      ? configured
      : DEFAULT_SCRAPER_USER_AGENT;
  }
}
