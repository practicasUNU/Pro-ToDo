import { api } from '@boot/axios';

import type { CheckParserPayload, CheckParserResult } from '@/types/parser-email';

// Frontera HTTP del nodo PARSER_PRE_IA (regla frontend-quasar.md §3.1).
//
// Ruta exclusiva del asistente, como la del disparador IMAP y a diferencia de la
// del mapeador, que delega en `templates.service.ts` porque comparte recurso con
// el gestor. Cero logica de negocio: que hacer con el resultado lo decide el
// store, y el mensaje al usuario lo decide el componente.

/**
 * Sanea un correo de prueba con la MISMA logica que ejecutara el nodo.
 *
 * El backend no reimplementa nada: invoca `buildParsedEmail`, exactamente la
 * misma funcion pura que consume `ParserEmailStrategy`. Lo que se ve aqui es lo
 * que producira la ejecucion real, y ese es el unico motivo por el que este
 * boton sirve de algo.
 *
 * Un correo sin texto aprovechable NO es un error: llega como 200 con
 * `parsed.body_source === 'none'`, igual que en produccion. Solo un cuerpo mal
 * formado —umbral no positivo, marcado por encima del tope de caracteres— produce
 * un 4xx, y ese si se propaga como excepcion hasta el componente.
 */
export const checkParser = async (payload: CheckParserPayload): Promise<CheckParserResult> => {
  const { data } = await api.post<CheckParserResult>('/wizard/check-parser', payload);
  return data;
};
