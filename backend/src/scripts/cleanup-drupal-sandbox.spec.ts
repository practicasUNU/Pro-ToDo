import {
  ACCORDION_PLACEHOLDER,
  COLLAPSE_PLACEHOLDER,
  DrupalSandboxCleanupService,
  findUndeployablePanelReasons,
  isUuid,
  normalizeHtmlForComparison,
  purgeMarkedBlocks,
  splitCliArgs,
  textContentOf,
} from './cleanup-drupal-sandbox';
import * as cheerio from 'cheerio';

import {
  applyCeuVisibilityRules,
  buildPurgeGuard,
  describePurgeMatches,
  describePreservedPanels,
  preserveLoneInjectedCommittee,
  restoreMissingUniversityPanels,
} from './cleanup-drupal-sandbox';

import type { PurgeGuard } from './cleanup-drupal-sandbox';
import type { DrupalApiConfig } from '@core/config/drupal-api.config';

/** Carga con las banderas CANONICAS del proyecto, como el propio script. */
const cheerioLoad = (html: string): cheerio.CheerioAPI =>
  cheerio.load(html, { xml: { xmlMode: false } }, false);

/**
 * Bloque editorial legitimo: lo que un flujo real publica.
 *
 * No lleva ningun marcador, y esa ausencia es deliberada:
 * `DrupalHttpStrategy` no estampa `data-protodo-injected` ni `data-test-id` en
 * lo que inyecta. Toda la seguridad de la purga descansa en esa asimetria, asi
 * que aqui se afirma como invariante y no como detalle.
 */
const EDITORIAL_BLOCK =
  '<div class="licitacion-entry" data-expediente="S_2026_015">' +
  '<h3>Licitacion real</h3></div>';

/** Panel que inyecta el E2E de titulos, con sus dos marcadores. */
const INJECTED_PANEL =
  '<div class="panel panel-default" data-protodo-injected="true" data-test-id="PROTODO-E2E-TITULOS">' +
  '<div class="collapse" id="collapseCEU_TEST"><p>Panel de prueba</p></div></div>';

const SELECTORS: readonly string[] = [
  '[data-protodo-injected="true"]',
  '[data-test-id="PROTODO-E2E-TITULOS"]',
  '.panel:has(#collapseCEU_TEST)',
  '#collapseCEU_TEST',
  '.licitacion-entry[data-expediente^="TEST_"]',
];

