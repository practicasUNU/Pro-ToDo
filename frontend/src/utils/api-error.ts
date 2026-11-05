import axios from 'axios';

import type { TemplateViolation } from '@/types/html-template';
import type { SchemaIssue } from '@/types/pipeline';

// Helper puro (frontend-architecture.md §3): sin estado ni I/O, solo lee un
// error ya resuelto por Axios.

/** Cuerpo minimo que produce el filtro HTTP por defecto de NestJS. */
interface ApiErrorBody {
  message?: string | string[];
  violations?: TemplateViolation[];
  issues?: SchemaIssue[];
  /** Codigo estable del fallo (`ERR_*`), cuando el backend lo adjunta. */
  code?: string;
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

/**
 * Extrae el codigo estable del fallo, si el backend lo adjunto.
 *
 * Varias excepciones del proyecto responden con payload objeto —
 * `{ code, message }`, como las tres del optimizador de prompts— y hasta ahora
 * ese `code` se perdia: `extractApiErrorMessage` solo lee `message`. El codigo
 * es el contrato estable que identifica el fallo, mientras que el texto cambia
 * con cada version, de modo que es lo unico que el operador puede buscar en la
 * trazabilidad o citar en un parte.
 *
 * Devuelve `null` —y nunca `undefined`— ante un error de red, un 500 o una
 * respuesta sin la clave, para que el consumidor no tenga que distinguir "sin
 * codigo" de "no se pudo saber".
 */
export const extractApiErrorCode = (error: unknown): string | null => {
  if (!axios.isAxiosError<ApiErrorBody>(error)) return null;

  return error.response?.data?.code ?? null;
};

/**
 * Extrae las infracciones localizables que el backend adjunta a un 400.
 *
 * No hay `ExceptionFilter` en el backend, asi que un `BadRequestException` con
 * payload objeto llega literalmente como `{ message, violations }`: el array se
 * lee de la raiz del cuerpo, sin desenvolver nada.
 *
 * Devuelve `[]` —y nunca `undefined`— ante un error de red, un 500 o cualquier
 * respuesta sin la clave, para que el consumidor no tenga que distinguir "no
 * hay infracciones" de "no se pudo saber".
 */
export const extractApiViolations = (error: unknown): TemplateViolation[] => {
  if (!axios.isAxiosError<ApiErrorBody>(error)) return [];

  const { violations } = error.response?.data ?? {};

  return Array.isArray(violations) ? violations : [];
};

/**
 * Extrae los campos invalidos que el validador del FSM adjunta a un 400.
 *
 * Hermano de `extractApiViolations` y separado de el a proposito: son dos
 * contratos distintos de dos endpoints distintos. Las plantillas HTML devuelven
 * `violations` (con `type` y `target`, que se buscan en el documento), y
 * `POST /fsm/validate-schema` devuelve `issues` (con `path` y `message`, que se
 * navegan como ruta JSON). Unificar las claves obligaria a cambiar uno de los
 * dos backends sin ganar nada.
 *
 * Devuelve `[]` —y nunca `undefined`— ante un error de red, un 500 o cualquier
 * respuesta sin la clave, para que el consumidor no tenga que distinguir "no hay
 * errores de esquema" de "no se pudo saber".
 */
export const extractApiIssues = (error: unknown): SchemaIssue[] => {
  if (!axios.isAxiosError<ApiErrorBody>(error)) return [];

  const { issues } = error.response?.data ?? {};

  return Array.isArray(issues) ? issues : [];
};
