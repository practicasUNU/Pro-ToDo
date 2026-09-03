import { describe, expect, it } from 'vitest';

import { locateViolations } from './violation-matcher';

import type { TemplateViolation } from '@/types/html-template';

/**
 * Documento con senuelos deliberados para cada tipo de falso positivo:
 * `<pre>` contiene `<p`, `data-onerror` contiene `onerror`, y hay un «body»
 * como palabra suelta y otro escapado como entidad.
 */
const HOSTILE_DOC = [
  '<body>',
  '  <pre>codigo</pre>',
  '  <p data-onerror="no">Hola</p>',
  '  <img src="x" onerror="alert(1)">',
  '  <a href="javascript:alert(1)">click</a>',
  '  <p>la palabra body y &lt;body&gt; escapado</p>',
  '  <BODY>',
  '  <h1>{{ bad_ns.titulo }}</h1>',
  '</body>',
].join('\n');

/** Texto que el rango localizado abarca; es lo que el editor subrayaria. */
const matchedTexts = (doc: string, violations: TemplateViolation[]): string[] =>
  locateViolations(doc, violations).map(({ from, to }) => doc.slice(from, to));

const violation = (
  target: string,
  type: TemplateViolation['type'],
): TemplateViolation => ({ target, type, message: `problema con ${target}` });

describe('locateViolations', () => {
  describe('1. Etiquetas', () => {
    it('1.1 deberia localizar apertura, cierre y variante en mayusculas', () => {
      // 1. Arrange & 2. Act
      const matches = matchedTexts(HOSTILE_DOC, [violation('body', 'tag')]);

      // 3. Assert: NO casan la palabra suelta «body» ni el `&lt;body&gt;`
      expect(matches).toEqual(['<body', '<BODY', '</body']);
    });

    it('1.2 NO deberia casar un tag dentro de otro con el mismo prefijo', () => {
      // 1. Arrange & 2. Act: el senuelo clasico de un `indexOf('<p')`
      const matches = matchedTexts('<pre>x</pre><p>y</p>', [
        violation('p', 'tag'),
      ]);

      // 3. Assert: solo el <p> real, no el <pre>
      expect(matches).toEqual(['<p', '</p']);
    });

    it('1.3 deberia casar una etiqueta con atributos y una autocerrada', () => {
      // 1. Arrange & 2. Act
      const matches = matchedTexts('<img src="a"><br/>', [
        violation('img', 'tag'),
        violation('br', 'tag'),
      ]);

      // 3. Assert
      expect(matches).toEqual(['<img', '<br']);
    });
  });

  describe('2. Atributos', () => {
    it('2.1 NO deberia casar un atributo con prefijo (data-onerror)', () => {
      // 1. Arrange & 2. Act
      const ranges = locateViolations(HOSTILE_DOC, [
        violation('onerror', 'attribute'),
      ]);

      // 3. Assert: una sola marca, y en la linea del `onerror` de verdad (la 4),
      //    no en la del `data-onerror` (la 3)
      expect(ranges).toHaveLength(1);

      const lineNumber = HOSTILE_DOC.slice(0, ranges[0]!.from).split('\n').length;

      expect(lineNumber).toBe(4);
      expect(HOSTILE_DOC.slice(ranges[0]!.from, ranges[0]!.to)).toBe('onerror');
    });

    it('2.2 deberia tolerar espacios antes del igual', () => {
      // 1. Arrange & 2. Act
      const matches = matchedTexts('<div onclick = "x()">t</div>', [
        violation('onclick', 'attribute'),
      ]);

      // 3. Assert
      expect(matches).toEqual(['onclick']);
    });

    it('2.3 NO deberia casar el nombre del atributo dentro de un texto', () => {
      // 1. Arrange & 2. Act: sin `=` detras no es una asignacion de atributo
      const matches = matchedTexts('<p>hablemos de srcset y ya</p>', [
        violation('srcset', 'attribute'),
      ]);

      // 3. Assert
      expect(matches).toEqual([]);
    });
  });

  describe('3. Protocolos y variables', () => {
    it('3.1 deberia localizar el pseudo-protocolo', () => {
      // 1. Arrange & 2. Act
      const matches = matchedTexts(HOSTILE_DOC, [
        violation('javascript:', 'protocol'),
      ]);

      // 3. Assert
      expect(matches).toEqual(['javascript:']);
    });

    it('3.2 deberia localizar el marcador verbatim, espacios incluidos', () => {
      // 1. Arrange & 2. Act: el backend envia el match completo del regex, no
      //    la ruta normalizada, justamente para que esto coincida.
      const matches = matchedTexts(HOSTILE_DOC, [
        violation('{{ bad_ns.titulo }}', 'variable'),
      ]);

      // 3. Assert
      expect(matches).toEqual(['{{ bad_ns.titulo }}']);
    });

    it('3.3 deberia escapar los metacaracteres del target', () => {
      // 1. Arrange & 2. Act: `{`, `[`, `]` y `.` son sintaxis de RegExp
      const doc = '<p>{{ llm_response.articles.[0].title }}</p>';
      const matches = matchedTexts(doc, [
        violation('{{ llm_response.articles.[0].title }}', 'variable'),
      ]);

      // 3. Assert
      expect(matches).toEqual(['{{ llm_response.articles.[0].title }}']);
    });

    it('3.4 NO deberia tratar el target como patron (sin escapar casaria de mas)', () => {
      // 1. Arrange & 2. Act: `{{{` sin escapar es un cuantificador invalido
      const matches = matchedTexts('<p>{{{crudo}}}</p>', [
        violation('{{{', 'variable'),
      ]);

      // 3. Assert
      expect(matches).toEqual(['{{{']);
    });
  });

  describe('4. Contrato con CodeMirror', () => {
    it('4.1 deberia devolver los rangos ordenados por posicion', () => {
      // 1. Arrange: el barrido es por infraccion, asi que el orden de entrada
      //    no es el orden del documento.
      const violations = [
        violation('javascript:', 'protocol'),
        violation('body', 'tag'),
        violation('onerror', 'attribute'),
      ];

      // 2. Act
      const ranges = locateViolations(HOSTILE_DOC, violations);

      // 3. Assert: CodeMirror rechaza diagnosticos desordenados
      const positions = ranges.map(({ from }) => from);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    });

    it('4.2 deberia conservar el mensaje de cada infraccion en su rango', () => {
      // 1. Arrange & 2. Act
      const ranges = locateViolations(HOSTILE_DOC, [
        violation('javascript:', 'protocol'),
      ]);

      // 3. Assert
      expect(ranges[0]?.message).toBe('problema con javascript:');
    });

    it('4.3 deberia devolver vacio sin infracciones', () => {
      // 1. Arrange & 2. Act
      // 3. Assert
      expect(locateViolations(HOSTILE_DOC, [])).toEqual([]);
    });

    it('4.4 deberia devolver vacio si el target ya no esta en el documento', () => {
      // 1. Arrange & 2. Act: el autor corrigio antes de que llegue la respuesta
      // 3. Assert
      expect(
        locateViolations('<p>limpio</p>', [violation('script', 'tag')]),
      ).toEqual([]);
    });
  });
});
