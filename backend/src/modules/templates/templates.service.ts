import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { CrudEventsCoordinator } from '@common/services/crud-events.coordinator';
import {
  AUDIT_RELATIONS,
  stampCreated,
  stampUpdated,
} from '@common/utils/audit.util';
import { Repository } from 'typeorm';

import { NODE_OUTPUT_NAMESPACES } from '@core/fsm/types/pipeline-schema.types';

import { CreateTemplateDto } from './dto/create-template.dto';
import { toHtmlTemplateResponse } from './dto/html-template-response.dto';
import { PreviewTemplateDto } from './dto/preview-template.dto';
import { UpdateTemplateDto } from './dto/update-template.dto';
import { HtmlTemplate } from './entities/html-template.entity';
import {
  ASSETS_NAMESPACE,
  TemplateRendererService,
} from './services/template-renderer.service';

import type { TemplateViolation } from './dto/template-violation.dto';
import type { RenderNamespaces } from './services/template-renderer.service';
import type { FindOptionsWhere } from 'typeorm';
import type { CrudAction } from '@common/types/crud-events.types';

/**
 * Namespaces que una plantilla puede referenciar.
 *
 * Lista CERRADA. Es la lista blanca contra la que se valida toda variable de una
 * plantilla: si un namespace no esta aqui, ningun nodo lo escribira nunca y la
 * variable jamas resolveria.
 *
 * Se DERIVA de `NODE_OUTPUT_NAMESPACES` (`@core/fsm`) en lugar de repetir sus
 * valores: son la misma lista vista desde dos lados —lo que un nodo puede
 * escribir y lo que una plantilla puede leer— y mantenerlas por separado
 * garantizaba que tarde o temprano divergieran.
 *
 * `_assets` es el unico anadido, y el unico que NO produce ningun nodo: lo
 * inyecta `TemplateRendererService` desde `ASSETS_BASE_URL` en cada render. Se
 * admite aqui porque, sin el, `{{_assets.base_url}}` seria un namespace
 * desconocido y la plantilla se rechazaria al guardar aunque en ejecucion
 * resolviese perfectamente. El guion bajo inicial lo distingue a simple vista de
 * un namespace de nodo, que `OUTPUT_NAMESPACE_PATTERN` obliga a empezar por
 * `[a-z0-9]`.
 */
export const ALLOWED_NAMESPACES = [
  ...NODE_OUTPUT_NAMESPACES,
  ASSETS_NAMESPACE,
] as const;

/** Busqueda O(1); el arreglo se exporta para documentacion y para el frontend. */
const ALLOWED_NAMESPACE_SET: ReadonlySet<string> = new Set(ALLOWED_NAMESPACES);

/**
 * Variable interpolable: un namespace raiz seguido de al menos un segmento.
 *
 * Acepta propiedades (`.campo`) e indices en notacion de literal de segmento de
 * Handlebars (`.[0]`), encadenados sin limite:
 *
 *   {{ parsed_email.clean_title }}
 *   {{ llm_response.articles.[0].title }}
 *
 * Exigir un segmento como minimo deja fuera `{{ parsed_email }}` a proposito: un
 * namespace entero no es un valor interpolable. El grupo 1 captura la raiz, que
 * es lo que se contrasta con la lista blanca, y el grupo 2 el resto de la ruta.
 */
const TEMPLATE_VARIABLE_PATTERN =
  /\{\{\s*([a-zA-Z0-9_]+)((?:\.(?:[a-zA-Z0-9_]+|\[\d+\]))+)\s*\}\}/g;

/**
 * Cualquier marcador que sobreviva a la extraccion: sintaxis no reconocida.
 *
 * EXPORTADA porque es la definicion del repositorio de "que cuenta como marcador
 * suelto", y tiene un segundo consumidor: `PostIaSanitizerStrategy`, que rechaza
 * el markup que la IA devuelve con interpolaciones sin resolver. Escribir alli
 * una segunda regex equivalente las dejaria divergir en cuanto alguien tocara
 * una —y el sintoma seria que el gestor rechaza al guardar lo que el escudo deja
 * publicar, o al reves.
 *
 * SIN bandera global a proposito: con `g` el objeto conserva `lastIndex` entre
 * llamadas y un `exec` repetido se saltaria coincidencias. Quien necesite
 * recorrerlas todas construye su propia instancia desde `.source`, que es el
 * mismo recurso que usa `INTERPOLATION_ONLY_PATTERN` para no duplicar un literal.
 */
export const RESIDUAL_MARKER_PATTERN = /\{\{[\s\S]*?\}\}/;

