// Helper puro (frontend-architecture.md §2.1): diferencia campo a campo entre
// las dos fotografias de un evento de auditoria, bajando hasta las hojas de los
// objetos anidados. Replica `flattenAuditSnapshot` / `changedAuditPaths` del
// backend (`audit-labels.ts`), para que la tabla y el informe PDF coincidan.

import type { AuditSnapshot } from '@/types/audit';

/** Que le paso a una ruta entre las dos fotografias. */
export type AuditDiffKind = 'added' | 'removed' | 'changed';

/** Una ruta hoja con su valor antes y despues. */
export interface AuditDiffEntry {
  /** Ruta legible: `pipelineSchema.nodes[1].params.customPrompt`. */
  readonly path: string;
  readonly kind: AuditDiffKind;
  /** Valor ya formateado para pintar; `—` si la ruta no existia. */
  readonly before: string;
  readonly after: string;
}

/**
 * Claves de auditoria que cambian en TODA modificacion. Se comparan por la
 * PRIMERA clave de la ruta: solo existen en la raiz de la fotografia.
 */
const BOOKKEEPING_KEYS: ReadonlySet<string> = new Set(['updatedAt', 'updatedByUserId']);

const ABSENT = '—';

/**
 * Aplana una fotografia a `ruta -> valor hoja`.
 *
 * Los objetos y arreglos vacios se conservan como hoja: si no, pasar de
 * `{ a: 1 }` a `{}` no dejaria ninguna ruta que comparar.
 */
export const flattenSnapshot = (
  value: unknown,
  prefix = '',
  target: Record<string, unknown> = {},
): Record<string, unknown> => {
  if (Array.isArray(value)) {
    if (value.length === 0 && prefix !== '') target[prefix] = [];
    value.forEach((item, index) => flattenSnapshot(item, `${prefix}[${index}]`, target));
    return target;
  }

  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0 && prefix !== '') target[prefix] = {};
    for (const [key, child] of entries) {
      flattenSnapshot(child, prefix === '' ? key : `${prefix}.${key}`, target);
    }
    return target;
  }

  if (prefix !== '') target[prefix] = value;
  return target;
};

/** Valor hoja como texto: las cadenas tal cual, el resto como JSON. */
export const formatLeaf = (value: unknown): string => {
  if (value === undefined) return ABSENT;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
};

const rootKeyOf = (path: string): string => path.split(/[.[]/, 1)[0] ?? path;

/**
 * Rutas hoja que difieren entre las dos fotografias, en el orden en que
 * aparecen (primero las de antes, luego las nuevas). En un alta todas son
 * `added`; en una baja, `removed`.
 */
export const computeAuditDiff = (
  previous: AuditSnapshot | null,
  next: AuditSnapshot | null,
): AuditDiffEntry[] => {
  const before = flattenSnapshot(previous ?? {});
  const after = flattenSnapshot(next ?? {});
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])];

  return paths
    .filter((path) => !BOOKKEEPING_KEYS.has(rootKeyOf(path)))
    .filter((path) => JSON.stringify(before[path]) !== JSON.stringify(after[path]))
    .map((path) => {
      const inBefore = Object.hasOwn(before, path);
      const inAfter = Object.hasOwn(after, path);

      return {
        path,
        kind: !inBefore ? 'added' : !inAfter ? 'removed' : 'changed',
        before: inBefore ? formatLeaf(before[path]) : ABSENT,
        after: inAfter ? formatLeaf(after[path]) : ABSENT,
      };
    });
};

/** Solo las rutas que cambiaron, para la columna "Campos modificados". */
export const changedPaths = (
  previous: AuditSnapshot | null,
  next: AuditSnapshot | null,
): string[] => computeAuditDiff(previous, next).map((entry) => entry.path);
