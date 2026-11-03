import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { createMockStatePayloadContext } from '@test/factories/state-payload-context.factory';
import { createTemplateRendererService } from '@test/factories/template-renderer.factory';

import { PostIaSanitizerConfigDto } from '../dto/post-ia-sanitizer-config.dto';

import {
  ERR_POST_IA_CONFIG,
  ERR_POST_IA_DOM_MUTATED,
  ERR_POST_IA_EMPTY_AFTER_SANITIZE,
  ERR_POST_IA_EMPTY_HTML,
  ERR_POST_IA_MISSING_PAYLOAD,
  ERR_POST_IA_RESIDUAL_VARS,
  ERR_POST_IA_UNSUPPORTED_TAGS,
  PostIaSanitizerStrategy,
} from './post-ia-sanitizer.strategy';

import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import type { TemplateRendererService } from '@modules/templates/services/template-renderer.service';

const SOURCE_NAMESPACE = 'llm_response';
const SOURCE_FIELD = 'filled_markup';

/** Articulo ya relleno por la IA: las dos ranuras con contenido real. */
const FILLED_HTML =
  '<h1 class="titular">Innovacion en Madrid</h1><div class="cuerpo"><p>Texto del articulo.</p></div>';

/**
 * Contexto con el markup ya sembrado en el namespace del nodo de IA.
 *
 * `overrides` permite sustituir el payload entero para los casos negativos sin
 * repetir la construccion del contexto en cada `Arrange`.
 */
const buildContext = (
  payload: Record<string, unknown> | null = { [SOURCE_FIELD]: FILLED_HTML },
): StatePayloadContext =>
  createMockStatePayloadContext({
    currentStep: 'escudo_post_ia',
    namespaces: payload === null ? {} : { [SOURCE_NAMESPACE]: payload },
  });

type RendererMock = jest.Mocked<
  Pick<TemplateRendererService, 'prepareInjectableMarkup' | 'auditFilledSlots'>
>;

/** Doble del renderer, solo para el bloque que verifica la delegacion. */
const buildRendererMock = (): RendererMock => ({
  prepareInjectableMarkup: jest.fn().mockReturnValue({
    sanitized: FILLED_HTML,
    wasFiltered: false,
    unsupportedTags: [],
  }),
  auditFilledSlots: jest
    .fn()
    .mockReturnValue({ missing: [], invalid: [], empty: [] }),
});

/**
 * Instancia la estrategia. El renderer va REAL por defecto a proposito.
 *
 * Mockearlo en todas las pruebas volveria tautologicas las de saneado y las del
 * contrato estructural: comprobarian que un doble devuelve lo que se le dijo, no
 * que la lista blanca recorte de verdad ni que cheerio encuentre el selector —
 * justo la cobertura que impide que el nodo publique markup que el gestor habria
 * rechazado. Como el renderer es puro (sin repositorio, red ni estado), usarlo
 * de verdad no introduce acoplamiento alguno. El bloque 8 si lo mockea, porque
 * alli lo que se verifica es el contrato de delegacion.
 */
const buildStrategy = (
  renderer:
    TemplateRendererService | RendererMock = createTemplateRendererService(),
): PostIaSanitizerStrategy =>
  new PostIaSanitizerStrategy(renderer as TemplateRendererService);

