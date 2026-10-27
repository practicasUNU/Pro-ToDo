import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

import { INTERPOLATION_ONLY_PATTERN } from '@core/fsm/context/state-payload.context';

/** Espera maxima por defecto para que la pagina cargue: veinte segundos. */
export const DEFAULT_SCRAPER_TIMEOUT_MS = 20_000;

/**
 * Suelo del `timeoutMs`.
 *
 * Por debajo de cinco segundos casi ningun portal de noticias termina de servir
 * el documento, y el nodo se pasaria la vida devolviendo
 * `ERR_SCRAPING_TIMEOUT_EXCEEDED` contra paginas que funcionan.
 */
export const MIN_SCRAPER_TIMEOUT_MS = 5_000;

/**
 * Techo del `timeoutMs`.
 *
 * El motor FSM ejecuta los nodos en linea, asi que este valor es tiempo que el
 * flujo entero pasa bloqueado. Un minuto es el limite a partir del cual conviene
 * dar la pagina por perdida antes que retener la ejecucion.
 */
export const MAX_SCRAPER_TIMEOUT_MS = 60_000;

/** Reintentos rapidos por defecto, adicionales al primer intento. */
export const DEFAULT_SCRAPER_MAX_RETRIES = 3;

/** Techo de reintentos internos. Ver la nota sobre `retryPolicy` mas abajo. */
export const MAX_SCRAPER_RETRIES = 5;

/** Espera por defecto entre reintentos internos: dos segundos. */
export const DEFAULT_SCRAPER_RETRY_DELAY_MS = 2_000;

/** Suelo de la espera entre reintentos. */
export const MIN_SCRAPER_RETRY_DELAY_MS = 500;

/** Techo de la espera entre reintentos. */
export const MAX_SCRAPER_RETRY_DELAY_MS = 10_000;

/**
 * Tope de dominios excluidos por nodo.
 *
 * No es una restriccion tecnica sino de diagnostico: la exclusion se recorre por
 * cada URL candidata, y una lista de cien dominios deja de ser una decision
 * editorial legible para convertirse en un filtro que nadie sabe por que
 * descarto el enlace del dia.
 */
export const MAX_EXCLUDED_DOMAINS = 20;

/**
 * Forma admitida de un dominio excluido: SOLO el host.
 *
 * Se rechaza a proposito `https://madrimasd.org/portal` y cualquier cosa con
 * esquema, ruta, puerto o barra. La comparacion se hace contra `url.hostname`,
 * asi que un valor con mas partes no coincidiria NUNCA: aceptarlo produciria un
 * filtro silenciosamente inerte, que es peor que un 400 al guardar.
 *
 * Admite etiquetas alfanumericas con guiones interiores, al menos dos niveles
 * (`madrimasd.org`), y no exige TLD conocido.
 */
export const EXCLUDED_DOMAIN_PATTERN =
  /^(?!-)[a-z0-9-]+(?<!-)(?:\.(?!-)[a-z0-9-]+(?<!-))+$/i;

/**
 * Por defecto, un extractor sin origen se SALTA en vez de romper el flujo.
 *
 * Se elige este defecto porque el modo de fallo que cubre —el correo que no
 * traia enlaces, la contingencia OCR que nunca publica una URL— es rutinario, y
 * convertirlo en una incidencia que alguien tiene que cerrar a mano cuesta mas
 * que el riesgo contrario. El precio esta asumido: un operador que olvide elegir
 * el origen obtiene un flujo que se salta la extraccion en silencio, y por eso
 * el asistente lo avisa de forma no bloqueante en vez de callarselo.
 */
export const DEFAULT_SCRAPER_SKIP_IF_EMPTY = true;

/**
 * Por defecto, un fallo de EXTRACCION tampoco rompe el flujo.
 *
 * Cubre una familia distinta de la de `DEFAULT_SCRAPER_SKIP_IF_EMPTY`, y la
 * frontera entre las dos es deliberada: aquella responde a «no habia de donde
 * sacar una URL», esta a «habia una URL y el portal no se dejo leer» —el
 * timeout, el muro anti-bot, el documento del que Readability no aisla nada—.
 *
 * Se elige `true` porque ese modo de fallo es AJENO y transitorio: depende de un
 * tercero que ni el operador ni este sistema controlan, y dejar el flujo PAUSADO
 * esperando un reintento manual convierte la mala racha de un portal en trabajo
 * para una persona. El precio asumido es que un portal caido de forma
 * permanente se traduce en publicaciones con el cuerpo vacio en vez de en una
 * alerta; por eso el payload lo DECLARA con `status: 'FALLBACK_EMPTY'` en vez
 * de limitarse a callar.
 *
 * NO cubre los fallos de CONFIGURACION (`ERR_SCRAPER_CONFIG`,
 * `ERR_SCRAPER_URL_MALFORMED`): esos son defectos del flujo, no contingencias de
 * red, y silenciarlos esconderia un nodo mal compuesto tras un exito.
 */
