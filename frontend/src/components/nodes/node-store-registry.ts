import { useTemplateMapperStore } from '@stores/nodes/template-mapper.store';
import { useTriggerImapStore } from '@stores/nodes/trigger-imap.store';

import { NodeType } from '@/types/pipeline';

/**
 * Contrato minimo que el anfitrion consume de cualquier store de nodo.
 *
 * Deliberadamente estrecho: solo `isConfigValid`. Es lo unico que el asistente
 * necesita para decidir si el flujo puede avanzar, y tiparlo asi impide que el
 * anfitrion acabe inspeccionando la `config` interna de un nodo concreto —lo que
 * §3.1 prohibe y lo que ataria el asistente a cada tipo de nodo.
 */
export interface NodeConfigStore {
  readonly isConfigValid: boolean;
}

/** Hook de Pinia que devuelve un store conforme al contrato del nodo. */
export type NodeStoreHook = () => NodeConfigStore;

/**
 * Resolucion polimorfica de los STORES de configuracion de nodo, hermana de
 * `node-config-registry.ts` (regla frontend-quasar.md §3.1).
 *
 * El registro de componentes resuelve QUE pintar; este resuelve A QUIEN
 * preguntar si lo pintado es valido. Hacian falta los dos: el anfitrion monta el
 * configurador por `nodeType` pero tambien tiene que leer el `isConfigValid` del
 * nodo activo para habilitar el boton Siguiente, y sin este mapa tendria que
 * importar cada store por su nombre y encadenar condicionales por tipo, que es
 * justo lo que los registros evitan.
 *
 * Anadir un tipo de nodo son dos entradas en dos registros, y el anfitrion no
 * cambia.
 *
 * `Partial` por el mismo motivo que en el registro de componentes: los tipos aun
 * sin implementar simplemente no estan, y el anfitrion debe contemplar el
 * `undefined` en vez de suponer cobertura total.
 */
export const nodeStoreRegistry: Partial<Record<NodeType, NodeStoreHook>> = {
  [NodeType.TRIGGER_IMAP]: useTriggerImapStore,
  [NodeType.MAPEADOR_PLANTILLA]: useTemplateMapperStore,
};

/**
 * Resuelve el store de un tipo de nodo, o `null` si aun no tiene configurador.
 *
 * El hook se invoca AQUI y no en el llamante: `useXStore()` debe ejecutarse con
 * una instancia de Pinia activa, y centralizarlo evita que cada anfitrion tenga
 * que acordarse de invocarlo.
 */
export const resolveNodeStore = (nodeType: NodeType): NodeConfigStore | null => {
  const useStore = nodeStoreRegistry[nodeType];

  return useStore === undefined ? null : useStore();
};
