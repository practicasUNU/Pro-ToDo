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

  /**
   * `params` que este nodo aporta al `pipeline_schema`.
   *
   * Es el nodo quien decide QUE publica, no el agregador quien lo deduce de su
   * `config`. Dos razones:
   *
   * 1. El agregador no debe conocer la forma interna de ninguna config (§3.1);
   *    con este metodo pregunta en vez de inspeccionar.
   * 2. `config` y `params` no siempre coinciden. El mapeador guarda
   *    `outputNamespace` en su config para la interfaz, pero en el esquema ese
   *    valor es propiedad del NODO y no de sus `params`: publicarlo en ambos
   *    sitios crearia dos fuentes de verdad dentro del mismo JSON.
   */
  readonly toNodeParams: () => Record<string, unknown>;

  /**
   * Declara los namespaces que aportan los nodos anteriores del flujo.
   *
   * OPCIONAL porque no todo nodo depende del contexto: un disparador es el
   * primero del grafo y no tiene nada aguas arriba. El anfitrion comprueba su
   * existencia antes de llamarlo.
   */
  readonly setAvailableUpstreamNamespaces?: (namespaces: string[]) => void;

  /**
   * Devuelve el nodo a su configuracion inicial.
   *
   * OBLIGATORIO en el contrato, y no opcional como el anterior: el agregador lo
   * necesita al abandonar un borrador o al cambiar de pipeline, porque la
   * instancia del store sobrevive a la topologia que la creo. Sin este metodo,
   * empezar un flujo nuevo arrancaria con los `params` del anterior y `canSave`
   * en `true` sin haber tocado un solo campo. Exigirlo por tipo obliga a
   * cualquier store de nodo futuro a implementarlo en vez de dejar la fuga.
   */
  readonly resetConfig: () => void;
}

/**
 * Hook de Pinia que devuelve el store de UN nodo concreto.
 *
 * Recibe el `nodeId` y no solo el `nodeType`: los stores de nodo se instancian
 * por nodo, de modo que dos nodos del mismo tipo en el mismo flujo no compartan
 * estado (ver el TSDoc de `buildTriggerImapStore`).
 */
export type NodeStoreHook = (nodeId: string) => NodeConfigStore;

/**
 * Resolucion polimorfica de los STORES de configuracion de nodo, hermana de
 * `components/nodes/node-config-registry.ts` (regla frontend-quasar.md §3.1).
 *
 * VIVE EN LA CAPA DE STORES y no junto a su hermano de componentes: no importa
 * ni resuelve un solo `.vue` —solo stores— y su unico consumidor es otro store,
 * el agregador del borrador. §3.1 fija la ruta del registro de COMPONENTES, que
 * si pertenece a `components/`; para este, la capa la manda lo que resuelve.
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
 * Resuelve el store del nodo `nodeId`, o `null` si su tipo aun no tiene
 * configurador.
 *
 * El hook se invoca AQUI y no en el llamante: `useXStore()` debe ejecutarse con
 * una instancia de Pinia activa, y centralizarlo evita que cada anfitrion tenga
 * que acordarse de invocarlo.
 *
 * Hacen falta los dos argumentos y ninguno sustituye al otro: el `nodeType`
 * elige QUE store, el `nodeId` elige CUAL de sus instancias.
 */
export const resolveNodeStore = (nodeType: NodeType, nodeId: string): NodeConfigStore | null => {
  const useStore = nodeStoreRegistry[nodeType];

  return useStore === undefined ? null : useStore(nodeId);
};
