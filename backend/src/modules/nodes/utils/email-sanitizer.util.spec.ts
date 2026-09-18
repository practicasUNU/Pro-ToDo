import {
  MAX_EXTRACTED_URLS,
  cleanSubject,
  normalizeWhitespace,
  reductionPercentage,
  sanitizeEmailHtml,
  sanitizeEmailText,
  stripReplyChain,
  stripSignatureBlock,
  stripTrailingBoilerplate,
} from './email-sanitizer.util';

/** Envuelve un texto en parrafos para ejercitar la ruta HTML. */
const asParagraphs = (...lines: readonly string[]): string =>
  lines.map((line) => `<p>${line}</p>`).join('');

describe('email-sanitizer.util', () => {
  describe('0. normalizeWhitespace', () => {
    it('0.1 deberia unificar CRLF y CR sueltos en saltos simples', () => {
      // 1. Arrange / 2. Act
      const result = normalizeWhitespace('uno\r\ndos\rtres');

      // 3. Assert
      expect(result).toBe('uno\ndos\ntres');
    });

    it('0.2 deberia convertir los espacios duros en espacios normales', () => {
      // 1. Arrange: `&nbsp;` decodifica a U+00A0, que NO es un espacio ASCII.
      const result = normalizeWhitespace('uno dos tres');

      // 3. Assert
      expect(result).toBe('uno dos tres');
      expect(result).not.toContain(' ');
    });

    it('0.3 deberia eliminar los espaciadores invisibles', () => {
      // 1. Arrange / 2. Act
      const result = normalizeWhitespace('u​n﻿o­s');

      // 3. Assert
      expect(result).toBe('unos');
    });

    it('0.4 deberia colapsar los espacios horizontales repetidos', () => {
      // 1. Arrange / 2. Act
      const result = normalizeWhitespace('uno  \t  dos');

      // 3. Assert
      expect(result).toBe('uno dos');
    });

    it('0.5 deberia dejar como maximo una linea en blanco entre parrafos', () => {
      // 1. Arrange / 2. Act
      const result = normalizeWhitespace('uno\n\n\n\n\ndos');

      // 3. Assert
      expect(result).toBe('uno\n\ndos');
    });

    it('0.6 deberia aplicar el orden que permite colapsar un espacio duro', () => {
      // 1. Arrange: si el paso del nbsp fuese DESPUES del colapso horizontal,
      //    esta cadena conservaria dos espacios seguidos y el recuento de
      //    caracteres quedaria inflado con blancos invisibles.
      const result = normalizeWhitespace('uno   dos');

      // 3. Assert
      expect(result).toBe('uno dos');
    });
  });

  describe('1. sanitizeEmailHtml: marcado a texto', () => {
    it('1.1 deberia eliminar script, style, noscript e iframe con su contenido', () => {
      // 1. Arrange
      const html =
        '<style>.a{color:red}</style><script>alert(1)</script>' +
        '<noscript>sin js</noscript><iframe src="x"></iframe><p>Titular</p>';

      // 2. Act
      const { text } = sanitizeEmailHtml(html);

      // 3. Assert: el texto interior de `style` acabaria en `clean_body` como si
      //    fuera prosa y envenenaria el prompt del nodo de inferencia.
      expect(text).toBe('Titular');
    });

    it('1.2 deberia separar los bloques con saltos de linea', () => {
      // 1. Arrange / 2. Act
      const { text } = sanitizeEmailHtml(asParagraphs('Uno', 'Dos'));

      // 3. Assert
      expect(text).toBe('Uno\n\nDos');
    });

    it('1.3 deberia convertir <br> en saltos de linea', () => {
      // 1. Arrange / 2. Act
      const { text } = sanitizeEmailHtml('<p>Uno<br>Dos</p>');

      // 3. Assert
      expect(text).toBe('Uno\nDos');
    });

    it('1.4 deberia separar las celdas con un espacio y no con un salto', () => {
      // 1. Arrange: con `\n` una fila horizontal se volveria una columna y la
      //    tabla perderia la unica estructura que tenia.
      const html = '<table><tr><td>Madrid</td><td>2026</td></tr></table>';

      // 2. Act
      const { text } = sanitizeEmailHtml(html);

      // 3. Assert
      expect(text).toBe('Madrid 2026');
    });

    it('1.5 deberia decodificar las entidades HTML', () => {
      // 1. Arrange / 2. Act
      const { text } = sanitizeEmailHtml('<p>M&aacute;s de 200 &amp; 300</p>');

      // 3. Assert
      expect(text).toBe('Más de 200 & 300');
    });

    it('1.6 deberia aplanar el anidamiento profundo sin duplicar el texto', () => {
      // 1. Arrange: un correo de Outlook son tablas dentro de tablas.
      const html =
        '<table><tr><td><div><p>Nueva sede</p></div></td></tr></table>';

      // 2. Act
      const { text } = sanitizeEmailHtml(html);

      // 3. Assert
      expect(text).toBe('Nueva sede');
    });

    it('1.7 deberia devolver un resultado vacio ante un marcado vacio', () => {
      // 1. Arrange / 2. Act
      const result = sanitizeEmailHtml('   ');

      // 3. Assert
      expect(result).toEqual({ text: '', urls: [] });
    });

    it('1.8 NO deberia lanzar ante un marcado mal formado', () => {
      // 1. Arrange: etiquetas sin cerrar y atributos rotos.
      const html = '<div><p>Texto<span class="roto<table><tr><td>Mas';

      // 2. Act / 3. Assert
      expect(() => sanitizeEmailHtml(html)).not.toThrow();
      expect(sanitizeEmailHtml(html).text).toContain('Texto');
    });

    it('1.9 deberia retirar los contenedores de firma y de cita conocidos', () => {
      // 1. Arrange
      const html =
        '<p>Cuerpo real del comunicado.</p>' +
        '<div class="gmail_signature">Juan Perez, Gabinete de Prensa</div>' +
        '<blockquote type="cite">texto citado</blockquote>';

      // 2. Act
      const { text } = sanitizeEmailHtml(html);

      // 3. Assert
      expect(text).toBe('Cuerpo real del comunicado.');
    });

    it('1.10 deberia borrar el marcador de Outlook Y todo lo que le sigue', () => {
      // 1. Arrange: `#appendonsend` no ENVUELVE la cita, la PRECEDE. Borrar solo
      //    el marcador dejaria el hilo entero dentro del cuerpo.
      const html =
        '<div><p>Os envio la nota.</p><div id="appendonsend"></div>' +
        '<p>hilo citado que sobra</p></div><p>cola tambien citada</p>';

      // 2. Act
      const { text } = sanitizeEmailHtml(html);

      // 3. Assert
      expect(text).toBe('Os envio la nota.');
    });
  });

  describe('2. stripReplyChain', () => {
    const BODY = 'Os envio la nota de prensa para su publicacion.';

    it.each([
      ['divisor de Outlook', '-----Mensaje original-----'],
      ['divisor en ingles', '----- Original Message -----'],
      ['regla de guiones bajos', '________________________________'],
      ['atribucion en espanol', 'El 12/03/2026, Ana <ana@ext.com> escribio:'],
      ['atribucion en ingles', 'On Mar 12 2026, Ana <ana@ext.com> wrote:'],
      ['cabeceras del reenvio', 'De: Ana <ana@ext.com>\nEnviado el: martes'],
    ])('2.x deberia cortar en el %s', (_label, divider) => {
      // 1. Arrange
      const text = `${BODY}\n\n${divider}\n> texto citado que no debe aparecer`;

      // 2. Act
      const result = stripReplyChain(text);

      // 3. Assert
      expect(result.trim()).toBe(BODY);
      expect(result).not.toContain('texto citado');
    });

    it('2.7 NO deberia vaciar un reenvio cuyo unico contenido es la cita', () => {
      // 1. Arrange: si cortar deja la cabeza vacia es preferible entregar la
      //    cita que entregar la nada.
      const text = '-----Mensaje original-----\nLa nota de prensa iba aqui.';

      // 2. Act
      const result = stripReplyChain(text);

      // 3. Assert
      expect(result).toBe(text);
    });

    it('2.8 NO deberia cortar en un "escribio" sin direccion de correo', () => {
      // 1. Arrange: la @ es obligatoria en el patron. Sin ella, cualquier
      //    parrafo de la noticia que use el verbo decapitaria el cuerpo.
      const text =
        'El consejero escribio: la nueva sede abrira en marzo.\n\nSigue el texto.';

      // 2. Act / 3. Assert
      expect(stripReplyChain(text)).toBe(text);
    });
  });

  describe('3. stripSignatureBlock', () => {
    it('3.1 deberia cortar en el delimitador de la RFC 3676', () => {
      // 1. Arrange / 2. Act
      const result = stripSignatureBlock(
        'Cuerpo real.\n\n--\nJuan Perez\nUNUWARE',
      );

      // 3. Assert
      expect(result.trim()).toBe('Cuerpo real.');
    });

    it('3.2 NO deberia confundir un guion doble en mitad de una frase', () => {
      // 1. Arrange: el patron exige los dos guiones SOLOS en su linea.
      const text = 'La sede --la mayor del grupo-- abre en marzo.';

      // 2. Act / 3. Assert
      expect(stripSignatureBlock(text)).toBe(text);
    });
  });

  describe('4. stripTrailingBoilerplate', () => {
    const BODY = 'La compania abre una nueva sede en Madrid.';

    it.each([
      ['aviso legal en espanol', 'AVISO LEGAL: este mensaje es confidencial.'],
      [
        'clausula de datos',
        'Puede ejercer sus derechos de acceso, rectificacion y supresion.',
      ],
      ['aviso en ingles', 'This message is confidential and privileged.'],
      [
        'destinatario no previsto',
        'If you are not the intended recipient, delete it.',
      ],
      [
        'cortesia de impresion',
        'Por favor, no imprima este mensaje si no es necesario.',
      ],
    ])('4.x deberia retirar el %s del final', (_label, notice) => {
      // 1. Arrange
      const text = `${BODY}\n\n${notice}`;

      // 2. Act / 3. Assert
      expect(stripTrailingBoilerplate(text)).toBe(BODY);
    });

    it('4.6 deberia retirar la racha entera de parrafos legales finales', () => {
      // 1. Arrange
      const text = [
        BODY,
        'AVISO LEGAL: este mensaje es confidencial.',
        'Para darse de baja del boletin, escriba a prensa.',
      ].join('\n\n');

      // 2. Act / 3. Assert
      expect(stripTrailingBoilerplate(text)).toBe(BODY);
    });

    it('4.7 NO deberia retirar un parrafo legal que este en MITAD del cuerpo', () => {
      // 1. Arrange: es el anti-falso-positivo que sostiene toda la heuristica.
      //    El corpus son notas de prensa institucionales, donde un comunicado
      //    puede hablar del RGPD como CONTENIDO. Solo se barre la racha final.
      const text = [
        BODY,
        'La nueva normativa aplica el RGPD a todo el sector publico.',
        'El acto de inauguracion sera en marzo.',
      ].join('\n\n');

      // 2. Act / 3. Assert
      expect(stripTrailingBoilerplate(text)).toBe(text);
    });

    it('4.8 NO deberia retirar un parrafo legal mas largo que el tope', () => {
      // 1. Arrange: red de seguridad para el aviso pegado al cuerpo sin linea en
      //    blanco. Un parrafo largo es prosa, no un pie.
      const longNotice = `AVISO LEGAL: este mensaje es confidencial. ${'texto '.repeat(200)}`;
      const text = `${BODY}\n\n${longNotice}`;

      // 2. Act / 3. Assert
      expect(stripTrailingBoilerplate(text)).toBe(text);
    });

    it('4.9 NO deberia vaciar un cuerpo que es integramente un aviso legal', () => {
      // 1. Arrange
      const text = 'AVISO LEGAL: este mensaje es confidencial.';

      // 2. Act / 3. Assert
      expect(stripTrailingBoilerplate(text)).toBe(text);
    });
  });

  describe('5. Extraccion y normalizacion de enlaces', () => {
    it('5.1 deberia recoger los enlaces http(s) en orden de aparicion', () => {
      // 1. Arrange
      const html =
        '<a href="https://unuware.com/a">A</a><a href="http://unuware.com/b">B</a>';

      // 2. Act
      const { urls } = sanitizeEmailHtml(html);

      // 3. Assert
      expect(urls).toEqual(['https://unuware.com/a', 'http://unuware.com/b']);
    });

    it('5.2 deberia descartar mailto, tel, javascript y anclas puras', () => {
      // 1. Arrange: el consumidor natural es EXTRACTOR_WEB, que solo navega
      //    http(s); un mailto ahi es una descarga fallida con su reintento.
      const html =
        '<a href="mailto:a@b.com">M</a><a href="tel:+34600">T</a>' +
        '<a href="javascript:void(0)">J</a><a href="#seccion">A</a>';

      // 2. Act
      const { urls } = sanitizeEmailHtml(html);

      // 3. Assert
      expect(urls).toEqual([]);
    });

    it('5.3 deberia descartar las rutas relativas', () => {
      // 1. Arrange: un correo no tiene documento base, y absolutizar contra el
      //    dominio del remitente fabricaria una direccion que puede no existir.
      const html = '<a href="/noticias/1">N</a><a href="../otra">O</a>';

      // 2. Act / 3. Assert
      expect(sanitizeEmailHtml(html).urls).toEqual([]);
    });

    it('5.4 deberia rescatar las protocol-relative promoviendolas a https', () => {
      // 1. Arrange: aqui el host es explicito y no se inventa nada.
      const html = '<a href="//unuware.com/nota">N</a>';

      // 2. Act / 3. Assert
      expect(sanitizeEmailHtml(html).urls).toEqual([
        'https://unuware.com/nota',
      ]);
    });

    it('5.5 deberia descartar Twitter/X, Facebook, LinkedIn e Instagram', () => {
      // 1. Arrange
      const html = [
        '<a href="https://twitter.com/unuware">T</a>',
        '<a href="https://x.com/unuware">X</a>',
        '<a href="https://www.facebook.com/unuware">F</a>',
        '<a href="https://linkedin.com/company/unuware">L</a>',
        '<a href="https://instagram.com/unuware">I</a>',
        '<a href="https://lnkd.in/abc">S</a>',
      ].join('');

      // 2. Act / 3. Assert
      expect(sanitizeEmailHtml(html).urls).toEqual([]);
    });

    it('5.6 NO deberia descartar YouTube: un video institucional es contenido', () => {
      // 1. Arrange: queda fuera de la lista social a proposito. Que nadie lo
      //    anada "por simetria".
      const html = '<a href="https://www.youtube.com/watch?v=abc">Video</a>';

      // 2. Act / 3. Assert
      expect(sanitizeEmailHtml(html).urls).toEqual([
        'https://www.youtube.com/watch?v=abc',
      ]);
    });

    it('5.7 deberia descartar los enlaces de desuscripcion por su ruta', () => {
      // 1. Arrange
      const html =
        '<a href="https://unuware.com/unsubscribe?id=7">Baja</a>' +
        '<a href="https://unuware.com/nota">Nota</a>';

      // 2. Act / 3. Assert
      expect(sanitizeEmailHtml(html).urls).toEqual([
        'https://unuware.com/nota',
      ]);
    });

    it('5.8 deberia descartar la desuscripcion escondida tras un redirector', () => {
      // 1. Arrange: la ruta es un identificador ilegible y solo el TEXTO del
      //    ancla delata la funcion del enlace.
      const html = '<a href="https://opaco.example/r/9f2a">Darse de baja</a>';

      // 2. Act / 3. Assert
      expect(sanitizeEmailHtml(html).urls).toEqual([]);
    });

    it('5.9 deberia descartar los redirectores de campana conocidos', () => {
      // 1. Arrange
      const html =
        '<a href="https://unuware.list-manage.com/track/click">C</a>';

      // 2. Act / 3. Assert
      expect(sanitizeEmailHtml(html).urls).toEqual([]);
    });

    it('5.10 deberia retirar los parametros utm_* conservando los funcionales', () => {
      // 1. Arrange
      const html =
        '<a href="https://unuware.com/n?utm_source=mc&id=7&utm_campaign=x">N</a>';

      // 2. Act / 3. Assert
      expect(sanitizeEmailHtml(html).urls).toEqual([
        'https://unuware.com/n?id=7',
      ]);
    });

    it('5.11 deberia deduplicar dos enlaces que solo diferian en el tracking', () => {
      // 1. Arrange: sin esto EXTRACTOR_WEB pagaria DOS navegaciones de
      //    Playwright por la misma pagina.
      const html =
        '<a href="https://unuware.com/n?id=7&utm_content=a">A</a>' +
        '<a href="https://unuware.com/n?id=7&utm_content=b">B</a>';

      // 2. Act / 3. Assert
      expect(sanitizeEmailHtml(html).urls).toEqual([
        'https://unuware.com/n?id=7',
      ]);
    });

    it('5.12 NO deberia recoger enlaces que vivian dentro de la firma', () => {
      // 1. Arrange: la recoleccion va DESPUES de podar, de modo que `clean_body`
      //    y `extracted_urls` describan el mismo documento.
      const html =
        '<p><a href="https://unuware.com/nota">Nota</a></p>' +
        '<div class="gmail_signature"><a href="https://oculto.test/x">web</a></div>';

      // 2. Act / 3. Assert
      expect(sanitizeEmailHtml(html).urls).toEqual([
        'https://unuware.com/nota',
      ]);
    });

    it('5.13 deberia acotar la lista a MAX_EXTRACTED_URLS', () => {
      // 1. Arrange: el arreglo se reserializa entero en cada checkpoint
      //    posterior; es el mismo argumento de peso que la purga de binarios.
      const html = Array.from(
        { length: MAX_EXTRACTED_URLS + 25 },
        (_value, index) => `<a href="https://unuware.com/n/${index}">N</a>`,
      ).join('');

      // 2. Act / 3. Assert
      expect(sanitizeEmailHtml(html).urls).toHaveLength(MAX_EXTRACTED_URLS);
    });
  });

  describe('6. cleanSubject', () => {
    it.each([
      ['Fwd: Re: Noticia', 'Noticia'],
      ['RV: ENC: Re[2]: FW: Noticia', 'Noticia'],
      ['re: RE: rv: Noticia', 'Noticia'],
      ['  Fwd:   Noticia  ', 'Noticia'],
      ['RE(2): Noticia', 'Noticia'],
      ['Noticia sin prefijo', 'Noticia sin prefijo'],
    ])('6.x deberia reducir %j a %j', (input, expected) => {
      // 1. Arrange / 2. Act / 3. Assert
      expect(cleanSubject(input)).toBe(expected);
    });

    it('6.7 NO deberia vaciar un asunto que solo eran prefijos', () => {
      // 1. Arrange: un titulo vacio rompe cualquier plantilla que lo interpole.
      // 2. Act / 3. Assert
      expect(cleanSubject('Re:')).toBe('Re:');
    });

    it('6.8 NO deberia tocar una referencia de expediente', () => {
      // 1. Arrange: `ref` queda fuera de la lista a proposito. El criterio es
      //    falso negativo antes que falso positivo.
      // 2. Act / 3. Assert
      expect(cleanSubject('Ref: 2026/45 Nueva sede')).toBe(
        'Ref: 2026/45 Nueva sede',
      );
    });

    it('6.9 deberia deshacer el plegado MIME de un asunto largo', () => {
      // 1. Arrange / 2. Act / 3. Assert
      expect(cleanSubject('Fwd: Nueva sede\r\n\ten Madrid')).toBe(
        'Nueva sede en Madrid',
      );
    });
  });

  describe('7. reductionPercentage', () => {
    it('7.1 deberia calcular el porcentaje con dos decimales', () => {
      // 1. Arrange / 2. Act / 3. Assert
      expect(reductionPercentage(1000, 250)).toBe(75);
      expect(reductionPercentage(3, 1)).toBe(66.67);
    });

    it('7.2 deberia devolver 0 y no NaN cuando el original es cero', () => {
      // 1. Arrange: `NaN` se serializa a `null` en el jsonb y romperia en
      //    silencio la regla de "toda clave presente CON SU TIPO".
      const result = reductionPercentage(0, 0);

      // 3. Assert
      expect(result).toBe(0);
      expect(Number.isNaN(result)).toBe(false);
    });

    it('7.3 deberia acotar a 0 si el resultado fuese mas largo que el original', () => {
      // 1. Arrange / 2. Act / 3. Assert
      expect(reductionPercentage(100, 150)).toBe(0);
    });

    it('7.4 deberia devolver 100 cuando no queda nada', () => {
      // 1. Arrange / 2. Act / 3. Assert
      expect(reductionPercentage(500, 0)).toBe(100);
    });
  });

  describe('8. sanitizeEmailText: la ruta de texto plano', () => {
    it('8.1 deberia encadenar cita, firma y pie legal en una sola pasada', () => {
      // 1. Arrange: un text/plain con cuarenta lineas de cita y un aviso legal
      //    entraria entero al prompt si el nodo se limitase a un `trim()`.
      const text = [
        'Os envio la nota de prensa adjunta.',
        '',
        'AVISO LEGAL: este mensaje es confidencial.',
        '',
        'El 12/03/2026, Ana <ana@ext.com> escribio:',
        '> hilo citado',
      ].join('\n');

      // 2. Act
      const result = sanitizeEmailText(text);

      // 3. Assert
      expect(result).toBe('Os envio la nota de prensa adjunta.');
    });

    it('8.2 deberia dejar intacto un cuerpo que ya estaba limpio', () => {
      // 1. Arrange / 2. Act / 3. Assert
      expect(sanitizeEmailText('Nota de prensa.\n\nSegundo parrafo.')).toBe(
        'Nota de prensa.\n\nSegundo parrafo.',
      );
    });
  });
});
