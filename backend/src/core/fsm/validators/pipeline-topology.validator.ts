import {
  catchesErrorExplicitly,
  declaredErrorTarget,
} from '@core/fsm/utils/pipeline-topology.util';
import {
  ERR_CONDITIONAL_UPSTREAM_CONTEXT,
  ERR_MISSING_UPSTREAM_CONTEXT,
  ERR_MISSING_UPSTREAM_FIELD_TYPE,
} from '@core/fsm/types/node-strategy.types';
import {
  ERROR_CONTEXT_NAMESPACE,
  NODE_OUTPUT_NAMESPACE_SET,
  NODE_OUTPUT_NAMESPACES,
  DESTINO_NODE_TYPES,
  TRIGGER_NODE_TYPES,
} from '@core/fsm/types/pipeline-schema.types';

import type {
  PipelineNodeConfigDto,
  PipelineSchemaDto,
} from '@core/fsm/dto/pipeline-schema.dto';
import type {
  NodeOutputField,
  NodeOutputFieldType,
} from '@core/fsm/types/node-strategy.types';

/**
 * Resuelve los namespaces que un nodo necesita para poder ejecutarse.
 *
 * Se recibe como PARAMETRO y no se importa: este validador es una funcion pura y
 * debe seguir siendolo. Quien conoce las estrategias es
 * `PipelineValidatorService`, que si es un provider y puede inyectar la
 * factoria; pasarselo aqui deja la regla comprobable con un doble de una linea y
 * evita que un validador de topologia acabe dependiendo del contenedor de Nest.
 */
export type NodeDependencyResolver = (
  node: PipelineNodeConfigDto,
) => readonly string[];

/**
 * Procedencia legible de una dependencia que NO esta escrita en los `params`.
 *
 * Mapea namespace -> frase que explica de donde sale (ej. `el prompt "NOTIWEB_DEFAULT"`).
 * Solo se usa para redactar el mensaje de la regla 7: sin esto, un nodo que
 * hereda `scraped_web` de un prompt guardado recibiria un "necesitas
 * scraped_web" que el operador no puede casar con nada de lo que ve en el
 * formulario del nodo.
 *
 * Es un mapa y no una cadena por nodo porque un mismo nodo puede heredar varios
 * namespaces de origenes distintos.
 */
export type NodeDependencyOriginResolver = (
  node: PipelineNodeConfigDto,
) => ReadonlyMap<string, string>;

/** Campos que un nodo publica en su `outputNamespace`. Regla 8. */
export type NodeOutputFieldsResolver = (
  node: PipelineNodeConfigDto,
) => readonly NodeOutputField[];

/** Tipos de campo que un nodo necesita poder apuntar aguas arriba. Regla 8. */
export type NodeRequiredFieldTypesResolver = (
  node: PipelineNodeConfigDto,
) => readonly NodeOutputFieldType[];

/** Codigos que el nodo NO puede emitir con sus `params` actuales. Regla 10. */
export type NodeUnreachableErrorCodesResolver = (
  node: PipelineNodeConfigDto,
) => readonly string[];

/**
 * Lo que el validador necesita preguntar a las estrategias.
 *
 * Se agrupan en un objeto en vez de encadenar parametros posicionales: son tres
 * preguntas distintas, dos de ellas nuevas, y una lista de lambdas sueltas en la
 * llamada no dice cual es cual. Cada una se pasa por separado y todas son
 * opcionales, de modo que omitir una desactiva solo su regla — que es lo que
 * hacen las pruebas de las reglas 1 a 6.
 */
export interface PipelineTopologyResolvers {
  /** Regla 7. */
  readonly dependencies?: NodeDependencyResolver;
  /**
   * Regla 7, subconjunto DURO de `dependencies`. Opcional.
   *
   * Solo lo que la estrategia declara en `getRequiredNamespaces`, sin las
   * variables que se descubren barriendo `params` o el texto de un prompt. Se
   * pide aparte porque las dos mitades no toleran lo mismo: una interpolacion
   * sobre un namespace ausente resuelve a cadena vacia, mientras que una
   * dependencia declarada hace abortar el nodo en el motor. Omitirlo deja la
   * regla 7 funcionando como antes, con un unico nivel de exigencia.
   */
  readonly strictDependencies?: NodeDependencyResolver;
  /** Regla 7, solo para enriquecer el mensaje. Opcional. */
  readonly dependencyOrigins?: NodeDependencyOriginResolver;
  /** Regla 8; hace falta junto con `requiredFieldTypes`. */
  readonly outputFields?: NodeOutputFieldsResolver;
  /** Regla 8; hace falta junto con `outputFields`. */
  readonly requiredFieldTypes?: NodeRequiredFieldTypesResolver;
  /** Regla 10. */
  readonly unreachableErrorCodes?: NodeUnreachableErrorCodesResolver;
}