export const DEFAULT_SCRAPER_IGNORE_EXTRACTION_FAILURE = true;

/**
 * Configuracion del nodo `EXTRACTOR_WEB`.
 *
 * AVISO SOBRE LOS DOS NIVELES DE REINTENTO. `maxRetries` y `retryDelayMs` son
 * el reintento RAPIDO DE RED de este nodo: cubren el corte de conexion puntual
 * y el portal que tarda de mas en una peticion concreta, y se resuelven en
 * segundos sin persistir nada. Son independientes del `retryPolicy` que el
 * `pipeline_schema` declara para el nodo, que es la politica del motor
 * (`FsmEngineService.canRetry`): esa reintenta el nodo ENTERO, con checkpoint en
 * PostgreSQL y backoff exponencial entre intentos.
 *
 * Las dos capas se multiplican. Con `maxRetries: 3` aqui y
 * `retryPolicy.maxRetries: 3` en el esquema, una pagina caida provoca hasta
 * DIECISEIS navegaciones y, con el `timeoutMs` por techo, mas de cinco minutos
 * de flujo bloqueado. Por eso se recomienda declarar este nodo en el esquema con
 * `retryPolicy: { maxRetries: 0 }` y dejar que el reintento viva solo aqui,
 * donde es barato: reaprovecha el mismo `BrowserContext` y no reserializa el
 * contexto acumulado en cada vuelta.
 */
export class WebScraperConfigDto {
  @ApiPropertyOptional({
    description:
      'Origen del enlace a extraer. Si viene, DEBE ser una variable interpolada contra el contexto acumulado, en una de sus dos formas: una POSICION concreta ("{{parsed_email.extracted_urls[0]}}") o el ARREGLO entero ("{{parsed_email.extracted_urls}}"), que toma el primer enlace elegible segun "excludedDomains". Opcional al GUARDAR (una plantilla de flujo declara topologia, no operativa) y obligatorio al ACTIVAR, que es donde lo exige `getIncompleteParams`.',
    example: '{{parsed_email.extracted_urls[0]}}',
  })
  // OPCIONAL, y esto es una decision sobre QUE significa guardar. Una plantilla
  // de flujo es un blueprint sin operativa: sus `params` van vacios a proposito
  // porque el valor concreto se elige despues, al instanciar el flujo en el
  // asistente. Con el campo obligatorio aqui, `PipelineValidatorService` —que
  // aplica este `paramsSchema` a plantillas y flujos por igual— hacia que
  // NINGUNA plantilla pudiera contener un EXTRACTOR_WEB: los tres constraints
  // saltaban a la vez sobre un `params: {}`.
  //
  // Lo que se valida aqui es la FORMA de lo que haya. Las otras dos preguntas
  // viven donde hay informacion para responderlas:
  //   - "hay de donde sacar una URL en este flujo" -> regla 8 de la topologia,
  //     via `requiredUpstreamFieldTypes`. Un DTO valida un nodo AISLADO y no
  //     puede saber quien va delante.
  //   - "esta completo para ejecutarse" -> `getIncompleteParams`, que consulta
  //     `assertActivatable` antes de habilitar un flujo.
  @IsOptional()
  @IsString({ message: 'targetUrl debe ser una cadena.' })
  @IsNotEmpty({ message: 'targetUrl no puede estar vacio.' })
  // NO se usa `@IsUrl()` y nunca se uso: aqui el valor no es una URL hasta que
  // el contexto lo resuelve. Quien valida el formato es la estrategia, sobre el
  // valor YA interpolado.
  //
  // Lo que SI cambia es que una URL literal deja de admitirse. El motivo es
  // topologico y no de formato: un `targetUrl` literal no menciona ningun
  // namespace, de modo que `getRequiredNamespaces` devuelve un arreglo vacio y
  // la regla 7 del validador de topologia se queda sin nada que comprobar. Ese
  // nodo podia entonces colocarse en cualquier punto del grafo —detras de un
  // TRIGGER_CRON, por ejemplo— y el esquema se guardaba igual. Exigiendo la
  // interpolacion, todo extractor declara de quien depende y esa laguna se
  // cierra en el momento de guardar.
  //
  // Precio asumido y decidido: el flujo que vigilaba siempre la misma portada
  // con una URL fija deja de ser expresable.
  @Matches(INTERPOLATION_ONLY_PATTERN, {
    message:
      'La URL objetivo debe ser una variable interpolada (ej. {{namespace.campo}}).',
  })
  targetUrl?: string;

