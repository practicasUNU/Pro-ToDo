import { Injectable } from '@nestjs/common';

import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { TemplateRendererService } from '@modules/templates/services/template-renderer.service';
import { TemplatesService } from '@modules/templates/templates.service';

import {
  TemplateMapperConfigDto,
  resolveTemplateMapperConfig,
} from '../dto/template-mapper-config.dto';

import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import type {
  INodeStrategy,
  NodeErrorDetail,
  NodeOutputField,
  NodeResult,
} from '@core/fsm/types/node-strategy.types';

/**
 * Codigos de fallo del nodo. Son lo que un `catchErrors` puede mencionar, y se
 * separan porque enrutar "la plantilla trae marcadores" a un nodo de aviso es
 * util mientras que enrutar "la plantilla no existe" al mismo sitio casi nunca
 * lo es.
 */
export const ERR_TEMPLATE_NOT_RESOLVED = 'ERR_TEMPLATE_NOT_RESOLVED';
export const ERR_TEMPLATE_PENDING_VARS = 'ERR_TEMPLATE_PENDING_VARS';
export const ERR_TEMPLATE_STRUCTURE = 'ERR_TEMPLATE_STRUCTURE';
export const ERR_TEMPLATE_UNSUPPORTED_TAGS = 'ERR_TEMPLATE_UNSUPPORTED_TAGS';

/**
 * Codigos de la etapa en que este nodo COMPILABA la plantilla.
 *
 * Se conservan exportados —y declarados en `getUnreachableErrorCodes`— en vez de
 * borrarse: son contrato publico y un flujo guardado puede tener una ruta
 * `onErrorStep` que los cite. Borrarlos convertiria ese esquema en un fallo de
 * importacion opaco; declararlos inalcanzables hace que la regla 10 del
 * validador de topologia los rechace al guardar, nombrando el codigo muerto.
 *
 * @deprecated El nodo ya no compila: ningun camino de `execute` los emite.
 */
export const ERR_TEMPLATE_MISSING_VARS = 'ERR_TEMPLATE_MISSING_VARS';
/** @deprecated Ver {@link ERR_TEMPLATE_MISSING_VARS}. */
export const ERR_TEMPLATE_RENDER = 'ERR_TEMPLATE_RENDER';

/** Plantilla lista para inyectar, venga de la base de datos o de `rawTemplate`. */
interface ResolvedTemplate {
  readonly htmlContent: string;
  /** Nombre legible, para que el diagnostico no sea solo un UUID. */
  readonly name: string;
  /** Rutas que la plantilla interpola; vacio en el modo `rawTemplate`. */
  readonly requiredVariables: readonly string[];
}

/**
 * Resultado de resolver la plantilla: o se obtuvo, o hay un fallo que devolver.
 *
 * Union discriminada en vez de excepciones internas: mantiene el fallo dentro
 * del contrato `NodeResult`, que es el unico canal que el motor interpreta.
 */
type TemplateResolution =
  | { readonly template: ResolvedTemplate }
  | { readonly failure: NodeErrorDetail };

/**
 * Nodo MAPEADOR_PLANTILLA: entrega la plantilla base del gestor, ya saneada,
 * para que un `PROCESADOR_IA` posterior la rellene.
 *
 * CAMBIO DE RESPONSABILIDAD. Hasta ahora este nodo COMPILABA la plantilla con
 * Handlebars contra el contexto acumulado y era el ultimo paso del flujo. Ahora
 * es la IA quien estructura e inyecta el contenido, de modo que el mapeador pasa
 * a ir DELANTE de la inferencia y su trabajo es otro: resolver la plantilla,
 * sanearla y verificar que conserva la estructura minima que el flujo da por
 * hecha. No sustituye ninguna variable.
 *
 * De ahi la guarda de `ERR_TEMPLATE_PENDING_VARS`. Una plantilla heredada llena
 * de `{{parsed_email.clean_title}}` seguiria resolviendose aqui sin que nadie
 * interpole nada, y esas llaves viajarian literales hasta el articulo publicado:
 * sin excepcion, sin PAUSADO y sin alerta. El nodo prefiere romper en voz alta y
 * de forma corregible antes que publicar markup corrupto en silencio.
 *
 * El saneado y la comprobacion estructural se DELEGAN en
 * `TemplateRendererService`, compartido con el gestor de plantillas: con dos
 * listas blancas, lo que el editor acepta al guardar y lo que el nodo publica al
 * ejecutar divergirian en cuanto alguien tocara una sola.
 *
 * NO escribe en el contexto: devuelve `data` y es `FsmEngineService` quien la
 * deposita en el `outputNamespace` declarado por el nodo. Escribir tambien desde
 * aqui duplicaria el payload en dos namespaces y contradiria el contrato de
 * `INodeStrategy`, donde el contexto es de solo lectura para la estrategia.
 */
