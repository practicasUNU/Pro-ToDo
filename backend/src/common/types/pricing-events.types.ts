/**
 * Contrato de cable del aviso de tarifas de IA.
 *
 * Familia aparte de `crud-events.types.ts` a proposito: una tarifa nueva no es
 * una mutacion de fila suelta sino un RELEVO —la vigente pasa a historico y
 * entra otra—, y los paneles que la consumen necesitan saber el par
 * (proveedor, modelo) afectado, no el diff de una sola fila.
 */

/** Nombre del evento en el cable. `as const` por el mismo motivo que las otras familias. */
export const PRICING_EVENT = { UPDATED: 'pricing:updated' } as const;

/**
 * Aviso de que el par (proveedor, modelo) estrena tarifa vigente.
 *
 * `supersededId` es `null` cuando el par no tenia tarifa previa (alta pura).
 */
export interface PricingUpdatedPayload {
  readonly id: string;
  readonly aiProvider: string;
  readonly aiModel: string;
  readonly supersededId: string | null;
  /** ISO, no `Date`: cruza un socket y se serializa. */
  readonly emittedAt: string;
}