describe('PostIaSanitizerStrategy', () => {
  describe('0. Identidad y contratos declarativos', () => {
    it('0.1 deberia declararse como ESCUDO_POST_IA', () => {
      // 1. Arrange & 2. Act ⚙️
      const strategy = buildStrategy();

      // 3. Assert 🎯
      expect(strategy.nodeType).toBe(NodeType.ESCUDO_POST_IA);
    });

    it('0.2 deberia someter sus params a validacion estricta', () => {
      // 1. Arrange & 2. Act ⚙️
      const strategy = buildStrategy();

      // 3. Assert 🎯: asi `PipelineValidatorService` rechaza al guardar una clave
      //    que el DTO no declare, en vez de dejarla pasar en silencio
      expect(strategy.paramsSchema).toBe(PostIaSanitizerConfigDto);
    });

    it('0.3 deberia declarar el namespace del que lee, derivado de sus params', () => {
      // 1. Arrange 📐
      const strategy = buildStrategy();

      // 2. Act ⚙️
      const porDefecto = strategy.getRequiredNamespaces({});
      const declarado = strategy.getRequiredNamespaces({
        sourceNamespace: 'ocr_result',
      });

      // 3. Assert 🎯: es lo que permite a la regla 7 del validador rechazar AL
      //    GUARDAR un escudo colocado delante del nodo que deberia alimentarlo
      expect(porDefecto).toEqual([SOURCE_NAMESPACE]);
      expect(declarado).toEqual(['ocr_result']);
    });
  });

  describe('1. Camino feliz', () => {
    it('1.1 deberia aprobar un markup limpio y sellarlo como PASSED', async () => {
      // 1. Arrange 📐
      const strategy = buildStrategy();

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {});

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(result.data?.validated_markup).toBe(FILLED_HTML);
      expect(result.data?.audit_status).toBe('PASSED');
      expect(result.data?.character_count).toBe(FILLED_HTML.length);
    });

    it('1.2 deberia podar las vallas de bloque markdown del modelo', async () => {
      // 1. Arrange 📐: el tic de formato del proveedor. Publicarlo imprimiria
      //    las comillas invertidas literales en el articulo.
      const strategy = buildStrategy();
      const context = buildContext({
        [SOURCE_FIELD]: '```html\n' + FILLED_HTML + '\n```',
      });

      // 2. Act ⚙️
      const result = await strategy.execute(context, {});

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(result.data?.validated_markup).toBe(FILLED_HTML);
    });

    it('1.3 deberia podar tambien una valla sin lenguaje declarado', async () => {
      // 1. Arrange 📐
      const strategy = buildStrategy();
      const context = buildContext({
        [SOURCE_FIELD]: '```\n' + FILLED_HTML + '\n```',
      });

      // 2. Act ⚙️
      const result = await strategy.execute(context, {});

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(result.data?.validated_markup).toBe(FILLED_HTML);
    });

    it('1.4 deberia aprobar cuando se cumplen los selectores exigidos', async () => {
      // 1. Arrange 📐
      const strategy = buildStrategy();

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        requiredSelectors: ['h1.titular', 'div.cuerpo'],
      });

      // 3. Assert 🎯
      expect(result.success).toBe(true);
    });
  });

  describe('2. Saneado XSS', () => {
    it('2.1 deberia eliminar un <script> junto con su contenido', async () => {
      // 1. Arrange 📐: `nonTextTags` importa. Con un simple `discard` el texto
      //    del script quedaria suelto dentro del articulo.
      const strategy = buildStrategy();
      const context = buildContext({
        [SOURCE_FIELD]: `${FILLED_HTML}<script>alert('xss')</script>`,
      });

      // 2. Act ⚙️
      const result = await strategy.execute(context, {});

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(result.data?.validated_markup).not.toContain('script');
      expect(result.data?.validated_markup).not.toContain('alert');
    });

    it.each(['onerror', 'onclick'])(
      '2.2 deberia eliminar el atributo de evento %s',
      async (attribute) => {
        // 1. Arrange 📐
        const strategy = buildStrategy();
        const context = buildContext({
          [SOURCE_FIELD]: `<div class="cuerpo" ${attribute}="robar()">Texto</div>`,
        });

        // 2. Act ⚙️
        const result = await strategy.execute(context, {});

        // 3. Assert 🎯
        expect(result.success).toBe(true);
        expect(result.data?.validated_markup).not.toContain(attribute);
      },
    );

    it('2.3 deberia descartar un href con pseudo-protocolo javascript:', async () => {
      // 1. Arrange 📐
      const strategy = buildStrategy();
      const context = buildContext({
        [SOURCE_FIELD]: '<p><a href="javascript:robar()">Pinchame</a></p>',
      });

      // 2. Act ⚙️
      const result = await strategy.execute(context, {});

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(result.data?.validated_markup).not.toContain('javascript:');
    });
  });

  describe('3. Preservacion de lo que Drupal necesita', () => {
    it('3.1 deberia conservar una imagen con ruta relativa', async () => {
      // 1. Arrange 📐: Drupal sirve sus adjuntos por ruta relativa. El saneador
      //    solo juzga el esquema cuando hay uno, asi que debe pasar intacta.
      const strategy = buildStrategy();
      const context = buildContext({
        [SOURCE_FIELD]:
          '<figure><img src="/sites/default/files/foto.jpg" alt="Foto"></figure>',
      });

      // 2. Act ⚙️
      const result = await strategy.execute(context, {});

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(result.data?.validated_markup).toContain(
        'src="/sites/default/files/foto.jpg"',
      );
      expect(result.data?.validated_markup).toContain('alt="Foto"');
    });

    it('3.2 deberia conservar target y forzar el rel seguro', async () => {
      // 1. Arrange 📐: sin `noopener`, la pagina destino recibe un
      //    `window.opener` con el que puede redirigir la pestana de origen.
      const strategy = buildStrategy();
      const context = buildContext({
        [SOURCE_FIELD]:
          '<p><a href="https://madrimasd.org" target="_blank">Portal</a></p>',
      });

      // 2. Act ⚙️
      const result = await strategy.execute(context, {});

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(result.data?.validated_markup).toContain('target="_blank"');
      expect(result.data?.validated_markup).toContain(
        'rel="noopener noreferrer"',
      );
    });

    it('3.3 deberia conservar el <img> de respaldo de un <picture>', async () => {
      // 1. Arrange 📐: `picture` y `source` NO estan en la lista blanca, y se
      //    decidio no ampliarla. `disallowedTagsMode: 'discard'` conserva los
      //    hijos, asi que la imagen —que es lo que Drupal necesita— sobrevive.
      const strategy = buildStrategy();
      const context = buildContext({
        [SOURCE_FIELD]:
          '<picture><source srcset="/a.webp" type="image/webp"><img src="/a.jpg" alt="Foto"></picture>',
      });

      // 2. Act ⚙️
      const result = await strategy.execute(context, {});

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(result.data?.validated_markup).toContain('src="/a.jpg"');
      expect(result.data?.validated_markup).not.toContain('<picture');
      expect(result.data?.validated_markup).not.toContain('<source');
    });
  });

  describe('4. Fallos GRAVE', () => {
    it('4.1 deberia fallar si el namespace de origen no existe', async () => {
      // 1. Arrange 📐: el escudo colocado antes del nodo que deberia alimentarlo.
      const strategy = buildStrategy();

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(null), {});

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.code).toBe(ERR_POST_IA_MISSING_PAYLOAD);
      expect(result.error?.missingFields).toEqual([SOURCE_NAMESPACE]);
    });

    it('4.2 deberia fallar si el campo de markup no esta en el payload', async () => {
      // 1. Arrange 📐: ES EL CAMINO QUE RECORRE HOY UN FLUJO REAL. El
      //    PROCESADOR_IA publica headline/summary/body_paragraphs/metadata y
      //    ninguna de las cuatro es markup.
      const strategy = buildStrategy();
      const context = buildContext({
        headline: 'Innovacion en Madrid',
        summary: 'Resumen',
        body_paragraphs: ['Parrafo'],
      });

      // 2. Act ⚙️
      const result = await strategy.execute(context, {});

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.code).toBe(ERR_POST_IA_EMPTY_HTML);
      expect(result.error?.missingFields).toEqual([
        `${SOURCE_NAMESPACE}.${SOURCE_FIELD}`,
      ]);
    });

    it.each([
      ['una cadena vacia', '   '],
      ['un nulo', null],
      ['un numero', 42],
    ])('4.3 deberia fallar si el campo es %s', async (_etiqueta, value) => {
      // 1. Arrange 📐: `pipeline_schema` es jsonb y el payload lo escribe un
      //    modelo, asi que los tres son alcanzables.
      const strategy = buildStrategy();
      const context = buildContext({ [SOURCE_FIELD]: value });

      // 2. Act ⚙️
      const result = await strategy.execute(context, {});

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_POST_IA_EMPTY_HTML);
    });

    it('4.4 deberia rechazar marcadores que el modelo dejo sin resolver', async () => {
      // 1. Arrange 📐: la guarda que evita publicar llaves literales en Drupal.
      const strategy = buildStrategy();
      const context = buildContext({
        [SOURCE_FIELD]:
          '<h1 class="titular">{{parsed_email.clean_title}}</h1><div class="cuerpo"><p>{{llm_response.summary}}</p></div>',
      });

      // 2. Act ⚙️
      const result = await strategy.execute(context, {});

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.code).toBe(ERR_POST_IA_RESIDUAL_VARS);
      expect(result.error?.missingFields).toEqual([
        '{{parsed_email.clean_title}}',
        '{{llm_response.summary}}',
      ]);
    });

    it('4.5 deberia de-duplicar los marcadores repetidos', async () => {
      // 1. Arrange 📐: veinte repeticiones del mismo marcador son un solo
      //    problema que resolver; listarlas todas enterraria el mensaje.
      const strategy = buildStrategy();
      const context = buildContext({
        [SOURCE_FIELD]: '<p>{{a.b}}</p><p>{{a.b}}</p><p>{{a.b}}</p>',
      });

      // 2. Act ⚙️
      const result = await strategy.execute(context, {});

      // 3. Assert 🎯
      expect(result.error?.code).toBe(ERR_POST_IA_RESIDUAL_VARS);
      expect(result.error?.missingFields).toEqual(['{{a.b}}']);
    });

    it('4.6 deberia detectar el marcador ANTES de que el saneado lo borre', async () => {
      // 1. Arrange 📐: el marcador vive dentro de una etiqueta que la lista
      //    blanca descarta. Si se saneara primero, desapareceria la prueba del
      //    delito y el flujo publicaria un hueco en vez de pararse.
      const strategy = buildStrategy();
      const context = buildContext({
        [SOURCE_FIELD]:
          '<p>Texto</p><iframe>{{parsed_email.clean_title}}</iframe>',
      });

      // 2. Act ⚙️
      const result = await strategy.execute(context, {});

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_POST_IA_RESIDUAL_VARS);
    });

    it('4.7 deberia rechazar allowedTags fuera de la lista blanca global', async () => {
      // 1. Arrange 📐: `allowedTags` solo puede RESTAR. Concederlo por parametro
      //    convertiria la configuracion de un nodo en una via de XSS.
      const strategy = buildStrategy();

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        allowedTags: ['h1', 'script'],
      });

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.code).toBe(ERR_POST_IA_UNSUPPORTED_TAGS);
      expect(result.error?.missingFields).toContain('script');
    });

    it('4.8 deberia fallar si el markup queda vacio tras el saneado', async () => {
      // 1. Arrange 📐: el sintoma de una inyeccion de prompt o de un modelo que
      //    ignoro el formato pedido. Se distingue de EMPTY_HTML a proposito.
      const strategy = buildStrategy();
      const context = buildContext({
        [SOURCE_FIELD]: '<script>alert(1)</script><style>p{}</style>',
      });

      // 2. Act ⚙️
      const result = await strategy.execute(context, {});

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.code).toBe(ERR_POST_IA_EMPTY_AFTER_SANITIZE);
    });

    it('4.9 deberia rechazar una configuracion invalida', async () => {
      // 1. Arrange 📐: GRAVE y no URGENTE, para que entre en la politica de
      //    reintento y CU-09 permita corregirlo.
      const strategy = buildStrategy();

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        sourceNamespace: 'NO-ES-SNAKE-CASE',
      });

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.code).toBe(ERR_POST_IA_CONFIG);
      expect(result.error?.missingFields).toContain('sourceNamespace');
    });
  });

  describe('5. Auditoria estructural', () => {
    it('5.1 deberia fallar si la IA elimino una ranura exigida', async () => {
      // 1. Arrange 📐
      const strategy = buildStrategy();
      const context = buildContext({
        [SOURCE_FIELD]: '<div class="cuerpo"><p>Solo el cuerpo.</p></div>',
      });

      // 2. Act ⚙️
      const result = await strategy.execute(context, {
        requiredSelectors: ['h1.titular', 'div.cuerpo'],
      });

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.code).toBe(ERR_POST_IA_DOM_MUTATED);
      expect(result.error?.missingFields).toContain('h1.titular');
      expect(result.error?.message).toContain('elimino');
    });

    it('5.2 deberia fallar si la ranura esta pero sigue en blanco', async () => {
      // 1. Arrange 📐: es el fallo que `auditStructure` NO puede ver, y la razon
      //    de que exista `auditFilledSlots`.
      const strategy = buildStrategy();
      const context = buildContext({
        [SOURCE_FIELD]:
          '<h1 class="titular">Titular</h1><div class="cuerpo"></div>',
      });

      // 2. Act ⚙️
      const result = await strategy.execute(context, {
        requiredSelectors: ['h1.titular', 'div.cuerpo'],
      });

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_POST_IA_DOM_MUTATED);
      expect(result.error?.missingFields).toContain('div.cuerpo');
      expect(result.error?.message).toContain('sin rellenar');
    });

    it('5.3 deberia separar un selector invalido de los ausentes', async () => {
      // 1. Arrange 📐: un selector que el motor no sabe parsear manda al operador
      //    a su propia lista, no a mirar la salida de la IA.
      const strategy = buildStrategy();

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {
        requiredSelectors: ['h1.titular', ':::'],
      });

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_POST_IA_DOM_MUTATED);
      expect(result.error?.message).toContain('no son selectores validos');
    });

    it('5.4 deberia contar una ranura solo con imagen como rellena', async () => {
      // 1. Arrange 📐: la tolerancia multimedia. Sin ella, una galeria legitima
      //    dejaria el flujo PAUSADO por un acierto del modelo.
      const strategy = buildStrategy();
      const context = buildContext({
        [SOURCE_FIELD]:
          '<div class="galeria"><img src="/foto.jpg" alt="Foto"></div>',
      });

      // 2. Act ⚙️
      const result = await strategy.execute(context, {
        requiredSelectors: ['div.galeria'],
      });

      // 3. Assert 🎯
      expect(result.success).toBe(true);
    });

    it('5.5 deberia auditar sobre el markup YA saneado', async () => {
      // 1. Arrange 📐: el selector apunta a una etiqueta que la lista blanca
      //    descarta. El lector no la va a ver, asi que la ranura NO esta.
      const strategy = buildStrategy();
      const context = buildContext({
        [SOURCE_FIELD]:
          '<p>Texto</p><section class="extra">Contenido</section>',
      });

      // 2. Act ⚙️
      const result = await strategy.execute(context, {
        requiredSelectors: ['section.extra'],
      });

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_POST_IA_DOM_MUTATED);
      expect(result.error?.missingFields).toContain('section.extra');
    });

    describe('5.6 Ranura del maestro de apertura (h3.licitacion-title)', () => {
      /** El mismo selector que exige el escudo del maestro de apertura. */
      const APERTURA_SELECTORS = ['h3.licitacion-title'];

      /** Envoltorio de la plantilla de convocatoria abierta, ya relleno. */
      const aperturaMarkup = (title: string): string =>
        '<div class="licitacion-entry" data-expediente="LIC-2026-001">' +
        '<hr class="licitacion-separator" />' +
        title +
        '<p class="valor-estimado">120000.00</p></div>';

      it('5.6.1 deberia aprobar el objeto del contrato dentro de la ranura', async () => {
        // 1. Arrange 📐
        const strategy = buildStrategy();
        const context = buildContext({
          [SOURCE_FIELD]: aperturaMarkup(
            '<h3 class="licitacion-title">Objeto válido</h3>',
          ),
        });

        // 2. Act ⚙️
        const result = await strategy.execute(context, {
          requiredSelectors: APERTURA_SELECTORS,
        });

        // 3. Assert 🎯
        expect(result.success).toBe(true);
        expect(result.error).toBeUndefined();
        expect(result.data?.validated_markup).toContain(
          '<h3 class="licitacion-title">Objeto válido</h3>',
        );
      });

      it('5.6.3 deberia aprobar el bloque completo y conservar expediente e importes', async () => {
        // 1. Arrange 📐: lo que el prompt de apertura exige rellenar.
        const strategy = buildStrategy();
        const context = buildContext({
          [SOURCE_FIELD]:
            '<div class="licitacion-entry pd-licitacion-block" data-expediente="S_2026_015">' +
            '<h3 class="licitacion-title">S_2026_015 Servicios de apoyo al emprendimiento innovador</h3>' +
            '<ul class="licitacion-presupuesto">' +
            '<li><strong>Base Imponible:</strong> <span class="base-imponible">33.000,00 euros</span></li>' +
            '<li><strong>Importe del I.V.A.:</strong> <span class="iva">6.930,00 euros</span></li>' +
            '<li><strong>Importe total:</strong> <span class="total">39.930,00 euros</span></li>' +
            '</ul></div>',
        });

        // 2. Act ⚙️
        const result = await strategy.execute(context, {
          requiredSelectors: APERTURA_SELECTORS,
        });

        // 3. Assert 🎯: el saneado no se lleva el atributo que localiza el
        //    bloque ni las clases de los importes.
        const markup = String(result.data?.validated_markup);
        expect(result.success).toBe(true);
        expect(markup).toContain('data-expediente="S_2026_015"');
        expect(markup).toContain(
          '<span class="base-imponible">33.000,00 euros</span>',
        );
        expect(markup).toContain('<span class="iva">6.930,00 euros</span>');
        expect(markup).toContain('<span class="total">39.930,00 euros</span>');
      });

      it.each([
        ['borro la clase', '<h3>Objeto válido</h3>'],
        ['suprimio el <h3>', '<p>Objeto válido</p>'],
        ['dejo el <h3> vacio', '<h3 class="licitacion-title"></h3>'],
      ])(
        '5.6.2 deberia pausar con ERR_POST_IA_DOM_MUTATED si la IA %s',
        async (_case, title) => {
          // 1. Arrange 📐
          const strategy = buildStrategy();
          const context = buildContext({
            [SOURCE_FIELD]: aperturaMarkup(title),
          });

          // 2. Act ⚙️
          const result = await strategy.execute(context, {
            requiredSelectors: APERTURA_SELECTORS,
          });

          // 3. Assert 🎯
          expect(result.success).toBe(false);
          expect(result.error?.level).toBe('GRAVE');
          expect(result.error?.code).toBe(ERR_POST_IA_DOM_MUTATED);
          expect(result.error?.missingFields).toEqual(APERTURA_SELECTORS);
        },
      );
    });
  });

  describe('6. Inmutabilidad del contexto', () => {
    it('6.1 no deberia escribir en el contexto: eso es cosa del motor', async () => {
      // 1. Arrange 📐
      const strategy = buildStrategy();
      const context = buildContext();

      // 2. Act ⚙️
      await strategy.execute(context, {});

      // 3. Assert 🎯
      expect(context.getNamespace('validated_drupal_json')).toBeUndefined();
    });
  });

  describe('7. Inventario de salida (outputFields)', () => {
    it('7.1 deberia declarar las seis claves del namespace', () => {
      // 1. Arrange & 2. Act ⚙️
      const strategy = buildStrategy();

      // 3. Assert 🎯
      expect(strategy.outputFields.map((field) => field.name)).toEqual([
        'validated_markup',
        'character_count',
        'audit_status',
        'sanitized_at',
        'validated_fields',
        'validated_items',
      ]);
    });

    it('7.2 deberia coincidir exactamente con las claves que emite execute', async () => {
      // 1. Arrange 📐: el inventario es lo que el selector del asistente ofrece.
      //    Si divergiera del payload real, ofreceria variables irresolubles.
      const strategy = buildStrategy();

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(), {});

      // 3. Assert 🎯
      expect(Object.keys(result.data ?? {}).sort()).toEqual(
        strategy.outputFields.map((field) => field.name).sort(),
      );
    });
  });

  describe('8. Delegacion en TemplateRendererService', () => {
    it('8.1 deberia delegar el saneado pasandole los allowedTags declarados', async () => {
      // 1. Arrange 📐
      const renderer = buildRendererMock();
      const strategy = buildStrategy(renderer);

      // 2. Act ⚙️
      await strategy.execute(buildContext(), { allowedTags: ['h1', 'div'] });

      // 3. Assert 🎯
      expect(renderer.prepareInjectableMarkup).toHaveBeenCalledWith(
        FILLED_HTML,
        ['h1', 'div'],
      );
    });

    it('8.2 deberia auditar el markup que devolvio el saneador, no el crudo', async () => {
      // 1. Arrange 📐
      const renderer = buildRendererMock();
      renderer.prepareInjectableMarkup.mockReturnValue({
        sanitized: '<p>saneado</p>',
        wasFiltered: true,
        unsupportedTags: [],
      });
      const strategy = buildStrategy(renderer);

      // 2. Act ⚙️
      await strategy.execute(buildContext(), { requiredSelectors: ['p'] });

      // 3. Assert 🎯
      expect(renderer.auditFilledSlots).toHaveBeenCalledWith('<p>saneado</p>', [
        'p',
      ]);
    });

    it('8.3 no deberia sanear nada si el payload no trae markup', async () => {
      // 1. Arrange 📐: las guardas van primero; el saneado es trabajo inutil
      //    sobre un payload que ya se sabe invalido.
      const renderer = buildRendererMock();
      const strategy = buildStrategy(renderer);

      // 2. Act ⚙️
      await strategy.execute(buildContext(null), {});

      // 3. Assert 🎯
      expect(renderer.prepareInjectableMarkup).not.toHaveBeenCalled();
    });
  });

  describe('9. Modo TEXT: flujos sin maquetacion (Innodays, Innobar, Cerrar licitacion)', () => {
    const TEXT_PAYLOAD = {
      headline: 'Innodays &amp; Innobar 2026',
      summary: 'Resumen <script>alert(1)</script><b>destacado</b>.',
      filled_markup: null,
    };

    it('9.1 deberia aprobar los campos de texto sin exigir MAPEADOR_PLANTILLA', async () => {
      // 1. Arrange 📐: `filled_markup` es nulo, como lo deja un prompt sin plantilla.
      const strategy = buildStrategy();

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(TEXT_PAYLOAD), {
        contentMode: 'TEXT',
      });

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        validated_markup: '',
        audit_status: 'PASSED',
        validated_fields: {
          headline: 'Innodays & Innobar 2026',
          summary: 'Resumen destacado.',
        },
      });
    });

    it('9.2 deberia fallar con EMPTY_HTML si falta un campo declarado', async () => {
      // 1. Arrange 📐
      const strategy = buildStrategy();

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(TEXT_PAYLOAD), {
        contentMode: 'TEXT',
        sourceFields: ['headline', 'body_paragraphs'],
      });

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.code).toBe(ERR_POST_IA_EMPTY_HTML);
      expect(result.error?.missingFields).toEqual([
        'llm_response.body_paragraphs',
      ]);
    });

    it('9.3 deberia rechazar marcadores residuales en un campo de texto', async () => {
      // 1. Arrange 📐
      const strategy = buildStrategy();

      // 2. Act ⚙️
      const result = await strategy.execute(
        buildContext({
          headline: 'Hola {{parsed_email.clean_title}}',
          summary: 'ok',
        }),
        { contentMode: 'TEXT' },
      );

      // 3. Assert 🎯
      expect(result.error?.code).toBe(ERR_POST_IA_RESIDUAL_VARS);
      expect(result.error?.missingFields).toEqual([
        '{{parsed_email.clean_title}}',
      ]);
    });

    it('9.4 deberia fallar si el campo solo traia etiquetas', async () => {
      // 1. Arrange 📐: una inyeccion de prompt que devuelve solo un script.
      const strategy = buildStrategy();

      // 2. Act ⚙️
      const result = await strategy.execute(
        buildContext({ headline: '<script>robar()</script>', summary: 'ok' }),
        { contentMode: 'TEXT' },
      );

      // 3. Assert 🎯
      expect(result.error?.code).toBe(ERR_POST_IA_EMPTY_AFTER_SANITIZE);
    });

    it('9.5 en modo HTML deberia sugerir TEXT cuando filled_markup es nulo', async () => {
      // 1. Arrange 📐
      const strategy = buildStrategy();

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(TEXT_PAYLOAD), {});

      // 3. Assert 🎯
      expect(result.error?.code).toBe(ERR_POST_IA_EMPTY_HTML);
      expect(result.error?.message).toContain('contentMode "TEXT"');
    });

    it('9.6 deberia rechazar un contentMode desconocido', async () => {
      // 1. Arrange 📐
      const strategy = buildStrategy();

      // 2. Act ⚙️
      const result = await strategy.execute(buildContext(TEXT_PAYLOAD), {
        contentMode: 'MARKDOWN',
      });

      // 3. Assert 🎯
      expect(result.error?.code).toBe(ERR_POST_IA_CONFIG);
    });
  });

  describe('10. Lote (cardinalidad 1 a N)', () => {
    const block = (code: string): string =>
      `<div data-expediente="${code}"><h3 class="licitacion-title">Objeto ${code}</h3></div>`;

    it('10.1 deberia auditar cada elemento y publicarlo en validated_items', async () => {
      // 1. Arrange 📐
      const strategy = buildStrategy();
      const context = buildContext({
        headline: 'LIC-1',
        [SOURCE_FIELD]: block('LIC-1'),
        items: [
          { headline: 'LIC-2', summary: 'Dos', [SOURCE_FIELD]: block('LIC-2') },
          {
            headline: 'LIC-3',
            summary: 'Tres',
            [SOURCE_FIELD]: block('LIC-3'),
          },
        ],
      });

      // 2. Act ⚙️
      const result = await strategy.execute(context, {
        requiredSelectors: ['h3.licitacion-title'],
      });

      // 3. Assert 🎯: la raiz es el primero; los demas, en orden y saneados.
      const items = result.data?.validated_items as {
        validated_markup: string;
        validated_fields: Record<string, string>;
      }[];

      expect(result.success).toBe(true);
      expect(result.data?.validated_markup).toContain('Objeto LIC-1');
      expect(result.data?.validated_fields).toMatchObject({
        headline: 'LIC-1',
      });
      expect(items.map((item) => item.validated_fields.headline)).toEqual([
        'LIC-2',
        'LIC-3',
      ]);
      expect(items[1]?.validated_markup).toContain('Objeto LIC-3');
    });

    it('10.2 deberia publicar validated_items vacio con un solo elemento', async () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const result = await buildStrategy().execute(buildContext(), {});

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(result.data?.validated_items).toEqual([]);
    });

    it('10.3 deberia detener el lote entero si un elemento rompe una ranura, nombrando su ruta', async () => {
      // 1. Arrange 📐: el 2.º elemento llega sin titulo.
      const strategy = buildStrategy();
      const context = buildContext({
        [SOURCE_FIELD]: block('LIC-1'),
        items: [
          { [SOURCE_FIELD]: block('LIC-2') },
          {
            [SOURCE_FIELD]:
              '<div data-expediente="LIC-3"><h3 class="licitacion-title"></h3></div>',
          },
        ],
      });

      // 2. Act ⚙️
      const result = await strategy.execute(context, {
        requiredSelectors: ['h3.licitacion-title'],
      });

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_POST_IA_DOM_MUTATED);
      expect(result.data).toBeUndefined();
    });

    it('10.4 deberia rechazar un elemento con un marcador sin resolver, con su ruta exacta', async () => {
      // 1. Arrange 📐
      const strategy = buildStrategy();
      const context = buildContext({
        [SOURCE_FIELD]: FILLED_HTML,
        items: [{ [SOURCE_FIELD]: '<p>{{llm_response.headline}}</p>' }],
      });

      // 2. Act ⚙️
      const result = await strategy.execute(context, {});

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_POST_IA_RESIDUAL_VARS);
    });

    it('10.5 deberia vaciar de scripts el marcado de cada elemento', async () => {
      // 1. Arrange 📐
      const strategy = buildStrategy();
      const context = buildContext({
        [SOURCE_FIELD]: FILLED_HTML,
        items: [
          {
            [SOURCE_FIELD]:
              '<p>Noticia dos</p><script>alert("xss")</script><img src="x" onerror="alert(1)">',
          },
        ],
      });

      // 2. Act ⚙️
      const result = await strategy.execute(context, {});

      // 3. Assert 🎯
      const [item] = result.data?.validated_items as {
        validated_markup: string;
      }[];

      expect(result.success).toBe(true);
      expect(item?.validated_markup).toContain('Noticia dos');
      expect(item?.validated_markup).not.toContain('<script');
      expect(item?.validated_markup).not.toContain('onerror');
    });

    it('10.6 deberia auditar en modo TEXT cada elemento y nombrar el que viene vacio', async () => {
      // 1. Arrange 📐
      const strategy = buildStrategy();
      const context = buildContext({
        headline: 'EXP-1',
        summary: 'Uno',
        items: [
          { headline: '<b>EXP-2</b>', summary: 'Dos' },
          { headline: '', summary: 'Tres' },
        ],
      });

      // 2. Act ⚙️
      const result = await strategy.execute(context, { contentMode: 'TEXT' });

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_POST_IA_EMPTY_HTML);
      expect(result.error?.missingFields).toEqual([
        `${SOURCE_NAMESPACE}.items[1].headline`,
      ]);
    });

    it('10.7 deberia publicar en texto plano los campos de cada elemento en modo TEXT', async () => {
      // 1. Arrange 📐
      const strategy = buildStrategy();
      const context = buildContext({
        headline: 'EXP-1',
        summary: 'Uno',
        items: [{ headline: '<b>EXP-2</b>', summary: 'Dos' }],
      });

      // 2. Act ⚙️
      const result = await strategy.execute(context, { contentMode: 'TEXT' });

      // 3. Assert 🎯
      const [item] = result.data?.validated_items as {
        validated_fields: Record<string, string>;
      }[];

      expect(result.success).toBe(true);
      expect(item?.validated_fields).toEqual({
        headline: 'EXP-2',
        summary: 'Dos',
      });
    });
  });
});
