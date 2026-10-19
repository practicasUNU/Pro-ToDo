import { describe, expect, it } from 'vitest';

import { hasPurgedAttachments } from '@/utils/purged-attachments';

/** Adjunto tal y como lo deposita `TRIGGER_IMAP`, con su binario intacto. */
const WITH_BINARY = {
  filename: 'escaneo.png',
  contentType: 'image/png',
  contentBase64: 'QUJDREVG',
};

/** El mismo despues de `releaseAttachmentBinaries` (RNF-01). */
const PURGED = {
  filename: 'escaneo.png',
  contentType: 'image/png',
  contentBase64: null,
};

describe('hasPurgedAttachments · deteccion de binarios liberados', () => {
  it('1. deberia detectar un adjunto cuyo binario ya se libero', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const result = hasPurgedAttachments({
      raw_email: { attachments: [PURGED] },
    });

    // 3. Assert 🎯
    expect(result).toBe(true);
  });

  it('2. NO deberia avisar mientras quede un binario utilizable', () => {
    // 1. Arrange 📐: con uno intacto el nodo puede volver a transcribir de
    //    verdad, y advertir de una reutilizacion seria falso.
    const result = hasPurgedAttachments({
      raw_email: { attachments: [PURGED, WITH_BINARY] },
    });

    // 3. Assert 🎯
    expect(result).toBe(false);
  });

  it('3. NO deberia avisar en un correo sin adjuntos', () => {
    // 1. Arrange 📐: un arreglo vacio no es "todo liberado", es "nunca hubo".
    //    `Array.every` sobre vacio devuelve `true`, asi que sin la guarda
    //    explicita todo correo de texto plano dispararia la advertencia.
    expect(hasPurgedAttachments({ raw_email: { attachments: [] } })).toBe(false);
  });

  it('4. NO deberia reventar con un contexto incompleto', () => {
    // 1. Arrange 📐: el contexto llega como payload abierto y una ejecucion
    //    detenida en el primer paso todavia no tiene `raw_email`.
    expect(hasPurgedAttachments({})).toBe(false);
    expect(hasPurgedAttachments({ raw_email: {} })).toBe(false);
    expect(hasPurgedAttachments({ raw_email: { attachments: 'no es un arreglo' } })).toBe(false);
    expect(hasPurgedAttachments({ raw_email: { attachments: [null] } })).toBe(false);
  });
});
