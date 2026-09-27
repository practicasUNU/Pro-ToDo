import { useLlmExtractorStore } from '@stores/nodes/llm-extractor.store';
import { useParserEmailStore } from '@stores/nodes/parser-email.store';
import { useSmtpAlertStore } from '@stores/nodes/smtp-alert.store';
import { useTemplateMapperStore } from '@stores/nodes/template-mapper.store';
import { useTriggerCronStore } from '@stores/nodes/trigger-cron.store';
import { useTriggerImapStore } from '@stores/nodes/trigger-imap.store';
import { useWebScraperStore } from '@stores/nodes/web-scraper.store';

import { NodeType } from '@/types/pipeline';

import type { NodeOutputField } from '@/types/node-catalog';

/**
 * Un nodo del `pipeline_schema` tal y como llega del backend, para hidratarlo.
 *
 * Se pasa el nodo ENTERO y no solo sus `params` porque los dos campos que un
 * store necesita restaurar no viven en el mismo sitio: el mapeador guarda
 * `outputNamespace` en su config, pero en el esquema ese valor es propiedad del
 * nodo y `toNodeParams()` nunca lo publica (ver el TSDoc de `toNodeParams`).
 */
export interface HydratableNode {
  readonly outputNamespace: string;
  readonly params: Record<string, unknown>;
}

/**
 * Un namespace disponible aguas arriba, con el inventario de lo que publica.
 *
 * Los `fields` salen del catalogo de nodos del backend, que los declara la
 * estrategia que construye el payload. Vienen vacios cuando el tipo de nodo no
 * los declara o cuando el catalogo aun no ha cargado: quien los consuma debe
 * tratar el vacio como "no hay nada que ofrecer todavia", nunca como un error.
 */
export interface UpstreamNamespace {
  readonly namespace: string;
  /**
   * Tipo del nodo que escribe este namespace.
   *
   * El namespace dice DONDE esta el valor; el `nodeType` dice QUIEN lo produjo,
   * y es con lo unico que se puede etiquetar el grupo de un desplegable de forma
   * que el operador reconozca el paso del que habla. Va aqui y no se deduce del
   * namespace en cada consumidor porque la relacion namespace -> tipo es una
   * CONVENCION (`DEFAULT_OUTPUT_NAMESPACE_BY_NODE_TYPE`) y no una regla: un
   * esquema puede declarar otro `outputNamespace`, e invertir el mapa donde se
   * consume lo daria por bueno igualmente.
   *
   * OPCIONAL porque no todo namespace lo escribe un nodo: `_assets` lo inyecta
   * el backend en cada render, y el banco de pruebas lo simula. Quien etiquete
   * con el debe tolerar su ausencia.
   */
  readonly nodeType?: NodeType;
  readonly fields: readonly NodeOutputField[];
}

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
   * Declara los namespaces anteriores CON los campos que publica cada uno.
   *
   * Hermano del anterior y NO su sustituto. Los dos conviven porque responden a
   * preguntas distintas: el mapeador solo necesita saber si un namespace existe
   * —sus variables requeridas se las da el backend con la plantilla—, mientras
   * que el extractor web tiene que COMPONER las opciones de un selector cerrado
   * y para eso no le basta el nombre, necesita el inventario de campos.
   *
   * Sustituir aquel por este obligaria al mapeador a desempaquetar una
   * estructura de la que ignora la mitad, y a los disparadores a recibir un
   * contexto que no usan. Se anade en vez de reemplazar.
   *
   * OPCIONAL por el mismo motivo: el anfitrion comprueba su existencia antes de
   * llamarlo, y un nodo que no componga interpolaciones no lo implementa.
   */
  readonly setAvailableUpstreamContext?: (context: UpstreamNamespace[]) => void;

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

  /**
   * Carga en el estado local los valores de un nodo YA GUARDADO.
   *
   * Es la inversa de `toNodeParams()`, y es lo que hace posible editar un flujo
   * existente en vez de solo crearlo. Sin ella el asistente abriria el
   * formulario en blanco y guardar borraria la configuracion que el operador
   * venia a retocar.
   *
   * OBLIGATORIO por el mismo motivo que `resetConfig`: un store de nodo futuro
   * que no lo implemente dejaria un paso del asistente imposible de editar, y un
   * hueco asi debe ser un error de compilacion y no un descubrimiento en
   * produccion.
   *
   * Contrato de ida y vuelta: `hydrateFromNode(n)` seguido de `toNodeParams()`
   * debe reproducir `n.params`. Cada store es responsable de reponer lo que su
   * propio `toNodeParams()` omite.
   */
  readonly hydrateFromNode: (node: HydratableNode) => void;

  /**
   * Ajusta los `params` para poder emitir los codigos que su ruta de error atrapa.
   *
   * Espejo del `getUnreachableErrorCodes` del backend, que responde la pregunta
   * inversa: "que codigos he apagado". La regla 10 del validador de topologia
   * RECHAZA al guardar un nodo cuya ruta declara un codigo que sus `params` le
   * impiden emitir —una rama que no se dispararia jamas—, asi que declarar la
   * ruta y configurar el nodo tienen que moverse a la vez.
   *
   * Hace falta que sea un metodo del NODO y no una escritura del agregador
   * porque el interruptor concreto es privado de cada tipo: el parser lo llama
   * `failOnUnextractableMedia`, y §3.1 prohibe que el anfitrion conozca la forma
   * interna de ninguna config. Aqui pregunta en vez de escribir.
   *
   * Recibe la lista COMPLETA de codigos que la ruta atrapa, vacia incluida: un
   * arreglo vacio significa "ya no atrapo nada", y el nodo debe poder volver a
   * su estado anterior. Sin eso, retirar una rama dejaria el interruptor puesto.
   *
   * OPCIONAL: la mayoria de los nodos emite siempre el mismo repertorio de
   * fallos y no tiene nada que ajustar.
   */
  readonly declareCaughtErrorCodes?: (codes: readonly string[]) => void;

  /**
   * Avisos que este nodo quiere que el operador confirme ANTES de persistir.
   *
   * Es la contrapartida honesta de `isConfigValid`: aquel responde "se puede
   * guardar", este responde "se puede, pero conviene que sepas esto". Un aviso
   * NUNCA bloquea; lo que deba impedir el guardado va en `isConfigValid`.
   *
   * Sin este canal, el anfitrion tendria que mirar el `connectionVerified` del
   * store IMAP para decidir si avisa, que es justo la inspeccion de la config
   * ajena que §3.1 prohibe. Aqui pregunta en vez de espiar.
   *
   * OPCIONAL: la mayoria de los nodos no tiene nada que advertir, y obligarles a
   * devolver `[]` seria ruido en cada store.
   */
  readonly configWarnings?: readonly string[];
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
  [NodeType.TRIGGER_CRON]: useTriggerCronStore,
  [NodeType.PARSER_PRE_IA]: useParserEmailStore,
  [NodeType.EXTRACTOR_WEB]: useWebScraperStore,
  [NodeType.MAPEADOR_PLANTILLA]: useTemplateMapperStore,
  [NodeType.PROCESADOR_IA]: useLlmExtractorStore,
  [NodeType.DESTINO_SMTP]: useSmtpAlertStore,
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
