import { Injectable } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import sanitizeHtml from 'sanitize-html';

import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { TemplateRendererService } from '@modules/templates/services/template-renderer.service';
import { RESIDUAL_MARKER_PATTERN } from '@modules/templates/templates.service';
import { normalizeItems } from '@common/utils/cardinality-normalizer.util';
import { stripCodeFence } from '@modules/nodes/utils/code-fence.util';
import {
  compileJsonSchema,
  describeSchemaErrors,
  isPlainObject,
} from '@modules/nodes/utils/json-schema.util';

import {
  DEFAULT_POST_IA_SOURCE_NAMESPACE,
  PostIaContentMode,
  PostIaSanitizerConfigDto,
  resolvePostIaSanitizerConfig,
} from '../dto/post-ia-sanitizer-config.dto';

import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import type {
  INodeStrategy,
  NodeErrorDetail,
  NodeOutputField,
  NodeResult,
} from '@core/fsm/types/node-strategy.types';
import type { ResolvedPostIaSanitizerConfig } from '../dto/post-ia-sanitizer-config.dto';
import type { ValidateFunction } from 'ajv';
import type { ValidatorOptions } from 'class-validator';

/**
 * Codigos de fallo del nodo.
 *
 * Viven junto a la estrategia y no en `@core` por el motivo escrito en
 * `node-strategy.types.ts`: el motor no debe conocerlos, y centralizarlos
 * obligaria a tocar el nucleo cada vez que se anade un nodo.
 *
 * Se separan en siete y no se funden en uno porque cada uno manda al operador a
 * un sitio distinto: `RESIDUAL_VARS` al prompt, `DOM_MUTATED` a la plantilla o
 * al prompt, `UNSUPPORTED_TAGS` a los params del propio nodo, y `EMPTY_HTML` al
 * nodo de IA que va delante. Enrutar todos al mismo `onErrorStep` seria
 * perfectamente posible con la forma de cadena, pero fundirlos aqui impediria
 * para siempre distinguirlos.
 */
export const ERR_POST_IA_CONFIG = 'ERR_POST_IA_CONFIG';
export const ERR_POST_IA_MISSING_PAYLOAD = 'ERR_POST_IA_MISSING_PAYLOAD';
export const ERR_POST_IA_EMPTY_HTML = 'ERR_POST_IA_EMPTY_HTML';
export const ERR_POST_IA_RESIDUAL_VARS = 'ERR_POST_IA_RESIDUAL_VARS';
export const ERR_POST_IA_UNSUPPORTED_TAGS = 'ERR_POST_IA_UNSUPPORTED_TAGS';
export const ERR_POST_IA_EMPTY_AFTER_SANITIZE =
  'ERR_POST_IA_EMPTY_AFTER_SANITIZE';
export const ERR_POST_IA_DOM_MUTATED = 'ERR_POST_IA_DOM_MUTATED';

/**
 * Modo JSON: el objeto del modelo no trae ningun valor efectivo (todo vacio,
 * nulo o solo claves tecnicas). Codigo propio y no `EMPTY_HTML`: no faltaba
 * marcado, faltaban DATOS, y el arreglo esta en el prompt o en el material.
 */
export const ERR_POST_IA_EMPTY_JSON = 'ERR_POST_IA_EMPTY_JSON';

/**
 * Modo JSON: el objeto saneado no cumple el `jsonSchema` del nodo. Es el caso
 * del cierre de licitacion sin expediente: hay datos, pero no el que localiza
 * el bloque en la pagina, y publicarlos solo moveria el fallo al destino.
 */
export const ERR_POST_IA_SCHEMA_MISMATCH = 'ERR_POST_IA_SCHEMA_MISMATCH';

/** Clave del lote en la salida del nodo de IA (cardinalidad 1 a N). */
const RESPONSE_ITEMS_FIELD = 'items';

/** Campos de texto que acompanan al markup y se publican saneados. */
const HTML_COMPANION_FIELDS = ['headline', 'summary', 'source_url'] as const;

/**
 * Claves TECNICAS que publica el `PROCESADOR_IA` junto a los datos. El modo
 * JSON no las audita ni las republica: `metadata` (telemetria) siempre trae
 * valor, y contarla haria que ningun objeto pareciera vacio; `items` se audita
 * elemento a elemento, como en los otros modos.
 */