describe('purgeMarkedBlocks · poda del sandbox de Drupal', () => {
  describe('1. Retirada de lo inyectado', () => {
    it('1.1 deberia quitar el panel marcado y contarlo una sola vez', () => {
      // 1. Arrange 📐: el panel casa con CUATRO de los selectores a la vez
      //    —los dos atributos, el `:has()` y el id del cuerpo—. Contarlo cuatro
      //    veces daria un informe que no se parece a lo que paso.
      const html = `<div id="accordionCEU">${INJECTED_PANEL}</div>`;

      // 2. Act ⚙️
      const result = purgeMarkedBlocks(html, SELECTORS);

      // 3. Assert 🎯
      expect(result.purgedCount).toBe(1);
      expect(result.html).not.toContain('data-protodo-injected');
      expect(result.html).not.toContain('collapseCEU_TEST');
    });

    it('1.2 deberia quitar los bloques de licitacion de prueba por expediente', () => {
      // 1. Arrange 📐: estos no llevan atributo de rastreo porque ya existian
      //    antes del marcador; se reconocen por el prefijo del expediente.
      const html =
        '<div class="licitacion-entry" data-expediente="TEST_0001"><p>x</p></div>';

      // 2. Act ⚙️
      const result = purgeMarkedBlocks(html, SELECTORS);

      // 3. Assert 🎯
      expect(result.purgedCount).toBe(1);
      expect(result.html).not.toContain('TEST_0001');
    });
  });

  describe('2. Lo que NO se puede tocar', () => {
    it('2.1 deberia conservar intacto un bloque editorial sin marcadores', () => {
      // 1. Arrange 📐: la prueba que sostiene el diseno. Un selector de mas no
      //    falla en voz alta: borra contenido publicado del portal real y
      //    devuelve exito. Es el unico fallo de este script sin vuelta atras.
      const html = `<div id="accordionCEU">${INJECTED_PANEL}${EDITORIAL_BLOCK}</div>`;

      // 2. Act ⚙️
      const result = purgeMarkedBlocks(html, SELECTORS);

      // 3. Assert 🎯
      expect(result.purgedCount).toBe(1);
      expect(result.html).toContain('Licitacion real');
      expect(result.html).toContain('data-expediente="S_2026_015"');
    });

    it('2.2 NO deberia serializar siquiera una pagina que no tiene nada que purgar', () => {
      // 1. Arrange 📐: la idempotencia. Sin coincidencias se devuelve la cadena
      //    ORIGINAL, no la reserializada, y el llamante corta sin emitir PATCH:
      //    una pagina limpia no puede recibir la normalizacion de cheerio
      //    —`<br/>` a `<br>`, `&nbsp;` a `&#xa0;`— por el mero hecho de haberla
      //    revisado.
      const html =
        '<div id="accordionCEU"><br/>&nbsp;Contenido editorial</div>';

      // 2. Act ⚙️
      const result = purgeMarkedBlocks(html, SELECTORS);

      // 3. Assert 🎯
      expect(result.purgedCount).toBe(0);
      expect(result.html).toBe(html);
    });
  });

  describe('3. Orden de los selectores', () => {
    it('3.1 deberia llevarse el panel entero y no solo su cuerpo plegable', () => {
      // 1. Arrange 📐: el orden NO es indiferente. Si `#collapseCEU_TEST` se
      //    evaluara antes que los marcadores genericos, arrancaria el cuerpo
      //    del acordeon y dejaria publicada su cabecera huerfana.
      const html = `<div id="accordionCEU">${INJECTED_PANEL}</div>`;

      // 2. Act ⚙️
      const result = purgeMarkedBlocks(html, SELECTORS);

      // 3. Assert 🎯
      expect(result.html).not.toContain('panel-default');
      expect(result.html).toBe('<div id="accordionCEU"></div>');
    });
  });

  describe('4. Resolucion del nodo sin tocar la red', () => {
    it('4.1 deberia distinguir un UUID de un alias de ruta', () => {
      // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
      expect(isUuid('7f1700bf-b54b-4c12-b71a-8a71f1f0ee38')).toBe(true);
      expect(isUuid('/prueba-licitaciones')).toBe(false);
      expect(isUuid('prueba-verificador-titulos')).toBe(false);
    });

    it('4.2 deberia devolver un UUID pasado como alias SIN emitir peticion', () => {
      // 1. Arrange 📐: es la salida de emergencia cuando Drupal responde
      //    500 al filtrar por `path.alias`. El doble de config no tiene URL
      //    valida ni credenciales: si el metodo intentara salir a la red, el
      //    test fallaria en vez de pasar.
      const apiConfig = {
        baseUrl: 'https://no-debe-usarse.invalid/jsonapi',
        authHeader: 'Basic x',
        timeoutMs: 1,
      } as DrupalApiConfig;
      const service = new DrupalSandboxCleanupService(apiConfig);

      // 2. Act ⚙️ + 3. Assert 🎯
      return expect(
        service.resolveNodeUuidByAlias('7f1700bf-b54b-4c12-b71a-8a71f1f0ee38'),
      ).resolves.toBe('7f1700bf-b54b-4c12-b71a-8a71f1f0ee38');
    });
  });

  describe('5. Comparacion contra la linea base', () => {
    it('5.1 deberia igualar las TRES formas del espacio duro', () => {
      // 1. Arrange 📐: la trampa del caso. Cheerio serializa a `&#xa0;` y
      //    no a `&nbsp;`, asi que normalizar solo la entidad con nombre dejaria
      //    la diferencia intacta y la prueba fallaria sin que nada este mal.
      const conEntidad = '<p>Hola&nbsp;mundo</p>';
      const conNumerica = '<p>Hola&#xa0;mundo</p>';
      const conLiteral = '<p>Hola\u00a0mundo</p>';

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(normalizeHtmlForComparison(conEntidad)).toBe(
        normalizeHtmlForComparison(conNumerica),
      );
      expect(normalizeHtmlForComparison(conLiteral)).toBe(
        normalizeHtmlForComparison(conNumerica),
      );
    });

    it('5.2 deberia colapsar saltos de linea y sangrias', () => {
      // 1. Arrange 📐: Drupal reindenta al guardar, y eso no es un fallo.
      const compacto = '<div><p>Uno</p><p>Dos</p></div>';
      const indentado = '<div>\n  <p>Uno</p>\n  <p>Dos</p>\n</div>';

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(normalizeHtmlForComparison(indentado)).toBe(
        normalizeHtmlForComparison(compacto),
      );
    });

    it('5.3 deberia acortar el texto plano cuando desaparece un bloque', () => {
      // 1. Arrange 📐: es la medida que sostiene el tramo 2 del E2E. La
      //    cosmetica no cambia lo que se lee; un borrado si, y es el unico
      //    fallo irreversible que puede cometer la purga.
      const completo = `<div>${EDITORIAL_BLOCK}<p>Pie de pagina</p></div>`;
      const mutilado = '<div><p>Pie de pagina</p></div>';

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(textContentOf(mutilado).length).toBeLessThan(
        textContentOf(completo).length,
      );
      // Y la reindentacion NO acorta: si lo hiciera, el tramo 2 daria falsos
      // positivos en cada corrida.
      expect(textContentOf('<div>\n  <p>Uno</p>\n</div>')).toBe(
        textContentOf('<div><p>Uno</p></div>'),
      );
    });
  });

  /**
   * El fallo que no ve nadie mas: un panel que se publica entero, pasa el
   * escudo y no despliega al pulsarlo.
   */
  describe('6. Panel desplegable', () => {
    const buildPanel = (href: string, id: string): string =>
      `<div class="panel panel-default"><div class="panel-heading"><h5 class="panel-title">` +
      `<a class="panel-toggle-link" href="${href}" data-bs-toggle="collapse">CEU 1</a>` +
      `</h5></div><div class="collapse" id="${id}"><p>Contenido</p></div></div>`;

    it('6.1 no deberia objetar nada a un panel cuyo enlace y contenedor casan', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const reasons = findUndeployablePanelReasons(
        buildPanel('#collapseESIC1', 'collapseESIC1'),
      );

      // 3. Assert 🎯
      expect(reasons).toEqual([]);
    });

    it('6.2 deberia delatar el placeholder que el modelo no sustituyo', () => {
      // 1. Arrange 📐: el enlace y el contenedor CASAN entre si, de modo que
      //    sin la comprobacion del literal el panel pareceria correcto. Lo que
      //    esta mal es que los dos paneles de la pagina compartirian id.
      const reasons = findUndeployablePanelReasons(
        buildPanel(`#${COLLAPSE_PLACEHOLDER}`, COLLAPSE_PLACEHOLDER),
      );

      // 3. Assert 🎯
      expect(reasons.join(' ')).toContain(COLLAPSE_PLACEHOLDER);
    });

    it('6.3 deberia delatar un href que no casa con ningun contenedor', () => {
      // 1. Arrange 📐 + 2. Act ⚙️: un digito de diferencia basta.
      const reasons = findUndeployablePanelReasons(
        buildPanel('#collapseESIC1', 'collapseESIC2'),
      );

      // 3. Assert 🎯
      expect(reasons.join(' ')).toContain('ningun ".collapse"');
    });

    it('6.4 deberia delatar un panel sin enlace de despliegue', () => {
      // 1. Arrange 📐: el modelo se comio la etiqueta entera.
      const reasons = findUndeployablePanelReasons(
        '<div class="panel panel-default"><div class="collapse" id="x"></div></div>',
      );

      // 3. Assert 🎯
      expect(reasons.join(' ')).toContain('panel-toggle-link');
    });

    it('6.5 deberia delatar un href que apunta fuera de la pagina', () => {
      // 1. Arrange 📐: un enlace absoluto no despliega nada; navega.
      const reasons = findUndeployablePanelReasons(
        buildPanel('https://www.madrimasd.org/panel', 'collapseESIC1'),
      );

      // 3. Assert 🎯
      expect(reasons.join(' ')).toContain('fragmento');
    });

    it('6.6 no deberia estallar con un id que lleva caracteres reservados por CSS', () => {
      // 1. Arrange 📐: se busca por atributo y no con el selector de id, porque
      //    un `#collapse.CEU:1` haria estallar el selector y el fallo saldria
      //    como una excepcion de cheerio en vez de como un motivo legible.
      const reasons = findUndeployablePanelReasons(
        buildPanel('#collapse.CEU:1', 'collapse.CEU:1'),
      );

      // 3. Assert 🎯
      expect(reasons).toEqual([]);
    });

    it('6.7 deberia cazar el acordeon de la universidad sin sustituir', () => {
      // 1. Arrange 📐: mismo modo de fallo que el placeholder del colapsable,
      //    un nivel mas arriba. El panel se publica bien formado y el escudo lo
      //    aprueba, pero la estrategia no encuentra el sub-acordeon y el comite
      //    no llega a su universidad.
      const markup =
        '<div class="panel panel-default"><div class="panel-heading"><h5 class="panel-title">' +
        `<a class="panel-toggle-link" href="#collapseUAM9" data-parent="${ACCORDION_PLACEHOLDER}" data-bs-toggle="collapse">UAM 9</a>` +
        '</h5></div><div class="collapse" id="collapseUAM9"><p>Contenido</p></div></div>';

      // 2. Act ⚙️
      const reasons = findUndeployablePanelReasons(markup);

      // 3. Assert 🎯
      expect(reasons).toHaveLength(1);
      expect(reasons[0]).toContain(ACCORDION_PLACEHOLDER);
    });

    it('6.8 NO deberia quejarse de un acordeon ya asignado', () => {
      // 1. Arrange 📐: el camino feliz del despacho jerarquico.
      const markup =
        '<div class="panel panel-default"><div class="panel-heading"><h5 class="panel-title">' +
        '<a class="panel-toggle-link" href="#collapseUAM9" data-parent="#accordionUAM" data-bs-toggle="collapse">UAM 9</a>' +
        '</h5></div><div class="collapse" id="collapseUAM9"><p>Contenido</p></div></div>';

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(findUndeployablePanelReasons(markup)).toEqual([]);
    });
  });
});

