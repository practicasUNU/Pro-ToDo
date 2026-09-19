import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_MIN_BODY_LENGTH,
  DEFAULT_PARSER_SOURCE_NAMESPACE,
  MIN_BODY_LENGTH,
  useParserEmailStore,
} from './parser-email.store';

import type { CheckParserResult, ParsedEmailPayload } from '@/types/parser-email';

// Sin esto se cargaria `@boot/axios`, que necesita entorno de navegador.
vi.mock('@services/nodes/parser-email.service', () => ({
  checkParser: vi.fn(),
}));

const parserEmailService = await import('@services/nodes/parser-email.service');
const checkParser = vi.mocked(parserEmailService.checkParser);

/**
 * `nodeId` del nodo bajo prueba.
 *
 * El store se instancia POR NODO, asi que toda prueba tiene que nombrar el nodo
 * al que pregunta.
 */
const NODE_ID = 'parser_pre_ia';

/** Payload que el backend devolveria, con las trece claves. */
const buildParsedPayload = (overrides: Partial<ParsedEmailPayload> = {}): ParsedEmailPayload => ({
  subject: 'Fwd: Nueva sede',
  clean_title: 'Nueva sede',
  clean_body: 'La compania abre una nueva sede en Madrid.',
  body_source: 'html',
  character_count: 41,
  original_character_count: 820,
  reduction_percentage: 95,
  extracted_urls: ['https://unuware.com/nota'],
  attachment_count: 0,
  attachments: [],
  extracted_documents_text: '',
  requires_multimodal_fallback: false,
  multimodal_reason: '',
  ...overrides,
});

const buildResult = (overrides: Partial<CheckParserResult> = {}): CheckParserResult => ({
  success: true,
  parsed: buildParsedPayload(),
  ...overrides,
});

