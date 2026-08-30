import axios from 'axios';

// Helper puro (frontend-architecture.md §3): sin estado ni I/O, solo lee un
// error ya resuelto por Axios.

/** Cuerpo minimo que produce el filtro HTTP por defecto de NestJS. */
interface ApiErrorBody {
  message?: string | string[];
}

/**
 * Extrae el mensaje que el backend redacto para el usuario (`ForbiddenException`,
 * errores de validacion de DTO, etc.) en vez de un texto generico que oculta la
 * causa real.
 *
 * `message` llega como `string` en excepciones de un solo mensaje y como
 * `string[]` en errores de `class-validator`; ambos casos se normalizan a texto
 * plano. `fallback` cubre lo que un texto fijo ya cubria: error de red, timeout,
 * o una respuesta que no sigue este formato.
 */
export const extractApiErrorMessage = (error: unknown, fallback: string): string => {
  if (!axios.isAxiosError<ApiErrorBody>(error)) return fallback;

  const message = error.response?.data?.message;
  if (!message) return fallback;

  return Array.isArray(message) ? message.join(', ') : message;
};