/** `.[0]` -> `.0`, la forma que `resolvePath` del contexto FSM navega. */
const SEGMENT_LITERAL_PATTERN = /\.\[(\d+)\]/g;

/**
 * Construcciones de Handlebars que quedan fuera del lenguaje admitido.
 *
 * `security-and-scope.md` §3 limita la transformacion de datos a "sustitucion
 * determinista de variables": nada de logica en la plantilla. Rechazarlas al
 * guardar, y no al renderizar, es lo que convierte el limite en un Poka-Yoke.
 */
const FORBIDDEN_SYNTAX: ReadonlyArray<{ token: string; reason: string }> = [
  {
    token: '{{{',
    reason:
      'el triple-stash desactiva el escapado de HTML y abriria una via de inyeccion en el articulo publicado',
  },
  {
    token: '{{&',
    reason:
      'la marca de no-escapado desactiva el escapado de HTML y abriria una via de inyeccion en el articulo publicado',
  },
  {
    token: '{{#',
    reason:
      'los bloques y helpers introducen logica en la plantilla, que solo admite sustitucion determinista de variables',
  },
  {
    token: '{{/',
    reason: 'cierra un bloque, y los bloques no estan admitidos',
  },
  {
    token: '{{>',
    reason:
      'los parciales cargarian una plantilla externa fuera del control del gestor',
  },
];

/**
 * Envuelve la ruta para que el marcador se distinga de un valor real de un
 * vistazo. Las comillas angulares no aparecen en texto corriente y sobreviven al
 * escapado de Handlebars sin convertirse en entidades.
 */
const buildPlaceholder = (path: string): string => `«${path}»`;

/**
 * Gestor de plantillas HTML (PROT-11.1).
 *
 * Su razon de ser no es el CRUD, sino la validacion estatica: una plantilla se
 * guarda solo si TODAS sus variables apuntan a un namespace que algun nodo
 * produce. El fallo aparece al crearla, no semanas despues cuando un flujo en
 * produccion publique un articulo con el titular en blanco.
 */
@Injectable()
export class TemplatesService {
  constructor(
    @InjectRepository(HtmlTemplate)
    private readonly templateRepository: Repository<HtmlTemplate>,
    private readonly templateRendererService: TemplateRendererService,
    private readonly crudEvents: CrudEventsCoordinator,
  ) {}
  /**
   * Difunde la mutacion a los paneles abiertos.
   *
   * Siempre DESPUES de confirmar la escritura: emitir antes abriria una ventana
   * en la que otro panel pinta una fila que PostgreSQL aun no tiene.
   *
   * Una baja logica viaja como `UPDATED` y no como `DELETED`, porque la fila
   * sigue existiendo con `active` en falso: es el cliente quien decide si la
   * oculta, segun liste o no las inactivas.
   */
  private publishMutation(
    action: CrudAction,
    id: string,
    data: HtmlTemplate,
  ): void {
    this.crudEvents.dispatch({
      entity: 'templates',
      action,
      id,
      // La proyeccion, no la entidad: con los autores cargados, la entidad
      // arrastraria el `User` completo hasta el socket.
      data: toHtmlTemplateResponse(data),
      emittedAt: new Date().toISOString(),
    });
  }

  public async findAll(onlyActive = true): Promise<HtmlTemplate[]> {
    const where: FindOptionsWhere<HtmlTemplate> = onlyActive
      ? { active: true }
      : {};

    // Orden alfabetico y no por fecha: el consumidor natural del listado es el
    // selector de plantillas de la Vista 4.
    return this.templateRepository.find({
      where,
      order: { name: 'ASC' },
      relations: AUDIT_RELATIONS,
    });
  }

  public async findOne(id: string): Promise<HtmlTemplate> {
    const template = await this.templateRepository.findOne({
      where: { id },
      relations: AUDIT_RELATIONS,
    });

    if (!template) {
      throw new NotFoundException(`Plantilla con id "${id}" no encontrada`);
    }

    return template;
  }