const JSON_TECHNICAL_KEYS: ReadonlySet<string> = new Set([
  'metadata',
  'resolved_cardinality',
  RESPONSE_ITEMS_FIELD,
]);

/**
 * Caracteres de control que no tienen sitio en un dato publicable. Se conservan
 * el tabulador y los saltos de linea (`\t`, `\n`, `\r`), que son formato.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Valor JSON tal y como lo serializa el escudo. */
type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** Un elemento del lote ya auditado, tal y como se publica. */
interface ValidatedItem {
  readonly validated_markup: string;
  readonly validated_fields: Record<string, string>;
  readonly character_count: number;
  /** El objeto saneado del elemento en modo JSON; `{}` en HTML y TEXT. */
  readonly validated_json: Record<string, JsonValue>;
}

/** Las mismas que aplica `PipelineValidatorService` al guardar el esquema. */
const VALIDATION_OPTIONS: ValidatorOptions = {
  whitelist: true,
  forbidNonWhitelisted: true,
};

/**
 * Estado con el que el nodo sella un markup aprobado.
 *
 * Es una constante y no un literal suelto porque viaja al namespace y un nodo de
 * aguas abajo puede interpolarlo (`{{validated_drupal_json.audit_status}}`).
 */
const AUDIT_STATUS_PASSED = 'PASSED';

/**
 * Resultado de resolver la configuracion: o hay config, o hay fallo que devolver.
 *
 * Union discriminada en vez de excepciones internas, como en
 * `web-scraper.strategy.ts`: mantiene el fallo dentro del contrato `NodeResult`,
 * que es el unico canal que el motor interpreta.
 */
type ConfigResolution =
  | { readonly config: ResolvedPostIaSanitizerConfig }
  | { readonly failure: NodeErrorDetail };

/**
 * Nodo ESCUDO_POST_IA: ultima barrera entre la inferencia y la publicacion.
 *
 * POR QUE EXISTE. Desde que el `MAPEADOR_PLANTILLA` paso de compilar a inyectar,
 * es la IA quien rellena la plantilla y su salida va directa al destino. Entre
 * las dos no habia nada: un `<script>` inyectado por prompt, un `{{nodo.campo}}`
 * que el modelo copio sin resolver o un titular que se llevo por delante al
 * reescribir el HTML llegaban a Drupal sin excepcion, sin PAUSADO y sin alerta.
 * Este nodo convierte los cuatro casos en un fallo GRAVE con `code` enrutable.
 *
 * LAS CUATRO COMPROBACIONES, en orden y con el porque del orden:
 *
 * 1. Vallas markdown. Se podan antes que nada: son envoltorio del proveedor y
 *    confundirian a las tres comprobaciones siguientes.
 * 2. Marcadores residuales. ANTES de sanear, no despues. Sanear primero podria
 *    descartar la etiqueta que contiene el marcador y hacer desaparecer la
 *    prueba del delito; el flujo se publicaria con un hueco en vez de pararse.
 * 3. Saneado XSS. Se DELEGA en `TemplateRendererService`, compartido con el
 *    gestor de plantillas. Con dos listas blancas, lo que el editor acepta al
 *    guardar y lo que el escudo deja publicar divergirian en cuanto alguien
 *    tocara una sola de las dos.
 * 4. Auditoria estructural, sobre el markup YA saneado. Un selector que apunte a
 *    una etiqueta que la lista blanca descarta tiene que contar como ausente: el
 *    lector no va a ver esa etiqueta, asi que la ranura no esta.
 *
 * NO escribe en el contexto: devuelve `data` y es `FsmEngineService` quien la
 * deposita en el `outputNamespace` declarado por el nodo. El contexto es de solo
 * lectura para una estrategia.
 *
 * SIN `Logger`, como el mapeador y el extractor web: el nodo no hace I/O, y el
 * motor ya emite el `warn` con nivel, codigo, ejecucion y nodo en cuanto recibe
 * un `success: false`. Un logger aqui solo duplicaria esa linea.
 */
@Injectable()
export class PostIaSanitizerStrategy implements INodeStrategy {
  public readonly nodeType = NodeType.ESCUDO_POST_IA;

  /** Validacion estricta de los `params` al guardar y al activar el flujo. */
  public readonly paramsSchema = PostIaSanitizerConfigDto;

