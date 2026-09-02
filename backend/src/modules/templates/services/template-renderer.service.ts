import { Injectable } from '@nestjs/common';
import Handlebars from 'handlebars';

import {
  MissingContextVariableException,
  resolvePath,
} from '@core/fsm/context/state-payload.context';

/** Namespaces acumulados contra los que se compila una plantilla. */
export type RenderNamespaces = Record<string, Record<string, unknown>>;

/**
 * Salida del render, como union discriminada.
 *
 * Ni lanza ni devuelve `null`: cada rama lleva el dato que su consumidor
 * necesita para construir su propia respuesta —un `NodeResult` en la estrategia,
 * una excepcion HTTP en el controlador—, sin que el renderer conozca a ninguno.
 */
export type RenderOutcome =
  | { readonly markup: string }
  | { readonly missingFields: string[] }
  | { readonly failure: string; readonly stackTrace?: string };

/**
 * Compilacion estricta de plantillas Handlebars contra un contexto de namespaces.
 *
 * Existe como servicio propio, y no como metodo privado de la estrategia, porque
 * tiene DOS consumidores: `TemplateMapperStrategy` en tiempo de ejecucion y el
 * endpoint de previsualizacion del gestor. Con dos implementaciones, la vista
 * previa podria divergir del render real y acabar mintiendo al editor sobre lo
 * que se va a publicar; con una sola, eso no puede pasar.
 *
 * Es un servicio PURO: sin repositorio, sin red y sin estado. De ahi que las
 * pruebas puedan instanciarlo con `new` en vez de mockearlo.
 */
@Injectable()
export class TemplateRendererService {
  /**
   * Compila `htmlContent` sustituyendo las variables por su valor en `namespaces`.
   *
   * @param htmlContent Plantilla a compilar.
   * @param requiredVariables Rutas que se comprueban ANTES de compilar. Vacio
   *        omite el pre-chequeo y deja el corte al modo estricto de Handlebars.
   * @param namespaces Volcado del contexto.
   */
  public renderStrict(
    htmlContent: string,
    requiredVariables: readonly string[],
    namespaces: RenderNamespaces,
  ): RenderOutcome {
    // 1. Pre-chequeo. Handlebars en modo estricto tambien detendria el render,
    //    pero solo en la PRIMERA variable ausente: recorrer las rutas ya
    //    validadas al guardar permite informar de todas de golpe, que es lo que
    //    el operador necesita para arreglar el flujo en una sola pasada.
    const missingFields = this.findMissingVariables(
      requiredVariables,
      namespaces,
    );

    if (missingFields.length > 0) {
      return { missingFields };
    }

    try {
      // `strict: true` frente al `false` por defecto de Handlebars: una variable
      // ausente debe detener el flujo, no interpolarse como cadena vacia. Un
      // titular en blanco se publicaria sin que nadie se enterase, y el fallo
      // apareceria lejos de su causa.
      const render = Handlebars.compile(htmlContent, { strict: true });

      // El escapado de HTML por defecto de `{{ }}` se conserva a proposito: el
      // gestor prohibe el triple-stash, asi que ningun valor del contexto puede
      // inyectar markup en el articulo publicado.
      return { markup: render(namespaces) };
    } catch (error) {
      return {
        failure: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && error.stack !== undefined
          ? { stackTrace: error.stack }
          : {}),
      };
    }
  }

  /**
   * Rutas que el contexto no puede resolver.
   *
   * Reutiliza `resolvePath`, la funcion pura del contexto FSM, para que la
   * comprobacion siga exactamente la misma gramatica de navegacion que la
   * interpolacion del motor.
   */
  private findMissingVariables(
    requiredVariables: readonly string[],
    namespaces: RenderNamespaces,
  ): string[] {
    return requiredVariables.filter((path) => {
      try {
        resolvePath(namespaces, path);
        return false;
      } catch (error) {
        if (error instanceof MissingContextVariableException) {
          return true;
        }

        // Cualquier otra cosa es imprevista: se deja subir en vez de
        // disfrazarla de variable ausente.
        throw error;
      }
    });
  }
}
