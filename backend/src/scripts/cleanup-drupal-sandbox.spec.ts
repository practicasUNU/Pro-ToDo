import { purgeMarkedBlocks } from './cleanup-drupal-sandbox';

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
});
