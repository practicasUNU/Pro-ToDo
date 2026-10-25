import { describe, expect, it } from 'vitest';

import { detectPrivateTarget } from './outbound-url';

describe('detectPrivateTarget (escudo SSRF del frontend)', () => {
  it.each([
    'http://localhost:3000/api',
    'http://api.localhost/',
    'http://127.0.0.1/',
    'http://10.0.0.5/avisos',
    'https://192.168.1.20:8443/',
    'http://172.20.0.1/',
    'http://169.254.169.254/latest/meta-data',
    'http://0.0.0.0/',
    'http://100.64.0.1/',
    'http://[::1]/',
    'http://[fd00::1]/',
    'http://[fe80::1]/',
    'http://[::ffff:10.0.0.1]/',
    // Formas raras de escribir 127.0.0.1 que `new URL` normaliza.
    'http://2130706433/',
    'http://0x7f.1/',
  ])('1.1 deberia alertar de %s', (url) => {
    // 1. Arrange + 2. Act
    const reason = detectPrivateTarget(url);

    // 3. Assert
    expect(reason).not.toBeNull();
  });

  it.each([
    'https://api.ejemplo.org/v1/avisos',
    'https://8.8.8.8/',
    'http://172.32.0.1/',
    'http://[2001:db8::1]/',
  ])('1.2 NO deberia alertar de un destino publico: %s', (url) => {
    // 1. Arrange + 2. Act + 3. Assert
    expect(detectPrivateTarget(url)).toBeNull();
  });

  it.each([
    null,
    '',
    '{{scraped_web.url}}',
    '{{parsed_email.extracted_urls[0]}}/avisos',
    'no es una url',
  ])('1.3 NO deberia juzgar lo que aun no es una URL con host literal: %s', (url) => {
    // 1. Arrange + 2. Act + 3. Assert: el host llega en ejecucion.
    expect(detectPrivateTarget(url)).toBeNull();
  });

  it('1.4 deberia nombrar el host en el motivo', () => {
    // 1. Arrange + 2. Act
    const reason = detectPrivateTarget('http://10.1.2.3/x');

    // 3. Assert
    expect(reason).toContain('10.1.2.3');
  });
});
