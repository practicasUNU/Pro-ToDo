import {
  ERR_HTTP_TIMEOUT,
  ERR_HTTP_UPSTREAM_UNAVAILABLE,
} from '@core/http/http-client.service';
import { LlmProvider } from '@modules/nodes/strategies/interfaces/llm-provider.interface';

/**
 * Reglas del respaldo dinamico de proveedor, compartidas por los DOS nodos que
 * llaman a un modelo (`PROCESADOR_OCR` y `PROCESADOR_IA`).
 *
 * Viven aqui y no dentro de una estrategia porque el problema es identico en
 * ambas y dos copias divergirian: la tabla anterior (`OCR_PROVIDER_FALLBACKS`)
 * solo la conocia el nodo de OCR, de modo que el de redaccion se quedaba sin
 * ninguna alternativa ante el mismo 429. Son funciones puras: ni estado, ni
 * I/O, ni dependencia de Nest.
 */

/** Un intento concreto: a quien se llama y con que modelo. */
export interface ProviderAttempt {
  readonly provider: LlmProvider;
  readonly model: string;
}

/**
 * Sucesor de cada proveedor, con SU modelo.
 *
 * El modelo viaja junto al proveedor y no se arrastra el del nodo: ningun
 * identificador de Gemini existe en Anthropic, asi que conmutar conservandolo
 * produciria un 404 que parece un fallo de red.
 *
 * Solo se declara el salto que hoy tiene sentido. `OPENAI` no figura porque no
 * tiene cliente, y `MOCK` nunca es destino de un respaldo (ver
 * `buildProviderAttempts`).
 */
export const PROVIDER_FALLBACK_CHAIN: Partial<
  Record<LlmProvider, ProviderAttempt>
> = {
  [LlmProvider.GEMINI]: {
    provider: LlmProvider.ANTHROPIC,
    model: 'claude-haiku-4-5',
  },
};

/**
 * Codigos ante los que merece la pena probar con OTRO proveedor.
 *
 * `ERR_HTTP_UPSTREAM_UNAVAILABLE` es donde `HttpClientService.toFailure` mete
 * tanto el 429 de cuota como la familia 5xx: ambos dicen "este proveedor no
 * puede ahora", que es exactamente la condicion que otro proveedor si podria
 * atender. `ERR_HTTP_TIMEOUT` se le suma por el mismo motivo.
 *
 * Queda FUERA `ERR_HTTP_CLIENT_REJECTED` (400, 401, 404): un payload invalido o
 * una credencial mala se repetirian igual en el destino, y reintentar seria
 * pagar dos veces el mismo error. Tambien queda fuera el contrato roto
 * (`ERR_LLM_PROVIDER_CONTRACT`): es un fallo de formato de la respuesta, no de
 * disponibilidad.
 *
 * No se mira ningun status numerico: la clasificacion ya la hizo el cliente
 * HTTP, y rehacerla aqui seria tener dos criterios que pueden discrepar.
 */
const FALLBACK_WORTHY_CODES: ReadonlySet<string> = new Set([
  ERR_HTTP_UPSTREAM_UNAVAILABLE,
  ERR_HTTP_TIMEOUT,
]);

/** Si un fallo justifica cambiar de proveedor en vez de rendirse. */
export const isFallbackWorthy = (code: string | undefined): boolean =>
  code !== undefined && FALLBACK_WORTHY_CODES.has(code);

/**
 * Intentos a recorrer, en orden, empezando por el proveedor configurado.
 *
 * Reemplaza a la antigua resolucion por credencial ausente, que decidia UNA vez
 * antes de llamar: aquella no podia ver un 429, porque un proveedor saturado
 * tiene su variable de entorno perfectamente puesta. Aqui conviven las dos
 * razones para pasar de largo —sin credencial y, ya en el bucle, sin servicio—
 * con una sola tabla.
 *
 * NUNCA incluye `MOCK`, y es deliberado: completar una transcripcion con el
 * simulador publicaria texto inventado como si fuera lo que pone en el
 * documento. Un flujo sin alternativa real debe FALLAR y desviarse por su
 * `onErrorStep`, que es donde una persona se entera.
 *
 * Se protege de los ciclos con un conjunto de visitados: la tabla es editable a
 * mano y un par que se apunte mutuamente colgaria el nodo en un bucle infinito.
 *
 * @param start Proveedor y modelo que el nodo declaro.
 * @param isUsable Si un proveedor tiene cliente y credencial (lo responde
 *                 `LlmProviderCatalogService.isProviderUsable`).
 * @returns Lista no vacia salvo que ni el propio `start` sea usable.
 */
export const buildProviderAttempts = (
  start: ProviderAttempt,
  isUsable: (provider: LlmProvider) => boolean,
): readonly ProviderAttempt[] => {
  const attempts: ProviderAttempt[] = [];
  const visited = new Set<LlmProvider>();

  let cursor: ProviderAttempt | undefined = start;

  while (cursor !== undefined && !visited.has(cursor.provider)) {
    visited.add(cursor.provider);

    if (cursor.provider !== LlmProvider.MOCK && isUsable(cursor.provider)) {
      attempts.push(cursor);
    }

    cursor = PROVIDER_FALLBACK_CHAIN[cursor.provider];
  }

  return attempts;
};