/*
 * NOTA: este nodo NO implementa `getRequiredNamespaces`, y ahora menos que nunca.
 *
 * Antes la ausencia se justificaba porque el pre-chequeo de `renderStrict` daba
 * un diagnostico mejor. Hoy el motivo es mas simple y mas fuerte: el nodo NO LEE
 * EL CONTEXTO en absoluto. No depende de ningun namespace anterior, asi que no
 * hay nada que declarar. Su unica dependencia es la fila de `plantillas_html`
 * que tenga elegida, y esa no es una dependencia de topologia.
 */
@Injectable()
export class TemplateMapperStrategy implements INodeStrategy {
  public readonly nodeType = NodeType.MAPEADOR_PLANTILLA;

  /**
   * Las dos claves que este nodo deposita en su namespace.
   *
   * `compiled_markup` CONSERVA SU NOMBRE pese a contener ahora markup sin
   * compilar. Es una concesion deliberada a la compatibilidad: renombrarlo
   * dejaria sin dato a todo consumidor de `rendered_html.compiled_markup`,
   * incluido el `DESTINO_HTTP` de cualquier flujo ya guardado. El precio es que
   * el nombre ya no describe el contenido, y por eso la `description` —que es lo
   * que leen `GET /api/nodos` y el selector de variables del asistente— lo dice
   * de forma explicita: quien audite una ejecucion lee la descripcion, no el
   * identificador.
   */
  /**
   * Validacion estricta de los `params` al guardar y al activar.
   *
   * Lo aplica `PipelineValidatorService.validateNodeParams` con
   * `whitelist: true, forbidNonWhitelisted: true`, de modo que una clave que el
   * DTO no declare deja de colarse en silencio y sale como
   * `nodes.<nodeId>.params.<clave>` — la ruta con la que el asistente senala el
   * control concreto. `assertActivatable` revalida el esquema entero, asi que la
   * comprobacion ocurre tambien antes de habilitar el flujo.
   *
   * Se conecta AHORA y no con el resto del cambio de semantica porque antes
   * hacia falta auditar `configuracion_pipeline`: con `forbidNonWhitelisted`,
   * cualquier `params` historico con una clave de mas pasaba a ser un 400 sobre
   * un flujo que hasta entonces se guardaba. La auditoria encontro
   * `outputNamespace`, y por eso el DTO lo declara como tolerado.
   */
  public readonly paramsSchema = TemplateMapperConfigDto;

  public readonly outputFields: readonly NodeOutputField[] = [
    {
      name: 'compiled_markup',
      type: 'text',
      description:
        'Plantilla base ya saneada y SIN interpolar, lista para que un PROCESADOR_IA la rellene',
    },
    {
      name: 'mapped_at',
      type: 'text',
      description: 'Marca ISO del instante en que se resolvio la plantilla',
    },
  ];

  constructor(
    private readonly templatesService: TemplatesService,
    private readonly templateRendererService: TemplateRendererService,
  ) {}

  public async execute(
    _context: StatePayloadContext,
    params: Record<string, unknown>,
  ): Promise<NodeResult> {
    const config = resolveTemplateMapperConfig(
      params as TemplateMapperConfigDto,
    );

    // 1. Resolver la plantilla (base de datos o fallback de pruebas).
    const resolution = await this.resolveTemplate(config);

    if ('failure' in resolution) {
      return { success: false, error: resolution.failure };
    }

    const { htmlContent, name, requiredVariables } = resolution.template;

    // 2. Guarda anti-corrupcion. Va la PRIMERA de las tres porque es la unica
    //    que protege de un fallo silencioso: las otras dos solo evitan publicar
    //    una plantilla mal recortada, esta evita publicar llaves literales.
    if (requiredVariables.length > 0) {
      return {
        success: false,
        error: {
          level: 'GRAVE',
          code: ERR_TEMPLATE_PENDING_VARS,
          message: `Este nodo ya no interpola variables y la plantilla "${name}" declara ${requiredVariables.length}. Retira los marcadores de la plantilla para que el PROCESADOR_IA rellene los huecos.`,
          missingFields: [...requiredVariables],
        },
      };
    }

    // 3. Sanear con la lista blanca compartida, recortada por `allowedTags`.
    const { sanitized, unsupportedTags } =
      this.templateRendererService.prepareInjectableMarkup(
        htmlContent,
        config.allowedTags,
      );

    if (unsupportedTags.length > 0) {
      // Fallo de CONFIGURACION del nodo, no de la plantilla: el operador pidio
      // permitir algo que la lista blanca global no admite. Concederlo seria
      // abrir una via de XSS por parametro.
      return {
        success: false,
        error: {
          level: 'GRAVE',
          code: ERR_TEMPLATE_UNSUPPORTED_TAGS,
          message: `El parametro "allowedTags" solo puede RESTRINGIR la lista blanca del saneador, y pide etiquetas que no figuran en ella: ${unsupportedTags.join(', ')}.`,
          missingFields: unsupportedTags,
        },
      };
    }

    // 4. Contrato estructural, sobre el markup YA saneado. Si el saneador se
    //    llevo por delante la ranura que el selector busca, el fallo tiene que
    //    verse ahora y no cuando la IA devuelva un hueco sin rellenar.
    const { missing, invalid } = this.templateRendererService.auditStructure(
      sanitized,
      config.requiredSelectors,
    );

    if (missing.length > 0 || invalid.length > 0) {
      return {
        success: false,
        error: {
          level: 'GRAVE',
          code: ERR_TEMPLATE_STRUCTURE,
          message: this.buildStructureMessage(name, missing, invalid),
          missingFields: [...missing, ...invalid],
        },
      };
    }

    return {
      success: true,
      data: {
        compiled_markup: sanitized,
        mapped_at: new Date().toISOString(),
      },
    };
  }