describe('7. Residuo del panel de titulos duplicado', () => {
  /** Los dos selectores que la purga gana para este residuo. */
  const DUPLICATE_SELECTORS: readonly string[] = [
    '.panel:has(#collapseUFV1Duplicado)',
    '#collapseUFV1Duplicado',
  ];

  /** El duplicado dejado a mano sobre el acordeon de titulos. */
  const DUPLICATE_PANEL =
    '<div class="panel panel-default">' +
    '<div class="collapse" id="collapseUFV1Duplicado"><p>Copia a mano</p></div></div>';

  /** Panel legitimo del mismo acordeon, sin marcador de prueba. */
  const LEGIT_PANEL =
    '<div class="panel panel-default">' +
    '<div class="collapse" id="collapseUFV2"><p>Comite real</p></div></div>';

  it('7.1 deberia retirar el panel duplicado ENTERO', () => {
    // 1. Arrange 📐: el `.panel:has(...)` se lleva el envoltorio, no solo el
    //    cuerpo. Quitar unicamente el `#collapse...` dejaria publicada una
    //    cabecera huerfana, que es el mismo fallo que razona el orden de
    //    `DEFAULT_PURGE_SELECTORS` para `#collapseCEU_TEST`.
    const html = `<div id="accordionUFV">${DUPLICATE_PANEL}</div>`;

    // 2. Act ⚙️
    const result = purgeMarkedBlocks(html, DUPLICATE_SELECTORS);

    // 3. Assert 🎯
    expect(result.purgedCount).toBeGreaterThan(0);
    expect(result.html).toBe('<div id="accordionUFV"></div>');
  });

  it('7.2 NO deberia tocar el panel legitimo vecino', () => {
    // 1. Arrange 📐: la asimetria de la que depende toda la purga. El residuo
    //    se identifica por su identificador concreto, no por ser un `.panel`.
    const html = `<div id="accordionUFV">${DUPLICATE_PANEL}${LEGIT_PANEL}</div>`;

    // 2. Act ⚙️
    const result = purgeMarkedBlocks(html, DUPLICATE_SELECTORS);

    // 3. Assert 🎯
    expect(result.html).toContain('collapseUFV2');
    expect(result.html).toContain('Comite real');
    expect(result.html).not.toContain('collapseUFV1Duplicado');
  });

  it('7.3 deberia cubrir el cuerpo suelto sin su envoltorio', () => {
    // 1. Arrange 📐: por eso los selectores van por pares. Una purga anterior
    //    —o la edicion a mano— pudo dejar el `.collapse` sin su `.panel`.
    const html =
      '<div id="accordionUFV">' +
      '<div class="collapse" id="collapseUFV1Duplicado"><p>Huerfano</p></div>' +
      '</div>';

    // 2. Act ⚙️
    const result = purgeMarkedBlocks(html, DUPLICATE_SELECTORS);

    // 3. Assert 🎯
    expect(result.purgedCount).toBe(1);
    expect(result.html).toBe('<div id="accordionUFV"></div>');
  });
});