  /**
   * Las siete claves que este nodo deposita en su namespace, en los tres modos.
   *
   * `validated_markup` y no `compiled_markup`: el nombre heredado del mapeador
   * ya miente alli (contiene markup sin compilar) y repetirlo aqui multiplicaria
   * el equivoco en un namespace distinto. Aqui el contenido SI esta validado,
   * que es justo lo que el nombre promete.
   */
  public readonly outputFields: readonly NodeOutputField[] = [
    {
      name: 'validated_markup',
      type: 'text',
      description:
        'HTML saneado contra XSS y auditado estructuralmente, listo para publicar',
    },
    {
      name: 'character_count',
      type: 'number',
      description: 'Longitud del markup aprobado, para auditar truncamientos',
    },
    {
      name: 'audit_status',
      type: 'text',
      description: `Sello de la auditoria; "${AUDIT_STATUS_PASSED}" en el unico camino que publica`,
    },
    {
      name: 'sanitized_at',
      type: 'text',
      description: 'Marca ISO del instante en que se aprobo el markup',
    },
    {
      name: 'validated_fields',
      type: 'object',
      description:
        'Campos en texto plano sin etiquetas (p. ej. validated_fields.headline): los auditados en modo TEXT, o titular, resumen y source_url en modo HTML',
    },
    {
      name: 'validated_items',
      type: 'object',
      description:
        'Elementos del lote del segundo en adelante, ya auditados: [{ validated_markup, validated_fields, character_count, validated_json }]. Vacio con un solo elemento',
    },
    {
      name: 'validated_json',
      type: 'object',
      description:
        'Modo JSON: el objeto estructurado del modelo, saneado en profundidad y validado contra el jsonSchema del nodo ({} en HTML y TEXT)',
    },
  ];

  constructor(
    private readonly templateRendererService: TemplateRendererService,
  ) {}

  /**
   * Namespace sin el cual este nodo no puede operar.
   *
   * Se deduce de la CONFIGURACION y no del tipo, como exige el contrato: el nodo
   * lee de donde su esquema le diga. Es lo que permite que la regla 7 del
   * validador de topologia rechace AL GUARDAR un escudo colocado delante del
   * nodo que deberia alimentarlo, en vez de descubrirlo en ejecucion.
   *
   * Puro y sincrono: solo mira `params`.
   */
  public getRequiredNamespaces(
    params: Record<string, unknown>,
  ): readonly string[] {
    // Sin aserción de tipo: los campos del DTO son todos opcionales, asi que un
    // `Record<string, unknown>` ya satisface su forma y el cast seria ruido.
    return [resolvePostIaSanitizerConfig(params).sourceNamespace];
  }

