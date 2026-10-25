import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  HttpGenericDestinationConfigDto,
  MAX_KEY_VALUE_ENTRIES,
} from './http-generic-destination-config.dto';

/** Mensajes de error de un `params` dado, con las opciones del validador real. */
const errorsOf = async (params: Record<string, unknown>): Promise<string> => {
  const errors = await validate(
    plainToInstance(HttpGenericDestinationConfigDto, params),
    { whitelist: true, forbidNonWhitelisted: true },
  );

  return errors
    .flatMap((error) => [
      ...Object.values(error.constraints ?? {}),
      ...(error.children ?? []).flatMap((child) =>
        Object.values(child.constraints ?? {}),
      ),
    ])
    .join(' | ');
};

describe('HttpGenericDestinationConfigDto', () => {
  it('1.1 deberia aceptar params vacios (plantilla de flujo)', async () => {
    // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
    await expect(errorsOf({})).resolves.toBe('');
  });

  it('1.2 deberia aceptar una configuracion completa con marcadores', async () => {
    // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
    await expect(
      errorsOf({
        targetUrl: 'https://api.ejemplo.org/{{scraped_web.slug}}',
        method: 'PATCH',
        headers: { 'X-Origen': '{{raw_email.from}}' },
        queryParams: { lang: 'es' },
        bodyType: 'JSON',
        bodyTemplate: '{"titulo": "{{parsed_email.clean_title}}"}',
        authType: 'BEARER_TOKEN',
        authConfig: { credentialId: '0b9a2c47-5d1e-4f3a-8c6b-2e7d9f1a4b30' },
        timeoutMs: 10_000,
        retryAttempts: 1,
      }),
    ).resolves.toBe('');
  });

  it.each([
    '{{scraped_web.url}}',
    '{{parsed_email.extracted_urls[0]}}',
    '{{ parsed_email.extracted_urls[2] }}/avisos?x=1',
  ])(
    '1.3 deberia aceptar una URL que toma la direccion de un paso anterior: %s',
    async (targetUrl) => {
      // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯: el protocolo lo comprueba la
      //    guarda SSRF sobre la URL ya interpolada.
      await expect(errorsOf({ targetUrl })).resolves.toBe('');
    },
  );

  it.each([
    [{ method: 'GET', bodyType: 'JSON' }, 'no lleva cuerpo'],
    [{ method: 'TRACE' }, 'method debe ser uno de'],
    [{ bodyTemplate: '{"roto": ' }, 'JSON valido'],
    [
      { bodyType: 'FORM_DATA', bodyTemplate: '{"a": {"b": 1}}' },
      'objeto plano de cadenas',
    ],
    [{ headers: { Authorization: 'Bearer x' } }, 'credencial'],
    [{ headers: { 'X Bad': 'v' } }, 'no es un nombre valido'],
    [{ headers: { 'X-Ok': 'a\r\nX-Inyectada: 1' } }, 'saltos de linea'],
    [{ targetUrl: 'ftp://ejemplo.org' }, 'URL absoluta http(s)'],
    [{ targetUrl: '{{sin_cerrar' }, 'URL absoluta http(s)'],
    [{ targetUrl: 'api.ejemplo.org/{{ns.campo}}' }, 'URL absoluta http(s)'],
    [{ authConfig: { credentialId: 'no-uuid' } }, 'UUID'],
    [{ retryAttempts: 9 }, 'retryAttempts no puede superar'],
    [{ outputNamespace: 'http_generic_response' }, 'should not exist'],
  ])('2.1 deberia rechazar %j', async (params, reason) => {
    // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
    await expect(errorsOf(params)).resolves.toContain(reason);
  });

  it('2.2 deberia limitar el numero de cabeceras', async () => {
    // 1. Arrange 📐
    const headers = Object.fromEntries(
      Array.from({ length: MAX_KEY_VALUE_ENTRIES + 1 }, (_, index) => [
        `X-H${index}`,
        'v',
      ]),
    );

    // 2. Act ⚙️ + 3. Assert 🎯
    await expect(errorsOf({ headers })).resolves.toContain(
      'no puede declarar mas de',
    );
  });
});