  /**
   * Registra una plantilla nueva.
   *
   * @param createTemplateDto Datos validados por `class-validator`.
   * @param createdById Autor, tomado del JWT y no del cuerpo de la peticion.
   */
  public async create(
    createTemplateDto: CreateTemplateDto,
    createdById: string,
  ): Promise<HtmlTemplate> {
    const name = createTemplateDto.name.trim();

    // El nombre se comprueba antes de analizar el HTML: es la validacion mas
    // barata y la que el usuario corrige mas a menudo.
    await this.assertNameAvailable(name);

    const requiredVariables = this.extractAndValidateVariables(
      createTemplateDto.htmlContent,
    );
    this.assertPublishableMarkup(createTemplateDto.htmlContent);

    const template = this.templateRepository.create({
      name,
      description: createTemplateDto.description?.trim() ?? null,
      htmlContent: createTemplateDto.htmlContent,
      requiredVariables,
      createdById,
    });

    const saved = await this.templateRepository.save(
      stampCreated(template, createdById),
    );
    // Se relee para devolver los autores ya resueltos (`AUDIT_RELATIONS`).
    const stored = await this.findOne(saved.id);
    this.publishMutation('CREATED', stored.id, stored);

    return stored;
  }

  /**
   * Actualiza una plantilla existente.
   *
   * Cambiar el HTML obliga a recalcular `requiredVariables`: dejarlas obsoletas
   * haria que la estrategia comprobase variables que ya no existen e ignorase
   * las nuevas.
   */
  public async update(
    id: string,
    updateTemplateDto: UpdateTemplateDto,
    actorId: string,
  ): Promise<HtmlTemplate> {
    const template = await this.findOne(id);

    if (updateTemplateDto.name !== undefined) {
      const name = updateTemplateDto.name.trim();
      await this.assertNameAvailable(name, id);
      template.name = name;
    }

    if (updateTemplateDto.description !== undefined) {
      template.description = updateTemplateDto.description.trim();
    }

    if (updateTemplateDto.htmlContent !== undefined) {
      template.requiredVariables = this.extractAndValidateVariables(
        updateTemplateDto.htmlContent,
      );
      this.assertPublishableMarkup(updateTemplateDto.htmlContent);
      template.htmlContent = updateTemplateDto.htmlContent;
    }

    // Unica via para REACTIVAR una plantilla retirada: `softDelete` solo sabe
    // apagarla. Sin esto, la tabla administrativa mostraria filas inactivas
    // imposibles de recuperar. Mismo criterio que `UsersController` con
    // `isActive`.
    if (updateTemplateDto.active !== undefined) {
      template.active = updateTemplateDto.active;
    }

    await this.templateRepository.save(stampUpdated(template, actorId));
    const stored = await this.findOne(id);
    this.publishMutation('UPDATED', stored.id, stored);

    return stored;
  }

  /**
   * Borrado logico (Poka-Yoke): no elimina el registro fisico.
   *
   * Una ejecucion ya trazada apunta a la plantilla con la que se genero su
   * markup; borrarla dejaria la auditoria sin la pieza que explica el
   * resultado. La plantilla desaparece del listado y la estrategia la rechaza,
   * pero la fila sigue ahi.
   */
  public async softDelete(id: string, actorId: string): Promise<HtmlTemplate> {
    const template = await this.findOne(id);

    template.active = false;

    await this.templateRepository.save(stampUpdated(template, actorId));
    const stored = await this.findOne(id);
    this.publishMutation('UPDATED', stored.id, stored);

    return stored;
  }

  /**
   * Compila la plantilla contra un payload simulado, para la vista previa.
   *
   * Usa el MISMO `TemplateRendererService` que `TemplateMapperStrategy`: si la
   * vista previa tuviera su propia compilacion, podria mostrar al editor un
   * resultado que el nodo no va a producir.
   *
   * Se previsualizan tambien las plantillas desactivadas: revisar por que se
   * retiro una es justo uno de los motivos para conservarlas.
   *
   * @throws NotFoundException Si la plantilla no existe.
   * @throws BadRequestException Si la plantilla no compila.
   */
  public async previewTemplate(
    id: string,
    previewTemplateDto: PreviewTemplateDto,
  ): Promise<{ compiledMarkup: string }> {
    const template = await this.findOne(id);
    const namespaces = this.buildPreviewContext(
      template.requiredVariables,
      previewTemplateDto.samplePayload,
    );

    const outcome = this.templateRendererService.renderStrict(
      template.htmlContent,
      template.requiredVariables,
      namespaces,
    );

    if ('markup' in outcome) {
      return { compiledMarkup: outcome.markup };
    }

    // Con los marcadores autogenerados no deberia faltar ninguna ruta de
    // `requiredVariables`; si falta, la plantilla usa una variable que la
    // validacion no detecto y el editor debe enterarse.
    if ('missingFields' in outcome) {
      throw new BadRequestException({
        message: `La plantilla referencia variables que no se pudieron resolver: ${outcome.missingFields.join(', ')}.`,
        missingFields: outcome.missingFields,
      });
    }

    throw new BadRequestException({
      message: `La plantilla no compila: ${outcome.failure}`,
    });
  }

