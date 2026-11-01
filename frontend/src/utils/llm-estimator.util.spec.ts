import { describe, expect, it } from 'vitest';

import { estimateLlmResources } from '@/utils/llm-estimator.util';

import {
  DEFAULT_LLM_MARKUP_MAX_TOKENS,
  MAX_LLM_MAX_TOKENS,
} from '@/types/nodes/llm-extractor.types';

/** Plantilla de estructura fija: titular, entradilla y un par de parrafos. */
const MARCADO_SIMPLE = `
  <article>
    <h1>{{titulo}}</h1>
    <p class="lead">{{entradilla}}</p>
    <p>{{cuerpo}}</p>
  </article>
`;

/** Plantilla con una coleccion: el caso del verificador de titulos. */
const buildTablaDeComisiones = (filas: number): string => `
  <table class="tableform">
    <tbody>
      ${Array.from({ length: filas }, () => '<tr><td>{{universidad}}</td><td>{{titulo}}</td></tr>').join('')}
    </tbody>
  </table>
`;

describe('estimateLlmResources', () => {
  describe('1. Sin plantilla base aguas arriba', () => {
    it('1.1 deberia devolver una estimacion vacia y NO recomendar tope', () => {
      // 1. Arrange 📐: es lo que llega mientras el operador no ha elegido
      //    plantilla, y tambien si el mapeador va detras de este nodo.
      // 2. Act ⚙️
      const estimate = estimateLlmResources(null);

      // 3. Assert 🎯: se estima por prompt, sin fijar tope.
      expect(estimate.complexityLevel).toBe('BAJA');
      expect(estimate.source).toBe('PROMPT');
      expect(estimate.recommendedMaxTokens).toBeNull();
      expect(estimate.recommendedMaxRetries).toBe(1);
    });

    it('1.3 deberia subir a MEDIA con mucho contexto interpolado', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const estimate = estimateLlmResources(null, 8);

      // 3. Assert 🎯
      expect(estimate.complexityLevel).toBe('MEDIA');
      expect(estimate.estimatedPromptTokens).toBeGreaterThan(0);
      expect(estimate.reason).toContain('8 campos');
    });

    it('1.2 deberia tratar una cadena de solo espacios como ausencia', () => {
      // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
      expect(estimateLlmResources('   \n  ').complexityLevel).toBe('BAJA');
    });
  });

  describe('2. Plantilla sin colecciones', () => {
    it('2.1 deberia quedarse en MEDIA y dejar el tope al backend', () => {
      // 1. Arrange 📐: la clave esta en el `null`. El backend ya sube a 8192 por
      //    su cuenta cuando el prompt cita una plantilla base; publicar un
      //    numero en los `params` DESACTIVARIA esa subida y congelaria el valor
      //    en el esquema para siempre.
      // 2. Act ⚙️
      const estimate = estimateLlmResources(MARCADO_SIMPLE);

      // 3. Assert 🎯
      expect(estimate.complexityLevel).toBe('MEDIA');
      expect(estimate.recommendedMaxTokens).toBeNull();
      expect(estimate.estimatedPromptTokens).toBeGreaterThan(0);
    });

    it('2.2 deberia proyectar una salida MAYOR que la entrada', () => {
      // 1. Arrange 📐: el modelo no resume la plantilla, la devuelve entera y
      //    ademas rellena, asi que el marcado es el SUELO de la respuesta.
      // 2. Act ⚙️
      const estimate = estimateLlmResources(MARCADO_SIMPLE);

      // 3. Assert 🎯
      expect(estimate.estimatedOutputTokens).toBeGreaterThan(estimate.estimatedPromptTokens);
    });
  });

  describe('3. Plantilla con coleccion', () => {
    it('3.1 deberia marcar ALTA y recomendar tope y espera', () => {
      // 1. Arrange 📐: las trece comisiones universitarias que tumbaron
      //    `FLUJO VERIFICACION DE TITULOS` con un JSON cortado a media cadena.
      // 2. Act ⚙️
      const estimate = estimateLlmResources(buildTablaDeComisiones(13));

      // 3. Assert 🎯
      expect(estimate.complexityLevel).toBe('ALTA');
      expect(estimate.recommendedTimeoutMs).toBe(60_000);
      expect(estimate.reason).toContain('13 filas');
    });

    it('3.2 el tope recomendado NUNCA deberia bajar del que pone el backend', () => {
      // 1. Arrange 📐: es la guarda que impide que el boton empeore la
      //    situacion de partida. Una tabla minima proyecta poco, pero aplicar
      //    esa proyeccion fijaria un tope por debajo de los 8192 que el backend
      //    ya aplica ante una plantilla base.
      // 2. Act ⚙️
      const estimate = estimateLlmResources(buildTablaDeComisiones(3));

      // 3. Assert 🎯
      expect(estimate.recommendedMaxTokens).toBeGreaterThanOrEqual(DEFAULT_LLM_MARKUP_MAX_TOKENS);
    });

    it('3.3 el tope recomendado deberia caber en el rango del nodo', () => {
      // 1. Arrange 📐: una recomendacion fuera de rango dejaria el nodo
      //    invalido y apagaria el "Siguiente" del asistente por culpa de un
      //    boton que el operador acaba de pulsar.
      // 2. Act ⚙️
      const estimate = estimateLlmResources(buildTablaDeComisiones(4_000));

      // 3. Assert 🎯
      expect(estimate.recommendedMaxTokens).toBeLessThanOrEqual(MAX_LLM_MAX_TOKENS);
    });

    it('3.4 deberia detectar la coleccion por su NOMBRE aunque traiga una sola fila', () => {
      // 1. Arrange 📐: la plantilla guardada suele traer UNA fila de muestra que
      //    el modelo tiene que multiplicar, de modo que contar filas se queda
      //    corto justo en el caso que mas importa.
      const unaFila = '<table class="tableform"><tr><td>{{universidad}}</td></tr></table>';

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(estimateLlmResources(unaFila).complexityLevel).toBe('ALTA');
    });
  });
});
