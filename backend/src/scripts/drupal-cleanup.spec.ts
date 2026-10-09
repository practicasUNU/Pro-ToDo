import {
  INJECTED_MARKER_SELECTOR,
  buildPurgeSelectors,
  describePurgeTargets,
  parseFlags,
} from './drupal-cleanup';

import { purgeMarkedBlocks } from './cleanup-drupal-sandbox';

/** Panel de universidad: estructura del portal, SIN marcador de inyeccion. */
const UNIVERSITY_PANEL = (siglas: string): string =>
  `<div class="panel panel-default">` +
  `<div class="panel-heading"><h4>Universidad ${siglas}</h4></div>` +
  `<div class="collapse" id="collapse${siglas}"><div id="accordion${siglas}"></div></div>` +
  '</div>';

/** Comite inyectado por un flujo: lleva el marcador de la plantilla. */
const COMMITTEE_PANEL = (code: string): string =>
  `<div class="panel panel-default" data-protodo-injected="true">` +
  `<div class="panel-heading"><h5><strong class="panel-comite-codigo">${code}</strong></h5></div>` +
  '</div>';

describe('drupal-cleanup · purga quirurgica', () => {
  describe('1. Banderas', () => {
    it('1.1 deberia SIMULAR por defecto', () => {
      // 1. Arrange 📐: la decision de seguridad de la herramienta. Un olvido de
      //    bandera no puede borrar contenido de un portal publicado.
      // 2. Act ⚙️ + 3. Assert 🎯
      expect(parseFlags(['--uuid=abc', '--injected-only']).write).toBe(false);
    });

    it('1.2 solo --write deberia habilitar el PATCH', () => {
      // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
      expect(parseFlags(['--uuid=abc', '--write']).write).toBe(true);
    });

    it('1.3 --dry-run deberia CANCELAR un --write', () => {
      // 1. Arrange 📐: ante dos banderas contradictorias gana la que no borra.
      //    Al reves —que --write ganase— convertiria una duda del operador en
      //    una escritura.
      // 2. Act ⚙️ + 3. Assert 🎯
      expect(parseFlags(['--write', '--dry-run']).write).toBe(false);
    });

    it('1.4 deberia leer los valores con signo igual', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const flags = parseFlags([
        '--uuid=b17d69d8-6998-4883-b8dc-153b55dbd9c5',
        '--selector=.panel-default:has(.panel-heading:contains("UAM 9"))',
        '--root=#accordionPrincipal',
      ]);

      // 3. Assert 🎯
      expect(flags.uuid).toBe('b17d69d8-6998-4883-b8dc-153b55dbd9c5');
      expect(flags.selector).toContain('UAM 9');
      expect(flags.rootSelector).toBe('#accordionPrincipal');
    });

    it('1.5 deberia caer al acordeon raiz por defecto', () => {
      // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
      expect(parseFlags([]).rootSelector).toBe('#accordion');
    });
  });

  describe('2. Composicion de selectores', () => {
    it('2.1 deberia exigir el MARCADOR en los paneles de primer nivel', () => {
      // 1. Arrange 📐: el matiz mas importante de la herramienta. El selector
      //    obvio —`#accordion > .panel.panel-default`— se llevaria por delante
      //    los catorce paneles de universidad, que son hijos directos del
      //    acordeon raiz. Lo unico que distingue a un comite es el marcador.
      // 2. Act ⚙️
      const [selector] = buildPurgeSelectors(
        parseFlags(['--remove-root-panels']),
      );

      // 3. Assert 🎯
      expect(selector).toBe(
        `#accordion > .panel.panel-default${INJECTED_MARKER_SELECTOR}`,
      );
    });

    it('2.2 deberia acumular las banderas pedidas', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const selectors = buildPurgeSelectors(
        parseFlags([
          '--injected-only',
          '--remove-root-panels',
          '--selector=#collapseUAM9',
        ]),
      );

      // 3. Assert 🎯
      expect(selectors).toHaveLength(3);
      expect(selectors[0]).toBe(INJECTED_MARKER_SELECTOR);
      expect(selectors[2]).toBe('#collapseUAM9');
    });

    it('2.3 sin banderas no deberia componer NINGUN selector', () => {
      // 1. Arrange 📐: es lo que hace que el script se niegue a correr en vacio
      //    en vez de purgar algo por defecto.
      // 2. Act ⚙️ + 3. Assert 🎯
      expect(buildPurgeSelectors(parseFlags(['--uuid=abc']))).toHaveLength(0);
    });
  });

  describe('3. Seguridad de --remove-root-panels', () => {
    /** La pagina real: universidades de primer nivel y un comite mal colocado. */
    const PAGE =
      '<div id="accordion">' +
      UNIVERSITY_PANEL('UAM') +
      UNIVERSITY_PANEL('UCM') +
      COMMITTEE_PANEL('UAM 9') +
      '</div>';

    it('3.1 NO deberia tocar los paneles de universidad', () => {
      // 1. Arrange 📐: EL caso que justifica toda la prueba. Si este test cae,
      //    la herramienta borra la pagina agregadora entera.
      const selectors = buildPurgeSelectors(
        parseFlags(['--remove-root-panels']),
      );

      // 2. Act ⚙️
      const purged = purgeMarkedBlocks(PAGE, selectors);

      // 3. Assert 🎯
      expect(purged.purgedCount).toBe(1);
      expect(purged.html).toContain('Universidad UAM');
      expect(purged.html).toContain('Universidad UCM');
      expect(purged.html).not.toContain('UAM 9');
    });

    it('3.2 tampoco deberia tocar una universidad SIN comites todavia', () => {
      // 1. Arrange 📐: la razon de no usar `:not(:has(.panel))`, que parecia la
      //    via elegante. Una universidad a la que no se le ha inyectado nada no
      //    anida ningun panel y caeria con los demas.
      const vacia = `<div id="accordion">${UNIVERSITY_PANEL('ESIC')}</div>`;

      // 2. Act ⚙️
      const purged = purgeMarkedBlocks(
        vacia,
        buildPurgeSelectors(parseFlags(['--remove-root-panels'])),
      );

      // 3. Assert 🎯
      expect(purged.purgedCount).toBe(0);
      expect(purged.html).toBe(vacia);
    });

    it('3.3 NO deberia tocar un comite BIEN colocado dentro de su universidad', () => {
      // 1. Arrange 📐: la bandera retira los que cuelgan de la raiz, no los que
      //    estan en su sitio. Son hijos del sub-acordeon, no del raiz.
      const bien =
        '<div id="accordion"><div class="panel panel-default">' +
        `<div class="collapse" id="collapseUAM"><div id="accordionUAM">${COMMITTEE_PANEL('UAM 9')}</div></div>` +
        '</div></div>';

      // 2. Act ⚙️
      const purged = purgeMarkedBlocks(
        bien,
        buildPurgeSelectors(parseFlags(['--remove-root-panels'])),
      );

      // 3. Assert 🎯
      expect(purged.purgedCount).toBe(0);
      expect(purged.html).toContain('UAM 9');
    });

    it('3.4 --injected-only SI alcanza a los que estan bien colocados', () => {
      // 1. Arrange 📐: es la diferencia entre las dos banderas, y conviene que
      //    este fijada. `--injected-only` purga TODO lo que un flujo publico,
      //    este donde este; es la purga global, no la quirurgica.
      const bien =
        '<div id="accordion"><div id="accordionUAM">' +
        COMMITTEE_PANEL('UAM 9') +
        '</div></div>';

      // 2. Act ⚙️
      const purged = purgeMarkedBlocks(
        bien,
        buildPurgeSelectors(parseFlags(['--injected-only'])),
      );

      // 3. Assert 🎯
      expect(purged.purgedCount).toBe(1);
    });
  });

  describe('4. Inventario del simulacro', () => {
    it('4.1 deberia nombrar cada elemento por su codigo de comite', () => {
      // 1. Arrange 📐: «3 elementos» no permite decidir si seguir adelante, y
      //    decidir es justo lo que el simulacro existe para que ocurra.
      const page = `<div id="accordion">${COMMITTEE_PANEL('UAM 9')}${COMMITTEE_PANEL('UCM 3')}</div>`;

      // 2. Act ⚙️
      const [target] = describePurgeTargets(page, [INJECTED_MARKER_SELECTOR]);

      // 3. Assert 🎯
      expect(target?.matches).toEqual(['UAM 9', 'UCM 3']);
    });

    it('4.2 deberia devolver una entrada por selector, aunque no case nada', () => {
      // 1. Arrange 📐: un selector sin coincidencias es informacion —dice que
      //    esa bandera no hizo nada— y callarlo lo haria pasar por aplicado.
      // 2. Act ⚙️
      const targets = describePurgeTargets('<div id="accordion"></div>', [
        INJECTED_MARKER_SELECTOR,
        '#collapseUAM9',
      ]);

      // 3. Assert 🎯
      expect(targets).toHaveLength(2);
      expect(targets.every((t) => t.matches.length === 0)).toBe(true);
    });
  });
});
