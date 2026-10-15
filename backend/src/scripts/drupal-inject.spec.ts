import * as cheerio from 'cheerio';

import {
  injectMarkup,
  inspectTarget,
  parseFlags,
  resolveMarkup,
} from './drupal-inject';

/** Carga con las banderas CANONICAS del proyecto, como el script. */
const cheerioLoad = (html: string): cheerio.CheerioAPI =>
  cheerio.load(html, { xml: { xmlMode: false } }, false);

/** Bloque a inyectar, reconocible en las aserciones. */
const BLOCK = '<div class="panel panel-default" id="nuevo">ESIC 2</div>';

/** Acordeon de universidad con un comite ya dentro. */
const PAGE =
  '<div class="panel-group" id="accordion">' +
  '<div class="panel-group" id="accordionESIC">' +
  '<div class="panel" id="existente">ESIC 1</div>' +
  '</div></div>';

const UUID = 'b17d69d8-6998-4883-b8dc-153b55dbd9c5';

describe('drupal-inject · inyeccion de marcado', () => {
  describe('1. Banderas', () => {
    it('1.1 deberia SIMULAR por defecto', () => {
      // 1. Arrange 📐: la decision de seguridad de la herramienta, igual que en
      //    `drupal:clean`. Un olvido de bandera no puede publicar en el portal.
      // 2. Act ⚙️ + 3. Assert 🎯
      expect(parseFlags([`--uuid=${UUID}`, '--html=<p></p>']).write).toBe(
        false,
      );
    });

    it('1.2 solo --write deberia habilitar el PATCH', () => {
      // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
      expect(
        parseFlags([`--uuid=${UUID}`, '--html=<p></p>', '--write']).write,
      ).toBe(true);
    });

    it('1.3 --dry-run deberia CANCELAR un --write simultaneo', () => {
      // 1. Arrange 📐: ante dos banderas contradictorias gana la que no escribe.
      // 2. Act ⚙️ + 3. Assert 🎯
      expect(parseFlags([`--uuid=${UUID}`, '--write', '--dry-run']).write).toBe(
        false,
      );
    });

    it('1.4 deberia aplicar los defectos de --target y --mode', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const flags = parseFlags([`--uuid=${UUID}`, '--html=<p></p>']);

      // 3. Assert 🎯
      expect(flags.target).toBe('#accordion');
      expect(flags.mode).toBe('append');
    });

    it('1.5 deberia RECHAZAR un modo desconocido', () => {
      // 1. Arrange 📐: un `--mode=apend` mal tecleado no puede degradarse en
      //    silencio al defecto; el operador pidio algo concreto.
      // 2. Act ⚙️ + 3. Assert 🎯
      expect(() =>
        parseFlags([`--uuid=${UUID}`, '--html=<p></p>', '--mode=apend']),
      ).toThrow('--mode debe ser uno de');
    });

    it('1.6 NO deberia recortar el marcado de --html', () => {
      // 1. Arrange 📐: los espacios de un marcado ajeno pueden ser deliberados.
      // 2. Act ⚙️
      const flags = parseFlags([`--uuid=${UUID}`, '--html=  <p></p>  ']);

      // 3. Assert 🎯
      expect(flags.html).toBe('  <p></p>  ');
    });
  });

  describe('2. Origen del marcado', () => {
    it('2.1 deberia tomar el marcado de --html', () => {
      // 1. Arrange 📐
      const flags = parseFlags([`--uuid=${UUID}`, `--html=${BLOCK}`]);

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(resolveMarkup(flags)).toBe(BLOCK);
    });

    it('2.2 deberia leer el marcado de --file', () => {
      // 1. Arrange 📐: el lector se inyecta para no tocar el disco en pruebas.
      const flags = parseFlags([`--uuid=${UUID}`, '--file=bloque.html']);
      const readFile = jest.fn().mockReturnValue(BLOCK);

      // 2. Act ⚙️
      const markup = resolveMarkup(flags, readFile);

      // 3. Assert 🎯
      expect(markup).toBe(BLOCK);
      expect(readFile).toHaveBeenCalledWith('bloque.html');
    });

    it('2.3 deberia rechazar --html y --file a la vez', () => {
      // 1. Arrange 📐: dos origenes distintos es una contradiccion, no una
      //    preferencia; elegir uno por el operador seria adivinar.
      const flags = parseFlags([
        `--uuid=${UUID}`,
        `--html=${BLOCK}`,
        '--file=bloque.html',
      ]);

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(() => resolveMarkup(flags)).toThrow('pero no los dos a la vez');
    });

    it('2.4 deberia rechazar la ausencia de los dos', () => {
      // 1. Arrange 📐
      const flags = parseFlags([`--uuid=${UUID}`]);

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(() => resolveMarkup(flags)).toThrow('Falta el marcado a inyectar');
    });
  });

  describe('3. Modos de insercion', () => {
    it('3.1 append deberia colocar el bloque al FINAL del contenedor', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const result = injectMarkup(PAGE, BLOCK, '#accordionESIC', 'append');

      // 3. Assert 🎯
      const children = cheerioLoad(result)('#accordionESIC').children();

      expect(children).toHaveLength(2);
      expect(children.last().attr('id')).toBe('nuevo');
    });

    it('3.2 prepend deberia colocar el bloque al INICIO del contenedor', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const result = injectMarkup(PAGE, BLOCK, '#accordionESIC', 'prepend');

      // 3. Assert 🎯
      const children = cheerioLoad(result)('#accordionESIC').children();

      expect(children).toHaveLength(2);
      expect(children.first().attr('id')).toBe('nuevo');
    });

    it('3.3 replace deberia sustituir el contenedor ENTERO', () => {
      // 1. Arrange 📐: a diferencia de los otros dos, el destino desaparece.
      // 2. Act ⚙️
      const result = injectMarkup(PAGE, BLOCK, '#accordionESIC', 'replace');

      // 3. Assert 🎯
      const $ = cheerioLoad(result);

      expect($('#accordionESIC')).toHaveLength(0);
      expect($('#existente')).toHaveLength(0);
      expect($('#nuevo')).toHaveLength(1);
    });

    it('3.4 NO deberia tocar el resto de la pagina', () => {
      // 1. Arrange 📐: la inyeccion reescribe el `body` entero, asi que hay que
      //    fijar que lo demas sobrevive al viaje de ida y vuelta de cheerio.
      // 2. Act ⚙️
      const result = injectMarkup(PAGE, BLOCK, '#accordionESIC', 'append');

      // 3. Assert 🎯
      expect(cheerioLoad(result)('#existente').text()).toBe('ESIC 1');
    });
  });

  describe('4. Poka-Yoke del destino', () => {
    it('4.1 deberia FALLAR si el destino no existe, sin mutar nada', () => {
      // 1. Arrange 📐: LA PRUEBA QUE IMPORTA. El script desechable al que esto
      //    sustituye caia a `#accordion` cuando no encontraba su contenedor, y
      //    el bloque acababa colgando de la raiz del acordeon en vez de de su
      //    universidad. Un bloque mal colocado no se distingue de uno bien
      //    puesto hasta que alguien mira la pagina.
      // 2. Act ⚙️ + 3. Assert 🎯
      expect(() =>
        injectMarkup(PAGE, BLOCK, '#accordionNOEXISTE', 'append'),
      ).toThrow('no existe en la pagina');
    });

    it('4.2 deberia elegir el destino VISIBLE y no el de la plantilla oculta', () => {
      // 1. Arrange 📐: el portal cuelga una plantilla de muestra de un `.d-none`
      //    que duplica cada contenedor. Un `$(selector).first()` ingenuo
      //    encuentra primero el escondido: el PATCH devuelve 200, el script
      //    canta exito y nadie ve el bloque.
      const page =
        '<div class="d-none"><div class="panel-group" id="accordionESIC">' +
        '<div class="panel" id="plantilla"></div></div></div>' +
        '<div class="panel-group" id="accordionESIC">' +
        '<div class="panel" id="real"></div></div>';

      // 2. Act ⚙️
      const result = injectMarkup(page, BLOCK, '#accordionESIC', 'append');

      // 3. Assert 🎯: el bloque entra junto al contenedor real.
      const $ = cheerioLoad(result);

      expect($('.d-none #nuevo')).toHaveLength(0);
      expect($('#real').parent().find('#nuevo')).toHaveLength(1);
    });

    it('4.3 deberia DESTAPAR un contenedor oculto al inyectar', () => {
      // 1. Arrange 📐: un sub-acordeon al que todavia no se le ha colgado nada
      //    viene oculto. Publicar dentro sin destaparlo es el mismo desenlace
      //    que el del caso anterior: todo en verde y nada visible.
      const page = '<div class="panel-group d-none" id="accordionESIC"></div>';

      // 2. Act ⚙️
      const result = injectMarkup(page, BLOCK, '#accordionESIC', 'append');

      // 3. Assert 🎯
      const container = cheerioLoad(result)('#accordionESIC');

      expect(container.hasClass('d-none')).toBe(false);
      expect(container.find('#nuevo')).toHaveLength(1);
    });
  });

  describe('5. Inventario del simulacro', () => {
    it('5.1 deberia contar las coincidencias del destino', () => {
      // 1. Arrange 📐: saber que el selector casa DOS veces es lo que permite
      //    al operador sospechar de la plantilla de muestra antes de escribir.
      const page =
        '<div class="d-none"><div id="accordionESIC"></div></div>' +
        '<div id="accordionESIC"></div>';

      // 2. Act ⚙️
      const inspection = inspectTarget(page, '#accordionESIC');

      // 3. Assert 🎯
      expect(inspection.matches).toBe(2);
      expect(inspection.hidden).toBe(false);
    });

    it('5.2 deberia avisar de que el destino elegido viene oculto', () => {
      // 1. Arrange 📐: destapar un contenedor es un cambio visible de la pagina
      //    y el operador tiene derecho a verlo venir en el simulacro.
      const page = '<div id="accordionESIC" class="d-none">contenido</div>';

      // 2. Act ⚙️
      const inspection = inspectTarget(page, '#accordionESIC');

      // 3. Assert 🎯
      expect(inspection.matches).toBe(1);
      expect(inspection.hidden).toBe(true);
    });

    it('5.3 deberia devolver cero coincidencias sin reventar', () => {
      // 1. Arrange 📐: `main` traduce este cero en un error legible; la funcion
      //    pura se limita a informar.
      // 2. Act ⚙️
      const inspection = inspectTarget(PAGE, '#noExiste');

      // 3. Assert 🎯
      expect(inspection.matches).toBe(0);
      expect(inspection.preview).toBe('');
    });
  });
});
