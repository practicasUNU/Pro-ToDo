import { api } from '@boot/axios';

import type { ValidateSchemaResult } from '@/types/pipeline';

// Unica capa que conoce las rutas de `FsmController`. Retorna la data ya
// desestructurada; las excepciones HTTP se propagan hacia el store y de ahi al
// componente, que es quien decide el mensaje al usuario.

/**
 * Valida un `pipeline_schema` contra el motor SIN persistirlo.
 *
 * El backend es la unica autoridad sobre la topologia: comprueba forma, tipos e
 * integridad del grafo (ciclos, punteros huerfanos, namespaces duplicados), que
 * es justo lo que un `JSON.parse` del cliente no puede saber.
 *
 * @param schema Grafo a validar, tal y como esta en el editor.
 * @returns `{ success: true, schema }` con el esquema ya tipado por el backend.
 * @throws AxiosError 400 cuyo cuerpo es `{ success: false, issues[] }`. Se lee
 *         con `extractApiIssues` para alimentar los diagnosticos del editor.
 */
export const validatePipelineSchema = async (
  schema: unknown,
): Promise<ValidateSchemaResult> => {
  const { data } = await api.post<ValidateSchemaResult>(
    '/fsm/validate-schema',
    schema,
  );

  return data;
};
