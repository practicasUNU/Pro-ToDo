import {
  collectNamespaceRoots,
  extractNamespaceRoots,
  INTERPOLATION_ONLY_PATTERN,
  isRequiredMarker,
  MissingContextVariableException,
  resolvePath,
  StatePayloadContext,
} from '@core/fsm/context/state-payload.context';

const EXECUTION_ID = 'd4c3b2a1-9f8e-4d7c-8b6a-5e4f3d2c1b0a';
const WORKFLOW_ID = 'b3f1c2d4-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const INITIAL_STEP = 'paso_1';

/** Contexto recien construido, sin ningun namespace escrito. */
const buildContext = (): StatePayloadContext =>
  new StatePayloadContext(EXECUTION_ID, WORKFLOW_ID, INITIAL_STEP);

describe('StatePayloadContext (PROT-08)', () => {
  let context: StatePayloadContext;

  beforeEach(() => {
    context = buildContext();
  });

  describe('1. Inmutabilidad profunda (structuredClone)', () => {
    it('1.1 deberia impedir que mutar la salida de getNamespace alcance el estado interno', () => {
      // 1. Arrange: un array y un objeto anidado, donde falla una copia superficial
      context.setNamespace('parsed_email', {
        urls: ['https://a.com'],
        meta: { retries: 0 },
      });

      // 2. Act: se muta la copia recibida en los dos niveles
      const escaped = context.getNamespace('parsed_email');
      (escaped?.urls as string[]).push('https://inyectada.com');
      (escaped?.meta as { retries: number }).retries = 99;

      // 3. Assert: el contexto sigue exactamente como se escribio
      const stored = context.getNamespace('parsed_email');
      expect(stored?.urls).toHaveLength(1);
      expect(stored?.urls).toEqual(['https://a.com']);
      expect((stored?.meta as { retries: number }).retries).toBe(0);
    });

    it('1.2 deberia impedir que alterar o borrar en la salida de getAllContext alcance el estado interno', () => {
      // 1. Arrange: dos namespaces, ambos con sub-objetos anidados
      context.setNamespace('parsed_email', {
        title: 'Noticia Tech',
        meta: { adjuntos: ['informe.pdf'] },
      });
      context.setNamespace('scraped_web', {
        author: 'Admin',
        meta: { status: 200 },
      });

      // 2. Act: se altera una propiedad, se muta un anidado y se borra un namespace entero
      const escaped = context.getAllContext();
      escaped.parsed_email.title = 'Titulo suplantado';
      (escaped.parsed_email.meta as { adjuntos: string[] }).adjuntos.push(
        'virus.exe',
      );
      delete escaped.scraped_web;

      // 3. Assert: el contexto conserva ambos namespaces integros
      const stored = context.getAllContext();
      expect(Object.keys(stored)).toEqual(['parsed_email', 'scraped_web']);
      expect(stored.parsed_email.title).toBe('Noticia Tech');
      expect(
        (stored.parsed_email.meta as { adjuntos: string[] }).adjuntos,
      ).toEqual(['informe.pdf']);
      expect(stored.scraped_web.author).toBe('Admin');
    });

    it('1.3 deberia clonar el objeto de entrada, de modo que mutarlo tras registrarlo no contamine', () => {
      // 1. Arrange: quien llama conserva su referencia y podria reutilizarla
      const localPayload = { raw: { body: 'texto original' } };
      context.setNamespace('trigger', localPayload);

      // 2. Act
      localPayload.raw.body = 'texto manipulado post-registro';

      // 3. Assert
      const stored = context.getNamespace('trigger');
      expect((stored?.raw as { body: string }).body).toBe('texto original');
    });
  });

  describe('2. Aislamiento y fusion de namespaces', () => {
    it('2.1 deberia mantener cada namespace aislado del resto', () => {
      // 1. Arrange
      context.setNamespace('nodo_a', { dataA: 100 });

      // 2. Act
      context.setNamespace('nodo_b', { dataB: 200 });

      // 3. Assert: ninguno filtra claves del otro
      expect(context.getNamespace('nodo_a')).toEqual({ dataA: 100 });
      expect(context.getNamespace('nodo_b')).toEqual({ dataB: 200 });
    });

    it('2.2 deberia fusionar sin destruir las claves previas del mismo namespace', () => {
      // 1. Arrange
      context.setNamespace('nodo_a', { campo1: 'valor1' });

      // 2. Act: el mismo nodo escribe en una segunda tanda
      context.setNamespace('nodo_a', { campo2: 'valor2' });

      // 3. Assert
      expect(context.getNamespace('nodo_a')).toEqual({
        campo1: 'valor1',
        campo2: 'valor2',
      });
    });

    it('2.3 deberia devolver undefined para un namespace que nadie ha escrito', () => {
      // 3. Assert
      expect(context.getNamespace('namespace_fantasma')).toBeUndefined();
    });
  });

  describe('3. Motor de interpolacion (getInterpolatedValue)', () => {
    beforeEach(() => {
      context.setNamespace('parsed_email', { title: 'Noticia Tech' });
      context.setNamespace('scraped_web', { author: 'Admin' });
    });

    it('3.1 deberia sustituir varias variables de distintos namespaces', () => {
      // 1. Arrange
      const template =
        'Autor: {{ scraped_web.author }} - Titulo: {{ parsed_email.title }}';

      // 2. Act
      const result = context.getInterpolatedValue(template);

      // 3. Assert
      expect(result).toBe('Autor: Admin - Titulo: Noticia Tech');
    });

    it('3.2 deberia resolver identicamente las variantes de espaciado mustache', () => {
      // 2. Act
      const results = [
        context.getInterpolatedValue('{{  parsed_email.title  }}'),
        context.getInterpolatedValue('{{parsed_email.title}}'),
        context.getInterpolatedValue('{{ parsed_email.title}}'),
        context.getInterpolatedValue('{{parsed_email.title }}'),
      ];

      // 3. Assert
      expect(new Set(results).size).toBe(1);
      expect(results[0]).toBe('Noticia Tech');
    });

    it('3.3 deberia devolver intacta una plantilla sin variables', () => {
      // 1. Arrange
      const template = '<p>Texto fijo sin etiquetas.</p>';

      // 2. Act + 3. Assert
      expect(context.getInterpolatedValue(template)).toBe(template);
    });

    it('3.4 deberia lanzar MissingContextVariableException si el namespace no existe', () => {
      // 2. Act + 3. Assert
      expect(() => context.getInterpolatedValue('{{ ausente.campo }}')).toThrow(
        MissingContextVariableException,
      );
    });

    it('3.5 deberia lanzar MissingContextVariableException ante campo inexistente, nulo o indefinido', () => {
      // 1. Arrange: la clave puede existir y aun asi no tener valor utilizable
      context.setNamespace('nodo_x', {
        valido: 123,
        nulo: null,
        indefinido: undefined,
      });

      // 2. Act + 3. Assert
      expect(() =>
        context.getInterpolatedValue('{{ nodo_x.inexistente }}'),
      ).toThrow(MissingContextVariableException);
      expect(() => context.getInterpolatedValue('{{ nodo_x.nulo }}')).toThrow(
        MissingContextVariableException,
      );
      expect(() =>
        context.getInterpolatedValue('{{ nodo_x.indefinido }}'),
      ).toThrow(MissingContextVariableException);

      // El campo con valor si resuelve: la excepcion no es indiscriminada
      expect(context.getInterpolatedValue('{{ nodo_x.valido }}')).toBe('123');
    });

    it('3.6 deberia nombrar la variable culpable en la excepcion', () => {
      // 2. Act
      let captured: MissingContextVariableException | undefined;

      try {
        context.getInterpolatedValue('<p>{{ parsed_email.inexistente }}</p>');
      } catch (error) {
        captured = error as MissingContextVariableException;
      }

      // 3. Assert: sin el nombre, el mensaje no seria accionable
      expect(captured?.variable).toBe('parsed_email.inexistente');
      expect(captured?.message).toContain('parsed_email.inexistente');
    });

    it('3.7 deberia interpolar numeros y booleanos sin anadir comillas', () => {
      // 1. Arrange
      context.setNamespace('ia_result', { score: 42, publicado: true });

      // 2. Act
      const result = context.getInterpolatedValue(
        '{{ia_result.score}}|{{ia_result.publicado}}',
      );

      // 3. Assert
      expect(result).toBe('42|true');
    });

    it('3.8 deberia serializar objetos y arrays a JSON, nunca a [object Object]', () => {
      // 1. Arrange: un mapeo erroneo podria apuntar a una clave no escalar
      context.setNamespace('ia_result', {
        tags: ['madrid', 'innovacion'],
        meta: { fuente: 'imap' },
      });

      // 2. Act
      const result = context.getInterpolatedValue(
        '{{ia_result.tags}}|{{ia_result.meta}}',
      );

      // 3. Assert
      expect(result).toBe('["madrid","innovacion"]|{"fuente":"imap"}');
      expect(result).not.toContain('[object Object]');
    });
  });

  describe('4. Control de cursor y metadatos', () => {
    it('4.1 deberia arrancar en el paso inicial y avanzar con setCursor', () => {
      // 1. Arrange
      expect(context.getCursor()).toBe(INITIAL_STEP);

      // 2. Act
      context.setCursor('paso_2');

      // 3. Assert
      expect(context.getCursor()).toBe('paso_2');
    });

    it('4.2 deberia exponer los identificadores inyectados en el constructor', () => {
      // 3. Assert
      expect(context.getExecutionId()).toBe(EXECUTION_ID);
      expect(context.getWorkflowId()).toBe(WORKFLOW_ID);
    });

    it('4.3 deberia avanzar el cursor sin tocar los namespaces acumulados', () => {
      // 1. Arrange
      context.setNamespace('parsed_email', { title: 'Noticia Tech' });

      // 2. Act
      context.setCursor('nodo_ia');

      // 3. Assert
      expect(context.getCursor()).toBe('nodo_ia');
      expect(context.getNamespace('parsed_email')).toEqual({
        title: 'Noticia Tech',
      });
    });
  });

  describe('5. Motor de interpolacion funcional complejo (PROT-10)', () => {
    beforeEach(() => {
      // Formas reales que devuelven los nodos del pipeline Notiweb.
      context.setNamespace('parsed_email', {
        headers: { routing: { ip: '192.168.10.44' } },
        extracted_urls: ['https://a.com', 'https://b.com'],
        metadata: { source: 'imap', read: true },
        adjunto: null,
      });
      context.setNamespace('llm_response', {
        articles: [
          { title: 'Primera noticia', score: 7 },
          { title: 'Innovacion en Madrid', score: 9 },
        ],
      });
      context.setNamespace('node', {
        items: [{ id: 'item-0', sub: 'valor-sub' }],
      });
    });

    it('5.1 deberia resolver objetos anidados de tres o mas niveles', () => {
      // 2. Act
      const result = context.getInterpolatedValue(
        'Origen: {{ parsed_email.headers.routing.ip }}',
      );

      // 3. Assert
      expect(result).toBe('Origen: 192.168.10.44');
    });

    it('5.2 deberia resolver un indice de arreglo con notacion de corchetes', () => {
      // 2. Act + 3. Assert
      expect(
        context.getInterpolatedValue('{{ parsed_email.extracted_urls[0] }}'),
      ).toBe('https://a.com');
      expect(
        context.getInterpolatedValue('{{ parsed_email.extracted_urls[1] }}'),
      ).toBe('https://b.com');
    });

    it('5.3 deberia extraer una propiedad anidada dentro de un arreglo de objetos', () => {
      // 2. Act + 3. Assert
      expect(
        context.getInterpolatedValue('{{ llm_response.articles[1].title }}'),
      ).toBe('Innovacion en Madrid');
      expect(
        context.getInterpolatedValue('{{ llm_response.articles[0].score }}'),
      ).toBe('7');
    });

    it('5.4 deberia tratar como equivalentes la notacion de corchetes y la de punto', () => {
      // 2. Act
      const conCorchetes = context.getInterpolatedValue(
        '{{ node.items[0].id }}',
      );
      const conPuntos = context.getInterpolatedValue('{{ node.items.0.id }}');

      // 3. Assert
      expect(conCorchetes).toBe('item-0');
      expect(conPuntos).toBe(conCorchetes);
    });

    it('5.5 deberia serializar objetos y arreglos a JSON, jamas a [object Object]', () => {
      // 2. Act
      const objeto = context.getInterpolatedValue(
        '{{ parsed_email.metadata }}',
      );
      const arreglo = context.getInterpolatedValue(
        '{{ parsed_email.extracted_urls }}',
      );

      // 3. Assert
      expect(objeto).toBe('{"source":"imap","read":true}');
      expect(arreglo).toBe('["https://a.com","https://b.com"]');
      expect(objeto).not.toContain('[object Object]');
    });

    it('5.6 deberia bloquear el acceso a la cadena de prototipos', () => {
      // 2. Act + 3. Assert
      expect(() =>
        context.getInterpolatedValue('{{ parsed_email.__proto__.polluted }}'),
      ).toThrow(MissingContextVariableException);
      expect(() =>
        context.getInterpolatedValue('{{ parsed_email.constructor.name }}'),
      ).toThrow(MissingContextVariableException);
      expect(() =>
        context.getInterpolatedValue('{{ node.items[0].prototype }}'),
      ).toThrow(MissingContextVariableException);
    });

    it('5.7 deberia lanzar citando la ruta literal ante un indice fuera de rango', () => {
      // 2. Act
      let captured: MissingContextVariableException | undefined;

      try {
        context.getInterpolatedValue('{{ parsed_email.extracted_urls[99] }}');
      } catch (error) {
        captured = error as MissingContextVariableException;
      }

      // 3. Assert: se cita lo que escribio el autor, no la ruta normalizada
      expect(captured).toBeInstanceOf(MissingContextVariableException);
      expect(captured?.variable).toBe('parsed_email.extracted_urls[99]');
      expect(captured?.message).toContain('parsed_email.extracted_urls[99]');
    });

    it('5.8 deberia lanzar ante namespaces, intermedios ausentes o valores nulos', () => {
      // 2. Act + 3. Assert
      expect(() =>
        context.getInterpolatedValue('{{ raw_email.unregistered.field }}'),
      ).toThrow(MissingContextVariableException);
      expect(() =>
        context.getInterpolatedValue('{{ parsed_email.inexistente.field }}'),
      ).toThrow(MissingContextVariableException);
      // `adjunto` es null: no se puede seguir navegando a traves de el
      expect(() =>
        context.getInterpolatedValue('{{ parsed_email.adjunto.nombre }}'),
      ).toThrow(MissingContextVariableException);
      // Y el propio null tampoco es interpolable
      expect(() =>
        context.getInterpolatedValue('{{ parsed_email.adjunto }}'),
      ).toThrow(MissingContextVariableException);
    });

    it('5.9 deberia tolerar espaciado holgado en rutas compuestas', () => {
      // 2. Act + 3. Assert
      expect(context.getInterpolatedValue('{{   node.items[0].sub   }}')).toBe(
        'valor-sub',
      );
      expect(context.getInterpolatedValue('{{node.items[0].sub}}')).toBe(
        'valor-sub',
      );
    });

    it('5.10 deberia bloquear tambien las propiedades heredadas no listadas', () => {
      // 1. Arrange: `toString` no esta en la lista de bloqueo, pero tampoco es
      // una propiedad propia. Sin la guarda de Object.hasOwn devolveria una
      // funcion, y JSON.stringify de una funcion es undefined: la plantilla
      // acabaria con el literal "undefined" dentro.

      // 2. Act + 3. Assert
      expect(() =>
        context.getInterpolatedValue('{{ parsed_email.metadata.toString }}'),
      ).toThrow(MissingContextVariableException);
      expect(() =>
        context.getInterpolatedValue(
          '{{ parsed_email.metadata.hasOwnProperty }}',
        ),
      ).toThrow(MissingContextVariableException);
    });

    it('5.13 deberia bloquear un __proto__ inyectado como propiedad propia via JSON', () => {
      // 1. Arrange: este es el vector realista. El nodo de IA devuelve texto que
      // se parsea con JSON.parse, y JSON.parse crea `__proto__` como propiedad
      // PROPIA (no invoca el setter). Sobrevive a structuredClone y al spread de
      // setNamespace, asi que Object.hasOwn lo daria por bueno: aqui la unica
      // barrera es la lista de bloqueo.
      const respuestaLlm: Record<string, unknown> = JSON.parse(
        '{"__proto__":{"polluted":"si"},"titulo":"Legitimo"}',
      ) as Record<string, unknown>;
      context.setNamespace('llm_crudo', respuestaLlm);

      // 2. Act + 3. Assert
      expect(Object.hasOwn(respuestaLlm, '__proto__')).toBe(true);
      expect(() =>
        context.getInterpolatedValue('{{ llm_crudo.__proto__.polluted }}'),
      ).toThrow(MissingContextVariableException);
      // El resto del payload sigue siendo interpolable con normalidad
      expect(context.getInterpolatedValue('{{ llm_crudo.titulo }}')).toBe(
        'Legitimo',
      );
    });

    it('5.11 deberia dejar literal una ruta de un solo token', () => {
      // 1. Arrange: un namespace entero no es un valor interpolable
      const template = 'Sin segmento: {{ parsed_email }}';

      // 2. Act + 3. Assert
      expect(context.getInterpolatedValue(template)).toBe(template);
    });

    it('5.12 deberia resolver varias rutas compuestas en la misma plantilla', () => {
      // 1. Arrange
      const template =
        '<h1>{{ llm_response.articles[1].title }}</h1><p>{{ parsed_email.headers.routing.ip }}</p><a>{{ parsed_email.extracted_urls[0] }}</a>';

      // 2. Act
      const result = context.getInterpolatedValue(template);

      // 3. Assert
      expect(result).toBe(
        '<h1>Innovacion en Madrid</h1><p>192.168.10.44</p><a>https://a.com</a>',
      );
    });
  });

  describe('5bis. Interpolacion tolerante (getInterpolatedValueLenient)', () => {
    it('5bis.1 deberia sustituir por "" namespaces, campos nulos y rutas ausentes', () => {
      // 1. Arrange 📐
      context.setNamespace('scraped_web', {
        author: null,
        article_title: 'Titulo',
        meta: { site: 'F-Droid' },
      });
      const template =
        'A:{{scraped_web.author}}|T:{{ scraped_web.article_title }}|S:{{scraped_web.meta.site}}|X:{{ocr_result.clean_body}}|Y:{{scraped_web.meta.nada}}';

      // 2. Act ⚙️
      const { text, missing } = context.getInterpolatedValueLenient(template);

      // 3. Assert 🎯
      expect(text).toBe('A:|T:Titulo|S:F-Droid|X:|Y:');
      expect(text).not.toContain('{{');
      expect(missing).toEqual([
        'scraped_web.author',
        'ocr_result.clean_body',
        'scraped_web.meta.nada',
      ]);
    });

    it('5bis.2 deberia seguir bloqueando la cadena de prototipos', () => {
      // 1. Arrange 📐
      context.setNamespace('ns', { dato: { a: 1 } });

      // 2. Act ⚙️
      const { text, missing } = context.getInterpolatedValueLenient(
        '[{{ns.dato.__proto__.toString}}][{{ns.dato.constructor}}]',
      );

      // 3. Assert 🎯
      expect(text).toBe('[][]');
      expect(missing).toHaveLength(2);
    });

    it('5bis.3 deberia dejar intacta la variante estricta', () => {
      // 2. Act + 3. Assert 🎯
      expect(() =>
        context.getInterpolatedValue('{{scraped_web.author}}'),
      ).toThrow(MissingContextVariableException);
    });
  });

  describe('5ter. Marcas obligatorias {{*ns.campo}} frente a opcionales', () => {
    it('5ter.1 deberia interpolar una obligatoria presente sin reportar ausencias', () => {
      // 1. Arrange 📐
      context.setNamespace('parsed_email', { clean_body: 'Cuerpo limpio' });

      // 2. Act ⚙️
      const result = context.getInterpolatedValueLenient(
        'Texto: {{*parsed_email.clean_body}}',
      );

      // 3. Assert 🎯
      expect(result.text).toBe('Texto: Cuerpo limpio');
      expect(result.missingRequired).toEqual([]);
      expect(result.missing).toEqual([]);
    });

    it('5ter.2 deberia vaciar y reportar una obligatoria cuyo namespace o clave falta', () => {
      // 1. Arrange 📐
      context.setNamespace('scraped_web', { article_title: 'Titulo' });

      // 2. Act ⚙️
      const absentKey = context.getInterpolatedValueLenient(
        '[{{*scraped_web.full_article_content}}]',
      );
      const absentNamespace = buildContext().getInterpolatedValueLenient(
        '[{{*scraped_web.full_article_content}}]',
      );

      // 3. Assert 🎯
      expect(absentKey.text).toBe('[]');
      expect(absentKey.missingRequired).toEqual([
        'scraped_web.full_article_content',
      ]);
      expect(absentNamespace.missingRequired).toEqual([
        'scraped_web.full_article_content',
      ]);
    });

    it('5ter.3 deberia sustituir por "" una opcional ausente sin marcarla como obligatoria', () => {
      // 1. Arrange 📐
      context.setNamespace('scraped_web', { article_title: 'Titulo' });

      // 2. Act ⚙️
      const result = context.getInterpolatedValueLenient(
        'Por {{scraped_web.byline}}.',
      );

      // 3. Assert 🎯
      expect(result.text).toBe('Por .');
      expect(result.missingRequired).toEqual([]);
      expect(result.missing).toEqual(['scraped_web.byline']);
    });

    it('5ter.4 deberia resolver un mixto con espacios: obligatoria presente y opcional ausente', () => {
      // 1. Arrange 📐
      context.setNamespace('parsed_email', { clean_title: 'Convocatoria' });

      // 2. Act ⚙️
      const result = context.getInterpolatedValueLenient(
        'Hola {{ * parsed_email.clean_title }} - {{ parsed_email.sender }}',
      );

      // 3. Assert 🎯
      expect(result.text).toBe('Hola Convocatoria - ');
      expect(result.missingRequired).toEqual([]);
      expect(result.missing).toEqual(['parsed_email.sender']);
    });

    it('5ter.5 deberia tratar como ausente una obligatoria en blanco', () => {
      // 1. Arrange 📐
      context.setNamespace('parsed_email', { clean_body: '   ' });

      // 2. Act ⚙️
      const required = context.getInterpolatedValueLenient(
        '{{*parsed_email.clean_body}}',
      );
      const optional = context.getInterpolatedValueLenient(
        '{{parsed_email.clean_body}}',
      );

      // 3. Assert 🎯
      expect(required.missingRequired).toEqual(['parsed_email.clean_body']);
      expect(optional.missingRequired).toEqual([]);
      expect(optional.text).toBe('   ');
    });

    it('5ter.6 deberia admitir rutas profundas e indices con asterisco', () => {
      // 1. Arrange 📐
      context.setNamespace('scraped_web', {
        urls: ['https://a.es'],
        meta: { site: { name: 'Madri+d' } },
      });

      // 2. Act ⚙️
      const result = context.getInterpolatedValueLenient(
        '{{*scraped_web.urls[0]}}|{{*scraped_web.meta.site.name}}',
      );

      // 3. Assert 🎯
      expect(result.text).toBe('https://a.es|Madri+d');
      expect(result.missingRequired).toEqual([]);
    });

    it('5ter.7 deberia aceptar el asterisco como redundante en la variante estricta', () => {
      // 1. Arrange 📐
      context.setNamespace('parsed_email', { subject: 'Asunto' });

      // 2. Act + 3. Assert 🎯
      expect(context.getInterpolatedValue('{{*parsed_email.subject}}')).toBe(
        'Asunto',
      );
      expect(() =>
        context.getInterpolatedValue('{{*parsed_email.nada}}'),
      ).toThrow(MissingContextVariableException);
    });

    it('5ter.8 deberia extraer la raiz de una marca obligatoria', () => {
      // 2. Act + 3. Assert 🎯
      expect(
        extractNamespaceRoots(
          '{{*scraped_web.url}} {{ * ocr_result.clean_body }}',
        ),
      ).toEqual(['scraped_web', 'ocr_result']);
    });

    it('5ter.9 deberia rechazar el asterisco en los patrones anclados de DTO', () => {
      // 2. Act + 3. Assert 🎯
      expect(INTERPOLATION_ONLY_PATTERN.test('{{parsed_email.url}}')).toBe(
        true,
      );
      expect(INTERPOLATION_ONLY_PATTERN.test('{{*parsed_email.url}}')).toBe(
        false,
      );
    });

    it('5ter.10 deberia distinguir marcas obligatorias por su texto', () => {
      // 2. Act + 3. Assert 🎯
      expect(isRequiredMarker('{{*ns.campo}}')).toBe(true);
      expect(isRequiredMarker('{{ * ns.campo }}')).toBe(true);
      expect(isRequiredMarker('{{ns.campo}}')).toBe(false);
    });
  });

  describe('6. resolvePath como funcion pura (PROT-10)', () => {
    const namespaces = {
      ns: { lista: [{ id: 1 }], texto: 'hola' },
    };

    it('6.1 deberia resolver sin depender de una instancia del contexto', () => {
      // 2. Act + 3. Assert
      expect(resolvePath(namespaces, 'ns.texto')).toBe('hola');
      expect(resolvePath(namespaces, 'ns.lista[0].id')).toBe(1);
    });

    it('6.2 deberia devolver el valor sin serializar, respetando su tipo', () => {
      // 2. Act
      const lista = resolvePath(namespaces, 'ns.lista');

      // 3. Assert: la serializacion es responsabilidad de getInterpolatedValue
      expect(Array.isArray(lista)).toBe(true);
      expect(lista).toEqual([{ id: 1 }]);
    });

    it('6.3 deberia lanzar ante un namespace inexistente', () => {
      // 2. Act + 3. Assert
      expect(() => resolvePath(namespaces, 'fantasma.campo')).toThrow(
        MissingContextVariableException,
      );
    });

    it('6.4 no deberia mutar los namespaces recibidos', () => {
      // 1. Arrange
      const snapshot = structuredClone(namespaces);

      // 2. Act
      resolvePath(namespaces, 'ns.lista[0].id');

      // 3. Assert
      expect(namespaces).toEqual(snapshot);
    });
  });

  describe('extractNamespaceRoots', () => {
    it('deberia devolver la raiz de una ruta con indice de arreglo', () => {
      // 1. Arrange & 2. Act & 3. Assert
      expect(
        extractNamespaceRoots('{{parsed_email.extracted_urls[0]}}'),
      ).toEqual(['parsed_email']);
    });

    it('deberia devolver la raiz de una ruta anidada', () => {
      // 1. Arrange & 2. Act & 3. Assert
      expect(
        extractNamespaceRoots('{{llm_response.articles[1].title}}'),
      ).toEqual(['llm_response']);
    });

    it('deberia deduplicar y conservar el orden de aparicion', () => {
      // 1. Arrange
      const template =
        '{{scraped_web.article_title}} - {{parsed_email.subject}} ({{scraped_web.source_url}})';

      // 2. Act & 3. Assert
      expect(extractNamespaceRoots(template)).toEqual([
        'scraped_web',
        'parsed_email',
      ]);
    });

    it('deberia devolver vacio para un texto sin marcas', () => {
      // 1. Arrange & 2. Act & 3. Assert: es el caso de una URL literal, que no
      //    depende de nada aguas arriba.
      expect(extractNamespaceRoots('https://www.ejemplo.es/nota')).toEqual([]);
    });

    it('no deberia reconocer un namespace suelto sin segmento', () => {
      // 1. Arrange & 2. Act & 3. Assert: el patron exige al menos un segmento
      //    porque un namespace entero no es un valor interpolable. Reconocerlo
      //    aqui exigiria un requisito que `getInterpolatedValue` no sabe
      //    resolver.
      expect(extractNamespaceRoots('{{parsed_email}}')).toEqual([]);
    });

    it('deberia ser reejecutable sin arrastrar el estado del patron global', () => {
      // 1. Arrange: `INTERPOLATION_PATTERN` lleva la bandera `g` y por tanto
      //    `lastIndex`. Si se consumiera con `exec` en bucle, la segunda llamada
      //    empezaria a medio texto y devolveria menos raices que la primera.
      const template = '{{parsed_email.subject}}';

      // 2. Act
      const first = extractNamespaceRoots(template);
      const second = extractNamespaceRoots(template);

      // 3. Assert
      expect(second).toEqual(first);
    });
  });

  describe('collectNamespaceRoots', () => {
    it('deberia recolectar las raices de cualquier clave de un objeto', () => {
      // 1. Arrange: unos `params` cuyas marcas no estan en `targetUrl`, que es
      //    el unico campo que el extractor web sabe mirar por su cuenta.
      const params = {
        endpoint: '{{scraped_web.source_url}}',
        method: 'POST',
        timeoutMs: 20_000,
      };

      // 2. Act & 3. Assert
      expect(collectNamespaceRoots(params)).toEqual(['scraped_web']);
    });

    it('deberia descender por objetos y arreglos anidados', () => {
      // 1. Arrange
      const params = {
        headers: { Authorization: '{{llm_response.token}}' },
        body: [{ titulo: '{{parsed_email.clean_title}}' }, 'literal'],
      };

      // 2. Act & 3. Assert
      expect(collectNamespaceRoots(params)).toEqual([
        'llm_response',
        'parsed_email',
      ]);
    });

    it('deberia deduplicar las raices repetidas en varias claves', () => {
      // 1. Arrange
      const params = {
        titulo: '{{parsed_email.clean_title}}',
        cuerpo: '{{parsed_email.clean_body}}',
      };

      // 2. Act & 3. Assert
      expect(collectNamespaceRoots(params)).toEqual(['parsed_email']);
    });

    it('deberia ignorar numeros, booleanos y nulos', () => {
      // 1. Arrange & 2. Act & 3. Assert: no pueden contener una marca
      expect(
        collectNamespaceRoots({ a: 1, b: true, c: null, d: undefined }),
      ).toEqual([]);
    });

    it('deberia devolver vacio para unos params sin ninguna interpolacion', () => {
      // 1. Arrange & 2. Act & 3. Assert
      expect(
        collectNamespaceRoots({ mailbox: 'INBOX', includeAttachments: false }),
      ).toEqual([]);
    });

    it('deberia detenerse al agotar la profundidad maxima', () => {
      // 1. Arrange: `params` es una columna jsonb y pudo escribirse por SQL
      //    directo, asi que el tope existe para que un anidamiento absurdo no
      //    convierta la validacion en un recorrido interminable.
      let deep: Record<string, unknown> = { url: '{{parsed_email.subject}}' };

      for (let level = 0; level < 10; level += 1) {
        deep = { nested: deep };
      }

      // 2. Act & 3. Assert: la marca queda por debajo del tope y no se ve
      expect(collectNamespaceRoots(deep)).toEqual([]);
    });
  });

  describe('withNamespaceOverlays (contexto por elemento del lote)', () => {
    it('deberia superponer el elemento sin tocar el contexto original', () => {
      // 1. Arrange 📐
      const base = buildContext();
      base.setNamespace('llm_response', { headline: 'Primera', summary: 'R1' });
      base.setNamespace('raw_email', { subject: 'Boletin' });

      // 2. Act ⚙️
      const derived = base.withNamespaceOverlays({
        llm_response: { headline: 'Segunda' },
      });

      // 3. Assert 🎯: fusion con spread, y el original intacto.
      expect(derived.getInterpolatedValue('{{llm_response.headline}}')).toBe(
        'Segunda',
      );
      expect(derived.getNamespace('llm_response')).toEqual({
        headline: 'Segunda',
        summary: 'R1',
      });
      expect(derived.getNamespace('raw_email')).toEqual({ subject: 'Boletin' });
      expect(base.getInterpolatedValue('{{llm_response.headline}}')).toBe(
        'Primera',
      );
    });

    it('deberia conservar ejecucion, flujo y cursor', () => {
      // 1. Arrange 📐
      const base = buildContext();

      // 2. Act ⚙️
      const derived = base.withNamespaceOverlays({ ns: { a: 1 } });

      // 3. Assert 🎯
      expect(derived.getExecutionId()).toBe(EXECUTION_ID);
      expect(derived.getWorkflowId()).toBe(WORKFLOW_ID);
      expect(derived.getCursor()).toBe(INITIAL_STEP);
      expect(base.getNamespace('ns')).toBeUndefined();
    });

    it('no deberia propagar al original una mutacion de la superposicion', () => {
      // 1. Arrange 📐
      const base = buildContext();
      const overlay = { headline: 'Segunda', tags: ['a'] };
      const derived = base.withNamespaceOverlays({ llm_response: overlay });

      // 2. Act ⚙️
      overlay.tags.push('b');

      // 3. Assert 🎯
      expect(derived.getNamespace('llm_response')).toEqual({
        headline: 'Segunda',
        tags: ['a'],
      });
    });

    it('deberia purgar el contentBase64 de los adjuntos en el contexto derivado', () => {
      // 1. Arrange 📐: un correo con un adjunto binario y otro ya liberado.
      const base = buildContext();
      base.setNamespace('raw_email', {
        subject: 'RV: NOTIWEB',
        attachments: [
          {
            filename: 'escaneo.png',
            contentType: 'image/png',
            size: 4,
            contentBase64: 'iVBORw==',
          },
          {
            filename: 'nota.txt',
            contentType: 'text/plain',
            size: 2,
            contentBase64: null,
          },
        ],
      });

      // 2. Act ⚙️
      const derived = base.withNamespaceOverlays({
        llm_response: { headline: 'Segunda' },
      });

      // 3. Assert 🎯: el binario sale a null y los metadatos se conservan.
      expect(derived.getNamespace('raw_email')).toEqual({
        subject: 'RV: NOTIWEB',
        attachments: [
          {
            filename: 'escaneo.png',
            contentType: 'image/png',
            size: 4,
            contentBase64: null,
          },
          {
            filename: 'nota.txt',
            contentType: 'text/plain',
            size: 2,
            contentBase64: null,
          },
        ],
      });
      expect(JSON.stringify(derived.getAllContext())).not.toContain('iVBORw==');
    });

    it('deberia conservar el Base64 en el contexto original', () => {
      // 1. Arrange 📐
      const base = buildContext();
      base.setNamespace('raw_email', {
        attachments: [{ filename: 'a.pdf', contentBase64: 'JVBERi0=' }],
      });

      // 2. Act ⚙️
      base.withNamespaceOverlays({ llm_response: { headline: 'Segunda' } });

      // 3. Assert 🎯: UPLOAD_ATTACHMENT lee de aqui, y aqui sigue el binario.
      expect(base.getNamespace('raw_email')).toEqual({
        attachments: [{ filename: 'a.pdf', contentBase64: 'JVBERi0=' }],
      });
    });

    it('deberia purgar tambien el Base64 que traiga una superposicion', () => {
      // 1. Arrange 📐
      const base = buildContext();

      // 2. Act ⚙️
      const derived = base.withNamespaceOverlays({
        ns: { attachments: [{ filename: 'b.png', contentBase64: 'AAAA' }] },
      });

      // 3. Assert 🎯
      expect(derived.getNamespace('ns')).toEqual({
        attachments: [{ filename: 'b.png', contentBase64: null }],
      });
    });

    it('deberia seguir compartiendo por referencia los namespaces sin binarios', () => {
      // 1. Arrange 📐
      const base = buildContext();
      base.setNamespace('parsed_email', { clean_body: 'Texto' });
      base.setNamespace('raw_email', {
        attachments: [{ filename: 'a.pdf', contentBase64: 'JVBERi0=' }],
      });
      const internals = (
        ctx: StatePayloadContext,
      ): Record<string, Record<string, unknown>> =>
        (
          ctx as unknown as {
            namespaces: Record<string, Record<string, unknown>>;
          }
        ).namespaces;

      // 2. Act ⚙️
      const derived = base.withNamespaceOverlays({
        llm_response: { headline: 'Segunda' },
      });

      // 3. Assert 🎯: el ligero no se copia; el que llevaba binario si.
      expect(internals(derived).parsed_email).toBe(
        internals(base).parsed_email,
      );
      expect(internals(derived).raw_email).not.toBe(internals(base).raw_email);
    });

    it('deberia listar los namespaces escritos sin clonar su contenido', () => {
      // 1. Arrange 📐
      const base = buildContext();
      base.setNamespace('a', { x: 1 });
      base.setNamespace('b', { y: 2 });

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(base.getNamespaceNames().sort()).toEqual(['a', 'b']);
    });
  });
});