  @ApiPropertyOptional({
    description: `Espera maxima de carga de la pagina, en milisegundos. Por defecto ${DEFAULT_SCRAPER_TIMEOUT_MS}`,
    default: DEFAULT_SCRAPER_TIMEOUT_MS,
    minimum: MIN_SCRAPER_TIMEOUT_MS,
    maximum: MAX_SCRAPER_TIMEOUT_MS,
  })
  @IsOptional()
  @IsInt({ message: 'timeoutMs debe ser un numero entero.' })
  @Min(MIN_SCRAPER_TIMEOUT_MS, {
    message: `timeoutMs no puede ser menor que ${MIN_SCRAPER_TIMEOUT_MS}.`,
  })
  @Max(MAX_SCRAPER_TIMEOUT_MS, {
    message: `timeoutMs no puede superar ${MAX_SCRAPER_TIMEOUT_MS}.`,
  })
  timeoutMs?: number;

  @ApiPropertyOptional({
    description: `Reintentos rapidos adicionales al primer intento. Por defecto ${DEFAULT_SCRAPER_MAX_RETRIES}`,
    default: DEFAULT_SCRAPER_MAX_RETRIES,
    minimum: 0,
    maximum: MAX_SCRAPER_RETRIES,
  })
  @IsOptional()
  @IsInt({ message: 'maxRetries debe ser un numero entero.' })
  @Min(0, { message: 'maxRetries no puede ser negativo.' })
  @Max(MAX_SCRAPER_RETRIES, {
    message: `maxRetries no puede superar ${MAX_SCRAPER_RETRIES}.`,
  })
  maxRetries?: number;

  @ApiPropertyOptional({
    description: `Espera entre reintentos rapidos, en milisegundos. Por defecto ${DEFAULT_SCRAPER_RETRY_DELAY_MS}`,
    default: DEFAULT_SCRAPER_RETRY_DELAY_MS,
    minimum: MIN_SCRAPER_RETRY_DELAY_MS,
    maximum: MAX_SCRAPER_RETRY_DELAY_MS,
  })
  @IsOptional()
  @IsInt({ message: 'retryDelayMs debe ser un numero entero.' })
  @Min(MIN_SCRAPER_RETRY_DELAY_MS, {
    message: `retryDelayMs no puede ser menor que ${MIN_SCRAPER_RETRY_DELAY_MS}.`,
  })
  @Max(MAX_SCRAPER_RETRY_DELAY_MS, {
    message: `retryDelayMs no puede superar ${MAX_SCRAPER_RETRY_DELAY_MS}.`,
  })
  retryDelayMs?: number;

  @ApiPropertyOptional({
    description:
      'Si es true, un "targetUrl" ausente deja de ser un fallo: el nodo devuelve el payload neutro (las cinco claves en blanco) y el flujo continua. Ademas exime a este nodo de la regla 8 de topologia, de modo que puede declararse en un flujo donde ningun paso anterior publica una URL (contingencia OCR).',
    default: DEFAULT_SCRAPER_SKIP_IF_EMPTY,
  })
  @IsOptional()
  @IsBoolean({ message: 'skipIfEmpty debe ser un booleano.' })
  skipIfEmpty?: boolean;

  @ApiPropertyOptional({
    description:
      'Si es true, un fallo de NAVEGACION o EXTRACCION (timeout, bloqueo anti-bot, portal inalcanzable, cuerpo no aislable) deja de pausar la FSM: el nodo devuelve el payload neutro con "status": "FALLBACK_EMPTY" y el flujo continua. No afecta a los fallos de configuracion, que siguen siendo GRAVE.',
    default: DEFAULT_SCRAPER_IGNORE_EXTRACTION_FAILURE,
  })
  @IsOptional()
  @IsBoolean({ message: 'ignoreExtractionFailure debe ser un booleano.' })
  ignoreExtractionFailure?: boolean;

