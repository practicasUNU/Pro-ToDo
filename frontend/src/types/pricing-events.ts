/**
 * Aviso de tarifas de IA. Replica de
 * `backend/src/common/types/pricing-events.types.ts`.
 *
 * Contrato de cable: una divergencia no da error de compilacion, solo un
 * evento que nunca llega.
 */

/** Nombre del evento en el cable. */
export const PRICING_EVENT = { UPDATED: 'pricing:updated' } as const;

/** El par (proveedor, modelo) estrena tarifa vigente. */
export interface PricingUpdatedPayload {
  readonly id: string;
  readonly aiProvider: string;
  readonly aiModel: string;
  /** `null` cuando el par no tenia tarifa previa. */
  readonly supersededId: string | null;
  readonly emittedAt: string;
}
