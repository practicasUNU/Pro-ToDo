import { extractClientIp } from '@common/utils/client-ip.util';

import type { Request } from 'express';

/**
 * Construye una peticion Express minima con solo lo que consume `extractClientIp`.
 */
const buildRequest = (overrides: {
  headers?: Record<string, string | string[] | undefined>;
  remoteAddress?: string;
  ip?: string;
}): Request =>
  ({
    headers: overrides.headers ?? {},
    socket: { remoteAddress: overrides.remoteAddress },
    ip: overrides.ip,
  }) as unknown as Request;

describe('extractClientIp (PROT-05.1)', () => {
  it('deberia priorizar x-forwarded-for sobre el resto de fuentes', () => {
    // 1. Arrange
    const req = buildRequest({
      headers: {
        'x-forwarded-for': '203.0.113.10',
        'x-real-ip': '198.51.100.5',
      },
      remoteAddress: '10.0.0.1',
      ip: '10.0.0.2',
    });

    // 2. Act
    const result = extractClientIp(req);

    // 3. Assert
    expect(result).toBe('203.0.113.10');
  });

  it('deberia tomar la primera IP de la cadena de x-forwarded-for (el cliente original)', () => {
    // 1. Arrange
    const req = buildRequest({
      headers: { 'x-forwarded-for': ' 192.168.1.55 , 10.0.0.8, 172.16.0.1 ' },
    });

    // 2. Act
    const result = extractClientIp(req);

    // 3. Assert
    expect(result).toBe('192.168.1.55');
  });

  it('deberia caer a x-real-ip cuando x-forwarded-for no esta presente', () => {
    // 1. Arrange
    const req = buildRequest({
      headers: { 'x-real-ip': '198.51.100.5' },
      remoteAddress: '10.0.0.1',
    });

    // 2. Act
    const result = extractClientIp(req);

    // 3. Assert
    expect(result).toBe('198.51.100.5');
  });

  it('deberia caer a socket.remoteAddress cuando no hay cabeceras de proxy', () => {
    // 1. Arrange
    const req = buildRequest({ remoteAddress: '10.0.0.1', ip: '172.16.0.9' });

    // 2. Act
    const result = extractClientIp(req);

    // 3. Assert
    expect(result).toBe('10.0.0.1');
  });

  it('deberia caer a req.ip como ultima fuente disponible', () => {
    // 1. Arrange
    const req = buildRequest({ ip: '172.16.0.9' });

    // 2. Act
    const result = extractClientIp(req);

    // 3. Assert
    expect(result).toBe('172.16.0.9');
  });

  it('deberia normalizar las IPv4 mapeadas en IPv6 quitando el prefijo ::ffff:', () => {
    // 1. Arrange
    const req = buildRequest({ remoteAddress: '::ffff:192.168.1.10' });

    // 2. Act
    const result = extractClientIp(req);

    // 3. Assert
    expect(result).toBe('192.168.1.10');
  });

  it('deberia conservar intacta una IPv6 nativa', () => {
    // 1. Arrange
    const req = buildRequest({ remoteAddress: '::1' });

    // 2. Act
    const result = extractClientIp(req);

    // 3. Assert
    expect(result).toBe('::1');
  });

  it('deberia devolver null cuando no hay ninguna fuente de IP (caso fail-closed)', () => {
    // 1. Arrange
    const req = buildRequest({ headers: { 'x-forwarded-for': '   ' } });

    // 2. Act
    const result = extractClientIp(req);

    // 3. Assert
    expect(result).toBeNull();
  });
});
