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
import { describePurgeMatches } from './cleanup-drupal-sandbox';

import type { DrupalApiConfig } from '@core/config/drupal-api.config';

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