  public async execute(
    context: StatePayloadContext,
    params: Record<string, unknown>,
  ): Promise<NodeResult> {
    // 1. Configuracion. Un nodo mal declarado es un fallo de configuracion
    //    corregible, y por tanto GRAVE y no URGENTE.
    const resolution = await this.resolveConfig(params);

    if ('failure' in resolution) {
      return { success: false, error: resolution.failure };
    }

    const { sourceNamespace, sourceField, allowedTags, requiredSelectors } =
      resolution.config;

    // 2. El nodo de aguas arriba tiene que haber corrido. Comparacion explicita
    //    con `undefined` porque `getNamespace` devuelve un `structuredClone`.
    const sourcePayload = context.getNamespace(sourceNamespace);

    if (sourcePayload === undefined) {
      return {
        success: false,
        error: {
          level: 'GRAVE',
          code: ERR_POST_IA_MISSING_PAYLOAD,
          message: `El escudo lee del namespace "${sourceNamespace}" y ningun nodo anterior lo ha escrito. Revisa el orden de los pasos: este nodo va DESPUES del que produce el markup.`,
          missingFields: [sourceNamespace],
        },
      };
    }

    // 2bis. Tres modos. TEXT y JSON no necesitan ningun MAPEADOR_PLANTILLA por
    //       delante: TEXT audita cadenas sueltas y JSON el objeto entero.
    const { contentMode, sourceFields, jsonSchema } = resolution.config;

    // El esquema se compila UNA vez por ejecucion, no por elemento del lote. El
    // DTO ya lo rechazo al guardar si no compilaba; esto cubre un esquema
    // escrito directamente en la base.
    const schemaCompilation =
      contentMode === PostIaContentMode.JSON && jsonSchema !== null
        ? compileJsonSchema(jsonSchema)
        : null;

    if (schemaCompilation !== null && 'error' in schemaCompilation) {
      return {
        success: false,
        error: {
          level: 'GRAVE',
          code: ERR_POST_IA_CONFIG,
          message: `Configuracion invalida del nodo escudo posterior a IA: jsonSchema no es un JSON Schema valido (${schemaCompilation.error}).`,
          missingFields: ['jsonSchema'],
        },
      };
    }

    const audit = (
      record: Record<string, unknown>,
      label: string,
    ): NodeResult => {
      switch (contentMode) {
        case PostIaContentMode.TEXT:
          return this.auditTextFields(record, label, sourceFields);
        case PostIaContentMode.JSON:
          return this.auditJson(
            record,
            label,
            schemaCompilation === null ? null : schemaCompilation.validate,
          );
        default:
          return this.auditHtml(record, label, {
            sourceField,
            allowedTags,
            requiredSelectors,
          });
      }
    };

    // 3. La raiz: el primer (o unico) elemento, exactamente como hasta ahora.
    const rootResult = audit(sourcePayload, sourceNamespace);

    if (!rootResult.success) {
      return rootResult;
    }

    // 4. Lote (cardinalidad 1 a N): cada elemento de `items` pasa por las
    //    MISMAS comprobaciones que la raiz. Es lo que permite a los destinos
    //    recorrer `validated_items` sin volver a sanear: un elemento que no
    //    supera la auditoria detiene el nodo entero, con su ruta exacta
    //    (`llm_response.items[2].filled_markup`), en vez de publicarse a medias.
    const items = normalizeItems<Record<string, unknown>>(
      sourcePayload[RESPONSE_ITEMS_FIELD],
    ).filter(
      (item): item is Record<string, unknown> =>
        typeof item === 'object' && !Array.isArray(item),
    );
    const validatedItems: ValidatedItem[] = [];

    for (const [index, item] of items.entries()) {
      const itemResult = audit(
        item,
        `${sourceNamespace}.${RESPONSE_ITEMS_FIELD}[${index}]`,
      );

      if (!itemResult.success) {
        return itemResult;
      }

      validatedItems.push({
        validated_markup:
          typeof itemResult.data?.validated_markup === 'string'
            ? itemResult.data.validated_markup
            : '',
        validated_fields: (itemResult.data?.validated_fields ?? {}) as Record<
          string,
          string
        >,
        character_count: Number(itemResult.data?.character_count ?? 0),
        validated_json: isPlainObject(itemResult.data?.validated_json)
          ? (itemResult.data.validated_json as Record<string, JsonValue>)
          : {},
      });
    }

    return {
      success: true,
      data: { ...rootResult.data, validated_items: validatedItems },
    };
  }

