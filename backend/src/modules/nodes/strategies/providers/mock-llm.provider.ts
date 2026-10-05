import { Injectable } from '@nestjs/common';

import { escapeHtml } from '@common/utils/escape-html.util';
import { LlmProvider } from '@modules/nodes/strategies/interfaces/llm-provider.interface';

import type {
  ILlmProviderClient,
  LlmExecutionOptions,
  LlmInlineAttachment,
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

/**
 * Transcripcion que devuelve la simulacion en modo OCR.
 *
 * Literal y no derivada del prompt, al contrario que la redaccion simulada: el
 * prompt de OCR es siempre el mismo texto del sistema, asi que derivar de el
 * produciria una "transcripcion" que repite la instruccion en vez de parecerse
 * a lo que devolveria un modelo de verdad. La marca entre corchetes esta para
 * que nadie confunda esto con contenido real si acaba publicado por error.
 */
const MOCK_OCR_TRANSCRIPTION =
  '[TRANSCRIPCIÓN MOCK OCR]: Texto recuperado de imagen adjunta.';

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
   *
   * `attachments` SI se mira, aunque no haya nada que leer en ellos. El motivo
   * es el modo vision: ahi el prompt llega practicamente vacio —el contenido del
   * correo esta en el PDF— y una simulacion que solo mirase el texto devolveria
   * "Contenido simulado sin titular", que no se distingue de un fallo. Nombrar
   * los adjuntos deja claro que la simulacion los recibio, que es justo lo que
   * un desarrollador sin `GEMINI_API_KEY` necesita comprobar.
   */
  public generateCompletion(
    prompt: string,
    _systemPrompt?: string,
    config?: LlmExecutionOptions,
    attachments: readonly LlmInlineAttachment[] = [],
  ): Promise<LlmResponsePayload> {
    if (config?.mode === 'ocr') {
      return Promise.resolve(this.buildOcrPayload());
    }

    const paragraphs = this.splitParagraphs(
      this.describeAttachments(prompt, attachments),
    );
    const [firstParagraph] = paragraphs;
    const flattened = paragraphs.join(' ');

    const headline = truncate(
      firstParagraph ?? 'Contenido simulado sin titular',
      MOCK_HEADLINE_LENGTH,
    );
    const bodyParagraphs =
      paragraphs.length > 0 ? paragraphs.slice(0, MOCK_MAX_PARAGRAPHS) : [];

    return Promise.resolve({
      headline,
      summary: truncate(
        flattened.length > 0 ? flattened : 'Contenido simulado sin cuerpo',
        MOCK_SUMMARY_LENGTH,
      ),
      body_paragraphs: bodyParagraphs,
      ...(config?.expectsFilledMarkup === true
        ? { filled_markup: this.buildMarkup(headline, bodyParagraphs) }
        : {}),
      metadata: {
        tokensPrompt: 0,
        tokensCompletion: 0,
        modelUsed: MOCK_LLM_MODEL,
        isMock: true,
      },
    });
  }

  /**
   * Esqueleto HTML simulado, con el mismo contenido que el resto del payload.
   *
   * POR QUE EL SIMULADOR MAQUETA. `MOCK` es el proveedor por defecto del DTO y
   * el destino de `dryRun`, asi que sin esto el circuito
   * MAPEADOR_PLANTILLA -> PROCESADOR_IA -> ESCUDO_POST_IA no se podria recorrer
   * entero sin una clave de API de pago: el escudo caeria siempre en
   * `ERR_POST_IA_EMPTY_HTML` y nadie sabria si es que la auditoria funciona o
   * que el banco de pruebas no llega.
   *
   * Se compone a partir del titular y los parrafos que este mismo metodo ya
   * produjo, y NO recortando la plantilla real que viaja interpolada dentro del
   * `systemPrompt`. Eso ultimo seria mas realista y ataria el simulador al
   * formato del prompt de otra capa, que es exactamente lo que el TSDoc de
   * `LlmExecutionOptions.mode` rechaza para el modo OCR.
   *
   * Determinista como todo lo demas aqui: la misma entrada da el mismo markup.
   * Las etiquetas son las minimas que la lista blanca del saneador admite, de
   * modo que el escudo lo aprueba salvo que se le exijan selectores que este
   * esqueleto no tiene —que es justamente lo que conviene que distinga.
   */
  private buildMarkup(headline: string, paragraphs: readonly string[]): string {
    const body = paragraphs
      .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
      .join('');

    return `<h1>${escapeHtml(headline)}</h1><div>${body}</div>`;
  }

  /**
   * Respuesta simulada de una transcripcion.
   *
   * Va en `body_paragraphs` y en `summary` a la vez porque el contrato
   * `LlmResponsePayload` esta pensado para una redaccion y quien consume esto
   * —`OcrProcessorStrategy.flattenTranscription`— prefiere los parrafos y cae al
   * resumen. Poblar ambos deja la simulacion correcta lea por donde lea.
   *
   * `headline` lleva la misma marca en vez de un titular inventado: una
   * transcripcion no tiene titular, y rellenarlo con algo verosimil invitaria a
   * publicarlo.
   */
  private buildOcrPayload(): LlmResponsePayload {
    return {
      headline: MOCK_OCR_TRANSCRIPTION,
      summary: MOCK_OCR_TRANSCRIPTION,
      body_paragraphs: [MOCK_OCR_TRANSCRIPTION],
      metadata: {
        tokensPrompt: 0,
        tokensCompletion: 0,
        modelUsed: MOCK_LLM_MODEL,
        isMock: true,
      },
    };
  }

  /**
   * Antepone al prompt una linea que nombra los adjuntos recibidos.
   *
   * Sin adjuntos devuelve el prompt INTACTO, de modo que la simulacion de
   * siempre no cambia ni un caracter y las pruebas que la afirman siguen valiendo.
   */
  private describeAttachments(
    prompt: string,
    attachments: readonly LlmInlineAttachment[],
  ): string {
    if (attachments.length === 0) {
      return prompt;
    }

    const names = attachments
      .map((attachment) => `${attachment.filename} (${attachment.contentType})`)
      .join(', ');

    return `Contenido simulado a partir de ${attachments.length} adjunto(s): ${names}.\n\n${prompt}`;
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