describe('8. describePurgeMatches · inventario del simulacro', () => {
  it('8.1 deberia desglosar las coincidencias POR SELECTOR', () => {
    // 1. Arrange 📐: un recuento total no sirve para decidir. Lo que el
    //    operador necesita saber es CUAL selector esta mordiendo.
    const html =
      '<div class="licitacion-entry" data-expediente="S_2026_015"></div>' +
      '<div class="collapse" id="collapseUFV1Duplicado"></div>';

    // 2. Act ⚙️
    const matches = describePurgeMatches(html, [
      '#collapseUFV1Duplicado',
      '.licitacion-entry',
      '[data-protodo-injected="true"]',
    ]);

    // 3. Assert 🎯: los que no casan NO aparecen; un inventario lleno de ceros
    //    esconde las dos lineas que importan.
    expect(matches).toEqual([
      { selector: '#collapseUFV1Duplicado', matches: 1 },
      { selector: '.licitacion-entry', matches: 1 },
    ]);
  });

  it('8.2 no deberia MUTAR el documento', () => {
    // 1. Arrange 📐: es la mitad entera de su razon de ser.
    const html = '<div class="collapse" id="collapseUFV1Duplicado"></div>';

    // 2. Act ⚙️
    describePurgeMatches(html, ['#collapseUFV1Duplicado']);

    // 3. Assert 🎯
    expect(purgeMarkedBlocks(html, []).html).toBe(html);
  });

  it('8.3 deberia contar SIN el solapamiento que aplica la purga', () => {
    // 1. Arrange 📐: `purgeMarkedBlocks` va quitando a medida que recorre, de
    //    modo que un selector generico desconecta los nodos que el siguiente
    //    habria contado. Aqui los dos selectores ven el mismo panel, y por eso
    //    la suma del inventario puede superar al `purgedCount` real.
    const html =
      '<div class="panel panel-default">' +
      '<div class="collapse" id="collapseUFV1Duplicado"></div></div>';
    const selectors = [
      '.panel:has(#collapseUFV1Duplicado)',
      '#collapseUFV1Duplicado',
    ];

    // 2. Act ⚙️
    const inventory = describePurgeMatches(html, selectors);
    const purged = purgeMarkedBlocks(html, selectors);

    // 3. Assert 🎯
    expect(inventory).toHaveLength(2);
    expect(purged.purgedCount).toBe(1);
  });
});

describe('9. splitCliArgs · banderas frente a posicionales', () => {
  it('9.1 deberia reconocer --dry-run en TERCERA posicion', () => {
    // 1. Arrange 📐: el fallo que esta funcion evita. Los dos argumentos reales
    //    son posicionales, de modo que sin separar banderas el `--dry-run` se
    //    tomaria como selector CSS, no casaria con nada y la purga se
    //    ejecutaria igual: lo contrario de lo que se acaba de pedir.
    // 2. Act ⚙️
    const { positionals, flags } = splitCliArgs([
      '/prueba-verificador-titulos',
      '--dry-run',
    ]);

    // 3. Assert 🎯
    expect(positionals).toEqual(['/prueba-verificador-titulos']);
    expect(flags.has('--dry-run')).toBe(true);
  });

  it('9.2 deberia conservar el selector adicional junto a la bandera', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const { positionals, flags } = splitCliArgs([
      '--dry-run',
      '/prueba-licitaciones',
      '.mi-selector',
    ]);

    // 3. Assert 🎯: la bandera se reconoce en CUALQUIER posicion, y no desplaza
    //    a los posicionales que la rodean.
    expect(positionals).toEqual(['/prueba-licitaciones', '.mi-selector']);
    expect(flags.has('--dry-run')).toBe(true);
  });

  it('9.3 deberia dejar las banderas fuera sin inventar posicionales', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const { positionals, flags } = splitCliArgs([]);

    // 3. Assert 🎯
    expect(positionals).toEqual([]);
    expect(flags.size).toBe(0);
  });
});