  /**
   * Modo HTML sobre un registro: el de la raiz o el de un elemento del lote.
   *
   * `label` es la ruta que se cita en los mensajes y en `missingFields`
   * (`llm_response` o `llm_response.items[1]`), de modo que el operador sepa
   * QUE elemento fallo sin tener que contarlos.
   */
  private auditHtml(
    sourcePayload: Record<string, unknown>,
    sourceNamespace: string,
    {
      sourceField,
      allowedTags,
      requiredSelectors,
    }: {
      readonly sourceField: string;
      readonly allowedTags: readonly string[];
      readonly requiredSelectors: readonly string[];
    },
  ): NodeResult {
    // 3. El campo concreto. El fallo es exacto a proposito —nombra la ruta
    //    completa— para que el operador no tenga que adivinar que le falta.
    const rawMarkup = sourcePayload[sourceField];

    if (typeof rawMarkup !== 'string' || rawMarkup.trim().length === 0) {
      // `filled_markup` nulo en `llm_response` es el sintoma exacto de un
      // prompt SIN plantilla: el nodo es valido, solo esta en el modo errado.
      const hint =
        sourceNamespace === DEFAULT_POST_IA_SOURCE_NAMESPACE
          ? ' Si el flujo no usa plantilla HTML, configura el escudo con contentMode "TEXT".'
          : '';

      return {
        success: false,
        error: {
          level: 'GRAVE',
          code: ERR_POST_IA_EMPTY_HTML,
          message: `El campo "${sourceNamespace}.${sourceField}" no contiene markup: ${this.describeValue(rawMarkup)}. El escudo no puede auditar lo que no existe.${hint}`,
          missingFields: [`${sourceNamespace}.${sourceField}`],
        },
      };
    }

    const markup = stripCodeFence(rawMarkup);

    // 4. Interpolaciones que el modelo dejo sin resolver. Va ANTES del saneado:
    //    ver el TSDoc de la clase.
    const residualMarkers = this.findResidualMarkers(markup);

    if (residualMarkers.length > 0) {
      return {
        success: false,
        error: {
          level: 'GRAVE',
          code: ERR_POST_IA_RESIDUAL_VARS,
          message: `El modelo devolvio ${residualMarkers.length} marcador(es) sin resolver: ${residualMarkers.join(', ')}. Publicarlos imprimiria las llaves literales en el articulo.`,
          missingFields: residualMarkers,
        },
      };
    }

    // 5. Saneado con la lista blanca compartida, recortada por `allowedTags`.
    const { sanitized, unsupportedTags } =
      this.templateRendererService.prepareInjectableMarkup(markup, allowedTags);

    if (unsupportedTags.length > 0) {
      // Fallo de CONFIGURACION del nodo, no del markup: el operador pidio
      // permitir algo que la lista blanca global no admite. Concederlo seria
      // abrir una via de XSS por parametro.
      return {
        success: false,
        error: {
          level: 'GRAVE',
          code: ERR_POST_IA_UNSUPPORTED_TAGS,
          message: `El parametro "allowedTags" solo puede RESTRINGIR la lista blanca del saneador, y pide etiquetas que no figuran en ella: ${unsupportedTags.join(', ')}.`,
          missingFields: unsupportedTags,
        },
      };
    }

    const validatedMarkup = sanitized.trim();

    if (validatedMarkup.length === 0) {
      // El modelo devolvio algo, pero nada de lo que devolvio es publicable. Se
      // distingue de `EMPTY_HTML` a proposito: aquel dice "no llego markup" y
      // este "llego markup entero de etiquetas prohibidas", que es el sintoma de
      // una inyeccion de prompt o de un modelo que ignoro el formato pedido.
      return {
        success: false,
        error: {
          level: 'GRAVE',
          code: ERR_POST_IA_EMPTY_AFTER_SANITIZE,
          message: `El markup de "${sourceNamespace}.${sourceField}" quedo vacio tras el saneado: todo su contenido estaba fuera de la lista blanca publicable.`,
          missingFields: [`${sourceNamespace}.${sourceField}`],
        },
      };
    }

    // 6. Contrato estructural, sobre el markup YA saneado.
    const { missing, invalid, empty } =
      this.templateRendererService.auditFilledSlots(
        validatedMarkup,
        requiredSelectors,
      );

    if (missing.length > 0 || invalid.length > 0 || empty.length > 0) {
      return {
        success: false,
        error: {
          level: 'GRAVE',
          code: ERR_POST_IA_DOM_MUTATED,
          message: this.buildMutationMessage(missing, invalid, empty),
          missingFields: [...missing, ...invalid, ...empty],
        },
      };
    }

    return {
      success: true,
      data: {
        validated_markup: validatedMarkup,
        character_count: validatedMarkup.length,
        audit_status: AUDIT_STATUS_PASSED,
        sanitized_at: new Date().toISOString(),
        // Los campos de texto que acompanan al markup, saneados: con ellos un
        // destino puede titular cada elemento del lote sin leer el texto en
        // bruto del modelo.
        validated_fields: this.plainCompanionFields(sourcePayload),
        // Neutro: la forma del payload es la misma en los tres modos.
        validated_json: {},
      },
    };
  }

