import {
  BadRequestException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  collectNamespaceRoots,
  extractNamespaceRoots,
} from '@core/fsm/context/state-payload.context';
import {
  PipelineNodeConfigDto,
  PipelineSchemaDto,
} from '@core/fsm/dto/pipeline-schema.dto';
// Import de VALOR: `NodeStrategyFactory` se inyecta por constructor, y con
// `emitDecoratorMetadata` un `import type` se borra al transpilar dejando a Nest
// sin el token que necesita para resolver la dependencia.
import { NodeStrategyFactory } from '@core/fsm/factories/node-strategy.factory';
import { ERR_INCOMPLETE_NODE_PARAMS } from '@core/fsm/types/node-strategy.types';
import { validatePipelineTopology } from '@core/fsm/validators/pipeline-topology.validator';
import {
  PROMPT_TEXT_RESOLVER,
  promptReferenceKey,
} from '@core/fsm/types/prompt-text-resolver.port';

import type { INodeStrategy } from '@core/fsm/types/node-strategy.types';
import type { SchemaIssue } from '@core/fsm/validators/pipeline-topology.validator';
import type {
  PromptReference,
  PromptTextResolverPort,
} from '@core/fsm/types/prompt-text-resolver.port';
import type { ValidationError, ValidatorOptions } from 'class-validator';

/** Lo que aportan los prompts guardados a la validacion de topologia. */
interface PromptContext {
  /** Namespaces que hereda cada nodo de los prompts que cita. */
  readonly namespacesByNode: ReadonlyMap<string, readonly string[]>;
  /** Procedencia legible de cada namespace, para el mensaje de la regla 7. */
  readonly originsByNode: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

/** Codigo de error del cuerpo de la excepcion; el frontend conmuta sobre el. */
const SCHEMA_ERROR_CODE = 'PIPELINE_SCHEMA_INVALIDO';

/**
 * Hasta donde llega la validacion.
 *
 * Por defecto se valida para GUARDAR: forma, tipos y grafo. Una plantilla de
 * flujo o un borrador a medio configurar deben poder persistirse, porque el
 * valor concreto de muchos `params` se elige despues, en el asistente.
 *
 * `requireRunnableParams` sube el liston a EJECUTABLE y solo lo pide
 * `assertActivatable`. Es la asimetria deliberada entre guardar y activar.
 */
export interface ValidateSchemaOptions {
  readonly requireRunnableParams?: boolean;
}

/**
 * `forbidNonWhitelisted` convierte cualquier propiedad no declarada en un error
 * en vez de descartarla en silencio: un `nextStepp` mal escrito debe fallar al
 * guardar el flujo, no dejar un puntero perdido que el motor descubra en runtime.
 */
const VALIDATION_OPTIONS: ValidatorOptions = {
  whitelist: true,
  forbidNonWhitelisted: true,
};

/** Comprueba que el valor sea un objeto JSON (ni null, ni array, ni primitivo). */
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Aplana el arbol de `ValidationError` a rutas con punto.
 *
 * class-validator anida los errores de un DTO hijo en `children`, asi que sin
 * este recorrido `retryPolicy.maxRetries` llegaria al cliente como un simple
 * `retryPolicy` sin indicar que campo concreto falla.
 */
const flattenValidationErrors = (
  errors: ValidationError[],
  parentPath = '',
): SchemaIssue[] =>
  errors.flatMap((error) => {
    const field =
      parentPath === '' ? error.property : `${parentPath}.${error.property}`;
    const constraints = Object.values(error.constraints ?? {});
    const own: SchemaIssue[] =
      constraints.length > 0 ? [{ field, constraints }] : [];

    return [...own, ...flattenValidationErrors(error.children ?? [], field)];
  });

/**
 * Valida el JSON de un pipeline antes de persistirlo en
 * `flujos.configuracion_pipeline`.
 *
 * Es la frontera Poka-Yoke del motor FSM: un esquema que supere este servicio
 * tiene forma, tipos y grafo correctos, de modo que el `FsmEngineService` puede
 * recorrerlo sin comprobaciones defensivas en cada paso.
 */
@Injectable()
export class PipelineValidatorService {
  /**
   * El puerto de prompts es OPCIONAL a proposito.
   *
   * Sin el, el validador se comporta exactamente como antes de PROT-24: ve los
   * namespaces escritos en `params` y no los que cita un prompt guardado. Eso
   * mantiene en pie cualquier contexto que construya este servicio a mano —las
   * pruebas, un arranque parcial— sin obligarlo a doblar una dependencia que no
   * le concierne.
   */
  constructor(
    private readonly strategyFactory: NodeStrategyFactory,
    @Optional()
    @Inject(PROMPT_TEXT_RESOLVER)
    private readonly promptTextResolver: PromptTextResolverPort | null = null,
  ) {}

