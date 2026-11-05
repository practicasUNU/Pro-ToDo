import {
  MAX_PAYLOAD_PREVIEW_LENGTH,
  buildAlertEmailHtml,
  buildAlertEmailText,
} from './alert-email.template';

import type { AlertEmailParams } from './alert-email.template';

const TIMESTAMP = '2026-09-26T18:04:11.000Z';
const FLOW_ID = 'flow-00000000-0000-4000-8000-000000000000';

/** Carta completa, como la deja un desvio por `onErrorStep`. */
const buildParams = (
  overrides: Partial<AlertEmailParams> = {},
): AlertEmailParams => ({
  flowId: FLOW_ID,
  timestamp: TIMESTAMP,
  failedNodeId: 'nodo_parser',
  failedNodeType: 'PARSER_PRE_IA',
  errorCode: 'ERR_PARSER_UNEXTRACTABLE_MEDIA',
  errorLevel: 'GRAVE',
  errorMessage: 'El correo solo trae un PDF escaneado',
  ...overrides,
});

describe('buildAlertEmailHtml', () => {
  describe('1. Identidad institucional', () => {
    it('1.1 deberia abrir con el degradado corporativo y su color de respaldo', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const html = buildAlertEmailHtml(buildParams());

      // 3. Assert 🎯: Outlook ignora el degradado, asi que sin el
      //    `background-color` la cabecera saldria transparente y el rotulo
      //    blanco quedaria ilegible sobre el fondo del cliente.
      expect(html).toContain(
        'linear-gradient(90deg, #2C4FC7 0%, #4E74E8 100%)',
      );
      expect(html).toContain('background-color:#2C4FC7');
      expect(html).toContain('Notificacion de Incidencia');
    });

    it('1.2 deberia maquetar con tablas y CSS en linea', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const html = buildAlertEmailHtml(buildParams());

      // 3. Assert 🎯: Gmail y Outlook descartan las hojas externas y el `<style>`
      //    del `<head>`, y su soporte de flex y grid es irregular.
      expect(html).toContain('<table role="presentation"');
      expect(html).not.toContain('<style');
      expect(html).not.toContain('class=');
    });
  });

  describe('2. Badge de severidad', () => {
    it('2.1 deberia pintar URGENTE en rojo', () => {
      expect(
        buildAlertEmailHtml(buildParams({ errorLevel: 'URGENTE' })),
      ).toContain('#E74C3C');
    });

    it('2.2 deberia pintar GRAVE en ambar', () => {
      expect(
        buildAlertEmailHtml(buildParams({ errorLevel: 'GRAVE' })),
      ).toContain('#F59E0B');
    });

    it('2.3 no deberia pintar badge sin nivel declarado', () => {
      // 1. Arrange 📐: un nodo en el camino feliz no trae severidad.
      // 2. Act ⚙️
      const html = buildAlertEmailHtml({
        flowId: FLOW_ID,
        timestamp: TIMESTAMP,
        failedNodeId: 'nodo_parser',
      });

      // 3. Assert 🎯
      expect(html).not.toContain('border-radius:999px');
    });
  });

  describe('3. Campos opcionales', () => {
    it('3.1 deberia componer la carta minima con solo flujo y fecha', () => {
      // 1. Arrange 📐: el nodo NO esta atado a la rama de error. Sin
      //    `error_context` la carta tiene que salir igual.
      // 2. Act ⚙️
      const html = buildAlertEmailHtml({
        flowId: FLOW_ID,
        timestamp: TIMESTAMP,
      });

      // 3. Assert 🎯: lo que no se sabe se omite, jamas se pinta vacio.
      expect(html).not.toContain('undefined');
      expect(html).not.toContain('Codigo de error');
      expect(html).not.toContain('Nota del operador');
      expect(html).toContain(FLOW_ID);
      expect(html).toContain(TIMESTAMP);
    });

    it('3.2 deberia hablar del flujo, no del nodo, cuando no hubo fallo', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const html = buildAlertEmailHtml({
        flowId: FLOW_ID,
        timestamp: TIMESTAMP,
      });

      // 3. Assert 🎯
      expect(html).toContain('ha emitido una notificacion');
      expect(html).not.toContain('ha detenido su ejecucion en el nodo');
    });

    it('3.3 deberia destacar la nota del operador solo si viene', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const withNote = buildAlertEmailHtml(
        buildParams({ customNote: 'Llamar al movil de guardia.' }),
      );
      const blankNote = buildAlertEmailHtml(buildParams({ customNote: '   ' }));

      // 3. Assert 🎯
      expect(withNote).toContain('Nota del operador');
      expect(withNote).toContain('Llamar al movil de guardia.');
      expect(blankNote).not.toContain('Nota del operador');
    });

    it('3.4 deberia omitir el payload cuando viene vacio', () => {
      // 1. Arrange 📐: el motor siembra `partial_data` SIEMPRE, y con `{}` cuando
      //    el nodo no alcanzo a producir nada. Un recuadro negro vacio en mitad
      //    de la carta no dice nada.
      // 2. Act ⚙️ + 3. Assert 🎯
      expect(
        buildAlertEmailHtml(buildParams({ partialData: {} })),
      ).not.toContain('Datos parciales del nodo');
    });
  });

  describe('4. Payload tecnico', () => {
    it('4.1 deberia volcarlo indentado', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const html = buildAlertEmailHtml(
        buildParams({ partialData: { attachment_count: 1 } }),
      );

      // 3. Assert 🎯
      expect(html).toContain('Datos parciales del nodo');
      expect(html).toContain('&quot;attachment_count&quot;: 1');
    });

    it('4.2 deberia recortar un payload desmedido y decir que lo hizo', () => {
      // 1. Arrange 📐: `partial_data` de un parser es el correo saneado entero.
      //    Sin tope la carta pesaria cientos de kilobytes y algunos proveedores
      //    la rechazarian.
      const html = buildAlertEmailHtml(
        buildParams({ partialData: { clean_body: 'x'.repeat(10_000) } }),
      );

      // 2. Act ⚙️ + 3. Assert 🎯: el volcado completo sigue en el checkpoint y en
      //    el `.log`, que es donde se diagnostica de verdad.
      expect(html).toContain('Recortado');
      expect(html.length).toBeLessThan(MAX_PAYLOAD_PREVIEW_LENGTH * 3);
    });
  });

  describe('5. Escapado', () => {
    it('5.1 deberia neutralizar el marcado de todo dato dinamico', () => {
      // 1. Arrange 📐: `errorMessage` y `partialData` derivan del correo
      //    ENTRANTE, que escribe cualquiera.
      const html = buildAlertEmailHtml(
        buildParams({
          errorMessage: '<img src=x onerror="alert(1)">',
          customNote: '<b>urgente</b>',
          failedNodeId: '<script>robar()</script>',
          partialData: { subject: '<iframe src="evil"></iframe>' },
        }),
      );

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(html).not.toContain('<img');
      expect(html).not.toContain('<b>urgente');
      expect(html).not.toContain('<script>');
      expect(html).not.toContain('<iframe');
      expect(html).toContain('&lt;img src=x');
    });
  });

  describe('6. Aviso de asunto sin resolver', () => {
    it('6.1 deberia nombrar la variable culpable al pie', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const html = buildAlertEmailHtml(
        buildParams({ unresolvedSubjectVariable: 'trigger.flow_name' }),
      );

      // 3. Assert 🎯: el aviso se envio con el asunto de respaldo, y esta es la
      //    unica traza que llega a una persona.
      expect(html).toContain('trigger.flow_name');
      expect(html).toContain('asunto por defecto');
    });

    it('6.2 no deberia mencionarlo cuando el asunto resolvio', () => {
      expect(buildAlertEmailHtml(buildParams())).not.toContain(
        'asunto por defecto',
      );
    });
  });
});

