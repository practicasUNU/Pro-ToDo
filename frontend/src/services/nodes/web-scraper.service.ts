import { api } from '@boot/axios';

import type { CheckScraperPayload, CheckScraperResult } from '@/types/web-scraper';

// Frontera HTTP del nodo EXTRACTOR_WEB (regla frontend-quasar.md §3.1).
//
// Ruta exclusiva del asistente, como las del disparador IMAP y el parser. Cero
// logica de negocio: que hacer con el resultado lo decide el store, y el mensaje
// al usuario lo decide el componente.

/**
 * Extrae un articulo de una URL real con la MISMA logica que ejecutara el nodo.
 *
 * El backend comparte `WebScraperRunner` con la estrategia, incluida la
 * deteccion de bloqueo: lo que se ve aqui es lo que producira el flujo.
 *
 * Un portal caido, un muro de pago o una pagina sin articulo NO son un 4xx:
 * llegan como 200 con `success: false` y su `error.code`. El 4xx queda para un
 * cuerpo mal formado, y el caso mas probable de todos es enviar una plantilla
 * `{{...}}` en `targetUrl`, que este endpoint rechaza a proposito.
 */
export const checkScraper = async (payload: CheckScraperPayload): Promise<CheckScraperResult> => {
  const { data } = await api.post<CheckScraperResult>('/wizard/check-scraper', payload);

  return data;
};