  /**
   * Convierte un JSON arbitrario en un `PipelineSchemaDto` validado.
   *
   * @param rawJson Payload sin tipar, tal y como llega del cliente o de la BD.
   * @param options `requireRunnableParams` exige ademas que ningun nodo tenga
   *                params a medias. Ver `ValidateSchemaOptions`.
   * @returns La instancia validada del esquema.
   * @throws BadRequestException Con la lista exacta de campos invalidos.
   */
  public async validateSchema(
    rawJson: unknown,
    options: ValidateSchemaOptions = {},
  ): Promise<PipelineSchemaDto> {
    if (!isPlainObject(rawJson)) {
      this.rejectWith([
        {
          field: '(root)',
          constraints: ['El esquema del pipeline debe ser un objeto JSON.'],
        },
      ]);
    }

    const schema = plainToInstance(PipelineSchemaDto, rawJson);
    const issues = flattenValidationErrors(
      await validate(schema, VALIDATION_OPTIONS),
    );

    // El mapa solo se recorre si es realmente un objeto: sobre una cadena,
    // Object.entries devolveria un error por cada caracter.
    if (isPlainObject(schema.nodes)) {
      issues.push(...(await this.validateNodes(schema.nodes)));
    }

    // La topologia presupone forma y tipos correctos (ver el TSDoc del validador).
    if (issues.length === 0) {
      // Se resuelve ANTES de validar la topologia y no dentro del resolutor
      // porque leer un prompt es I/O y `validatePipelineTopology` es una funcion
      // pura y sincrona. Pre-resolver mantiene esa propiedad y de paso agrupa
      // todas las lecturas en una sola consulta.
      const promptContext = await this.resolvePromptContext(schema);

      issues.push(
        ...validatePipelineTopology(schema, {
          dependencies: (node) => [
            ...new Set([
              ...this.resolveNodeDependencies(node),
              ...(promptContext.namespacesByNode.get(node.nodeId) ?? []),
            ]),
          ],
          dependencyOrigins: (node) =>
            promptContext.originsByNode.get(node.nodeId) ?? new Map(),
          outputFields: (node) =>
            this.tryGetStrategy(node.nodeType)?.outputFields ?? [],
          // Se prefiere el metodo sobre la propiedad: hay nodos cuya exigencia
          // aguas arriba depende de sus propios `params` (ver `skipIfEmpty` del
          // extractor web) y la propiedad estatica no puede expresarlo.
          requiredFieldTypes: (node) => {
            const strategy = this.tryGetStrategy(node.nodeType);

            return (
              strategy?.getRequiredUpstreamFieldTypes?.(node.params) ??
              strategy?.requiredUpstreamFieldTypes ??
              []
            );
          },
          unreachableErrorCodes: (node) =>
            this.tryGetStrategy(node.nodeType)?.getUnreachableErrorCodes?.(
              node.params,
            ) ?? [],
        }),
      );
    }

    if (options.requireRunnableParams === true) {
      issues.push(...this.collectIncompleteParams(schema));
    }

    if (issues.length > 0) {
      this.rejectWith(issues);
    }

    return schema;
  }

  /**
   * Nodos cuyos `params` estan a medias para EJECUTARSE.
   *
   * Separado de la validacion normal porque guardar y activar son dos
   * exigencias distintas. Una plantilla de flujo declara topologia y deja los
   * `params` vacios a proposito —el valor concreto se elige al instanciar—, asi
   * que exigir aqui la completitud haria inexpresable cualquier nodo que la
   * necesite. Se pide solo desde `assertActivatable`, que es el unico punto por
   * el que un flujo pasa a poder dispararse.
   *
   * Se recorre el mapa ENTERO y no solo el camino activo: activar un flujo con
   * una rama de error a medio configurar es exactamente el fallo que se
   * descubriria de madrugada, cuando esa rama se use por primera vez.
   */
  private collectIncompleteParams(schema: PipelineSchemaDto): SchemaIssue[] {
    if (!isPlainObject(schema.nodes)) {
      return [];
    }

    return Object.entries(schema.nodes).flatMap(([key, node]) => {
      const missing =
        this.tryGetStrategy(node.nodeType)?.getIncompleteParams?.(
          node.params,
        ) ?? [];

      if (missing.length === 0) {
        return [];
      }

      return [
        {
          field: `nodes.${key}.params`,
          code: ERR_INCOMPLETE_NODE_PARAMS,
          constraints: [
            `Faltan por configurar [${missing.join(', ')}]. El flujo se puede guardar asi, pero no activar: completalo en el asistente.`,
          ],
        },
      ];
    });
  }

