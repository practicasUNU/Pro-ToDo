// Helper puro: sin estado ni E/S.
//
// Coalescencia del texto documental dentro de un prompt. Un mismo prompt sirve
// para correos con escaneos (los transcribe PROCESADOR_OCR), con adjuntos
// ofimaticos (los extrae PARSER_PRE_IA) o sin adjuntos: exigir el marcador
// exacto obligaba a mantener tres plantillas casi identicas, y la que no
// encajaba pausaba el flujo con ERR_LLM_INTERPOLATION aunque el texto estuviera
// en el contexto bajo otra clave.

import { INTERPOLATION_PATTERN } from './state-payload.context';

/**
 * Rutas de texto documental, de la mas especifica a la mas generica.
 *
 * El OCR va primero porque solo existe cuando el parser no encontro texto
 * aprovechable; despues, el texto de los adjuntos ofimaticos y, por ultimo, el
 * cuerpo del correo. Un marcador de esta lista se resuelve desde SU posicion
 * hacia abajo: pedir `extracted_documents_text` nunca devuelve el OCR.
 */
export const DOCUMENT_TEXT_FALLBACK_CHAIN = [
  'ocr_result.clean_body',
  'parsed_email.extracted_documents_text',
  'parsed_email.clean_body',
] as const;

/** Una sustitucion aplicada: el marcador pedido y la ruta que lo sirve. */
export interface DocumentTextSubstitution {
  readonly from: string;
  readonly to: string;
}

export interface CoalescedPrompt {
  readonly prompt: string;
  readonly substitutions: readonly DocumentTextSubstitution[];
}

/** Devuelve el texto de una ruta, o `null` si falta o esta en blanco. */
export type DocumentTextReader = (path: string) => string | null;

const chainIndexOf = (path: string): number =>
  (DOCUMENT_TEXT_FALLBACK_CHAIN as readonly string[]).indexOf(path);

/**
 * Reescribe cada marcador de texto documental hacia la primera ruta de la
 * cadena que tenga texto.
 *
 * No interpola: devuelve otro marcador (`{{parsed_email.clean_body}}`) para
 * que la sustitucion siga pasando por `getInterpolatedValue`, la unica que
 * sabe resolver rutas. Si ninguna ruta tiene texto, el marcador se deja como
 * estaba y la interpolacion falla con su error de siempre: una instruccion sin
 * material no debe facturarse ni publicar una noticia vacia.
 */
export const coalesceDocumentTextMarkers = (
  prompt: string,
  readText: DocumentTextReader,
): CoalescedPrompt => {
  const substitutions: DocumentTextSubstitution[] = [];

  const rewritten = prompt.replace(
    INTERPOLATION_PATTERN,
    (marker, rawPath: string) => {
      const start = chainIndexOf(rawPath);

      if (start === -1 || readText(rawPath) !== null) return marker;

      const fallback = DOCUMENT_TEXT_FALLBACK_CHAIN.slice(start + 1).find(
        (path) => readText(path) !== null,
      );

      if (fallback === undefined) return marker;

      substitutions.push({ from: rawPath, to: fallback });
      return `{{${fallback}}}`;
    },
  );

  return { prompt: rewritten, substitutions };
};

/**
 * Quita del texto los marcadores de texto documental.
 *
 * Lo usa el calculo de dependencias del validador de topologia: esos
 * marcadores se degradan en ejecucion, de modo que no deben obligar a colocar
 * un PROCESADOR_OCR delante solo porque el prompt cite `ocr_result`.
 */
export const stripDocumentTextMarkers = (template: string): string =>
  template.replace(INTERPOLATION_PATTERN, (marker, rawPath: string) =>
    chainIndexOf(rawPath) === -1 ? marker : '',
  );