/**
 * Campo invalido detectado durante la validacion de un `pipeline_schema`.
 *
 * `field` usa notacion con punto para que el cliente pueda senalar el control
 * exacto del wizard (ej. `nodes.nodo_ia.retryPolicy.maxRetries`).
 */
export interface SchemaIssue {
  field: string;
  /**
   * Codigo estable del fallo, cuando lo tiene.
   *
   * OPCIONAL, y hoy solo lo declara la regla 7. Es deliberadamente el MISMO
   * `ERR_MISSING_UPSTREAM_CONTEXT` que emite el motor ante la misma causa: el
   * asistente puede entonces conmutar sobre el codigo en vez de sobre el texto
   * del mensaje, que esta escrito para leerse y puede reescribirse sin previo
   * aviso.
   */
  code?: string;
  constraints: string[];
}

// `nextStep` y `onErrorStep` ya no se pueden recorrer con un bucle comun: el
// primero es un `string | null` directo y el segundo admite ademas la forma
// selectiva `{ targetNode, catchErrors }`. Quien conoce esa union es
// `declaredErrorTarget`, y este validador le pregunta en vez de inspeccionarla.

/** Comprueba la pertenencia a `nodes` sin heredar claves de `Object.prototype`. */
const hasNode = (schema: PipelineSchemaDto, nodeId: string): boolean =>
  Object.hasOwn(schema.nodes, nodeId);

/** Codigo de la regla 11: un nodo DESTINO encadena un paso posterior. */
export const ERR_TOPOLOGY_DESTINATION_NOT_TERMINAL =
  'ERR_TOPOLOGY_DESTINATION_NOT_TERMINAL';