  /**
   * Contexto de previsualizacion: marcadores por cada ruta requerida, con el
   * `samplePayload` del cliente fusionado encima.
   *
   * Autogenerar los marcadores es lo que evita que la vista previa falle por
   * falta de datos: el editor abre el dialogo y ve la maqueta al instante, con
   * `«parsed_email.clean_title»` donde ira el titular. Donde aporte valores
   * reales, se ven esos.
   */
  private buildPreviewContext(
    requiredVariables: readonly string[],
    samplePayload: Record<string, Record<string, unknown>> | undefined,
  ): RenderNamespaces {
    const namespaces: RenderNamespaces = {};

    for (const path of requiredVariables) {
      const [namespace, ...nestedKeys] = path.split('.');

      // `requiredVariables` siempre trae namespace + al menos un segmento, pero
      // la fila pudo escribirse por SQL directo: sin esta guarda seria un
      // TypeError opaco al previsualizar.
      if (namespace === undefined || nestedKeys.length === 0) {
        continue;
      }

      namespaces[namespace] ??= {};
      this.assignNested(
        namespaces[namespace],
        nestedKeys,
        buildPlaceholder(path),
      );
    }

    return this.deepMerge(namespaces, samplePayload ?? {});
  }

  /** Escribe `value` en `keys` creando los objetos intermedios que falten. */
  private assignNested(
    target: Record<string, unknown>,
    keys: string[],
    value: string,
  ): void {
    let cursor = target;

    for (let index = 0; index < keys.length - 1; index += 1) {
      const key = keys[index];
      const existing = cursor[key];

      // Un tramo ya ocupado por un primitivo se sustituye: dos rutas que se
      // contradicen (`a.b` y `a.b.c`) son un error de la plantilla, y aqui solo
      // se trata de pintar algo coherente.
      if (typeof existing !== 'object' || existing === null) {
        cursor[key] = {};
      }

      cursor = cursor[key] as Record<string, unknown>;
    }

    cursor[keys[keys.length - 1]] = value;
  }

  /** Fusion recursiva: `override` gana, y los objetos se combinan por clave. */
  private deepMerge<T extends Record<string, unknown>>(
    base: T,
    override: Record<string, unknown>,
  ): T {
    const merged: Record<string, unknown> = { ...base };

    for (const [key, value] of Object.entries(override)) {
      const current = merged[key];

      if (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        typeof current === 'object' &&
        current !== null &&
        !Array.isArray(current)
      ) {
        merged[key] = this.deepMerge(
          current as Record<string, unknown>,
          value as Record<string, unknown>,
        );
        continue;
      }

      merged[key] = value;
    }

    return merged as T;
  }

  /**
   * Extrae las variables del HTML y valida su namespace contra la lista blanca.
   *
   * Fail-fast: la primera variable invalida corta con `BadRequestException`. Se
   * valida la RAIZ de la ruta a cualquier profundidad, no solo `{{ns.campo}}`:
   * Handlebars resuelve `{{llm_response.articles.[0].title}}` igual de bien, y
   * un regex de dos segmentos dejaria esa ruta fuera de todo control.
   *
   * @param html Contenido de la plantilla.
   * @returns Rutas detectadas, normalizadas y sin duplicados.
   * @throws BadRequestException Si hay sintaxis prohibida, un namespace fuera de
   *         la lista blanca o un marcador que no se puede interpretar.
   */
  private extractAndValidateVariables(html: string): string[] {
    this.assertDeterministicSyntax(html);

    const paths: string[] = [];

    // El resultado del `replace` no es el HTML final: es el residuo con las
    // variables validas ya consumidas, y sirve para detectar lo que el patron
    // NO supo leer. Analizar y limpiar en una sola pasada evita recorrer dos
    // veces la misma cadena con dos gramaticas que podrian divergir.
    const residue = html.replace(
      TEMPLATE_VARIABLE_PATTERN,
      (match: string, namespace: string, nestedPath: string) => {
        const variable = `${namespace}${nestedPath}`;

        if (!ALLOWED_NAMESPACE_SET.has(namespace)) {
          throw new BadRequestException({
            message: `Namespace no permitido o desconocido: "${namespace}" en la variable {{${variable}}}. Verifique la sintaxis.`,
            invalidVariable: variable,
            // `match` y no `variable`: el editor busca esta cadena tal cual, y
            // `variable` va sin llaves y con la ruta ya normalizada.
            violations: TemplatesService.buildVariableViolation(
              match,
              `Namespace '${namespace}' no permitido. Solo se admiten: ${ALLOWED_NAMESPACES.join(', ')}.`,
            ),
          });
        }

        paths.push(variable.replace(SEGMENT_LITERAL_PATTERN, '.$1'));
        return '';
      },
    );

    this.assertNoResidualMarkers(residue);

    // `Set` preserva el orden de aparicion: la lista se lee igual que el HTML.
    return [...new Set(paths)];
  }