  @ApiPropertyOptional({
    description:
      'Dominios que este nodo NUNCA navega (p. ej. el portal institucional propio, cuyo enlace en el correo es un metadato de enrutado editorial y no la noticia). Se comparan contra el host de la URL ya resuelta, incluyendo subdominios. Por defecto, lista vacia.',
    example: ['madrimasd.org'],
    maxItems: MAX_EXCLUDED_DOMAINS,
    type: [String],
  })
  // DEFECTO VACIO, y es una decision: el backend no cablea ningun dominio de
  // ningun cliente. La sugerencia institucional la ofrece el asistente, donde el
  // operador la acepta o la quita; sembrarla aqui se la impondria ademas a todo
  // flujo ya guardado, que nadie pidio cambiar.
  @IsOptional()
  @IsArray({ message: 'excludedDomains debe ser un arreglo.' })
  @ArrayMaxSize(MAX_EXCLUDED_DOMAINS, {
    message: `excludedDomains no puede superar ${MAX_EXCLUDED_DOMAINS} entradas.`,
  })
  @IsString({
    each: true,
    message: 'Cada dominio excluido debe ser una cadena.',
  })
  @Matches(EXCLUDED_DOMAIN_PATTERN, {
    each: true,
    message:
      'Cada dominio excluido debe ser solo el host (p. ej. "madrimasd.org"), sin esquema, puerto ni ruta.',
  })
  excludedDomains?: string[];
}

/** Configuracion del extractor con los valores por defecto ya aplicados. */
export interface ResolvedWebScraperConfig {
  readonly targetUrl: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly retryDelayMs: number;
  readonly skipIfEmpty: boolean;
  readonly ignoreExtractionFailure: boolean;
  readonly excludedDomains: readonly string[];
}

/**
 * Pasa la lista de exclusion a minusculas y la deduplica.
 *
 * `url.hostname` llega siempre en minusculas, asi que la conversion se hace UNA
 * vez aqui y no en cada comparacion; el `@Matches` admite las mayusculas porque
 * es lo unico que un dominio tecleado puede traer de mas sin dejar de ser un
 * host. Nada mas se "arregla" en esta funcion: corre DESPUES de la validacion,
 * de modo que recortar aqui espacios o un punto final seria limpiar algo que el
 * DTO ya ha rechazado con un 400, y daria a entender que se aceptan.
 *
 * Se deduplica porque la lista la escribe una persona y repetir un dominio no
 * cambia el resultado, solo gasta comparaciones por cada URL candidata.
 */
const normalizeExcludedDomains = (
  domains: readonly string[],
): readonly string[] => [
  ...new Set(domains.map((domain) => domain.toLowerCase())),
];

/** Aplica los valores por defecto sobre un DTO ya validado. Funcion pura. */
export const resolveWebScraperConfig = (
  dto: WebScraperConfigDto | ResolvedWebScraperConfig,
): ResolvedWebScraperConfig => ({
  // `?? ''` y no un lanzamiento: el DTO admite la ausencia al guardar, asi que
  // aqui hay que representarla. Quien la convierte en un fallo diagnosticado es
  // la guarda de `resolveConfig`, que emite ERR_SCRAPER_CONFIG antes de navegar.
  targetUrl: dto.targetUrl ?? '',
  timeoutMs: dto.timeoutMs ?? DEFAULT_SCRAPER_TIMEOUT_MS,
  maxRetries: dto.maxRetries ?? DEFAULT_SCRAPER_MAX_RETRIES,
  retryDelayMs: dto.retryDelayMs ?? DEFAULT_SCRAPER_RETRY_DELAY_MS,
  skipIfEmpty: dto.skipIfEmpty ?? DEFAULT_SCRAPER_SKIP_IF_EMPTY,
  ignoreExtractionFailure:
    dto.ignoreExtractionFailure ?? DEFAULT_SCRAPER_IGNORE_EXTRACTION_FAILURE,
  excludedDomains: normalizeExcludedDomains(dto.excludedDomains ?? []),
});