/**
 * Valida la integridad del grafo declarado en el pipeline.
 *
 * Se ejecuta solo cuando la forma y los tipos ya son validos: con un `nextStep`
 * numerico o un `nodes` que no es un objeto, estas comprobaciones solo generarian
 * ruido sobre el error real.
 *
 * Reglas aplicadas:
 * 1. `entrypoint` existe en `nodes`.
 * 2. La clave del mapa coincide con el `nodeId` del nodo (evita que mapa y nodo
 *    se desincronicen: el motor indexa por clave y la estrategia lee `nodeId`).
 * 3. Todo `nextStep` / `onErrorStep` no nulo resuelve a un nodo existente.
 * 4. Todo `outputNamespace` pertenece a `NODE_OUTPUT_NAMESPACES`. El formato ya
 *    lo comprueba el DTO; aqui se comprueba la PERTENENCIA, porque un namespace
 *    bien formado pero desconocido pasaria el esquema y solo reventaria despues,
 *    al guardar una plantilla que lo interpola.
 * 5. Ningun `outputNamespace` se repite: dos nodos escribiendo en el mismo
 *    namespace romperian la inmutabilidad del `StatePayloadContext`.
 * 6. El camino activo desde `entrypoint` siguiendo `nextStep` termina en un nodo
 *    terminal (`nextStep === null`) sin revisitar ninguno.
 * 7. Todo namespace que un nodo del camino activo declara necesitar lo escribe
 *    algun nodo ANTERIOR de ese mismo camino. Solo se aplica si se recibe el
 *    resolutor `dependencies`, y es lo que convierte un flujo mal ordenado en un
 *    400 al guardar en vez de una ejecucion PAUSADA en produccion.
 * 8. Todo nodo que declare necesitar un TIPO de campo aguas arriba (ej. el
 *    extractor web, que solo puede apuntar a un `url` o un `url[]`) encuentra al
 *    menos uno entre los que publican sus predecesores. Es la regla 7 un nivel
 *    mas fino: aquella pregunta "corrio el nodo que produce esto", esta pregunta
 *    "hay de donde sacar lo que necesito".
 *
 *    Existe porque la alternativa era exigir el campo en el DTO del nodo, y eso
 *    hacia que una PLANTILLA de flujo —topologia sin operativa, `params` vacios
 *    a proposito— no pudiera contener un EXTRACTOR_WEB. La comprobacion se
 *    mueve aqui porque es la unica capa que conoce el grafo: `class-validator`
 *    valida un nodo AISLADO y no puede saber quien va delante.
 * 9. El nodo al que apunta `entrypoint` es de categoria TRIGGER
 *    (`TRIGGER_NODE_TYPES`). Un flujo que arranca por un mapeador o un destino
 *    se guardaba sin protestar y solo reventaba en ejecucion, al pedir un
 *    namespace `trigger` que nadie habia escrito. La regla mira solo el primer
 *    nodo: un disparador en una posicion posterior es raro pero no se prohibe,
 *    para no invalidar plantillas ya guardadas.
 * 11. Un nodo de categoria DESTINO (`DESTINO_NODE_TYPES`) cierra el flujo:
 *    `nextStep` debe ser `null`. Encadenar procesamiento DESPUES de haber
 *    publicado en Drupal o enviado el correo no tiene marcha atras —el efecto
 *    externo ya ocurrio—, y si ese nodo posterior falla el flujo queda FALLIDO
 *    describiendo una entrega que si se realizo.
 *
 *    `onErrorStep` SI se permite, y es la valvula de escape deliberada: un
 *    destino que falla debe poder derivar a un `DESTINO_SMTP` de alerta. Por eso
 *    la regla mira `nextStep` y no la salida del nodo en general. Un destino
 *    encadenado a otro destino tambien se rechaza: publicar y notificar se
 *    modela con la ruta de error o con dos flujos distintos.
 *
 *    Se comprueba sobre el MAPA COMPLETO, como las reglas 2 a 5 y 10, y no solo
 *    sobre el camino activo: una rama en construccion con esta forma es un error
 *    que conviene ver al guardar, no el dia que se conecte.
 *
 * Los nodos inalcanzables desde `entrypoint` se ignoran deliberadamente: un flujo
 * puede conservar ramas en construccion sin que eso invalide el esquema.
 * `onErrorStep` queda fuera del recorrido porque apuntar hacia atras es el patron
 * legitimo de reintento o recuperacion.
 *
 * @param schema Esquema con forma y tipos ya validados.
 * @param resolvers Lo que se pregunta a cada estrategia. Omitir uno desactiva su
 *                  regla, que es lo que hacen las pruebas de las reglas 1 a 6.
 * @returns Lista de incidencias; vacia si el grafo es integro.
 */