  /**
   * Envuelve un fallo de interpolacion como infraccion localizable.
   *
   * `target` debe ser una subcadena VERBATIM del documento para que el editor
   * pueda subrayarla (ver la invariante en `TemplateViolation`). De ahi que los
   * tres emisores pasen el texto tal y como aparece en el HTML —el match
   * completo con sus llaves y espacios— y no la ruta ya normalizada.
   */
  private static buildVariableViolation(
    target: string,
    message: string,
  ): TemplateViolation[] {
    return [{ target, type: 'variable', message }];
  }

  /**
   * Rechaza el markup que la lista blanca eliminaria al compilar.
   *
   * `TemplateRendererService` sanea igualmente en tiempo de render, asi que esto
   * NO es lo que impide publicar un `<script>`: es lo que impide que el autor se
   * entere tarde. Sin esta guarda, la plantilla se guardaria tal cual, se veria
   * intacta en el editor, y el recorte ocurriria en silencio al compilar. Mismo
   * criterio que con los namespaces: el fallo se senala al guardar.
   *
   * @throws BadRequestException Si algo del markup no sobrevive al saneado.
   */
  private assertPublishableMarkup(html: string): void {
    const { sanitized, wasFiltered } =
      this.templateRendererService.inspectPublishableMarkup(html);

    if (!wasFiltered) {
      return;
    }

    // La sonda es la puerta y ya ha decidido que hay que rechazar; la auditoria
    // solo anade DONDE, para que el editor lo subraye. Si no supiera localizar
    // nada, `violations` sale vacio y el 400 se comporta como antes.
    throw new BadRequestException({
      message:
        'La plantilla contiene markup que no se puede publicar y seria eliminado al compilar: etiquetas fuera de la lista blanca, atributos de evento (on*) o enlaces con protocolo no permitido. Revise el resultado saneado.',
      sanitizedHtml: sanitized,
      violations: this.templateRendererService.auditPublishableMarkup(html),
    });
  }

  /** Rechaza toda construccion de Handlebars que no sea sustitucion simple. */
  private assertDeterministicSyntax(html: string): void {
    const forbidden = FORBIDDEN_SYNTAX.find(({ token }) =>
      html.includes(token),
    );

    if (forbidden) {
      throw new BadRequestException({
        message: `Sintaxis no permitida "${forbidden.token}": ${forbidden.reason}. La plantilla solo admite variables {{namespace.campo}}.`,
        invalidVariable: forbidden.token,
        violations: TemplatesService.buildVariableViolation(
          forbidden.token,
          `Sintaxis no permitida "${forbidden.token}": ${forbidden.reason}.`,
        ),
      });
    }
  }

  /**
   * Rechaza los marcadores que sobrevivieron a la extraccion.
   *
   * Cubre lo que el patron no reconoce: un namespace suelto (`{{titulo}}`), un
   * identificador con guion o un marcador mal cerrado. Sin esta guarda pasarian
   * la validacion sin figurar en `requiredVariables`, y reventarian en tiempo
   * de ejecucion con Handlebars en modo estricto.
   */
  private assertNoResidualMarkers(residue: string): void {
    const [marker] = RESIDUAL_MARKER_PATTERN.exec(residue) ?? [];

    if (marker !== undefined) {
      throw new BadRequestException({
        message: `Marcador no interpretable "${marker}". Toda variable debe tener la forma {{namespace.campo}} con un namespace de la lista permitida (${ALLOWED_NAMESPACES.join(', ')}).`,
        invalidVariable: marker,
        violations: TemplatesService.buildVariableViolation(
          marker,
          `Marcador no interpretable "${marker}". Use la forma {{namespace.campo}}.`,
        ),
      });
    }
  }

  private async assertNameAvailable(
    name: string,
    excludeId?: string,
  ): Promise<void> {
    const existing = await this.templateRepository.findOne({
      where: { name },
    });

    if (existing && existing.id !== excludeId) {
      throw new ConflictException(`La plantilla "${name}" ya esta registrada`);
    }
  }
}