describe('10. Acotamiento al segundo nivel del acordeon', () => {
  /**
   * La pagina agregadora, en miniatura: acordeon raiz -> panel de universidad
   * -> sub-acordeon -> panel de comite. Los DOS niveles de panel llevan la
   * misma clase `.panel`, que es de donde salio el incidente.
   */
  const TWO_LEVEL_PAGE =
    '<div class="panel-group" id="accordion">' +
    '<div class="panel panel-default">' +
    '<div class="panel-heading"><h4 class="panel-title">' +
    '<a href="#collapseESIC" data-parent="#accordion">ESIC Universidad</a></h4></div>' +
    '<div class="collapse" id="collapseESIC"><div class="panel-body">' +
    '<div class="panel-group" id="accordionESIC">' +
    '<div class="panel panel-default"><div class="panel-heading"><h5 class="panel-title">' +
    '<a class="panel-toggle-link" href="#collapseESIC1" data-parent="#accordionESIC">' +
    '<strong class="panel-comite-codigo">ESIC 1</strong></a></h5></div>' +
    '<div class="collapse" id="collapseESIC1"><p>Inyectado</p></div></div>' +
    '<div class="panel panel-default"><div class="panel-heading"><h5 class="panel-title">' +
    '<a href="#collapseESIC9"><strong>ESIC 9</strong></a></h5></div>' +
    '<div class="collapse" id="collapseESIC9"><p>Nativo</p></div></div>' +
    '</div></div></div></div></div>';

  const SCOPED = '.panel-group .panel-group > .panel';

  it('10.1 NUNCA deberia casar con un panel de universidad', () => {
    // 1. Arrange 📐: LA REGRESION DE ESTE INCIDENTE. El selector anterior era
    //    `.panel:has(#collapseESIC1)`, que casa tambien con el panel de la
    //    universidad —lleva la misma clase— y `.remove()` se llevo el
    //    contenedor entero. ESIC desaparecio de la pagina por esto.
    const html = TWO_LEVEL_PAGE;

    // 2. Act ⚙️: guard neutro a proposito. Este bloque verifica el ACOTADO del
    //    selector; la preservacion tiene los suyos en el bloque 12, y dejarla
    //    activa aqui mezclaria las dos razones por las que un panel sobrevive.
    const result = purgeMarkedBlocks(
      html,
      [
        `${SCOPED}:has(a.panel-toggle-link)`,
        `${SCOPED}:has(.panel-comite-codigo)`,
      ],
      () => false,
    );

    // 3. Assert 🎯: la universidad sigue en pie y su sub-acordeon tambien.
    expect(result.html).toContain('ESIC Universidad');
    expect(result.html).toContain('id="accordionESIC"');
    expect(result.html).toContain('id="collapseESIC"');
  });

  it('10.2 deberia quitar el comite INYECTADO y dejar el nativo', () => {
    // 1. Arrange 📐: la asimetria de la que depende todo. `panel-toggle-link` y
    //    `panel-comite-codigo` son clases de NUESTRA plantilla; los paneles que
    //    ya estaban en el portal no las llevan.
    // 2. Act ⚙️: guard neutro, por el mismo motivo que en 10.1.
    const result = purgeMarkedBlocks(
      TWO_LEVEL_PAGE,
      [`${SCOPED}:has(a.panel-toggle-link)`],
      () => false,
    );

    // 3. Assert 🎯
    expect(result.purgedCount).toBe(1);
    expect(result.html).not.toContain('Inyectado');
    expect(result.html).toContain('Nativo');
    expect(result.html).toContain('ESIC 9');
  });

  it('10.3 el selector sin acotar SI se llevaria la universidad', () => {
    // 1. Arrange 📐: se deja escrito el comportamiento del selector retirado,
    //    para que nadie lo reintroduzca creyendo que era equivalente.
    // 2. Act ⚙️
    const sinAcotar = purgeMarkedBlocks(
      TWO_LEVEL_PAGE,
      ['.panel:has(.panel-comite-codigo)'],
      () => false,
    );

    // 3. Assert 🎯
    expect(sinAcotar.html).not.toContain('ESIC Universidad');
  });
});