  /**
   * Parametros sin los que el nodo no puede ejecutarse.
   *
   * Lo consulta `assertActivatable` para impedir ACTIVAR un flujo incompleto,
   * mientras que guardarlo sigue permitido: una plantilla de flujo declara
   * topologia, no operativa. Sin esto, la ausencia de plantilla solo se
   * descubria en ejecucion, con el flujo ya PAUSADO.
   */
  public getIncompleteParams(params: Record<string, unknown>): readonly string[] {
    const { templateId, rawTemplate } = resolveTemplateMapperConfig(
      params as TemplateMapperConfigDto,
    );

    return templateId === '' && rawTemplate === null ? ['templateId'] : [];
  }

  /**
   * Codigos que este nodo NO puede emitir (regla 10 del validador de topologia).
   *
   * Son los de la etapa en que compilaba. Declararlos hace que una ruta
   * `onErrorStep` que los capture se rechace AL GUARDAR, nombrando el codigo,
   * en vez de quedarse como un respaldo que jamas se ejecutaria.
   */
  public getUnreachableErrorCodes(
    _params: Record<string, unknown>,
  ): readonly string[] {
    return [ERR_TEMPLATE_MISSING_VARS, ERR_TEMPLATE_RENDER];
  }

  /** Mensaje que separa el selector ausente del que ni siquiera es valido. */
  private buildStructureMessage(
    templateName: string,
    missing: readonly string[],
    invalid: readonly string[],
  ): string {
    const parts: string[] = [];

    if (missing.length > 0) {
      parts.push(`no contiene ${missing.join(', ')}`);
    }

    if (invalid.length > 0) {
      parts.push(`no son selectores validos: ${invalid.join(', ')}`);
    }

    return `La estructura de la plantilla "${templateName}" incumple el contrato del nodo: ${parts.join('; ')}.`;
  }

  /**
   * Obtiene el HTML a inyectar a partir de la configuracion del nodo.
   *
   * Prioriza `templateId` (el modo de produccion) y admite `rawTemplate` como
   * fallback para probar la estrategia sin base de datos. El markup de
   * `rawTemplate` no ha pasado por la lista blanca que `TemplatesService` aplica
   * al guardar, pero eso no lo deja sin sanear: `prepareInjectableMarkup` corre
   * igual sobre los dos origenes.
   */
  private async resolveTemplate(
    config: ReturnType<typeof resolveTemplateMapperConfig>,
  ): Promise<TemplateResolution> {
    const { templateId, rawTemplate } = config;

    if (templateId !== '') {
      return this.resolveStoredTemplate(templateId.trim());
    }

    if (rawTemplate !== null) {
      return {
        template: {
          htmlContent: rawTemplate,
          name: 'rawTemplate',
          // Sin fila en base de datos no hay columna `variables_esperadas` que
          // consultar, asi que no se puede afirmar que la plantilla interpole
          // nada. La guarda de marcadores pendientes no aplica a este origen.
          requiredVariables: [],
        },
      };
    }

    // Guarda de configuracion, no excepcion: el flujo esta mal declarado y debe
    // quedar PAUSADO en este paso para que CU-09 permita corregirlo y reintentar.
    return {
      failure: {
        level: 'GRAVE',
        code: ERR_TEMPLATE_NOT_RESOLVED,
        message:
          'El nodo requiere un parametro "templateId" con el identificador de la plantilla.',
        missingFields: ['templateId'],
      },
    };
  }

  private async resolveStoredTemplate(
    templateId: string,
  ): Promise<TemplateResolution> {
    try {
      const template = await this.templatesService.findOne(templateId);

      // Una plantilla desactivada se conserva por trazabilidad, pero no debe
      // seguir generando markup nuevo.
      if (!template.active) {
        return {
          failure: {
            level: 'GRAVE',
            code: ERR_TEMPLATE_NOT_RESOLVED,
            message: `La plantilla "${template.name}" (${templateId}) esta desactivada y no puede usarse.`,
          },
        };
      }

      return {
        template: {
          htmlContent: template.htmlContent,
          name: template.name,
          requiredVariables: template.requiredVariables,
        },
      };
    } catch (error) {
      // La `NotFoundException` de `TemplatesService` NO se propaga: dejarla
      // escapar la convertiria el motor en un fallo URGENTE, que nunca se
      // reintenta. Una plantilla que falta es un error de configuracion
      // corregible, y por tanto GRAVE.
      return {
        failure: {
          level: 'GRAVE',
          code: ERR_TEMPLATE_NOT_RESOLVED,
          message: `No se pudo resolver la plantilla "${templateId}": ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
  }
}
