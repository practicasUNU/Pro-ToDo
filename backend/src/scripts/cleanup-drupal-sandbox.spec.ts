import {
  DrupalSandboxCleanupService,
  isUuid,
  normalizeHtmlForComparison,
  purgeMarkedBlocks,
  textContentOf,
} from './cleanup-drupal-sandbox';

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
});
