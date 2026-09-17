import { describe, expect, it } from 'vitest';

import { withBaseParamDefaults } from '@/utils/node-base-params';

import { DEFAULT_PARAMS_BY_NODE_TYPE, NodeType } from '@/types/pipeline';

describe('node-base-params · defaults de params por tipo de nodo', () => {
  describe('1. Siembra en un nodo nuevo', () => {
    it('1.1 deberia aplicar los defaults del tipo sobre unos params vacios', () => {
      // 1. Arrange / 2. Act
      const result = withBaseParamDefaults(NodeType.TRIGGER_IMAP, {});

      // 3. Assert
      expect(result).toEqual({ mailbox: 'INBOX', includeAttachments: false });
    });

    it('1.2 deberia entregar un booleano REAL y no una cadena', () => {
      // 1. Arrange / 2. Act
      const result = withBaseParamDefaults(NodeType.TRIGGER_IMAP, {});

      // 3. Assert: lo que viaja al backend tiene que ser `false`, no `'false'`.
      expect(typeof result.includeAttachments).toBe('boolean');
    });

    it('1.3 deberia devolver un objeto NUEVO en cada llamada', () => {
      // 1. Arrange / 2. Act: el mapa de defaults es un literal de modulo; si se
      //    devolviera por referencia, dos nodos del mismo tipo compartirian
      //    `params` y tocar uno movería el otro.
      const first = withBaseParamDefaults(NodeType.TRIGGER_IMAP, {});
      const second = withBaseParamDefaults(NodeType.TRIGGER_IMAP, {});

      // 3. Assert
      expect(first).not.toBe(second);
      expect(first).not.toBe(DEFAULT_PARAMS_BY_NODE_TYPE[NodeType.TRIGGER_IMAP]);
    });

    it('1.4 deberia devolver un objeto vacio para un tipo sin parametros base', () => {
      // 1. Arrange / 2. Act
      const result = withBaseParamDefaults(NodeType.PARSER_PRE_IA, {});

      // 3. Assert
      expect(result).toEqual({});
    });
  });

  describe('2. Plantillas ya guardadas', () => {
    it('2.1 lo guardado deberia GANAR sobre el default', () => {
      // 1. Arrange: una plantilla cuyo autor cambio el buzon a mano.
      const saved = { mailbox: 'Archivadas', includeAttachments: true };

      // 2. Act
      const result = withBaseParamDefaults(NodeType.TRIGGER_IMAP, saved);

      // 3. Assert: abrir la plantilla para tocar un toggle no puede reescribirle
      //    el buzon y colar ese cambio en el siguiente guardado.
      expect(result.mailbox).toBe('Archivadas');
      expect(result.includeAttachments).toBe(true);
    });

    it('2.2 deberia conservar las claves que ningun control gestiona', () => {
      // 1. Arrange: claves sembradas por el editor JSON que se retiro.
      const saved = { markAsRead: false, maxAttachmentBytes: 1024 };

      // 2. Act
      const result = withBaseParamDefaults(NodeType.TRIGGER_IMAP, saved);

      // 3. Assert: sobreviven aunque la interfaz ya no sepa pintarlas.
      expect(result).toEqual({
        mailbox: 'INBOX',
        includeAttachments: false,
        markAsRead: false,
        maxAttachmentBytes: 1024,
      });
    });

    it('2.3 NO deberia mutar el objeto de entrada', () => {
      // 1. Arrange
      const saved: Record<string, unknown> = {};

      // 2. Act
      withBaseParamDefaults(NodeType.TRIGGER_IMAP, saved);

      // 3. Assert
      expect(saved).toEqual({});
    });
  });
});
