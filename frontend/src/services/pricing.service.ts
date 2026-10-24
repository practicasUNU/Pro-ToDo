import { api } from '@boot/axios';

import type {
  CreatePricingPayload,
  ModelPricing,
  ModelPricingPage,
  PricingQuery,
} from '@/types/pricing';

// Unica capa que conoce las rutas de `PricingController`. Devuelve la data ya
// desestructurada; los errores HTTP se propagan al store y de ahi al
// componente, que decide el mensaje.
//
// Solo dos funciones, como el controlador: no existe ruta para editar en sitio
// ni para desactivar una tarifa.

/** Sin `/api`: ya esta en el `baseURL` de la instancia. */
const PRICING_PATH = '/pricing';

/** Pagina de tarifas con buscador, rango, orden y filtro de vigentes. */
export const fetchPricing = async (query: PricingQuery = {}): Promise<ModelPricingPage> => {
  const { data } = await api.get<ModelPricingPage>(PRICING_PATH, { params: query });

  return data;
};

/** Registra la tarifa vigente de un par; el backend pasa la anterior a historico. */
export const createPricing = async (payload: CreatePricingPayload): Promise<ModelPricing> => {
  const { data } = await api.post<ModelPricing>(PRICING_PATH, payload);

  return data;
};
