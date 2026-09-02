import { Injectable } from '@nestjs/common';
import Handlebars from 'handlebars';

import {
  MissingContextVariableException,
  resolvePath,
} from '@core/fsm/context/state-payload.context';
import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { TemplatesService } from '@modules/templates/templates.service';

import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import type {
  INodeStrategy,
  NodeErrorDetail,
  NodeResult,
} from '@core/fsm/types/node-strategy.types';

/** Plantilla lista para compilar, venga de la base de datos o de `rawTemplate`. */
interface ResolvedTemplate {
  readonly htmlContent: string;
  /** Rutas a comprobar antes de renderizar; vacio en el modo `rawTemplate`. */
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
 * Nodo MAPEADOR_PLANTILLA (PROT-11.2): compila una plantilla del gestor contra
 * el contexto acumulado de la ejecucion.
 *
 * Sustituye a `DummyTemplateMapperStrategy`, que recibia el HTML incrustado en
 * `params.template`. Aqui el nodo solo declara `params.templateId` y la
 * plantilla vive en `plantillas_html`, reutilizable y auditable.
 *
 * NO escribe en el contexto: devuelve `data` y es `FsmEngineService` quien la
 * deposita en el `outputNamespace` declarado por el nodo. Escribir tambien
 * desde aqui duplicaria el payload en dos namespaces y contradiria el contrato
 * de `INodeStrategy`, donde el contexto es de solo lectura para la estrategia.
 */
@Injectable()
export class TemplateMapperStrategy implements INodeStrategy {
  public readonly nodeType = NodeType.MAPEADOR_PLANTILLA;

  constructor(private readonly templatesService: TemplatesService) {}

  public async execute(
    context: StatePayloadContext,
    params: Record<string, unknown>,
  ): Promise<NodeResult> {
    // 1. Resolver la plantilla (base de datos o fallback de pruebas).
    const resolution = await this.resolveTemplate(params);

    if ('failure' in resolution) {
      return { success: false, error: resolution.failure };
    }

    const { htmlContent, requiredVariables } = resolution.template;

    // 2. Pre-chequeo de variables. Handlebars en modo estricto tambien lanzaria,
    //    pero solo por la PRIMERA ausencia; recorrer las rutas ya validadas al
    //    guardar la plantilla permite informar de todas de golpe, que es lo que
    //    el operador necesita para arreglar el flujo en una sola pasada.
    const missingFields = this.findMissingVariables(context, requiredVariables);

    if (missingFields.length > 0) {
      return {
        success: false,
        error: {
          level: 'GRAVE',
          message: `El contexto no aporta ${missingFields.length} variable(s) que la plantilla requiere.`,
          missingFields,
        },
      };
    }

    // 3. Compilar y renderizar sobre el volcado completo de memoria.
    try {
      // `strict: true` frente al `false` habitual de Handlebars: una variable
      // ausente debe detener el flujo, no interpolarse como cadena vacia. Un
      // titular en blanco se publicaria en Drupal sin que nadie se enterase, y
      // el fallo apareceria lejos de su causa.
      const render = Handlebars.compile(htmlContent, { strict: true });

      // El escapado de HTML por defecto de `{{ }}` se conserva a proposito: el
      // gestor prohibe el triple-stash, asi que ningun valor del contexto puede
      // inyectar markup en el articulo publicado.
      const compiledMarkup = render(context.getAllContext());

      return {
        success: true,
        data: {
          compiled_markup: compiledMarkup,
          mapped_at: new Date().toISOString(),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          level: 'GRAVE',
          message: `Fallo al compilar la plantilla: ${this.describeError(error)}`,
          stackTrace: error instanceof Error ? error.stack : undefined,
        },
      };
    }
  }

  /**
   * Obtiene el HTML a compilar a partir de los `params` del nodo.
   *
   * Prioriza `templateId` (el modo de produccion) y admite `rawTemplate` como
   * fallback para probar la estrategia sin base de datos. En el modo
   * `rawTemplate` no hay `requiredVariables` precalculadas, asi que la deteccion
   * de variables ausentes recae por completo en el modo estricto de Handlebars.
   */
  private async resolveTemplate(
    params: Record<string, unknown>,
  ): Promise<TemplateResolution> {
    const { templateId, rawTemplate } = params;

    if (typeof templateId === 'string' && templateId.trim() !== '') {
      return this.resolveStoredTemplate(templateId.trim());
    }

    if (typeof rawTemplate === 'string') {
      return { template: { htmlContent: rawTemplate, requiredVariables: [] } };
    }

    // Guarda de configuracion, no excepcion: el flujo esta mal declarado y debe
    // quedar PAUSADO en este paso para que CU-09 permita corregirlo y reintentar.
    return {
      failure: {
        level: 'GRAVE',
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
            message: `La plantilla "${template.name}" (${templateId}) esta desactivada y no puede usarse.`,
          },
        };
      }

      return {
        template: {
          htmlContent: template.htmlContent,
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
          message: `No se pudo resolver la plantilla "${templateId}": ${this.describeError(error)}`,
        },
      };
    }
  }

  /**
   * Rutas de `requiredVariables` que el contexto no puede resolver.
   *
   * Reutiliza `resolvePath`, la funcion pura del contexto FSM, para que la
   * comprobacion siga exactamente la misma gramatica de navegacion que la
   * interpolacion del motor.
   */
  private findMissingVariables(
    context: StatePayloadContext,
    requiredVariables: readonly string[],
  ): string[] {
    // Un solo volcado: `getAllContext()` clona en profundidad en cada llamada.
    const namespaces = context.getAllContext();

    return requiredVariables.filter((path) => {
      try {
        resolvePath(namespaces, path);
        return false;
      } catch (error) {
        if (error instanceof MissingContextVariableException) {
          return true;
        }

        // Cualquier otra cosa es imprevista: se deja subir para que el motor la
        // normalice a URGENTE en vez de disfrazarla de variable ausente.
        throw error;
      }
    });
  }

  private describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