describe('11. restoreMissingUniversityPanels', () => {
  const PANEL = {
    title: 'ESIC Universidad',
    html:
      '<div class="panel panel-default"><div class="panel-heading">' +
      '<h4 class="panel-title"><a href="#collapseESIC">ESIC Universidad</a>' +
      '</h4></div></div>',
  };

  const OTHER =
    '<div class="panel panel-default"><div class="panel-heading">' +
    '<h4 class="panel-title"><a href="#collapseUFV">Universidad Francisco de Vitoria</a>' +
    '</h4></div></div>';

  it('11.1 deberia reponer el panel que falta', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const result = restoreMissingUniversityPanels(
      `<div id="accordion">${OTHER}</div>`,
      [PANEL],
    );

    // 3. Assert 🎯
    expect(result.restored).toEqual(['ESIC Universidad']);
    expect(result.html).toContain('ESIC Universidad');
    expect(result.html).toContain('Universidad Francisco de Vitoria');
  });

  it('11.2 deberia ser IDEMPOTENTE', () => {
    // 1. Arrange 📐: es lo unico que hace seguro llamarla en cada corrida.
    const once = restoreMissingUniversityPanels('<div id="accordion"></div>', [
      PANEL,
    ]);

    // 2. Act ⚙️
    const twice = restoreMissingUniversityPanels(once.html, [PANEL]);

    // 3. Assert 🎯
    expect(twice.restored).toEqual([]);
    expect(twice.html).toBe(once.html);
    expect(twice.html.match(/ESIC Universidad/g)).toHaveLength(1);
  });

  it('11.3 NO deberia reponer un panel que ya esta, aunque falte otro', () => {
    // 1. Arrange 📐: el fallo de preguntar "¿falta alguno?" sobre el conjunto.
    //    Con un `||`, faltando ESIC se reinyectaria tambien UFV, que esta, y la
    //    pagina acabaria con dos Francisco de Vitoria.
    const ufvPanel = { title: 'Universidad Francisco de Vitoria', html: OTHER };

    // 2. Act ⚙️
    const result = restoreMissingUniversityPanels(
      `<div id="accordion">${OTHER}</div>`,
      [ufvPanel, PANEL],
    );

    // 3. Assert 🎯
    expect(result.restored).toEqual(['ESIC Universidad']);
    expect(result.html.match(/Universidad Francisco de Vitoria/g)).toHaveLength(
      1,
    );
  });

  it('11.4 no deberia inventar la estructura si no hay #accordion', () => {
    // 1. Arrange 📐: repone lo que falta DENTRO de algo que existe; construir
    //    el acordeon seria inventarse la pagina.
    const html = '<p>Una pagina cualquiera</p>';

    // 2. Act ⚙️
    const result = restoreMissingUniversityPanels(html, [PANEL]);

    // 3. Assert 🎯
    expect(result.restored).toEqual([]);
    expect(result.html).toBe(html);
  });

  it('11.5 el catalogo por defecto deberia reponer SOLO ESIC', () => {
    // 1. Arrange 📐: Francisco de Vitoria sigue publicada. Incluirla "por
    //    simetria" la duplicaria.
    // 2. Act ⚙️
    const result = restoreMissingUniversityPanels('<div id="accordion"></div>');

    // 3. Assert 🎯
    expect(result.restored).toEqual(['ESIC Universidad']);
    expect(result.html).toContain('id="accordionESIC"');
    expect(result.html).not.toContain('accordionUFV');
  });
});

