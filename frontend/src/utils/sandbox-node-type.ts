import type { NodeType } from '@/types/pipeline';

/**
 * Tipo de nodo pedido por `?nodeType=` en el banco de pruebas, o `null`.
 * Solo admite tipos con configurador registrado: un enlace con un tipo
 * desconocido deja el banco en su valor por defecto.
 */
export const parseSandboxNodeType = (
  value: unknown,
  allowed: readonly NodeType[],
): NodeType | null => {
  const raw = Array.isArray(value) ? (value[0] as unknown) : value;

  if (typeof raw !== 'string') {
    return null;
  }

  const candidate = raw.trim().toUpperCase();

  return allowed.find((nodeType) => String(nodeType) === candidate) ?? null;
};
