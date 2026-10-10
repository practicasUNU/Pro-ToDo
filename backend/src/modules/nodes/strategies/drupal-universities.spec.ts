import {
  DRUPAL_UNIVERSITIES_CATALOG,
  planPanelDispatch,
  resolveUniversityAccordion,
} from '@modules/nodes/strategies/drupal-universities';
import { accordionsInSeededPrompt } from '@test/helpers/prompt-migrations.helper';

/** Panel al molde del que siembra la migracion 034. */
const buildPanel = (options: {
  readonly code: string;
  readonly facultad?: string;
  readonly dataParentOnLink?: string;
  readonly dataParentOnPanel?: string;
}): string =>
  `<div class="panel panel-default" data-protodo-injected="true"${
    options.dataParentOnPanel === undefined
      ? ''
      : ` data-parent="${options.dataParentOnPanel}"`
  }>` +
  '<div class="panel-heading"><h5 class="panel-title">' +
  `<a class="panel-toggle-link"${
    options.dataParentOnLink === undefined
      ? ''
      : ` data-parent="${options.dataParentOnLink}"`
  } href="#collapse${options.code}">` +
  `<strong class="panel-comite-codigo">${options.code}</strong>&nbsp;` +
  `<span class="panel-facultad-nombre">${options.facultad ?? ''}</span>` +
  '</a></h5></div>' +
  `<div class="collapse" id="collapse${options.code}"><p>Cuerpo</p></div></div>`;

