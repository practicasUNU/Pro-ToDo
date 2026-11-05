import { api } from '@boot/axios';

import type {
  LlmModelDescriptor,
  LlmTestConnectionPayload,
  LlmTestConnectionResult,
} from '@/types/nodes/llm-extractor.types';

// Frontera HTTP del nodo PROCESADOR_IA (regla frontend-quasar.md §3.1).
//
// POR QUE EXISTE AHORA Y NO ANTES. El store de este nodo llevaba un comentario
// argumentando en contra de crear este archivo, y tenia razon mientras fue
// cierto: lo unico que el nodo pedia al backend eran las plantillas de prompt,
// que ya posee `ai-prompt-templates.service.ts`, y envolverlas aqui habria sido
// la capa vacia que `frontend-architecture.md` §2.1 desaconseja. Desde PROT-21
// hay dos rutas que no son de nadie mas —el catalogo de modelos y el banco de
// pruebas de conectividad—, y alguien tiene que poseerlas.
//
// Cero logica de negocio: que hacer con el resultado lo decide el store, y el
// mensaje al usuario lo decide el componente.

/**
 * Catalogo de modelos con su disponibilidad real.
 *
 * La disponibilidad la calcula el BACKEND contra su propio entorno y no se
 * puede deducir aqui: las credenciales nunca llegan al navegador
 * (`security-and-scope.md` §0.1). De ahi que esto sea una peticion y no una
 * constante del cliente.
 */
export const fetchLlmModels = async (): Promise<LlmModelDescriptor[]> => {
  const { data } = await api.get<LlmModelDescriptor[]>('/llm/models');
  return data;
};

/**
 * Ejecuta una inferencia minima contra un proveedor y mide la latencia.
 *
 * AVISO: contra un proveedor de pago, cada llamada factura tokens. El prompt lo
 * fija el backend y este payload no puede sustituirlo, precisamente para que el
 * coste de pulsar el boton no dependa de lo que mande el cliente.
 *
 * Un fallo de conexion NO es un error HTTP: llega como 200 con
 * `success: false`, porque el diagnostico del proveedor es parte de la
 * respuesta que el formulario tiene que mostrar. Solo un cuerpo mal formado
 * produce un 4xx, y ese si se propaga como excepcion.
 */
export const testLlmConnection = async (
  payload: LlmTestConnectionPayload,
): Promise<LlmTestConnectionResult> => {
  const { data } = await api.post<LlmTestConnectionResult>('/llm/test-connection', payload);
  return data;
};