export const validatePipelineTopology = (
  schema: PipelineSchemaDto,
  resolvers: PipelineTopologyResolvers = {},
): SchemaIssue[] => {
  const issues: SchemaIssue[] = [];

  // 1. El camino activo necesita un punto de partida real.
  if (!hasNode(schema, schema.entrypoint)) {
    issues.push({
      field: 'entrypoint',
      constraints: [
        `El entrypoint "${schema.entrypoint}" no existe en el mapa de nodos.`,
      ],
    });
  }

  // 9. El punto de partida tiene que ser ademas un DISPARADOR.
  //
  // Solo se comprueba si el nodo existe: con un entrypoint colgado ya se emitio
  // la regla 1, y anadir aqui un segundo issue seria ruido sobre el error real.
  const entryNode = schema.nodes[schema.entrypoint];

  if (entryNode !== undefined && !TRIGGER_NODE_TYPES.has(entryNode.nodeType)) {
    issues.push({
      field: `nodes.${schema.entrypoint}.nodeType`,
      constraints: [
        'El nodo inicial (Entry Point) debe ser un disparador de categoria TRIGGER',
      ],
    });
  }

  // 2, 3, 4 y 5. Recorrido del mapa completo, nodo a nodo.
  const namespaceOwners = new Map<string, string>();

  for (const [key, node] of Object.entries(schema.nodes)) {
    if (node.nodeId !== key) {
      issues.push({
        field: `nodes.${key}.nodeId`,
        constraints: [
          `La clave del mapa "${key}" no coincide con el nodeId "${node.nodeId}".`,
        ],
      });
    }

    if (node.nextStep !== null && !hasNode(schema, node.nextStep)) {
      issues.push({
        field: `nodes.${key}.nextStep`,
        constraints: [
          `nextStep apunta a "${node.nextStep}", que no existe en el mapa de nodos.`,
        ],
      });
    }

    // 11. Un nodo de destino es terminal.
    if (DESTINO_NODE_TYPES.has(node.nodeType) && node.nextStep !== null) {
      issues.push({
        field: `nodes.${key}.nextStep`,
        code: ERR_TOPOLOGY_DESTINATION_NOT_TERMINAL,
        constraints: [
          `"${key}" es un nodo de destino y debe cerrar el flujo; no puede encadenar "${node.nextStep}". Para reaccionar a un fallo de la entrega, usa onErrorStep.`,
        ],
      });
    }

    // Se valida el destino DECLARADO y no el efectivo: que la ruta atrape unos
    // codigos u otros es indiferente aqui, porque apuntar a un nodo inexistente
    // rompe el esquema aunque ese codigo no llegue a ocurrir nunca.
    const errorTarget = declaredErrorTarget(node.onErrorStep);

    if (errorTarget !== null && !hasNode(schema, errorTarget)) {
      issues.push({
        field: `nodes.${key}.onErrorStep`,
        constraints: [
          `onErrorStep apunta a "${errorTarget}", que no existe en el mapa de nodos.`,
        ],
      });
    }

    // 10. Una ruta declarada contra un codigo que el nodo no puede emitir.
    //
    // Se comprueba solo la forma SELECTIVA (`catchesErrorExplicitly`): un
    // `onErrorStep: "alerta"` generico esta ahi para los demas fallos del nodo y
    // rechazarlo seria un falso positivo. Mencionar el codigo a mano en
    // `catchErrors`, en cambio, es una declaracion inequivoca de intencion, y si
    // los `params` la desmienten el operador se queda con un nodo de respaldo
    // que jamas corre — sin excepcion, sin traza y sin forma de notarlo hasta
    // que el correo que debia desviarse siga de largo en produccion.
    if (resolvers.unreachableErrorCodes !== undefined) {
      const unreachable = resolvers
        .unreachableErrorCodes(node)
        .filter((code) => catchesErrorExplicitly(node.onErrorStep, code));

      if (unreachable.length > 0) {
        issues.push({
          field: `nodes.${key}.onErrorStep`,
          constraints: [
            `La ruta de error atrapa ${unreachable.join(', ')}, que este nodo no puede emitir con sus params actuales: nunca se disparara.`,
          ],
        });
      }
    }

    if (!NODE_OUTPUT_NAMESPACE_SET.has(node.outputNamespace)) {
      issues.push({
        field: `nodes.${key}.outputNamespace`,
        constraints: [
          `El namespace "${node.outputNamespace}" no esta permitido. Solo se admiten: ${NODE_OUTPUT_NAMESPACES.join(', ')}.`,
        ],
      });
    }

    const owner = namespaceOwners.get(node.outputNamespace);

    if (owner === undefined) {
      namespaceOwners.set(node.outputNamespace, key);
      continue;
    }

    issues.push({
      field: `nodes.${key}.outputNamespace`,
      constraints: [
        `El namespace "${node.outputNamespace}" ya lo escribe el nodo "${owner}".`,
      ],
    });
  }

  issues.push(...detectActivePathCycle(schema));

  if (resolvers.dependencies !== undefined) {
    issues.push(
      ...detectUnreachableNamespaces(
        schema,
        resolvers.dependencies,
        resolvers.strictDependencies,
        resolvers.dependencyOrigins,
      ),
    );
  }

  if (
    resolvers.outputFields !== undefined &&
    resolvers.requiredFieldTypes !== undefined
  ) {
    issues.push(
      ...detectMissingUpstreamFieldTypes(
        schema,
        resolvers.outputFields,
        resolvers.requiredFieldTypes,
      ),
    );
  }

  return issues;
};

/**
 * Namespaces que el motor siembra por su cuenta y que ningun nodo declara.
 *
 * `trigger` lo escribe el motor con el `initialPayload` al crear la ejecucion,
 * `_assets` lo inyecta el renderizador de plantillas, y `error_context` lo
 * siembra el motor al desviar por `onErrorStep`. Exigir que algun nodo los
 * produzca los haria irresolubles por construccion.
 *
 * `error_context` tiene ademas un matiz propio: solo existe en las ejecuciones
 * que se desviaron. Un nodo de respaldo puede interpolarlo con garantias porque
 * a el solo se llega por esa ruta, pero declararlo en `NODE_OUTPUT_NAMESPACES`
 * seria mentir —ninguna estrategia lo escribe— y de paso lo colaria en
 * `ALLOWED_NAMESPACES`, habilitandolo en plantillas HTML que se renderizan en
 * ejecuciones donde no existe.
 */