describe('useParserEmailStore · configuracion del nodo PARSER_PRE_IA', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  describe('1. Estado inicial', () => {
    it('1.1 deberia arrancar con los defectos del backend', () => {
      // 1. Arrange & 2. Act
      const store = useParserEmailStore(NODE_ID);

      // 3. Assert
      expect(store.config.minBodyLength).toBe(DEFAULT_MIN_BODY_LENGTH);
      expect(store.config.sourceNamespace).toBe(DEFAULT_PARSER_SOURCE_NAMESPACE);
      expect(store.sandboxResult).toBeNull();
      expect(store.loading).toBe(false);
    });

    it('1.2 deberia ser valido de salida, sin exigir haber probado nada', () => {
      // 1. Arrange & 2. Act
      const store = useParserEmailStore(NODE_ID);

      // 3. Assert: contrapunto explicito al disparador IMAP, que SI exige la
      //    conexion probada. Aquella exigencia protege de unas credenciales que
      //    no fallarian hasta el primer sondeo; aqui no hay credenciales ni red,
      //    y copiar ese Poka-Yoke haria imposible guardar un flujo con parser sin
      //    tener a mano un correo de ejemplo. Sin esta prueba, alguien lo
      //    "arreglaria" por simetria.
      expect(store.isConfigValid).toBe(true);
      expect(store.canRunSandbox).toBe(false);
    });
  });

  describe('2. Regla del umbral', () => {
    it('2.1 deberia rechazar el cero', () => {
      // 1. Arrange: espejo del `@IsPositive()` del DTO backend, que queda
      //    intacto. Sin esta copia el operador veria un 400 de servidor donde
      //    deberia haber visto una regla de campo.
      const store = useParserEmailStore(NODE_ID);

      // 2. Act
      store.updateConfig({ minBodyLength: 0 });

      // 3. Assert
      expect(store.isConfigValid).toBe(false);
    });

    it('2.2 deberia aceptar el uno, que es el minimo exacto', () => {
      // 1. Arrange: fija el limite contra una regresion que lo suba.
      const store = useParserEmailStore(NODE_ID);

      // 2. Act
      store.updateConfig({ minBodyLength: MIN_BODY_LENGTH });

      // 3. Assert
      expect(store.isConfigValid).toBe(true);
    });

    it.each([1.5, -10, Number.NaN, Number.POSITIVE_INFINITY])(
      '2.3 deberia rechazar %p',
      (value) => {
        // 1. Arrange
        const store = useParserEmailStore(NODE_ID);

        // 2. Act
        store.updateConfig({ minBodyLength: value });

        // 3. Assert
        expect(store.isConfigValid).toBe(false);
      },
    );
  });

  describe('3. Contrato con el pipeline_schema', () => {
    it('3.1 deberia publicar solo minBodyLength con el namespace por defecto', () => {
      // 1. Arrange: emitir `sourceNamespace` siempre congelaria el defecto de
      //    hoy dentro de cada esquema guardado.
      const store = useParserEmailStore(NODE_ID);

      // 2. Act
      store.updateConfig({ minBodyLength: 120 });

      // 3. Assert: `outputNamespace` tampoco va aqui: en el esquema es propiedad
      //    del nodo, no de sus `params`.
      expect(store.toNodeParams()).toEqual({ minBodyLength: 120 });
    });

    it('3.2 deberia reproducir un namespace de autoria manual', () => {
      // 1. Arrange: la prueba clave del ida y vuelta. Omitir siempre
      //    `sourceNamespace` devolveria a `raw_email` un nodo escrito a mano
      //    para leer de `scraped_web`, y pasaria a fallar con
      //    ERR_PARSER_SOURCE_MISSING sin que nadie lo pidiera.
      const store = useParserEmailStore(NODE_ID);

      // 2. Act
      store.hydrateFromNode({
        outputNamespace: 'parsed_email',
        params: { sourceNamespace: 'scraped_web', minBodyLength: 200 },
      });

      // 3. Assert
      expect(store.toNodeParams()).toEqual({
        sourceNamespace: 'scraped_web',
        minBodyLength: 200,
      });
    });

    it('3.3 deberia reponer los defectos al hidratar un nodo sin params', () => {
      // 1. Arrange
      const store = useParserEmailStore(NODE_ID);

      // 2. Act
      store.hydrateFromNode({ outputNamespace: 'parsed_email', params: {} });

      // 3. Assert
      expect(store.config.minBodyLength).toBe(DEFAULT_MIN_BODY_LENGTH);
      expect(store.toNodeParams()).toEqual({
        minBodyLength: DEFAULT_MIN_BODY_LENGTH,
      });
    });

    it('3.4 deberia tolerar un jsonb con el tipo equivocado', () => {
      // 1. Arrange: la columna pudo escribirse por SQL directo. Propagar el
      //    valor crudo dejaria el `<q-input>` como campo descontrolado en Vue.
      const store = useParserEmailStore(NODE_ID);

      // 2. Act
      store.hydrateFromNode({
        outputNamespace: 'parsed_email',
        params: { minBodyLength: 'cincuenta', sourceNamespace: 42 },
      });

      // 3. Assert
      expect(store.config.minBodyLength).toBe(DEFAULT_MIN_BODY_LENGTH);
      expect(store.config.sourceNamespace).toBe(DEFAULT_PARSER_SOURCE_NAMESPACE);
    });

    it('3.5 deberia devolver todo a su estado inicial con resetConfig', () => {
      // 1. Arrange
      const store = useParserEmailStore(NODE_ID);
      store.updateConfig({ minBodyLength: 999 });
      store.updateSandboxInput({ html: '<p>algo</p>' });

      // 2. Act
      store.resetConfig();

      // 3. Assert
      expect(store.config.minBodyLength).toBe(DEFAULT_MIN_BODY_LENGTH);
      expect(store.sandboxInput.html).toBe('');
      expect(store.sandboxResult).toBeNull();
    });
  });

  describe('4. Cuerpo de la peticion de prueba', () => {
    it('4.1 NO deberia incluir sourceNamespace', async () => {
      // 1. Arrange: el correo viaja en el propio cuerpo y el backend valida con
      //    `forbidNonWhitelisted`, asi que incluirlo devolveria un 400.
      const store = useParserEmailStore(NODE_ID);
      store.updateSandboxInput({ html: '<p>Hola</p>' });
      checkParser.mockResolvedValue(buildResult());

      // 2. Act
      await store.runSandboxTest();

      // 3. Assert
      expect(checkParser).toHaveBeenCalledTimes(1);
      expect(checkParser.mock.calls[0]?.[0]).not.toHaveProperty('sourceNamespace');
    });

    it('4.2 deberia OMITIR attachments cuando no se simula adjunto', () => {
      // 1. Arrange: ausente y no `undefined`. Con `exactOptionalPropertyTypes`
      //    asignar `undefined` a un `?: T` ni siquiera compila.
      const store = useParserEmailStore(NODE_ID);

      // 2. Act
      store.updateSandboxInput({ text: 'Hola' });

      // 3. Assert
      expect(store.sandboxPayload).not.toHaveProperty('attachments');
    });

    it('4.3 deberia inyectar un PDF simulado con el interruptor activo', () => {
      // 1. Arrange: sin adjunto la regla multimodal nunca se activa, y el panel
      //    mostraria un indicador muerto.
      const store = useParserEmailStore(NODE_ID);

      // 2. Act
      store.updateSandboxInput({ text: 'Hola', simulateVisualAttachment: true });

      // 3. Assert
      expect(store.sandboxPayload.attachments).toEqual([
        { filename: 'nota-de-prensa.pdf', contentType: 'application/pdf', size: 1024 },
      ]);
    });

    it('4.4 deberia exigir texto o HTML para poder probar', () => {
      // 1. Arrange
      const store = useParserEmailStore(NODE_ID);

      // 2. Act & 3. Assert: sin cuerpo la prueba no diria nada.
      expect(store.canRunSandbox).toBe(false);

      store.updateSandboxInput({ text: '   ' });
      expect(store.canRunSandbox).toBe(false);

      store.updateSandboxInput({ html: '<p>Hola</p>' });
      expect(store.canRunSandbox).toBe(true);
    });
  });

  describe('5. Ejecucion de la prueba', () => {
    it('5.1 deberia guardar el payload y apagar loading', async () => {
      // 1. Arrange
      const store = useParserEmailStore(NODE_ID);
      checkParser.mockResolvedValue(buildResult());

      // 2. Act
      await store.runSandboxTest();

      // 3. Assert
      expect(store.sandboxResult?.clean_title).toBe('Nueva sede');
      expect(store.loading).toBe(false);
    });

    it('5.2 deberia recoger los warnings del backend', async () => {
      // 1. Arrange: son los avisos que en la ejecucion real solo llegan al
      //    archivo `.log` del servidor.
      const store = useParserEmailStore(NODE_ID);
      checkParser.mockResolvedValue(
        buildResult({ warnings: ['Cuerpo de 12 caracteres con 1 adjunto.'] }),
      );

      // 2. Act
      await store.runSandboxTest();

      // 3. Assert
      expect(store.sandboxWarnings).toEqual(['Cuerpo de 12 caracteres con 1 adjunto.']);
    });

    it('5.3 deberia dejar sin payload un fallo diagnosticado por el backend', async () => {
      // 1. Arrange: llega como 200 con `success: false`, no como excepcion.
      const store = useParserEmailStore(NODE_ID);
      checkParser.mockResolvedValue({
        success: false,
        error: { level: 'GRAVE', message: 'No se pudo procesar el correo de prueba' },
      });

      // 2. Act
      await store.runSandboxTest();

      // 3. Assert
      expect(store.sandboxResult).toBeNull();
      expect(store.sandboxWarnings).toEqual(['No se pudo procesar el correo de prueba']);
      expect(store.loading).toBe(false);
    });

    it('5.4 deberia propagar la excepcion y apagar loading igualmente', async () => {
      // 1. Arrange: el store solo garantiza el `finally`; el mensaje al usuario
      //    lo decide el componente (`frontend-architecture.md` §2.1).
      const store = useParserEmailStore(NODE_ID);
      checkParser.mockRejectedValue(new Error('400'));

      // 2. Act & 3. Assert
      await expect(store.runSandboxTest()).rejects.toThrow('400');
      expect(store.loading).toBe(false);
    });

    it('5.5 deberia caducar el resultado al cambiar el umbral', async () => {
      // 1. Arrange: `minBodyLength` decide `requires_multimodal_fallback`, asi
      //    que un resultado calculado con el umbral anterior dejaria en pantalla
      //    un veredicto que ya no corresponde al formulario.
      const store = useParserEmailStore(NODE_ID);
      checkParser.mockResolvedValue(buildResult());
      await store.runSandboxTest();

      // 2. Act
      store.updateConfig({ minBodyLength: 300 });

      // 3. Assert
      expect(store.sandboxResult).toBeNull();
      expect(store.sandboxWarnings).toEqual([]);
    });

    it('5.6 deberia caducar el resultado al cambiar el correo de ejemplo', async () => {
      // 1. Arrange
      const store = useParserEmailStore(NODE_ID);
      checkParser.mockResolvedValue(buildResult());
      await store.runSandboxTest();

      // 2. Act
      store.updateSandboxInput({ html: '<p>Otro correo</p>' });

      // 3. Assert
      expect(store.sandboxResult).toBeNull();
    });
  });

  describe('6. Aislamiento por nodeId', () => {
    it('6.1 no deberia compartir configuracion entre dos parsers del mismo flujo', () => {
      // 1. Arrange: el prefijo de Pinia lleva el `nodeId`, de modo que son dos
      //    instancias distintas y no una compartida.
      const first = useParserEmailStore('parser_a');
      const second = useParserEmailStore('parser_b');

      // 2. Act
      first.updateConfig({ minBodyLength: 500 });

      // 3. Assert
      expect(first.config.minBodyLength).toBe(500);
      expect(second.config.minBodyLength).toBe(DEFAULT_MIN_BODY_LENGTH);
    });

    it('6.2 deberia devolver la MISMA instancia para el mismo nodeId', () => {
      // 1. Arrange & 2. Act
      const first = useParserEmailStore(NODE_ID);
      const second = useParserEmailStore(NODE_ID);
      first.updateSandboxInput({ text: 'Compartido' });

      // 3. Assert
      expect(second.sandboxInput.text).toBe('Compartido');
    });
  });
});
