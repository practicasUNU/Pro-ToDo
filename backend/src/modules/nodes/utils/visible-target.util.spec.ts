import * as cheerio from 'cheerio';

import { selectVisibleTarget } from '@modules/nodes/utils/visible-target.util';

/** Las banderas de carga CANONICAS del proyecto, como en la estrategia. */
const load = (html: string): cheerio.CheerioAPI =>
  cheerio.load(html, { xml: { xmlMode: false } }, false);

describe('selectVisibleTarget', () => {
  describe('1. Eleccion entre candidatos', () => {
    it('1.1 deberia elegir el candidato VISIBLE cuando el oculto va primero', () => {
      // 1. Arrange 📐: el caso real. La pagina agregadora trae una plantilla de
      //    muestra escondida en un `.d-none` que duplica cada contenedor, y el
      //    duplicado aparece ANTES en el documento. `$(selector).first()` se
      //    quedaba con el, publicaba dentro y el PATCH devolvia 200.
      const $ = load(
        '<div class="d-none"><div id="accordionUFV">MUESTRA</div></div>' +
          '<div class="panel-group"><div id="accordionUFV">REAL</div></div>',
      );

      // 2. Act ⚙️
      const target = selectVisibleTarget($, '#accordionUFV');

      // 3. Assert 🎯
      expect(target).toHaveLength(1);
      expect(target.text()).toBe('REAL');
    });

    it('1.2 deberia elegir el visible aunque el oculto este PROFUNDAMENTE anidado', () => {
      // 1. Arrange 📐: `closest` y no `parent`. El contenedor de la muestra
      //    cuelga de varios niveles de maquetacion, no del `.d-none` directo.
      const $ = load(
        '<section class="d-none"><div class="row"><div class="col">' +
          '<div id="accordionUFV">MUESTRA</div>' +
          '</div></div></section>' +
          '<div id="accordionUFV">REAL</div>',
      );

      // 2. Act ⚙️
      // 3. Assert 🎯
      expect(selectVisibleTarget($, '#accordionUFV').text()).toBe('REAL');
    });

    it('1.3 deberia reconocer tambien `.hidden`, la utilidad de Bootstrap 3', () => {
      // 1. Arrange 📐: el portal es Bootstrap 3 y la plantilla Bootstrap 5.
      //    Contemplar solo `d-none` dejaria el fallo vivo en la mitad de la
      //    pagina que no migro.
      const $ = load(
        '<div class="hidden"><div id="accordionUFV">MUESTRA</div></div>' +
          '<div id="accordionUFV">REAL</div>',
      );

      // 2. Act ⚙️
      // 3. Assert 🎯
      expect(selectVisibleTarget($, '#accordionUFV').text()).toBe('REAL');
    });

    it('1.4 deberia respetar el orden del documento entre varios visibles', () => {
      // 1. Arrange 📐: sin ocultos de por medio el comportamiento no cambia.
      const $ = load(
        '<div id="accordionUFV">PRIMERO</div><div id="accordionUFV">SEGUNDO</div>',
      );

      // 2. Act ⚙️
      // 3. Assert 🎯
      expect(selectVisibleTarget($, '#accordionUFV').text()).toBe('PRIMERO');
    });
  });

  describe('2. Respaldo y ausencia', () => {
    it('2.1 deberia devolver el unico candidato aunque este oculto', () => {
      // 1. Arrange 📐: un sub-acordeon al que todavia no se le ha inyectado
      //    ningun comite viene oculto, y es PUBLICABLE: quien llama lo destapa
      //    con `removeClass`. Devolver vacio aqui convertiria un caso corriente
      //    en un ERR_DRUPAL_DOM_TARGET y dejaria la tanda sin publicar.
      const $ = load(
        '<div class="d-none"><div id="accordionUFV">UNICO</div></div>',
      );

      // 2. Act ⚙️
      const target = selectVisibleTarget($, '#accordionUFV');

      // 3. Assert 🎯
      expect(target).toHaveLength(1);
      expect(target.text()).toBe('UNICO');
    });

    it('2.2 deberia devolver el primero cuando TODOS estan ocultos', () => {
      // 1. Arrange 📐: mismo razonamiento que 2.1, con mas de un candidato.
      const $ = load(
        '<div class="d-none"><div id="accordionUFV">A</div></div>' +
          '<div class="hidden"><div id="accordionUFV">B</div></div>',
      );

      // 2. Act ⚙️
      // 3. Assert 🎯
      expect(selectVisibleTarget($, '#accordionUFV').text()).toBe('A');
    });

    it('2.3 deberia devolver una seleccion VACIA cuando el selector no casa', () => {
      // 1. Arrange 📐: es lo que la guarda de la estrategia lee para emitir
      //    ERR_DRUPAL_DOM_TARGET. No casar con nada y estar oculto son dos
      //    cosas distintas y solo la primera es un error.
      const $ = load('<div id="accordionUAM">OTRA</div>');

      // 2. Act ⚙️
      // 3. Assert 🎯
      expect(selectVisibleTarget($, '#accordionUFV')).toHaveLength(0);
    });
  });

  describe('3. Aislamiento', () => {
    it('3.1 no deberia MUTAR el documento', () => {
      // 1. Arrange 📐: es una funcion de consulta. Destapar el contenedor es
      //    decision de quien llama, no efecto secundario de elegirlo.
      const html =
        '<div class="d-none"><div id="accordionUFV">MUESTRA</div></div>' +
        '<div id="accordionUFV">REAL</div>';
      const $ = load(html);

      // 2. Act ⚙️
      selectVisibleTarget($, '#accordionUFV');

      // 3. Assert 🎯
      expect($.html()).toBe(html);
    });
  });
});