const ENGINE_PROVIDED_NAMESPACES: ReadonlySet<string> = new Set([
  'trigger',
  '_assets',
  ERROR_CONTEXT_NAMESPACE,
]);

/**
 * Disponibilidad de un namespace en el punto del recorrido en que se consulta.
 *
 * `certain` lo escribe un predecesor del camino activo, asi que existe en TODA
 * ejecucion que llegue al consumidor. `conditional` lo escribe un nodo al que
 * solo se llega por una rama de contingencia: existe unicamente en las
 * ejecuciones que se desviaron por ahi.
 */
type NamespaceAvailability = 'certain' | 'conditional';

/** Nodos del camino activo, para distinguir un satelite de una reincorporacion. */
const collectActivePathIds = (
  schema: PipelineSchemaDto,
): ReadonlySet<string> => {
  const path = new Set<string>();
  let cursor: string | null = schema.entrypoint;

  while (cursor !== null && hasNode(schema, cursor) && !path.has(cursor)) {
    path.add(cursor);
    cursor = schema.nodes[cursor].nextStep;
  }

  return path;
};

/**
 * Recorre el subgrafo de contingencia que cuelga de un nodo del camino activo.
 *
 * Entra por `onErrorStep` y sigue avanzando por los `nextStep` y por los
 * `onErrorStep` anidados del satelite, PARANDO en cuanto pisa un nodo del camino
 * activo. Ese corte es lo que impide adelantar namespaces: un satelite que
 * reincorpora al flujo no debe hacer parecer disponibles los nodos nominales que
 * vengan despues, porque esos ya los acumula el bucle principal cuando toca.
 *
 * El `Set` de visitados no es decorativo: dos satelites pueden apuntarse entre
 * si, y una rama de error que vuelve sobre si misma colgaria el recorrido.
 *
 * Recibe el NODO ya resuelto y no su identificador: la regla 2 no garantiza que
 * la clave del mapa coincida con el `nodeId`, y volver a indexar `schema.nodes`
 * con el segundo reventaria justo en los esquemas que esa regla esta reportando.
 */
const forEachContingencyNode = (
  schema: PipelineSchemaDto,
  from: PipelineNodeConfigDto,
  activePath: ReadonlySet<string>,
  visit: (node: PipelineNodeConfigDto) => void,
): void => {
  const entry = declaredErrorTarget(from.onErrorStep);

  if (entry === null) {
    return;
  }

  const pending: string[] = [entry];
  const seen = new Set<string>();

  while (pending.length > 0) {
    const nodeId = pending.shift() as string;

    if (
      seen.has(nodeId) ||
      activePath.has(nodeId) ||
      !hasNode(schema, nodeId)
    ) {
      continue;
    }

    seen.add(nodeId);

    const node: PipelineNodeConfigDto = schema.nodes[nodeId];
    visit(node);

    if (node.nextStep !== null) {
      pending.push(node.nextStep);
    }

    const nested = declaredErrorTarget(node.onErrorStep);

    if (nested !== null) {
      pending.push(nested);
    }
  }
};