describe('buildAlertEmailText', () => {
  it('7.1 no deberia llevar ni una etiqueta', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const text = buildAlertEmailText(
      buildParams({ customNote: 'Llamar al movil de guardia.' }),
    );

    // 3. Assert 🎯: es la version que se lee en un reloj o en un cliente con el
    //    marcado bloqueado.
    expect(text).not.toContain('<');
    expect(text).toContain('PROTO-DO');
    expect(text).toContain('Llamar al movil de guardia.');
  });

  it('7.2 deberia llevar los mismos datos que el HTML', () => {
    // 1. Arrange 📐: viven en el mismo modulo para que no puedan divergir; esta
    //    prueba es la que lo comprueba.
    const params = buildParams({ partialData: { attachment_count: 1 } });

    // 2. Act ⚙️
    const text = buildAlertEmailText(params);

    // 3. Assert 🎯
    expect(text).toContain('ERR_PARSER_UNEXTRACTABLE_MEDIA');
    expect(text).toContain('GRAVE');
    expect(text).toContain('nodo_parser');
    expect(text).toContain(FLOW_ID);
    expect(text).toContain(TIMESTAMP);
    expect(text).toContain('attachment_count');
  });

  it('7.3 deberia omitir lo ausente igual que el HTML', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const text = buildAlertEmailText({ flowId: FLOW_ID, timestamp: TIMESTAMP });

    // 3. Assert 🎯
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('Codigo de error');
    expect(text).toContain('ha emitido una notificacion');
  });

  it('7.4 no deberia escapar nada: el texto plano no interpreta marcado', () => {
    // 1. Arrange 📐: escaparlo aqui publicaria "&lt;" literal en el aviso, que es
    //    el defecto documentado en `article-extractor.util.ts`.
    // 2. Act ⚙️
    const text = buildAlertEmailText(
      buildParams({ errorMessage: 'AT&T <fallo>' }),
    );

    // 3. Assert 🎯
    expect(text).toContain('AT&T <fallo>');
    expect(text).not.toContain('&amp;');
  });
});
