import {
  catchesErrorExplicitly,
  declaredErrorTarget,
} from '@core/fsm/utils/pipeline-topology.util';
import {
  ERR_MISSING_UPSTREAM_CONTEXT,
  ERR_MISSING_UPSTREAM_FIELD_TYPE,
} from '@core/fsm/types/node-strategy.types';
import {
  ERROR_CONTEXT_NAMESPACE,
  NODE_OUTPUT_NAMESPACE_SET,
  NODE_OUTPUT_NAMESPACES,
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
 * Comprueba que cada nodo del camino activo encuentre lo que necesita.
 *
 * Recorre `entrypoint -> nextStep` acumulando los `outputNamespace` ya escritos,
 * de modo que un nodo solo puede depender de lo que producen sus PREDECESORES.
 * Es la misma pregunta que la guarda del motor responde en ejecucion, adelantada
 * al momento de guardar.
 *
 * DOS ACOTACIONES DELIBERADAS, ambas para no rechazar flujos validos:
 *
 * 1. Solo el camino activo. Un nodo al que solo se llega por `onErrorStep` tiene
 *    un conjunto de predecesores distinto segun por donde se entre, y afirmar
 *    algo sobre el aqui seria adivinar. Esos nodos quedan cubiertos por la
 *    guarda del motor, que si sabe que contexto hay de verdad.
 * 2. Se para en seco si un puntero no resuelve o si el camino cicla. Los dos
 *    fallos ya los reportan las reglas 3 y 6, y duplicarlos anadiria ruido sobre
 *    el error real.
 */
const detectUnreachableNamespaces = (
  schema: PipelineSchemaDto,
  resolveDependencies: NodeDependencyResolver,
  resolveOrigins?: NodeDependencyOriginResolver,
): SchemaIssue[] => {
  const issues: SchemaIssue[] = [];
  const produced = new Set<string>();
  const visited = new Set<string>();
  let cursor: string | null = schema.entrypoint;

  while (cursor !== null) {
    if (!hasNode(schema, cursor) || visited.has(cursor)) {
      break;
    }

    visited.add(cursor);

    const node: PipelineNodeConfigDto = schema.nodes[cursor];
    const missing = resolveDependencies(node).filter(
      (namespace) =>
        !ENGINE_PROVIDED_NAMESPACES.has(namespace) && !produced.has(namespace),
    );

    if (missing.length > 0) {
      // Las procedencias solo adornan el mensaje: un namespace que el nodo
      // hereda de un prompt guardado no aparece por ninguna parte de sus
      // `params`, y sin decirlo el operador no sabria donde mirar.
      const origins = resolveOrigins?.(node);
      const described = missing.map((namespace) => {
        const origin = origins?.get(namespace);

        return origin === undefined ? namespace : `${namespace} (lo cita ${origin})`;
      });

      issues.push({
        field: `nodes.${node.nodeId}.params`,
        code: ERR_MISSING_UPSTREAM_CONTEXT,
        constraints: [
          `El nodo necesita los namespaces [${described.join(', ')}], que ningun paso anterior del flujo escribe. Reordena el flujo o anade el nodo que los produce.`,
        ],
      });
    }

    produced.add(node.outputNamespace);
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
 * Comparte las dos acotaciones de la regla 7 y por los mismos motivos: solo el
 * camino activo —un nodo alcanzable unicamente por `onErrorStep` tiene
 * predecesores distintos segun por donde se entre— y parada en seco si un
 * puntero no resuelve o el camino cicla, porque eso ya lo reportan las reglas 3
 * y 6.
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
