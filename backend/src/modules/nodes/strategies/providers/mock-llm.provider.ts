import { Injectable } from '@nestjs/common';

import { LlmProvider } from '@modules/nodes/strategies/interfaces/llm-provider.interface';

import type {
  ILlmProviderClient,
  LlmExecutionOptions,
  LlmResponsePayload,
} from '@modules/nodes/strategies/interfaces/llm-provider.interface';

/** Modelo declarado en la `metadata` de toda respuesta simulada. */
export const MOCK_LLM_MODEL = 'mock-engine';

/** Longitud maxima del resumen simulado, en caracteres. */
const MOCK_SUMMARY_LENGTH = 280;

/** Longitud maxima del titular simulado, en caracteres. */
const MOCK_HEADLINE_LENGTH = 120;

/** Parrafos que como mucho devuelve la simulacion. */
const MOCK_MAX_PARAGRAPHS = 5;

/** Recorta en el ultimo espacio anterior al limite, para no partir palabras. */
const truncate = (text: string, limit: number): string => {
  if (text.length <= limit) {
    return text;
  }

  const clipped = text.slice(0, limit);
  const lastSpace = clipped.lastIndexOf(' ');

  return `${lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped}...`;
};

/**
 * Cliente de simulacion: devuelve el contrato formal sin salir a ningun sitio.
 *
 * Es la pieza de COSTE CERO del nodo de IA, y existe por dos motivos distintos
 * que conviene no confundir:
 *
 * 1. `dryRun: true` — el operador quiere probar la TOPOLOGIA de un flujo (que
 *    el mapeador recibe lo que espera, que la plantilla interpola bien) sin
 *    pagar una inferencia por cada vuelta del banco de pruebas.
 * 2. Sin API key en el entorno — un despliegue de desarrollo no puede quedarse
 *    sin poder ejecutar un flujo entero solo porque falte un secreto.
 *
 * DETERMINISTA, y esto es lo que lo hace util: la misma entrada produce
 * exactamente la misma salida. Una simulacion que variase obligaria a las
 * pruebas a aseverar sobre formas en lugar de sobre valores, y el operador no
 * podria distinguir un cambio suyo de ruido del simulador.
 *
 * `tokensPrompt` y `tokensCompletion` valen CERO a proposito, no una
 * estimacion: son el contador de gasto real, y un numero inventado ahi
 * falsearia la unica traza que dice cuanto ha costado una ejecucion.
 */
@Injectable()
export class MockLlmProvider implements ILlmProviderClient {
  public readonly provider = LlmProvider.MOCK;

  /**
   * Estructura el texto de entrada como si fuera una redaccion periodistica.
   *
   * El `systemPrompt` y la `config` se aceptan por contrato y se ignoran: no hay
   * modelo al que trasladarlos. `modelUsed` reporta `mock-engine` y NO el modelo
   * que pidiera la configuracion, porque lo que ejecuto la inferencia fue esto.
   */
  public generateCompletion(
    prompt: string,
    _systemPrompt?: string,
    _config?: LlmExecutionOptions,
  ): Promise<LlmResponsePayload> {
    const paragraphs = this.splitParagraphs(prompt);
    const [firstParagraph] = paragraphs;
    const flattened = paragraphs.join(' ');

    return Promise.resolve({
      headline: truncate(
        firstParagraph ?? 'Contenido simulado sin titular',
        MOCK_HEADLINE_LENGTH,
      ),
      summary: truncate(
        flattened.length > 0 ? flattened : 'Contenido simulado sin cuerpo',
        MOCK_SUMMARY_LENGTH,
      ),
      body_paragraphs:
        paragraphs.length > 0 ? paragraphs.slice(0, MOCK_MAX_PARAGRAPHS) : [],
      metadata: {
        tokensPrompt: 0,
        tokensCompletion: 0,
        modelUsed: MOCK_LLM_MODEL,
        isMock: true,
      },
    });
  }

  /**
   * Trocea el prompt en parrafos no vacios.
   *
   * Corta por linea en blanco y, si no hay ninguna, por salto simple: un prompt
   * escrito a mano en el editor del nodo rara vez trae dobles saltos, y sin este
   * respaldo la simulacion devolveria un unico parrafo gigante que no se parece
   * en nada a lo que produce un modelo real.
   */
  private splitParagraphs(prompt: string): string[] {
    const normalized = prompt.replace(/\r\n/g, '\n').trim();

    if (normalized.length === 0) {
      return [];
    }

    const byBlankLine = normalized
      .split(/\n\s*\n/)
      .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
      .filter((paragraph) => paragraph.length > 0);

    if (byBlankLine.length > 1) {
      return byBlankLine;
    }

    return normalized
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }
}