  /**
   * Modo TEXT: audita cada campo de texto del modelo.
   *
   * Mismo orden que el modo HTML y por el mismo motivo: los marcadores
   * residuales se buscan ANTES de sanear. El saneado aqui no tiene lista
   * blanca: TODA etiqueta sobra en un titular o un resumen, y un `<script>`
   * se descarta con su contenido (`nonTextTags` de sanitize-html). Las
   * entidades se decodifican despues, porque el destino escapa por su cuenta
   * y un `&amp;` llegaria impreso.
   *
   * `validated_markup` sale vacio: la forma del payload es la misma en los dos
   * modos, y el asistente nunca ofrece una variable que no exista.
   */
  private auditTextFields(
    sourcePayload: Record<string, unknown>,
    sourceNamespace: string,
    sourceFields: readonly string[],
  ): NodeResult {
    const missing = sourceFields.filter((field) => {
      const value = sourcePayload[field];

      return typeof value !== 'string' || value.trim().length === 0;
    });

    if (missing.length > 0) {
      return {
        success: false,
        error: {
          level: 'GRAVE',
          code: ERR_POST_IA_EMPTY_HTML,
          message: `El escudo (modo TEXT) no encuentra texto en: ${missing.map((field) => `${sourceNamespace}.${field}`).join(', ')}.`,
          missingFields: missing.map((field) => `${sourceNamespace}.${field}`),
        },
      };
    }

    const texts = sourceFields.map((field) => [
      field,
      stripCodeFence(String(sourcePayload[field])),
    ]);
    const residualMarkers = [
      ...new Set(texts.flatMap(([, text]) => this.findResidualMarkers(text))),
    ];

    if (residualMarkers.length > 0) {
      return {
        success: false,
        error: {
          level: 'GRAVE',
          code: ERR_POST_IA_RESIDUAL_VARS,
          message: `El modelo devolvio ${residualMarkers.length} marcador(es) sin resolver: ${residualMarkers.join(', ')}. Publicarlos imprimiria las llaves literales.`,
          missingFields: residualMarkers,
        },
      };
    }

    const validatedFields = Object.fromEntries(
      texts.map(([field, text]) => [field, this.toPlainText(text)]),
    );
    const emptied = sourceFields.filter(
      (field) => validatedFields[field]?.length === 0,
    );

    if (emptied.length > 0) {
      return {
        success: false,
        error: {
          level: 'GRAVE',
          code: ERR_POST_IA_EMPTY_AFTER_SANITIZE,
          message: `Quedaron vacios tras el saneado (todo su contenido eran etiquetas): ${emptied.map((field) => `${sourceNamespace}.${field}`).join(', ')}.`,
          missingFields: emptied.map((field) => `${sourceNamespace}.${field}`),
        },
      };
    }

    return {
      success: true,
      data: {
        validated_markup: '',
        character_count: Object.values(validatedFields).reduce(
          (total, text) => total + text.length,
          0,
        ),
        audit_status: AUDIT_STATUS_PASSED,
        sanitized_at: new Date().toISOString(),
        validated_fields: validatedFields,
        // Neutro: la forma del payload es la misma en los tres modos.
        validated_json: {},
      },
    };
  }

  /**
   * Modo JSON: valida, sanea y serializa el objeto estructurado del modelo.
   *
   * Mismo orden que los otros modos y por el mismo motivo: los marcadores
   * residuales se buscan ANTES de sanear. Despues:
   *
   * 1. Valor efectivo: al menos una cadena con texto, un numero, un booleano o
   *    una coleccion que contenga algo de eso. `null`, `''`, `[]` y `{}` no
   *    cuentan, y las claves tecnicas (`metadata`...) no se miran.
   * 2. Saneado en profundidad de cada cadena —sin ninguna etiqueta, entidades
   *    decodificadas y sin caracteres de control—, construyendo un objeto NUEVO.
   *    Claves, numeros, booleanos, `null` y la forma de los arreglos se
   *    conservan. El contexto no se toca: `getNamespace` entrega un clon y de el
   *    solo se lee.
   * 3. `jsonSchema` sobre el objeto YA saneado: lo que el esquema garantiza es
   *    lo que se publica, no lo que el modelo escribio antes de quitarle las
   *    etiquetas.
   *
   * `validated_fields` lleva las cadenas de primer nivel saneadas, para que los
   * destinos que ya leen `validated_fields.headline` funcionen igual.
   */
  private auditJson(
    sourcePayload: Record<string, unknown>,
    sourceNamespace: string,
    validateSchema: ValidateFunction | null,
  ): NodeResult {
    const content = Object.fromEntries(
      Object.entries(sourcePayload).filter(
        ([key]) => !JSON_TECHNICAL_KEYS.has(key),
      ),
    );

    if (!this.hasEffectiveValue(content)) {
      return {
        success: false,
        error: {
          level: 'GRAVE',
          code: ERR_POST_IA_EMPTY_JSON,
          message: `El escudo (modo JSON) no encuentra ningun dato en "${sourceNamespace}": el objeto esta vacio o todos sus campos son nulos o estan en blanco.`,
          missingFields: [sourceNamespace],
        },
      };
    }

    const residualMarkers = [
      ...new Set(
        this.collectStrings(content).flatMap((text) =>
          this.findResidualMarkers(text),
        ),
      ),
    ];

    if (residualMarkers.length > 0) {
      return {
        success: false,
        error: {
          level: 'GRAVE',
          code: ERR_POST_IA_RESIDUAL_VARS,
          message: `El modelo devolvio ${residualMarkers.length} marcador(es) sin resolver: ${residualMarkers.join(', ')}. Publicarlos imprimiria las llaves literales.`,
          missingFields: residualMarkers,
        },
      };
    }

    const sanitized = this.sanitizeJsonObject(content);

    if (!this.hasEffectiveValue(sanitized)) {
      return {
        success: false,
        error: {
          level: 'GRAVE',
          code: ERR_POST_IA_EMPTY_AFTER_SANITIZE,
          message: `El objeto de "${sourceNamespace}" quedo sin ningun dato tras el saneado: todo su texto eran etiquetas.`,
          missingFields: [sourceNamespace],
        },
      };
    }

    if (validateSchema !== null && !validateSchema(sanitized)) {
      const { paths, messages } = describeSchemaErrors(
        validateSchema.errors ?? [],
        sourceNamespace,
      );

      return {
        success: false,
        error: {
          level: 'GRAVE',
          code: ERR_POST_IA_SCHEMA_MISMATCH,
          message: `El objeto saneado no cumple el jsonSchema del escudo: ${messages.join('; ')}.`,
          missingFields: paths,
        },
      };
    }

    const validatedFields = Object.fromEntries(
      Object.entries(sanitized).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === 'string' && entry[1].length > 0,
      ),
    );