describe('12. Preservacion del comite sin gemelo nativo', () => {
  const SCOPED = '.panel-group .panel-group > .panel';
  const PURGE = [`${SCOPED}:has(a.panel-toggle-link)`];

  /** Panel tal y como lo emite la plantilla de Proto-Do. */
  const injected = (code: string): string =>
    '<div class="panel panel-default"><div class="panel-heading">' +
    '<h5 class="panel-title"><a class="panel-toggle-link" ' +
    `href="#collapse${code.replace(/\s/g, '')}">` +
    `<strong class="panel-comite-codigo">${code}</strong></a></h5></div>` +
    `<div class="collapse" id="collapse${code.replace(/\s/g, '')}">` +
    '<table class="tableform"><tbody><tr><th>Titulacion</th></tr></tbody></table>' +
    '</div></div>';

  /** El mismo comite, pero como lo tiene el portal: sin clases de plantilla y
   *  con el codigo separado del centro por un ESPACIO DURO. */
  const native = (code: string): string =>
    '<div class="panel panel-default"><div class="panel-heading">' +
    `<h5 class="panel-title"><a href="#collapse${code.replace(/\s/g, '')}Nat">` +
    `<strong>${code}&nbsp;</strong> Centro</a></h5></div></div>`;

  const page = (accordion: string, inner: string): string =>
    `<div class="panel-group" id="accordion"><div class="panel panel-default">` +
    `<div class="panel-group" id="${accordion}">${inner}</div></div></div>`;

  it('12.1 deberia purgar los duplicados y PRESERVAR el que no tiene gemelo', () => {
    // 1. Arrange 📐: UAM 9 y UPM 4 inyectados tienen copia nativa al lado;
    //    ESIC 2 no. Retirar ESIC 2 no seria limpiar, seria despublicar el unico
    //    ejemplar del comite.
    const html =
      page('accordionUAM', injected('UAM 9') + native('UAM 9')) +
      page('accordionUPM', injected('UPM 4') + native('UPM 4')) +
      page('accordionESIC', injected('ESIC 2'));

    // 2. Act ⚙️
    const result = purgeMarkedBlocks(html, PURGE);

    // 3. Assert 🎯
    expect(result.purgedCount).toBe(2);
    expect(result.html).toContain('id="collapseESIC2"');
    expect(result.html).toContain('tableform');
    expect(result.html).not.toContain('id="collapseUAM9"');
    expect(result.html).not.toContain('id="collapseUPM4"');
    // Las copias nativas siguen enteras.
    expect(result.html).toContain('collapseUAM9Nat');
    expect(result.html).toContain('collapseUPM4Nat');
  });

  it('12.2 deberia purgar ESIC 2 EN CUANTO exista su gemelo nativo', () => {
    // 1. Arrange 📐: lo que distingue una regla de una lista cableada. Con
    //    `#collapseESIC2` fijo en una constante, este panel quedaria blindado
    //    para siempre, tambien cuando ya fuese un duplicado mas.
    const html = page('accordionESIC', injected('ESIC 2') + native('ESIC 2'));

    // 2. Act ⚙️
    const result = purgeMarkedBlocks(html, PURGE);

    // 3. Assert 🎯
    expect(result.purgedCount).toBe(1);
    expect(result.html).not.toContain('id="collapseESIC2"');
    expect(result.html).toContain('collapseESIC2Nat');
  });

  it('12.3 deberia plegar el espacio duro al comparar codigos', () => {
    // 1. Arrange 📐: el portal separa el codigo del centro con `&nbsp;`. Sin
    //    normalizarlo, "ESIC 2\u00a0" y "ESIC 2" son cadenas distintas y el
    //    panel no reconoceria a su propio gemelo: se preservaria un duplicado.
    const html = page('accordionESIC', injected('ESIC 2') + native('ESIC 2'));
    const $ = cheerioLoad(html);
    const panel = $(`${SCOPED}:has(a.panel-toggle-link)`).first();

    // 2. Act ⚙️ + 3. Assert 🎯
    expect(preserveLoneInjectedCommittee($, panel.get(0)!)).toBe(false);
  });

  it('12.4 NO deberia opinar sobre bloques que no son paneles de comite', () => {
    // 1. Arrange 📐: `purgeMarkedBlocks` la comparten las rutas de licitaciones
    //    y Notiweb. El guard debe callarse ahi y dejar mandar al selector.
    const html =
      '<div class="licitacion-entry" data-expediente="TEST_1">x</div>';

    // 2. Act ⚙️
    const result = purgeMarkedBlocks(html, [
      '.licitacion-entry[data-expediente^="TEST_"]',
    ]);

    // 3. Assert 🎯
    expect(result.purgedCount).toBe(1);
    expect(result.html).not.toContain('licitacion-entry');
  });

  it('12.5 deberia admitir selectores de exclusion manuales', () => {
    // 1. Arrange 📐: la escotilla para la incidencia puntual que no merece un
    //    despliegue. UAM 9 tiene gemelo, asi que la regla lo purgaria.
    const html = page('accordionUAM', injected('UAM 9') + native('UAM 9'));

    // 2. Act ⚙️
    const result = purgeMarkedBlocks(
      html,
      PURGE,
      buildPurgeGuard(['.panel:has(#collapseUAM9)']),
    );

    // 3. Assert 🎯
    expect(result.purgedCount).toBe(0);
    expect(result.html).toContain('id="collapseUAM9"');
  });

  it('12.6 deberia NOMBRAR lo que preserva, no solo contarlo', () => {
    // 1. Arrange 📐: la pregunta del operador es "¿seguro que no te llevas el
    //    comite bueno?", y solo se responde nombrandolo.
    const html = page('accordionESIC', injected('ESIC 2'));

    // 2. Act ⚙️
    const preserved = describePreservedPanels(
      html,
      PURGE,
      preserveLoneInjectedCommittee,
    );

    // 3. Assert 🎯
    expect(preserved).toEqual(['ESIC 2']);
  });
});

describe('13. Visibilidad de CEU', () => {
  /** Padre de universidad con su comite dentro, como el portal lo sirve. */
  const CEU_PAGE =
    '<div class="panel-group" id="accordion">' +
    '<div class="panel panel-default"><div class="panel-heading">' +
    '<h4 class="panel-title"><a href="#collapseCEU" aria-expanded="true">' +
    'Universidad San Pablo CEU</a></h4></div>' +
    '<div class="collapse show" id="collapseCEU"><div class="panel-body">' +
    '<div class="panel-group" id="accordionCEU">' +
    '<div class="panel panel-default"><div class="panel-heading">' +
    '<h5 class="panel-title"><a href="#collapseCEUD1"><strong>CEU D1</strong></a>' +
    '</h5></div><div class="collapse" id="collapseCEUD1"><p>Doctorado</p></div></div>' +
    '<div class="panel panel-default"><div class="collapse" id="collapseCEU1">' +
    '<p>Otro comite</p></div></div>' +
    '</div></div></div></div></div>';

  it('13.1 deberia ocultar CEU D1 y plegar el acordeon padre', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const result = applyCeuVisibilityRules(CEU_PAGE);
    const $ = cheerioLoad(result.html);

    // 3. Assert 🎯
    expect(
      $('.panel-group .panel-group > .panel:has(#collapseCEUD1)').hasClass(
        'd-none',
      ),
    ).toBe(true);
    expect($('#collapseCEU').hasClass('show')).toBe(false);
    expect($('a[href="#collapseCEU"]').attr('aria-expanded')).toBe('false');
    expect($('a[href="#collapseCEU"]').hasClass('collapsed')).toBe(true);
  });

  it('13.2 NUNCA deberia ocultar el panel de la universidad', () => {
    // 1. Arrange 📐: LA REGRESION. `.panel:has(#collapseCEUD1)` casa tambien
    //    con `Universidad San Pablo CEU`, que lleva la misma clase y contiene
    //    el comite. Sin acotar al segundo nivel, este `addClass` esconde la
    //    universidad entera con todos sus comites: el mismo mecanismo que, con
    //    `remove()`, ya borro el panel de ESIC de esta pagina.
    // 2. Act ⚙️
    const $ = cheerioLoad(applyCeuVisibilityRules(CEU_PAGE).html);

    // 3. Assert 🎯
    const universityPanel = $('#accordion > .panel').first();

    expect(universityPanel.hasClass('d-none')).toBe(false);
    expect($('#collapseCEU1').length).toBe(1);
  });

  it('13.3 deberia ser IDEMPOTENTE y no reportar cambios la segunda vez', () => {
    // 1. Arrange 📐: el script corre en cada limpieza; lo que no cambia no debe
    //    provocar un PATCH.
    const once = applyCeuVisibilityRules(CEU_PAGE);

    // 2. Act ⚙️
    const twice = applyCeuVisibilityRules(once.html);

    // 3. Assert 🎯
    expect(twice.changes).toEqual([]);
    expect(twice.html).toBe(once.html);
    expect(once.html.match(/d-none/g)).toHaveLength(1);
  });

  it('13.4 no deberia tocar una pagina sin CEU', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const html = '<div class="panel-group" id="accordion"></div>';
    const result = applyCeuVisibilityRules(html);

    // 3. Assert 🎯
    expect(result.changes).toEqual([]);
    expect(result.html).toBe(html);
  });
});