/**
 * Comprueba que cada nodo del camino activo encuentre lo que necesita.
 *
 * Recorre `entrypoint -> nextStep` acumulando los `outputNamespace` ya escritos,
 * de modo que un nodo solo puede depender de lo que producen sus PREDECESORES.
 * Es la misma pregunta que la guarda del motor responde en ejecucion, adelantada
 * al momento de guardar.
 *
 * LAS RAMAS DE CONTINGENCIA SI CUENTAN, pero marcadas aparte. Al visitar un nodo
 * se acumula tambien lo que producen los satelites que cuelgan de su
 * `onErrorStep`, como `conditional`. El caso que lo motiva es el rescate por OCR:
 * `parser_pre_ia` desvia a un `PROCESADOR_OCR` que escribe `ocr_result` y
 * reincorpora al `procesador_ia`, cuyo prompt cita `{{ocr_result.clean_body}}`.
 * Esa topologia es correcta y hasta ahora se rechazaba con un 400.
 *
 * El nivel de exigencia NO es el mismo para las dos mitades de la dependencia:
 *
 * - Lo INTERPOLADO (`{{ns.campo}}` en los params o en un prompt) se satisface con
 *   un namespace condicional. Si la rama no llego a dispararse,
 *   `getInterpolatedValue` resuelve a cadena vacia y el flujo continua.
 * - Lo DECLARADO en `getRequiredNamespaces` exige un productor del camino activo.
 *   Ahi el motor no interpola nada: aborta el nodo con
 *   `ERR_MISSING_UPSTREAM_CONTEXT` siempre que la ejecucion tome el camino feliz,
 *   que es justamente el caso normal. Se reporta con un codigo propio para que el
 *   operador sepa que el nodo esta bien colocado pero mal alimentado.
 *
 * SE MANTIENE la segunda acotacion original: parada en seco si un puntero no
 * resuelve o si el camino cicla, porque eso ya lo reportan las reglas 3 y 6 y
 * duplicarlo anadiria ruido sobre el error real.
 */
const detectUnreachableNamespaces = (
  schema: PipelineSchemaDto,
  resolveDependencies: NodeDependencyResolver,
  resolveStrictDependencies?: NodeDependencyResolver,
  resolveOrigins?: NodeDependencyOriginResolver,
): SchemaIssue[] => {
  const issues: SchemaIssue[] = [];
  const produced = new Map<string, NamespaceAvailability>();
  const activePath = collectActivePathIds(schema);
  const visited = new Set<string>();
  let cursor: string | null = schema.entrypoint;

  while (cursor !== null) {
    if (!hasNode(schema, cursor) || visited.has(cursor)) {
      break;
    }

    visited.add(cursor);

    const node: PipelineNodeConfigDto = schema.nodes[cursor];
    const isSatisfiable = (namespace: string): boolean =>
      ENGINE_PROVIDED_NAMESPACES.has(namespace) || produced.has(namespace);

    const missing = resolveDependencies(node).filter(
      (namespace) => !isSatisfiable(namespace),
    );

    // Lo declarado que SI esta, pero solo por una rama que puede no dispararse.
    const conditional = (resolveStrictDependencies?.(node) ?? []).filter(
      (namespace) =>
        !ENGINE_PROVIDED_NAMESPACES.has(namespace) &&
        produced.get(namespace) === 'conditional',
    );

    if (missing.length > 0) {
      // Las procedencias solo adornan el mensaje: un namespace que el nodo
      // hereda de un prompt guardado no aparece por ninguna parte de sus
      // `params`, y sin decirlo el operador no sabria donde mirar.
      const origins = resolveOrigins?.(node);
      const described = missing.map((namespace) => {
        const origin = origins?.get(namespace);

        return origin === undefined
          ? namespace
          : `${namespace} (lo cita ${origin})`;
      });

      issues.push({
        field: `nodes.${node.nodeId}.params`,
        code: ERR_MISSING_UPSTREAM_CONTEXT,
        constraints: [
          `El nodo necesita los namespaces [${described.join(', ')}], que ningun paso anterior del flujo escribe. Reordena el flujo o anade el nodo que los produce.`,
        ],
      });
    }

    if (conditional.length > 0) {
      issues.push({
        field: `nodes.${node.nodeId}.params`,
        code: ERR_CONDITIONAL_UPSTREAM_CONTEXT,
        constraints: [
          `El nodo exige los namespaces [${conditional.join(', ')}], que solo escribe una rama de contingencia y por tanto faltan siempre que el flujo no falle. Coloca en el camino principal un nodo que los produzca.`,
        ],
      });
    }

    produced.set(node.outputNamespace, 'certain');

    forEachContingencyNode(schema, node, activePath, (satellite) => {
      if (!produced.has(satellite.outputNamespace)) {
        produced.set(satellite.outputNamespace, 'conditional');
      }
    });

    cursor = node.nextStep;
  }

  return issues;
};