  /**
   * Namespaces que un nodo necesita: los que DECLARA y los que se le LEEN.
   *
   * Dos fuentes que se suman, y ninguna sobra:
   *
   * 1. `getRequiredNamespaces` es la fuente autorizada cuando existe, porque la
   *    estrategia sabe cosas que el texto de `params` no dice. El parser depende
   *    de `raw_email` aunque su `sourceNamespace` no aparezca escrito por
   *    ninguna parte, al ser el valor por defecto, y el extractor web impone su
   *    `FALLBACK_SCRAPER_NAMESPACE` cuando la plantilla no nombra a nadie.
   * 2. El barrido por interpolacion cubre a TODOS los demas. El metodo es
   *    opcional y hoy solo lo implementan dos de los ocho tipos: sin este
   *    segundo canal, un MAPEADOR_PLANTILLA —que deliberadamente no lo
   *    implementa— o un tipo aun sin estrategia podia interpolar
   *    `{{scraped_web.url}}` en cualquier clave de sus `params` y guardarse sin
   *    que nadie comprobara que ese namespace llega a existir.
   *
   * Un tipo sin estrategia registrada no propaga la excepcion de la factoria:
   * que el nodo no sea ejecutable es un problema distinto y lo reporta el motor
   * con `ERR_STRATEGY_NOT_FOUND`; convertirlo aqui en un fallo de dependencias
   * daria un diagnostico que manda al operador a reordenar un flujo cuyo orden
   * esta bien. Sus `params` si se barren, porque el texto se lee igual.
   *
   * La union se deduplica: las dos fuentes coinciden a menudo —el extractor web
   * deriva la suya justamente de `targetUrl`— y un namespace repetido saldria
   * dos veces en el mensaje de la regla 7.
   */
  /**
   * Namespaces que cada nodo hereda de los prompts GUARDADOS que cita.
   *
   * Es la mitad que `resolveNodeDependencies` no puede ver: aquella mira los
   * `params`, y un nodo que resuelve su instruccion por `templatePromptId` o
   * `promptCode` solo lleva ahi un identificador. Sin esto, el
   * `{{scraped_web.full_article_content}}` que trae el prompt sembrado
   * `NOTIWEB_DEFAULT` no se detectaba al guardar: el flujo se daba por valido y
   * reventaba en ejecucion con `ERR_LLM_INTERPOLATION`, ya PAUSADO.
   *
   * Devuelve DOS mapas porque responden a preguntas distintas. El de namespaces
   * alimenta la regla 7; el de procedencias solo sirve para que el mensaje diga
   * de donde sale la dependencia, que es lo que evita mandar al operador a
   * buscar en los `params` un marcador que esta en el prompt.
   *
   * Sale en seco si no hay puerto inyectado o si ningun nodo cita un prompt
   * guardado: el caso normal no paga ninguna consulta.
   */
  private async resolvePromptContext(
    schema: PipelineSchemaDto,
  ): Promise<PromptContext> {
    const empty: PromptContext = {
      namespacesByNode: new Map(),
      originsByNode: new Map(),
    };

    if (this.promptTextResolver === null || !isPlainObject(schema.nodes)) {
      return empty;
    }

    // Referencias por nodo. Se recorre el mapa ENTERO y no solo el camino
    // activo: filtrar aqui seria adivinar, y la regla 7 ya decide por donde
    // camina. Un nodo satelite pide su prompt y simplemente nadie le pregunta.
    const referencesByNode = new Map<string, readonly PromptReference[]>();

    for (const node of Object.values(schema.nodes)) {
      const references =
        this.tryGetStrategy(node.nodeType)?.getPromptReferences?.(node.params) ??
        [];

      if (references.length > 0) {
        referencesByNode.set(node.nodeId, references);
      }
    }

    if (referencesByNode.size === 0) return empty;

    const texts = await this.promptTextResolver.resolvePromptTexts([
      ...referencesByNode.values(),
    ].flat());

    const namespacesByNode = new Map<string, readonly string[]>();
    const originsByNode = new Map<string, ReadonlyMap<string, string>>();

    for (const [nodeId, references] of referencesByNode) {
      const namespaces = new Set<string>();
      const origins = new Map<string, string>();

      for (const reference of references) {
        const text = texts.get(promptReferenceKey(reference));

        // Una referencia que no resuelve no es un fallo de dependencias: de la
        // plantilla que falta se queja la ejecucion con
        // `ERR_LLM_PROMPT_UNRESOLVED`, y tratarla aqui como un namespace ausente
        // mandaria a reordenar un flujo cuyo orden esta bien.
        if (text === undefined) continue;

        for (const namespace of extractNamespaceRoots(text)) {
          namespaces.add(namespace);
          // La primera procedencia gana: con `templatePromptId` y `promptCode`
          // solo se declara una referencia (ver `getPromptReferences`), asi que
          // en la practica no hay empate que deshacer.
          if (!origins.has(namespace)) {
            origins.set(namespace, `el prompt "${reference.value}"`);
          }
        }
      }

      if (namespaces.size > 0) {
        namespacesByNode.set(nodeId, [...namespaces]);
        originsByNode.set(nodeId, origins);
      }
    }

    return { namespacesByNode, originsByNode };
  }