describe('14. Reset total (--all)', () => {
  const SCOPED = '.panel-group .panel-group > .panel';
  const PURGE = [`${SCOPED}:has(a.panel-toggle-link)`];

  /** Guard neutro: el mismo que `--all` pasa al servicio. Nada se preserva. */
  const NEUTRAL_GUARD: PurgeGuard = () => false;

  /** Panel tal y como lo emite la plantilla de Proto-Do. */
  const injected = (code: string): string =>
    '<div class="panel panel-default"><div class="panel-heading">' +
    '<h5 class="panel-title"><a class="panel-toggle-link" ' +
    `href="#collapse${code.replace(/\s/g, '')}">` +
    `<strong class="panel-comite-codigo">${code}</strong></a></h5></div>` +
    `<div class="collapse" id="collapse${code.replace(/\s/g, '')}"></div></div>`;

  const page = (accordion: string, inner: string): string =>
    `<div class="panel-group" id="accordion"><div class="panel panel-default">` +
    `<div class="panel-group" id="${accordion}">${inner}</div></div></div>`;

  it('14.1 deberia purgar el comite que la heuristica preservaria', () => {
    // 1. Arrange 📐: ESIC 2 no tiene gemelo nativo, de modo que la regla de
    //    serie lo salva. Es justo lo que `--all` viene a desactivar: en un
    //    reset total del sandbox, "es la unica copia" deja de ser una razon
    //    para conservarlo, porque lo que se quiere es la pagina sin rastro.
    const html = page('accordionESIC', injected('ESIC 2'));

    // 2. Act ⚙️
    const result = purgeMarkedBlocks(html, PURGE, NEUTRAL_GUARD);

    // 3. Assert 🎯
    expect(result.purgedCount).toBe(1);
    expect(result.html).not.toContain('collapseESIC2');
  });

  it('14.2 el guard de SERIE deberia seguir preservandolo', () => {
    // 1. Arrange 📐: la contrapartida de 14.1, y la que protege el defecto. Sin
    //    esta, un cambio que dejara el guard neutro siempre activo pasaria
    //    inadvertido.
    const html = page('accordionESIC', injected('ESIC 2'));

    // 2. Act ⚙️
    const result = purgeMarkedBlocks(html, PURGE, buildPurgeGuard());

    // 3. Assert 🎯
    expect(result.purgedCount).toBe(0);
    expect(result.html).toContain('collapseESIC2');
  });

  it('14.3 deberia vaciar TODAS las inyecciones de varias universidades', () => {
    // 1. Arrange 📐: el caso real del reset. Ninguno tiene gemelo nativo, asi
    //    que con la heuristica activa no se purgaria ni uno.
    const html =
      page('accordionUAM', injected('UAM 9')) +
      page('accordionUPM', injected('UPM 4')) +
      page('accordionESIC', injected('ESIC 2'));

    // 2. Act ⚙️
    const result = purgeMarkedBlocks(html, PURGE, NEUTRAL_GUARD);

    // 3. Assert 🎯
    expect(result.purgedCount).toBe(3);
    expect(result.html).not.toContain('panel-comite-codigo');
  });

  it('14.4 NO deberia tocar los paneles de universidad contenedores', () => {
    // 1. Arrange 📐: `--all` desactiva la preservacion de comites, no el
    //    acotamiento al segundo nivel. La pagina se queda sin inyecciones,
    //    pero con su estructura de universidades intacta (docs/commands.md §6.4).
    const html = page('accordionESIC', injected('ESIC 2'));

    // 2. Act ⚙️
    const result = purgeMarkedBlocks(html, PURGE, NEUTRAL_GUARD);

    // 3. Assert 🎯
    expect(result.html).toContain('id="accordionESIC"');
    expect(result.html).toContain('id="accordion"');
  });
});