describe('Catalogo de universidades de Drupal', () => {
  describe('1. Integridad del catalogo', () => {
    it('1.1 deberia declarar las CATORCE universidades del portal', () => {
      // 1. Arrange 📐: la pagina agregadora las lista todas; una de menos deja
      //    a sus comites sin destino y hace fallar el nodo entero.
      // 2. Act ⚙️ + 3. Assert 🎯
      expect(DRUPAL_UNIVERSITIES_CATALOG).toHaveLength(14);
    });

    it('1.2 no deberia repetir ningun sub-acordeon', () => {
      // 1. Arrange 📐: dos filas con el mismo `accordionId` mandarian comites
      //    de universidades distintas al mismo sitio, que es el fallo original.
      const accordions = DRUPAL_UNIVERSITIES_CATALOG.map((u) => u.accordionId);

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(new Set(accordions).size).toBe(accordions.length);
    });

    it('1.3 cada universidad deberia resolverse por su propio nombre', () => {
      // 1. Arrange 📐: el caso que el codigo de partida fallaba en SILENCIO.
      //    Comparaba el texto plegado contra el nombre SIN plegar, de modo que
      //    ningun nombre con tilde se encontraba a si mismo.
      // 2. Act ⚙️ + 3. Assert 🎯
      for (const university of DRUPAL_UNIVERSITIES_CATALOG) {
        expect(resolveUniversityAccordion(university.name)).toBe(
          university.accordionId,
        );
      }
    });

    it('1.4 deberia mandar a ESIC al contenedor heredado #accordionUFV', () => {
      // 1. Arrange 📐: ESTE TEST PARECE UN ERROR Y NO LO ES. El sub-acordeon de
      //    ESIC en la pagina agregadora arrastra el identificador `accordionUFV`
      //    de una version anterior del portal; ESIC y UFV son el MISMO
      //    contenedor y no hay ninguna universidad Francisco de Vitoria en el
      //    agregador. Esta aqui para que quien vea la discrepancia en el
      //    catalogo y la "arregle" se encuentre antes con este rojo que con un
      //    ERR_DRUPAL_DOM_TARGET en produccion, que es como se descubrio.
      const esic = DRUPAL_UNIVERSITIES_CATALOG.find(
        (university) => university.name === 'ESIC Universidad',
      );

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(esic?.accordionId).toBe('#accordionUFV');
      expect(resolveUniversityAccordion('ESIC 1 · Facultad')).toBe(
        '#accordionUFV',
      );
    });
  });

  describe('1bis. Coherencia con el prompt sembrado', () => {
    /**
     * Son DOS fuentes para la misma verdad y no hay forma de fundirlas: el
     * catalogo de TypeScript resuelve el destino cuando el panel no trae
     * `data-parent`, y la tabla del prompt es de donde el modelo saca ese
     * atributo —el acordeon no es un dato del material de entrada, es una
     * propiedad del DOM del portal—. Si divergen, el fallo no se ve: el panel
     * se publica bien formado y apunta a un contenedor que no existe.
     *
     * El prompt se COMPONE recorriendo las migraciones en orden, en vez de leer
     * una por su ruta. Leer solo la 035 funcionaba hasta que la 036 la parcheo;
     * desde entonces ese fichero ya no describe lo que hay en la base de datos.
     * Ver `composeSeededPrompt`.
     */
    it('1bis.1 el prompt deberia mapear EXACTAMENTE las mismas universidades', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const fromPrompt = new Set(accordionsInSeededPrompt());
      const fromCatalog = new Set(
        DRUPAL_UNIVERSITIES_CATALOG.map((u) => u.accordionId),
      );

      // 3. Assert 🎯
      expect([...fromPrompt].sort()).toEqual([...fromCatalog].sort());
    });

    it('1bis.2 el prompt deberia mandar a ESIC al contenedor heredado', () => {
      // 1. Arrange 📐: la linea concreta que causo el ERR_DRUPAL_DOM_TARGET.
      //    Se afirma aparte del conjunto de arriba porque aquel solo compara
      //    DOS CONJUNTOS: si alguien cambiase las dos fuentes a la vez de vuelta
      //    a `#accordionESIC`, seguirian coincidiendo entre si y el flujo
      //    volveria a romperse contra la pagina real.
      // 2. Act ⚙️
      const accordions = accordionsInSeededPrompt();

      // 3. Assert 🎯
      expect(accordions).toContain('#accordionUFV');
      expect(accordions).not.toContain('#accordionESIC');
    });
  });

  describe('2. Resolucion por texto', () => {
    it('2.1 deberia resolver por alias y por sigla', () => {
      // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
      expect(resolveUniversityAccordion('UAM 9 · Facultad de Medicina')).toBe(
        '#accordionUAM',
      );
      expect(resolveUniversityAccordion('Comite de la Complutense')).toBe(
        '#accordionUCM',
      );
    });

    it('2.2 deberia tolerar la falta de tilde en el material', () => {
      // 1. Arrange 📐: el material llega de un correo y de documentos ofimaticos
      //    convertidos a texto; la tilde se pierde por el camino mas de una vez.
      // 2. Act ⚙️ + 3. Assert 🎯
      expect(
        resolveUniversityAccordion('Universidad Politecnica de Madrid'),
      ).toBe('#accordionUPM');
      expect(resolveUniversityAccordion('UNIVERSIDAD AUTONOMA DE MADRID')).toBe(
        '#accordionUAM',
      );
    });

    it('2.3 NO deberia casar un alias en mitad de una palabra', () => {
      // 1. Arrange 📐: la razon de comparar por palabra completa y no con un
      //    `includes` suelto. Un alias de tres letras aparece por accidente con
      //    demasiada facilidad, y aqui una falsa coincidencia no falla: publica
      //    el comite dentro de otra universidad.
      // 2. Act ⚙️ + 3. Assert 🎯
      expect(
        resolveUniversityAccordion('Facultad de Farmaceuticas'),
      ).toBeNull();
      expect(resolveUniversityAccordion('Comite de Uaxactun')).toBeNull();
    });

    it('2.4 deberia devolver null cuando no reconoce nada', () => {
      // 1. Arrange 📐: `null` no se traga; quien llama lo convierte en un error
      //    que nombra el comite afectado.
      // 2. Act ⚙️ + 3. Assert 🎯
      expect(resolveUniversityAccordion('Comite sin universidad')).toBeNull();
      expect(resolveUniversityAccordion('')).toBeNull();
    });

    it('2.5 NO deberia confundir Carlos III con Rey Juan Carlos', () => {
      // 1. Arrange 📐: comparten la palabra "carlos" y van seguidas en el
      //    catalogo, asi que es la colision mas probable de toda la tabla.
      // 2. Act ⚙️ + 3. Assert 🎯
      expect(resolveUniversityAccordion('Universidad Rey Juan Carlos')).toBe(
        '#accordionURJC',
      );
      expect(
        resolveUniversityAccordion('Universidad Carlos III de Madrid'),
      ).toBe('#accordionUC3M');
    });
  });

  describe('3. Despacho de paneles', () => {
    it('3.1 deberia leer el data-parent del ENLACE, que es donde lo pone la plantilla', () => {
      // 1. Arrange 📐: el encargo pedia leerlo del panel, pero Bootstrap lo pone
      //    en el enlace que dispara el colapsable y ahi es donde lo siembra la
      //    migracion 034. Mirando solo el panel no se encontraria nunca.
      const markup = buildPanel({
        code: 'UAM 9',
        dataParentOnLink: '#accordionUAM',
      });

      // 2. Act ⚙️
      const [panel] = planPanelDispatch(markup);

      // 3. Assert 🎯
      expect(panel?.targetSelector).toBe('#accordionUAM');
      expect(panel?.committeeCode).toBe('UAM 9');
      expect(panel?.html).toContain('class="panel panel-default"');
    });

    it('3.2 el data-parent del PANEL deberia mandar sobre el del enlace', () => {
      // 1. Arrange 📐: son dos escalones de la misma precedencia, no dos sitios
      //    equivalentes. El del panel es el mas explicito.
      const markup = buildPanel({
        code: 'UPM 2',
        dataParentOnPanel: '#accordionUPM',
        dataParentOnLink: '#accordionCEU',
      });

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(planPanelDispatch(markup)[0]?.targetSelector).toBe(
        '#accordionUPM',
      );
    });

    it('3.3 deberia deducirlo del encabezado cuando no hay atributo', () => {
      // 1. Arrange 📐: tercer escalon. Cubre al modelo que rellena el panel pero
      //    se olvida del atributo.
      const markup = buildPanel({
        code: 'ESIC 1',
        facultad: 'ESIC Universidad · Facultad de Ciencias Juridicas',
      });

      // 2. Act ⚙️ + 3. Assert 🎯: UFV, no ESIC. Ver el comentario de la entrada
      //    de ESIC en el catalogo.
      expect(planPanelDispatch(markup)[0]?.targetSelector).toBe(
        '#accordionUFV',
      );
    });

    it('3.4 deberia devolver null como destino cuando no hay forma de deducirlo', () => {
      // 1. Arrange 📐: lo que convierte el panel en un error con nombre, en vez
      //    de en una publicacion fuera de sitio.
      const markup = buildPanel({
        code: 'X 1',
        facultad: 'Centro desconocido',
      });

      // 2. Act ⚙️
      const [panel] = planPanelDispatch(markup);

      // 3. Assert 🎯
      expect(panel?.targetSelector).toBeNull();
      expect(panel?.committeeCode).toBe('X 1');
    });

    it('3.5 deberia repartir varios paneles de universidades distintas', () => {
      // 1. Arrange 📐: EL caso. Antes, los dos acababan en el mismo contenedor.
      const markup =
        buildPanel({ code: 'UAM 9', dataParentOnLink: '#accordionUAM' }) +
        buildPanel({ code: 'UCM 3', dataParentOnLink: '#accordionUCM' });

      // 2. Act ⚙️
      const plan = planPanelDispatch(markup);

      // 3. Assert 🎯
      expect(plan).toHaveLength(2);
      expect(plan.map((p) => p.targetSelector)).toEqual([
        '#accordionUAM',
        '#accordionUCM',
      ]);
    });

    it('3.6 deberia devolver lista VACIA ante marcado que no son paneles', () => {
      // 1. Arrange 📐: es la senal que conserva la ruta de siempre para los
      //    demas flujos que publican por APPEND_HTML_BLOCK. Sin ella se
      //    quedarian sin destino y fallarian en bloque.
      const markup =
        '<div class="licitacion-entry" data-expediente="X1"><p>Pliego</p></div>';

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(planPanelDispatch(markup)).toHaveLength(0);
    });

    it('3.7 deberia conservar el literal sin sustituir, no inventarse un destino', () => {
      // 1. Arrange 📐: si el modelo no sustituye el relleno de la plantilla, el
      //    destino sale tal cual, no existe en la pagina y el nodo para con un
      //    error que lo nombra. Deducirlo del encabezado aqui esconderia el
      //    fallo del prompt.
      const markup = buildPanel({
        code: 'UAM 9',
        facultad: 'Universidad Autonoma de Madrid',
        dataParentOnLink: '#accordionPadreId',
      });

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(planPanelDispatch(markup)[0]?.targetSelector).toBe(
        '#accordionPadreId',
      );
    });
  });
});
