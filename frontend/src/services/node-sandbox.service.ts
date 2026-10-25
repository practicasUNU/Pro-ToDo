import { api } from '@boot/axios';

import type { NodeSandboxResult, RunNodeSandboxPayload } from '@/types/node-sandbox';

// Unica capa que conoce la ruta del banco de pruebas. Un fallo DEL NODO llega
// como 200 con `success: false`; solo un rol sin permiso (403), un tipo no
// ejecutable o unos params invalidos (400) son errores de la peticion.

export const runNodeSandbox = async (
  payload: RunNodeSandboxPayload,
): Promise<NodeSandboxResult> => {
  const { data } = await api.post<NodeSandboxResult>('/nodes/sandbox/run', payload);
  return data;
};
