/**
 * Tarifas de modelos de IA (`precios_modelos_ia`). Replica de los DTOs de
 * `PricingController` del backend (`backend/src/modules/pricing/dto/`).
 * Cualquier cambio alla hay que traerlo aqui.
 */

import { LlmProvider } from '@/types/nodes/llm-extractor.types';

import type { AuditableData } from '@/types/auditable';
import type { PricingSortKey, SortQuery } from '@/types/sort';

/**
 * Proveedores que facturan (`PRICING_PROVIDERS`). `MOCK` queda fuera: es el
 * doble de pruebas del motor y el backend rechaza su tarifa con un 400.
 */
export const PRICING_PROVIDERS = [
  LlmProvider.GEMINI,
  LlmProvider.ANTHROPIC,
  LlmProvider.OPENAI,
] as const;
export type PricingProvider = (typeof PRICING_PROVIDERS)[number];

/** Comodin de `modelo_ia`: tarifa generica del proveedor (`ANY_MODEL`). */
export const ANY_MODEL = '*';

/** Techo de `NUMERIC(12, 6)` (`MAX_RATE_USD_PER_MTOK`). */
export const MAX_RATE_USD_PER_MTOK = 999_999.999_999;

/** Patron del id de modelo (`MODEL_ID_PATTERN`). */
export const MODEL_ID_PATTERN = /^(\*|[A-Za-z0-9][A-Za-z0-9._:-]*)$/;

/** Techo del buscador (`MAX_PRICING_SEARCH_LENGTH`). */
export const MAX_PRICING_SEARCH_LENGTH = 100;

/** Replica de `PricingResponseDto`. Fechas como ISO: es lo que llega por JSON. */
export interface ModelPricing extends AuditableData {
  readonly id: string;
  readonly aiProvider: string;
  readonly aiModel: string;
  readonly promptRateUsdPerMTok: number;
  readonly completionRateUsdPerMTok: number;
  readonly reasoningRateUsdPerMTok: number;
  readonly validFrom: string;
  readonly active: boolean;
}

/** Replica de `PricingPageResponseDto`. */
export interface ModelPricingPage {
  readonly items: ModelPricing[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

/** Replica de `CreatePricingDto`: alta de la tarifa vigente de un par. */
export interface CreatePricingPayload {
  readonly aiProvider: PricingProvider;
  readonly aiModel: string;
  readonly promptRateUsdPerMTok: number;
  readonly completionRateUsdPerMTok: number;
  readonly reasoningRateUsdPerMTok: number;
}

/** Replica de `ListPricingQueryDto`. */
export interface PricingQuery extends SortQuery<PricingSortKey> {
  readonly search?: string;
  readonly from?: string;
  readonly to?: string;
  readonly activeOnly?: boolean;
  readonly limit?: number;
  readonly offset?: number;
}