  private resolveNodeDependencies(
    node: PipelineNodeConfigDto,
  ): readonly string[] {
    const declared =
      this.tryGetStrategy(node.nodeType)?.getRequiredNamespaces?.(
        node.params,
      ) ?? [];

    return [...new Set([...declared, ...collectNamespaceRoots(node.params)])];
  }

  /**
   * La estrategia de un tipo, o `null` si no hay ninguna registrada.
   *
   * Engulle la `StrategyNotFoundException` de la factoria en vez de propagarla,
   * y lo hace en un solo sitio para los dos consumidores que la necesitan. Que
   * un nodo no sea ejecutable es un problema distinto y ya lo reporta el motor
   * con `ERR_STRATEGY_NOT_FOUND`; convertirlo aqui en un fallo de dependencias
   * o de params daria un diagnostico que manda al operador a corregir algo que
   * esta bien.
   */
  private tryGetStrategy(
    nodeType: PipelineNodeConfigDto['nodeType'],
  ): INodeStrategy | null {
    try {
      return this.strategyFactory.getStrategy(nodeType);
    } catch {
      return null;
    }
  }

  /**
   * Valida cada nodo por separado y prefija sus errores con `nodes.<clave>.`.
   *
   * class-validator 0.15.1 no itera `Record` con `@ValidateNested({ each: true })`
   * —solo Array, Set y Map—, asi que la iteracion es manual. A cambio se conserva
   * la clave del nodo en la ruta del error, que es justo lo que necesita el wizard
   * del frontend para senalar el paso culpable.
   */
  private async validateNodes(
    nodes: Record<string, unknown>,
  ): Promise<SchemaIssue[]> {
    const issues: SchemaIssue[] = [];

    for (const [key, rawNode] of Object.entries(nodes)) {
      if (!isPlainObject(rawNode)) {
        issues.push({
          field: `nodes.${key}`,
          constraints: ['Cada nodo debe ser un objeto de configuracion.'],
        });
        continue;
      }

      const node = plainToInstance(PipelineNodeConfigDto, rawNode);
      const nodeErrors = await validate(node, VALIDATION_OPTIONS);

      if (nodeErrors.length > 0) {
        issues.push(...flattenValidationErrors(nodeErrors, `nodes.${key}`));
        continue;
      }

      issues.push(...(await this.validateNodeParams(key, node)));
    }

    return issues;
  }

  /**
   * Valida los `params` del nodo contra el DTO que declare su estrategia.
   *
   * Solo se llega aqui con el nodo ya correcto en forma y tipos: sobre un
   * `nodeType` invalido la factoria no resolveria nada, y sobre unos `params`
   * que ni siquiera son un objeto el DTO devolveria un error por cada clave
   * imaginaria, enterrando el fallo real.
   *
   * Una estrategia sin `paramsSchema` no se comprueba, y es correcto que no se
   * compruebe: sus params los sigue validando su `execute`, como hasta ahora.
   */
  private async validateNodeParams(
    key: string,
    node: PipelineNodeConfigDto,
  ): Promise<SchemaIssue[]> {
    const paramsSchema = this.tryGetStrategy(node.nodeType)?.paramsSchema;

    if (paramsSchema === undefined || !isPlainObject(node.params)) {
      return [];
    }

    const dto = plainToInstance(paramsSchema, node.params);

    return flattenValidationErrors(
      await validate(dto, VALIDATION_OPTIONS),
      `nodes.${key}.params`,
    );
  }

  /** Lanza la excepcion estructurada. Tipada como `never` para cortar el flujo. */
  private rejectWith(issues: SchemaIssue[]): never {
    throw new BadRequestException({
      statusCode: 400,
      error: SCHEMA_ERROR_CODE,
      message: 'El esquema del pipeline no supera la validacion.',
      issues,
    });
  }
}