/**
 * Comprueba que cada nodo encuentre aguas arriba el TIPO de campo que necesita.
 *
 * Recorre el camino activo acumulando los campos que publica cada predecesor,
 * indexados por su `outputNamespace`, y para cada nodo que declare
 * `requiredUpstreamFieldTypes` comprueba que al menos uno de esos tipos exista
 * entre lo acumulado.
 *
 * ES DELIBERADAMENTE MAS DEBIL QUE PEDIR EL VALOR. No afirma que el nodo este
 * configurado —un `targetUrl` vacio la supera sin problema—, solo que el flujo
 * PODRIA configurarse. Es la distincion entre guardar y activar: una plantilla
 * de flujo declara topologia y elige los valores despues, asi que bloquear aqui
 * por falta de valor haria inexpresable el nodo. De la completitud responde
 * `getIncompleteParams`, que consulta `assertActivatable`.
 *
 * Acumula tambien los campos de los satelites de contingencia, por el mismo
 * motivo que la regla 7 y con el mismo recorrido: si un `PROCESADOR_OCR` cuelga
 * de la rama de error de un predecesor, su `text` esta disponible para quien
 * venga detras. Aqui NO se distingue `certain` de `conditional`: la regla 8 solo
 * afirma que el flujo PODRIA configurarse, que es una pregunta mas debil, y
 * exigir un tipo de campo por dos caminos distintos rechazaria flujos correctos.
 *
 * Se mantiene la parada en seco si un puntero no resuelve o el camino cicla,
 * porque eso ya lo reportan las reglas 3 y 6.
 *
 * Un nodo cuya estrategia no declare campos de salida aporta un arreglo vacio y
 * simplemente no ayuda a satisfacer a nadie. No es un fallo: hoy solo dos de las
 * ocho estrategias los declaran, y tratar el silencio como ausencia rechazaria
 * flujos correctos.
 */
const detectMissingUpstreamFieldTypes = (
  schema: PipelineSchemaDto,
  resolveOutputFields: NodeOutputFieldsResolver,
  resolveRequiredFieldTypes: NodeRequiredFieldTypesResolver,
): SchemaIssue[] => {
  const issues: SchemaIssue[] = [];
  const availableTypes = new Set<string>();
  const activePath = collectActivePathIds(schema);
  const visited = new Set<string>();
  let cursor: string | null = schema.entrypoint;

  while (cursor !== null) {
    if (!hasNode(schema, cursor) || visited.has(cursor)) {
      break;
    }

    visited.add(cursor);

    const node: PipelineNodeConfigDto = schema.nodes[cursor];
    const required = resolveRequiredFieldTypes(node);

    if (
      required.length > 0 &&
      !required.some((fieldType) => availableTypes.has(fieldType))
    ) {
      issues.push({
        field: `nodes.${node.nodeId}.params`,
        code: ERR_MISSING_UPSTREAM_FIELD_TYPE,
        constraints: [
          `Ningun paso anterior del flujo publica un campo de tipo [${required.join(', ')}], que es lo que este nodo necesita poder referenciar. Coloca por delante un nodo que lo produzca o reordena el flujo.`,
        ],
      });
    }

    for (const field of resolveOutputFields(node)) {
      availableTypes.add(field.type);
    }

    forEachContingencyNode(schema, node, activePath, (satellite) => {
      for (const field of resolveOutputFields(satellite)) {
        availableTypes.add(field.type);
      }
    });

    cursor = node.nextStep;
  }

  return issues;
};

/**
 * Recorre el camino activo desde `entrypoint` en busca de un ciclo.
 *
 * El grafo de `nextStep` es funcional (cada nodo tiene como mucho un sucesor),
 * asi que basta un recorrido lineal con un `Set` de visitados: no hace falta DFS
 * ni deteccion de componentes fuertemente conexas.
 *
 * Se detiene en silencio si un puntero no resuelve; ese fallo ya lo reportan las
 * reglas 1 y 3 y duplicarlo solo anadiria ruido.
 */
const detectActivePathCycle = (schema: PipelineSchemaDto): SchemaIssue[] => {
  const visited = new Set<string>();
  const path: string[] = [];
  let cursor: string | null = schema.entrypoint;

  while (cursor !== null) {
    if (!hasNode(schema, cursor)) {
      return [];
    }

    if (visited.has(cursor)) {
      const lastNode = path[path.length - 1];

      return [
        {
          field: `nodes.${lastNode}.nextStep`,
          constraints: [
            `El camino activo forma un ciclo infinito: ${[...path, cursor].join(' -> ')}.`,
          ],
        },
      ];
    }

    visited.add(cursor);
    path.push(cursor);
    cursor = schema.nodes[cursor].nextStep;
  }

  return [];
};
