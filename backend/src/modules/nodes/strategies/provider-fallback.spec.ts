import { describe, expect, it } from '@jest/globals';

import {
  ERR_HTTP_CLIENT_REJECTED,
  ERR_HTTP_TIMEOUT,
  ERR_HTTP_UPSTREAM_UNAVAILABLE,
} from '@core/http/http-client.service';
import {
  ERR_LLM_PROVIDER_CONTRACT,
  LlmProvider,
} from '@modules/nodes/strategies/interfaces/llm-provider.interface';
import {
  buildProviderAttempts,
  isFallbackWorthy,
} from '@modules/nodes/strategies/provider-fallback';

/** Punto de partida habitual: el par por defecto del nodo de OCR. */
const GEMINI_START = {
  provider: LlmProvider.GEMINI,
  model: 'gemini-3.6-flash',
};

/** Todos usables, que es el entorno con las dos claves puestas. */
const allUsable = (): boolean => true;

describe('provider-fallback · reglas del respaldo dinamico', () => {
  describe('1. Codigos que justifican cambiar de proveedor', () => {
    it('1.1 deberia aceptar saturacion y caida del servicio', () => {
      // 1. Arrange 📐: `toFailure` mete en ese mismo codigo el 429 de cuota y
      //    toda la familia 5xx. Los dos dicen "este proveedor no puede ahora",
      //    que es justo lo que otro si podria atender.

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(isFallbackWorthy(ERR_HTTP_UPSTREAM_UNAVAILABLE)).toBe(true);
      expect(isFallbackWorthy(ERR_HTTP_TIMEOUT)).toBe(true);
    });

    it('1.2 deberia rechazar un fallo que el destino repetiria igual', () => {
      // 1. Arrange 📐: un payload invalido o una credencial mala fallan igual
      //    en el siguiente proveedor; reintentar seria pagar dos veces el mismo
      //    error. El contrato roto tampoco es un problema de disponibilidad.

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(isFallbackWorthy(ERR_HTTP_CLIENT_REJECTED)).toBe(false);
      expect(isFallbackWorthy(ERR_LLM_PROVIDER_CONTRACT)).toBe(false);
    });

    it('1.3 deberia rechazar un fallo sin codigo', () => {
      // 1. Arrange 📐: una excepcion ajena al contrato de proveedor —un
      //    TypeError del propio cliente— no dice nada sobre la disponibilidad
      //    del remoto, y conmutar a ciegas facturaria una segunda llamada.

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(isFallbackWorthy(undefined)).toBe(false);
    });
  });

  describe('2. Lista de intentos', () => {
    it('2.1 deberia encadenar Gemini con Anthropic y su propio modelo', () => {
      // 1. Arrange 📐: el modelo viaja con el proveedor. Arrastrar el de Gemini
      //    a Anthropic daria un 404 disfrazado de fallo de red.

      // 2. Act ⚙️
      const attempts = buildProviderAttempts(GEMINI_START, allUsable);

      // 3. Assert 🎯
      expect(attempts).toEqual([
        GEMINI_START,
        { provider: LlmProvider.ANTHROPIC, model: 'claude-haiku-4-5' },
      ]);
    });

    it('2.2 deberia omitir al sucesor sin credencial', () => {
      // 1. Arrange 📐: sin `ANTHROPIC_API_KEY` ese salto acabaria en el
      //    simulador, que publicaria texto inventado como transcripcion.

      // 2. Act ⚙️
      const attempts = buildProviderAttempts(
        GEMINI_START,
        (provider) => provider === LlmProvider.GEMINI,
      );

      // 3. Assert 🎯
      expect(attempts).toEqual([GEMINI_START]);
    });

    it('2.3 deberia devolver vacio si el propio configurado no es usable', () => {
      // 1. Arrange 📐: el vacio es la senal de "no hay a quien llamar"; cada
      //    estrategia decide entonces si degrada al simulador con aviso.

      // 2. Act ⚙️
      const attempts = buildProviderAttempts(GEMINI_START, () => false);

      // 3. Assert 🎯
      expect(attempts).toEqual([]);
    });

    it('2.4 NUNCA deberia incluir el simulador', () => {
      // 1. Arrange 📐: completar una transcripcion con el simulador publicaria
      //    texto fabricado tapando una incidencia real. Un flujo sin
      //    alternativa debe fallar y desviarse por su `onErrorStep`.

      // 2. Act ⚙️
      const attempts = buildProviderAttempts(
        { provider: LlmProvider.MOCK, model: 'mock-llm' },
        allUsable,
      );

      // 3. Assert 🎯
      expect(attempts).toEqual([]);
    });
  });
});
