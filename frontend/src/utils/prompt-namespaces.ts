import { NODE_TYPE_BY_NAMESPACE } from '@/utils/upstream-catalog';

import { NodeCategory } from '@/types/node-catalog';
import { NodeType } from '@/types/pipeline';

import type { NodeCatalogEntry } from '@/types/node-catalog';
import type { UpstreamNamespace } from '@stores/nodes/node-store-registry';

// Helpers puros de dominio (frontend-architecture.md §2.1): sin estado ni E/S.
// Deciden QUE origenes puede citar una plantilla de prompt; `VariableExplorer`
// solo pinta lo que estos devuelven.

/**
 * Tipos de nodo cuyo namespace NO puede alimentar una plantilla de prompt.
 *
 * `ESCUDO_POST_IA` consume lo que produce la IA, asi que citarlo desde el prompt
 * seria pedirle al modelo el resultado de procesar su propia respuesta: en
 * ejecucion no habra corrido todavia.
 *
 * `PROCESADOR_IA` por lo mismo, un paso mas cerca: `llm_response` es su PROPIA
 * salida, y un prompt que se cita a si mismo no resuelve nunca.
 *
 * `MAPEADOR_PLANTILLA` ESTUVO AQUI y ya no esta, y la asimetria es deliberada.
 * Mientras el nodo compilaba la plantilla consumia la salida de la IA y iba
 * detras, de modo que citarlo era imposible. Desde el cambio de semantica va
 * DELANTE: publica en `rendered_html.compiled_markup` el esqueleto HTML saneado
 * que la instruccion debe pedir al modelo que rellene. Es, de hecho, el origen
 * con mas sentido para un prompt de redaccion, y esconderlo obligaba al operador
 * a teclear el marcador de memoria.
 *
 * Los destinos no estan aqui sino en `isExcludedCategory`: son dos hoy
 * (`DESTINO_DRUPAL`, `DESTINO_ACENS`) pero la regla es "todo lo que cierre el
 * flujo", y enumerarlos obligaria a acordarse de esta lista al anadir el
 * tercero.
 */
export const PROMPT_EXCLUDED_NODE_TYPES: ReadonlySet<string> = new Set<string>([
  NodeType.PROCESADOR_IA,
  NodeType.ESCUDO_POST_IA,
]);

/**
 * Un destino cierra el flujo: su salida es el acuse de la publicacion y nada
 * corre despues, asi que jamas puede alimentar a un nodo anterior.
 */
const isExcludedCategory = (category: NodeCategory): boolean => category === NodeCategory.DESTINO;

/** Excluye por tipo de nodo; lo que no se puede identificar se deja pasar. */
const isExcludedNodeType = (nodeType: string | undefined): boolean =>
  nodeType !== undefined && PROMPT_EXCLUDED_NODE_TYPES.has(nodeType);

/**
 * Escenario A — CRUD global: el catalogo entero menos las exclusiones.
 *
 * Es el fallback del gestor de plantillas de prompt, donde no hay ningun flujo
 * detras: solo se sabe que publicaria cada tipo de nodo SI alguien lo colocara.
 * Hoy deja SEIS origenes: `raw_email`, `cron_trigger`, `parsed_email`,
 * `scraped_web`, `rendered_html` (el mapeador salio de las exclusiones cuando
 * paso a ir DELANTE de la inferencia) y `ocr_result` —el OCR transcribe para
 * que un prompt posterior lea, asi que citarlo es su razon de ser—.
 *
 * Se recorre el catalogo y no la lista de namespaces porque la CATEGORIA solo
 * la conoce el catalogo; `NODE_TYPE_BY_NAMESPACE` responde la pregunta inversa.
 */
export const buildPromptContextFromCatalog = (
  entries: readonly NodeCatalogEntry[],
): UpstreamNamespace[] =>
  entries
    .filter((entry) => !isExcludedCategory(entry.category) && !isExcludedNodeType(entry.code))
    // Un nodo sin campos declarados no aporta nada al explorador: seleccionarlo
    // dejaria el segundo selector vacio sin explicar por que. Hoy es el caso de
    // DESTINO_ACENS, que no tiene estrategia ni valor de enum. PROCESADOR_IA y
    // ESCUDO_POST_IA ya declaran los suyos, pero no llegan hasta aqui: los dos
    // salen antes por `isExcludedNodeType`.
    .filter((entry) => entry.outputFields.length > 0)
    .map((entry) => ({
      namespace: namespaceOf(entry.code),
      nodeType: entry.code as NodeType,
      fields: entry.outputFields,
    }));

/**
 * Escenario B — dentro del asistente: lo que publican los nodos ANTERIORES,
 * menos las mismas exclusiones.
 *
 * El anfitrion ya ha resuelto la precedencia (`flujo-draft.store.upstreamContext`),
 * asi que aqui solo queda quitar lo que un prompt no debe citar aunque vaya
 * delante: hoy, un `ESCUDO_POST_IA` mal colocado. El mapeador YA NO se filtra —
 * colocado antes del nodo de IA no solo es una topologia legal, es la prevista.
 */
export const filterPromptContext = (context: readonly UpstreamNamespace[]): UpstreamNamespace[] =>
  context.filter(({ nodeType }) => !isExcludedNodeType(nodeType)).map((entry) => ({ ...entry }));

/**
 * Namespace por defecto de un codigo del catalogo.
 *
 * Se invierte `NODE_TYPE_BY_NAMESPACE` en vez de leer
 * `DEFAULT_OUTPUT_NAMESPACE_BY_NODE_TYPE` directamente para no anadir una
 * segunda fuente: aquel mapa ya es la unica inversion declarada del proyecto, y
 * un codigo fuera del enum —`DESTINO_ACENS`— no figura en ninguno de los dos.
 * Cae a su propio codigo en minusculas, que nunca llegara al explorador porque
 * esas filas no declaran campos.
 */
const namespaceOf = (code: string): string => {
  // La comparacion se hace entre cadenas a proposito: `code` es `string` y no
  // `NodeType` porque el catalogo tiene una fila de mas (`DESTINO_ACENS`), asi
  // que enfrentarlo al enum seria comparar dos dominios distintos.
  const found = Object.entries(NODE_TYPE_BY_NAMESPACE).find(
    ([, nodeType]) => (nodeType as string) === code,
  );

  return found?.[0] ?? code.toLowerCase();
};