    return {
      success: true,
      data: {
        validated_markup: '',
        character_count: JSON.stringify(sanitized).length,
        audit_status: AUDIT_STATUS_PASSED,
        sanitized_at: new Date().toISOString(),
        validated_fields: validatedFields,
        validated_json: sanitized,
      },
    };
  }

  /** Si un valor (a cualquier profundidad) trae algun dato publicable. */
  private hasEffectiveValue(value: unknown): boolean {
    if (typeof value === 'string') return value.trim().length > 0;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value === 'boolean') return true;
    if (Array.isArray(value)) {
      return value.some((entry) => this.hasEffectiveValue(entry));
    }
    if (isPlainObject(value)) {
      return Object.values(value).some((entry) =>
        this.hasEffectiveValue(entry),
      );
    }

    return false;
  }

  /** Todas las cadenas de un valor, a cualquier profundidad. */
  private collectStrings(value: unknown): string[] {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) {
      return value.flatMap((entry) => this.collectStrings(entry));
    }
    if (isPlainObject(value)) {
      return Object.values(value).flatMap((entry) =>
        this.collectStrings(entry),
      );
    }

    return [];
  }

  /** Copia saneada de un objeto: ver `sanitizeJsonValue`. */
  private sanitizeJsonObject(
    record: Record<string, unknown>,
  ): Record<string, JsonValue> {
    return Object.fromEntries(
      Object.entries(record).flatMap(([key, value]) => {
        const sanitized = this.sanitizeJsonValue(value);

        return sanitized === undefined ? [] : [[key, sanitized]];
      }),
    );
  }

  /**
   * Copia saneada de un valor JSON.
   *
   * Las cadenas pierden toda etiqueta, decodifican entidades y pierden los
   * caracteres de control; numeros, booleanos y `null` pasan tal cual. Lo que
   * no es JSON (`undefined`, funciones, `NaN`) se descarta: no sobreviviria a
   * la persistencia del namespace en `jsonb`, y es mejor que falte aqui, a la
   * vista, que en la base.
   */
  private sanitizeJsonValue(value: unknown): JsonValue | undefined {
    if (typeof value === 'string') {
      return this.toPlainText(stripCodeFence(value)).replace(
        CONTROL_CHARACTERS,
        '',
      );
    }
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : undefined;
    }
    if (typeof value === 'boolean' || value === null) return value;
    if (Array.isArray(value)) {
      return value.flatMap((entry) => {
        const sanitized = this.sanitizeJsonValue(entry);

        return sanitized === undefined ? [] : [sanitized];
      });
    }
    if (isPlainObject(value)) return this.sanitizeJsonObject(value);

    return undefined;
  }

  /**
   * `headline`, `summary` y `source_url` en texto plano, los que vengan.
   *
   * Solo en modo HTML, donde antes `validated_fields` iba vacio. Un campo
   * ausente o que queda vacio tras el saneado simplemente no aparece: el markup
   * es lo que se audita aqui, y estos campos son su acompanamiento.
   */
  private plainCompanionFields(
    record: Record<string, unknown>,
  ): Record<string, string> {
    return Object.fromEntries(
      HTML_COMPANION_FIELDS.flatMap((field) => {
        const value = record[field];

        if (typeof value !== 'string') {
          return [];
        }

        const plain = this.toPlainText(stripCodeFence(value));

        return plain.length > 0 ? [[field, plain]] : [];
      }),
    );
  }

  /** Texto sin ninguna etiqueta y con las entidades ya decodificadas. */
  private toPlainText(text: string): string {
    const stripped = sanitizeHtml(text, {
      allowedTags: [],
      allowedAttributes: {},
    });

    return cheerio
      .load(stripped, null, false)
      .text()
      .replace(/[ \t]+/g, ' ')
      .trim();
  }

  /**
   * Valida `params` y aplica los valores por defecto.
   *
   * Se usa `validate` y NO `validateOrReject`: esta ultima lanza, y el motor
   * normaliza toda excepcion a URGENTE, que `canRetry` nunca reintenta.
   */
  private async resolveConfig(
    params: Record<string, unknown>,
  ): Promise<ConfigResolution> {
    const dto = plainToInstance(PostIaSanitizerConfigDto, params);
    const errors = await validate(dto, VALIDATION_OPTIONS);

    if (errors.length > 0) {
      const constraints = errors.flatMap((error) =>
        Object.values(error.constraints ?? {}),
      );

      return {
        failure: {
          level: 'GRAVE',
          code: ERR_POST_IA_CONFIG,
          message: `Configuracion invalida del nodo escudo posterior a IA: ${constraints.join(' ')}`,
          missingFields: errors.map((error) => error.property),
        },
      };
    }

    return { config: resolvePostIaSanitizerConfig(dto) };
  }

  /**
   * Marcadores de interpolacion que sobreviven en el markup, sin repetidos.
   *
   * La gramatica se toma de `RESIDUAL_MARKER_PATTERN`, la misma que aplica el
   * gestor de plantillas al guardar, para que lo que alli se rechaza no se
   * cuele aqui. Se construye una instancia propia con bandera global en vez de
   * exportarla ya global: un `RegExp` con `g` conserva `lastIndex` entre
   * llamadas, y compartirlo haria que la segunda ejecucion del nodo se saltara
   * coincidencias.
   *
   * De-duplicado porque veinte repeticiones del mismo marcador son un solo
   * problema que resolver, y listarlas todas enterraria el resto del mensaje.
   */
  private findResidualMarkers(markup: string): string[] {
    const pattern = new RegExp(RESIDUAL_MARKER_PATTERN.source, 'g');

    return [...new Set(markup.match(pattern) ?? [])];
  }

  /** Mensaje que separa las tres familias de mutilacion estructural. */
  private buildMutationMessage(
    missing: readonly string[],
    invalid: readonly string[],
    empty: readonly string[],
  ): string {
    const parts: string[] = [];

    if (missing.length > 0) {
      parts.push(`elimino ${missing.join(', ')}`);
    }

    if (empty.length > 0) {
      parts.push(`dejo sin rellenar ${empty.join(', ')}`);
    }

    if (invalid.length > 0) {
      parts.push(`no son selectores validos: ${invalid.join(', ')}`);
    }

    return `El marcado HTML devuelto por la IA no contiene la estructura o elementos inyectables requeridos: ${parts.join('; ')}.`;
  }

  /**
   * Describe un valor inesperado sin volcarlo entero en el mensaje.
   *
   * El payload de un modelo puede traer miles de caracteres, y un mensaje de
   * error que los incluya acaba en la columna de la alerta y en el `.log` sin
   * aportar nada: lo que el operador necesita saber es de que TIPO es lo que
   * llego, no su contenido.
   */
  private describeValue(value: unknown): string {
    if (value === undefined) return 'la clave no existe';
    if (value === null) return 'es nulo';
    if (typeof value === 'string') return 'es una cadena vacia';

    return `es de tipo ${typeof value}`;
  }
}
