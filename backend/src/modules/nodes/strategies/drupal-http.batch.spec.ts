import * as cheerio from 'cheerio';

import { createMockStatePayloadContext } from '@test/factories/state-payload-context.factory';

import { DrupalOperationMode } from '../dto/drupal-http-config.dto';

import {
  CREATE_PARTIAL_OPERATION,
  DrupalHttpStrategy,
  ERR_DRUPAL_DOM_TARGET,
} from './drupal-http.strategy';

import type { DrupalApiConfig } from '@core/config/drupal-api.config';
import type { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import type { NodeErrorDetail } from '@core/fsm/types/node-strategy.types';
import type { HttpClientService } from '@core/http/http-client.service';
import type { AxiosRequestConfig } from 'axios';

/**
 * Cardinalidad 1 a N del destino Drupal.
 *
 * El contrato del lote es asimetrico: la raiz del namespace de origen es el
 * PRIMER elemento y `validated_items` los restantes; `llm_response.items` lleva
 * los mismos elementos en bruto, de donde salen titulares y expedientes. Aqui
 * se fija que cada modo recorre el lote entero, con el numero minimo de
 * peticiones y conservando el orden.
 */

const BASE_URL = 'https://drupal.example/jsonapi';
const PAGE_UUID = '7f1700bf-b54b-4c12-b71a-8a71f1f0ee38';
const CLOSED_UUID = 'b17d69d8-6998-4883-b8dc-153b55dbd9c5';

type HttpMock = jest.Mocked<Pick<HttpClientService, 'requestWithStatus'>>;

const buildHttpMock = (): HttpMock => ({ requestWithStatus: jest.fn() });

const buildStrategy = (httpClient: HttpMock): DrupalHttpStrategy =>
  new DrupalHttpStrategy(
    httpClient as unknown as HttpClientService,
    {
      baseUrl: BASE_URL,
      siteRootUrl: 'https://drupal.example',
      token: 'token',
      user: 'editor_api',
      authType: 'BASIC',
      authHeader: 'Basic dGVzdA==',
      timeoutMs: 15_000,
      isUsable: true,
      productionNodeUuids: new Set<string>(),
    } as unknown as DrupalApiConfig,
  );

const buildContext = (
  namespaces: Record<string, Record<string, unknown>>,
): StatePayloadContext =>
  createMockStatePayloadContext({ currentStep: 'destino_drupal', namespaces });

const entityResponse = (
  attributes: Record<string, unknown>,
  id = PAGE_UUID,
): { data: unknown; status: number } => ({
  data: { data: { id, attributes, relationships: {} } },
  status: 200,
});

const pageResponse = (
  html: string,
  id = PAGE_UUID,
): { data: unknown; status: number } =>
  entityResponse(
    {
      drupal_internal__nid: 55_937,
      path: { alias: '/pagina' },
      body: { value: html, format: 'full_html' },
      changed: '2026-11-03T10:00:00+00:00',
    },
    id,
  );

const createdResponse = (nid: number): { data: unknown; status: number } => ({
  data: {
    data: {
      id: `uuid-${nid}`,
      attributes: {
        drupal_internal__nid: nid,
        path: { alias: `/noticia-${nid}` },
        changed: '2026-11-03T10:00:00+00:00',
      },
    },
  },
  status: 201,
});

const httpFailure = (
  status: number,
): { failure: NodeErrorDetail; status: number } => ({
  failure: {
    level: 'GRAVE',
    code: 'ERR_HTTP_CLIENT_REJECTED',
    message: `el remoto respondio ${status}`,
  },
  status,
});

const callConfig = (httpClient: HttpMock, index: number): AxiosRequestConfig =>
  httpClient.requestWithStatus.mock.calls[index]?.[0];

/** `body.value` del PATCH de la llamada indicada. */
const sentHtml = (httpClient: HttpMock, index: number): string => {
  const body = callConfig(httpClient, index).data as {
    data: { attributes: { body: { value: string } } };
  };

  return body.data.attributes.body.value;
};

/** Titulo del POST de la llamada indicada. */
const sentTitle = (httpClient: HttpMock, index: number): string => {
  const body = callConfig(httpClient, index).data as {
    data: { attributes: { title: string } };
  };

  return body.data.attributes.title;
};

/**
 * Contexto de un lote: raiz + `items` en bruto y su version auditada.
 * `fields` describe cada elemento en orden (el primero va en la raiz).
 */
const batchContext = (
  elements: readonly { headline: string; markup: string }[],
): StatePayloadContext => {
  const [first, ...rest] = elements;

  return buildContext({
    llm_response: {
      headline: first?.headline ?? '',
      filled_markup: first?.markup ?? '',
      items: rest.map((item) => ({
        headline: item.headline,
        filled_markup: item.markup,
      })),
    },
    validated_drupal_json: {
      validated_markup: first?.markup ?? '',
      validated_fields: { headline: first?.headline ?? '' },
      validated_items: rest.map((item) => ({
        validated_markup: item.markup,
        validated_fields: { headline: item.headline },
        character_count: item.markup.length,
      })),
    },
  });
};

describe('DrupalHttpStrategy · lotes (cardinalidad 1 a N)', () => {
  describe('1. CREATE_NODE', () => {
    const createParams = {
      operationMode: DrupalOperationMode.CREATE_NODE,
      bundle: 'node--article',
      titleTemplate: '{{llm_response.headline}}',
    };

    it('1.1 deberia crear UNA entidad con un solo elemento', async () => {
      // 1. Arrange 📐
      const httpClient = buildHttpMock();
      httpClient.requestWithStatus.mockResolvedValueOnce(createdResponse(1));

      // 2. Act ⚙️
      const result = await buildStrategy(httpClient).execute(
        batchContext([{ headline: 'Unica', markup: '<p>Unica</p>' }]),
        createParams,
      );

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(httpClient.requestWithStatus).toHaveBeenCalledTimes(1);
      expect(result.data).toMatchObject({
        total_published: 1,
        drupal_internal__nid: 1,
      });
    });

    it('1.2 deberia crear una entidad por elemento, en orden y con su titular', async () => {
      // 1. Arrange 📐
      const httpClient = buildHttpMock();
      httpClient.requestWithStatus
        .mockResolvedValueOnce(createdResponse(1))
        .mockResolvedValueOnce(createdResponse(2))
        .mockResolvedValueOnce(createdResponse(3));

      // 2. Act ⚙️
      const result = await buildStrategy(httpClient).execute(
        batchContext([
          { headline: 'Noticia 1', markup: '<p>Uno</p>' },
          { headline: 'Noticia 2', markup: '<p>Dos</p>' },
          { headline: 'Noticia 3', markup: '<p>Tres</p>' },
        ]),
        createParams,
      );

      // 3. Assert 🎯: las claves de siempre describen el PRIMER elemento.
      expect(result.success).toBe(true);
      expect(httpClient.requestWithStatus).toHaveBeenCalledTimes(3);
      expect([0, 1, 2].map((index) => sentTitle(httpClient, index))).toEqual([
        'Noticia 1',
        'Noticia 2',
        'Noticia 3',
      ]);
      expect(result.data?.total_published).toBe(3);
      expect(result.data?.drupal_internal__nid).toBe(1);
      expect(
        (
          result.data?.published_nodes as { drupal_internal__nid: number }[]
        ).map((entry) => entry.drupal_internal__nid),
      ).toEqual([1, 2, 3]);
    });

    it('1.3 deberia devolver un resultado PARCIAL si falla a mitad del lote y no duplicar al reanudar', async () => {
      // 1. Arrange 📐: el 2.º POST falla con un 503.
      const elements = [
        { headline: 'Noticia 1', markup: '<p>Uno</p>' },
        { headline: 'Noticia 2', markup: '<p>Dos</p>' },
      ];
      const firstRun = buildHttpMock();
      firstRun.requestWithStatus
        .mockResolvedValueOnce(createdResponse(1))
        .mockResolvedValueOnce(httpFailure(503));

      // 2. Act ⚙️
      const failed = await buildStrategy(firstRun).execute(
        batchContext(elements),
        createParams,
      );

      // 3. Assert 🎯
      expect(failed.success).toBe(false);
      expect(failed.data?.operation_applied).toBe(CREATE_PARTIAL_OPERATION);
      expect(failed.data?.total_published).toBe(1);

      // Reanudacion: el motor dejo el parcial en `http_result`.
      const resumedContext = batchContext(elements);
      resumedContext.setNamespace('http_result', failed.data ?? {});
      const secondRun = buildHttpMock();
      secondRun.requestWithStatus.mockResolvedValueOnce(createdResponse(2));

      const resumed = await buildStrategy(secondRun).execute(
        resumedContext,
        createParams,
      );

      expect(resumed.success).toBe(true);
      expect(secondRun.requestWithStatus).toHaveBeenCalledTimes(1);
      expect(sentTitle(secondRun, 0)).toBe('Noticia 2');
      expect(resumed.data?.total_published).toBe(2);
    });
  });

  describe('1bis. URLs del lote (urls, created_nodes, url)', () => {
    const createParams = {
      operationMode: DrupalOperationMode.CREATE_NODE,
      bundle: 'node--article',
      titleTemplate: '{{llm_response.headline}}',
    };

    it('1bis.1 deberia acumular las TRES URLs del lote, en orden, con id y titulo', async () => {
      // 1. Arrange 📐
      const httpClient = buildHttpMock();
      httpClient.requestWithStatus
        .mockResolvedValueOnce(createdResponse(1))
        .mockResolvedValueOnce(createdResponse(2))
        .mockResolvedValueOnce(createdResponse(3));

      // 2. Act ⚙️
      const result = await buildStrategy(httpClient).execute(
        batchContext([
          { headline: 'Noticia 1', markup: '<p>Uno</p>' },
          { headline: 'Noticia 2', markup: '<p>Dos</p>' },
          { headline: 'Noticia 3', markup: '<p>Tres</p>' },
        ]),
        createParams,
      );

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(result.data?.urls).toEqual([
        'https://drupal.example/noticia-1',
        'https://drupal.example/noticia-2',
        'https://drupal.example/noticia-3',
      ]);
      expect(result.data?.created_nodes).toEqual([
        {
          id: 'uuid-1',
          url: 'https://drupal.example/noticia-1',
          title: 'Noticia 1',
        },
        {
          id: 'uuid-2',
          url: 'https://drupal.example/noticia-2',
          title: 'Noticia 2',
        },
        {
          id: 'uuid-3',
          url: 'https://drupal.example/noticia-3',
          title: 'Noticia 3',
        },
      ]);
      // Retrocompatible: `url` y `published_url` siguen siendo la primera.
      expect(result.data?.url).toBe('https://drupal.example/noticia-1');
      expect(result.data?.published_url).toBe(
        'https://drupal.example/noticia-1',
      );
    });

    it('1bis.2 deberia devolver una sola URL con un solo elemento', async () => {
      // 1. Arrange 📐
      const httpClient = buildHttpMock();
      httpClient.requestWithStatus.mockResolvedValueOnce(createdResponse(7));

      // 2. Act ⚙️
      const result = await buildStrategy(httpClient).execute(
        batchContext([{ headline: 'Unica', markup: '<p>Unica</p>' }]),
        createParams,
      );

      // 3. Assert 🎯
      expect(result.data?.urls).toEqual(['https://drupal.example/noticia-7']);
      expect(result.data?.url).toBe('https://drupal.example/noticia-7');
    });

    it('1bis.3 deberia incluir al reanudar las URLs de lo que ya se habia creado', async () => {
      // 1. Arrange 📐: primer intento con el 2.º POST caido.
      const elements = [
        { headline: 'Noticia 1', markup: '<p>Uno</p>' },
        { headline: 'Noticia 2', markup: '<p>Dos</p>' },
      ];
      const firstRun = buildHttpMock();
      firstRun.requestWithStatus
        .mockResolvedValueOnce(createdResponse(1))
        .mockResolvedValueOnce(httpFailure(503));
      const failed = await buildStrategy(firstRun).execute(
        batchContext(elements),
        createParams,
      );
      const resumedContext = batchContext(elements);
      resumedContext.setNamespace('http_result', failed.data ?? {});
      const secondRun = buildHttpMock();
      secondRun.requestWithStatus.mockResolvedValueOnce(createdResponse(2));

      // 2. Act ⚙️
      const resumed = await buildStrategy(secondRun).execute(
        resumedContext,
        createParams,
      );

      // 3. Assert 🎯: el parcial ya llevaba su URL, y la reanudacion las dos.
      expect(failed.data?.urls).toEqual(['https://drupal.example/noticia-1']);
      expect(resumed.data?.urls).toEqual([
        'https://drupal.example/noticia-1',
        'https://drupal.example/noticia-2',
      ]);
      expect(
        (resumed.data?.created_nodes as { title: string }[]).map(
          (node) => node.title,
        ),
      ).toEqual(['Noticia 1', 'Noticia 2']);
    });

    it('1bis.4 deberia dejar urls vacia y url en blanco en los modos que no crean entidades', async () => {
      // 1. Arrange 📐: UPDATE_LINK_SOURCE no crea nada.
      const httpClient = buildHttpMock();
      httpClient.requestWithStatus.mockResolvedValueOnce(
        pageResponse(
          '<p><a class="enlace" href="https://viejo.example">Jornada</a></p>',
        ),
      );

      // 2. Act ⚙️
      const result = await buildStrategy(httpClient).execute(
        buildContext({
          llm_response: {
            headline: 'Jornada',
            summary: 'https://viejo.example',
          },
          validated_drupal_json: { validated_fields: {} },
        }),
        {
          operationMode: DrupalOperationMode.UPDATE_LINK_SOURCE,
          targetNodeUuid: PAGE_UUID,
          linkSelector: 'a.enlace',
          linkValueTemplate: '{{llm_response.summary}}',
        },
      );

      // 3. Assert 🎯: tenga exito o no, la forma es la misma.
      expect(result.data?.urls).toEqual([]);
      expect(result.data?.created_nodes).toEqual([]);
      expect(result.data?.url).toBe('');
    });
  });

  describe('2. APPEND_HTML_BLOCK', () => {
    const appendParams = {
      operationMode: DrupalOperationMode.APPEND_HTML_BLOCK,
      bundle: 'node--page',
      targetNodeUuid: PAGE_UUID,
      expedienteTemplate: '{{llm_response.headline}}',
    };

    it('2.1 deberia anteponer el lote en UN fragmento, con el 1.º arriba, y un solo PATCH', async () => {
      // 1. Arrange 📐
      const httpClient = buildHttpMock();
      httpClient.requestWithStatus
        .mockResolvedValueOnce(
          pageResponse('<div data-expediente="ANTIGUA"><p>Antigua</p></div>'),
        )
        .mockResolvedValueOnce(pageResponse(''));

      // 2. Act ⚙️
      const result = await buildStrategy(httpClient).execute(
        batchContext([
          { headline: 'LIC-1', markup: '<p>Licitacion_1</p>' },
          { headline: 'LIC-2', markup: '<p>Licitacion_2</p>' },
          { headline: 'LIC-3', markup: '<p>Licitacion_3</p>' },
        ]),
        appendParams,
      );

      // 3. Assert 🎯
      const html = sentHtml(httpClient, 1);

      expect(result.success).toBe(true);
      expect(httpClient.requestWithStatus).toHaveBeenCalledTimes(2);
      expect(result.data?.total_appended).toBe(3);
      expect(html.indexOf('Licitacion_1')).toBeLessThan(
        html.indexOf('Licitacion_2'),
      );
      expect(html.indexOf('Licitacion_2')).toBeLessThan(
        html.indexOf('Licitacion_3'),
      );
      expect(html.indexOf('Licitacion_3')).toBeLessThan(
        html.indexOf('Antigua'),
      );
    });

    it('2.2 deberia omitir el expediente que ya esta publicado, sin confundir LIC-1 con LIC-10', async () => {
      // 1. Arrange 📐: la pagina ya tiene LIC-10, no LIC-1.
      const httpClient = buildHttpMock();
      httpClient.requestWithStatus
        .mockResolvedValueOnce(
          pageResponse(
            '<div data-expediente="LIC-10"><p>Diez</p></div>' +
              '<div data-expediente="LIC-2"><p>Dos</p></div>',
          ),
        )
        .mockResolvedValueOnce(pageResponse(''));

      // 2. Act ⚙️
      const result = await buildStrategy(httpClient).execute(
        batchContext([
          { headline: 'LIC-1', markup: '<p>Nueva uno</p>' },
          { headline: 'LIC-2', markup: '<p>Repetida</p>' },
        ]),
        appendParams,
      );

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(result.data?.total_appended).toBe(1);
      expect(sentHtml(httpClient, 1)).toContain('Nueva uno');
      expect(sentHtml(httpClient, 1)).not.toContain('Repetida');
    });

    it('2.3 deberia repartir los paneles de varias universidades en una sola escritura', async () => {
      // 1. Arrange 📐
      const panel = (code: string, accordion: string): string =>
        `<div class="panel panel-default">` +
        '<div class="panel-heading"><h5 class="panel-title">' +
        `<a class="panel-toggle-link" data-parent="${accordion}" href="#c${code}">` +
        `<strong class="panel-comite-codigo">${code}</strong></a>` +
        `</h5></div><div class="collapse" id="c${code}"><p>Cuerpo</p></div></div>`;
      const page =
        '<div id="accordion">' +
        '<div id="accordionUAM"></div><div id="accordionUPM"></div>' +
        '</div>';
      const httpClient = buildHttpMock();
      httpClient.requestWithStatus
        .mockResolvedValueOnce(pageResponse(page))
        .mockResolvedValueOnce(pageResponse(''));

      // 2. Act ⚙️
      const result = await buildStrategy(httpClient).execute(
        batchContext([
          { headline: 'UAM', markup: panel('UAM1', '#accordionUAM') },
          { headline: 'UPM', markup: panel('UPM1', '#accordionUPM') },
        ]),
        { ...appendParams, containerSelector: '#accordion' },
      );

      // 3. Assert 🎯
      const $ = cheerio.load(
        sentHtml(httpClient, 1),
        { xml: { xmlMode: false } },
        false,
      );

      expect(result.success).toBe(true);
      expect(httpClient.requestWithStatus).toHaveBeenCalledTimes(2);
      expect($('#accordionUAM .panel-comite-codigo').text()).toBe('UAM1');
      expect($('#accordionUPM .panel-comite-codigo').text()).toBe('UPM1');
    });
  });

  describe('3. TRANSFER_HTML_BLOCK', () => {
    const transferParams = {
      operationMode: DrupalOperationMode.TRANSFER_HTML_BLOCK,
      bundle: 'node--page',
      targetNodeUuid: PAGE_UUID,
      destinationNodeUuid: CLOSED_UUID,
      itemSelector:
        '[data-expediente="{{validated_drupal_json.validated_fields.headline}}"]',
    };

    it('3.1 deberia trasladar dos expedientes con dos GET y dos PATCH', async () => {
      // 1. Arrange 📐
      const httpClient = buildHttpMock();
      httpClient.requestWithStatus
        .mockResolvedValueOnce(
          pageResponse(
            '<div data-expediente="EXP-1"><p>Uno</p></div>' +
              '<div data-expediente="EXP-2"><p>Dos</p></div>' +
              '<div data-expediente="EXP-3"><p>Sigue abierta</p></div>',
          ),
        )
        .mockResolvedValueOnce(pageResponse('', CLOSED_UUID))
        .mockResolvedValueOnce(pageResponse('', CLOSED_UUID))
        .mockResolvedValueOnce(pageResponse(''));

      // 2. Act ⚙️
      const result = await buildStrategy(httpClient).execute(
        batchContext([
          { headline: 'EXP-1', markup: '' },
          { headline: 'EXP-2', markup: '' },
        ]),
        transferParams,
      );

      // 3. Assert 🎯
      expect(result.success).toBe(true);
      expect(httpClient.requestWithStatus).toHaveBeenCalledTimes(4);
      expect(result.data?.total_transferred).toBe(2);
      expect(sentHtml(httpClient, 2)).toContain('EXP-1');
      expect(sentHtml(httpClient, 2)).toContain('EXP-2');
      expect(sentHtml(httpClient, 3)).not.toContain('EXP-1');
      expect(sentHtml(httpClient, 3)).toContain('EXP-3');
    });

    it('3.2 no deberia escribir nada si un expediente del lote no aparece', async () => {
      // 1. Arrange 📐
      const httpClient = buildHttpMock();
      httpClient.requestWithStatus
        .mockResolvedValueOnce(
          pageResponse('<div data-expediente="EXP-1"><p>Uno</p></div>'),
        )
        .mockResolvedValueOnce(pageResponse('', CLOSED_UUID));

      // 2. Act ⚙️
      const result = await buildStrategy(httpClient).execute(
        batchContext([
          { headline: 'EXP-1', markup: '' },
          { headline: 'EXP-9', markup: '' },
        ]),
        transferParams,
      );

      // 3. Assert 🎯: solo los dos GET; ningun PATCH.
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_DRUPAL_DOM_TARGET);
      expect(httpClient.requestWithStatus).toHaveBeenCalledTimes(2);
    });
  });

  describe('4. UPDATE_LINK_SOURCE', () => {
    it('4.1 deberia cambiar tres enlaces con un GET y un PATCH', async () => {
      // 1. Arrange 📐
      const page =
        '<table>' +
        '<tr><td>Agrifood</td><td><a href="/a.pdf">PDF</a></td></tr>' +
        '<tr><td>Salud</td><td><a href="/s.pdf">PDF</a></td></tr>' +
        '<tr><td>Energia</td><td><a href="/e.pdf">PDF</a></td></tr>' +
        '</table>';
      const httpClient = buildHttpMock();
      httpClient.requestWithStatus
        .mockResolvedValueOnce(pageResponse(page))
        .mockResolvedValueOnce(pageResponse(''));
      const context = buildContext({
        validated_drupal_json: {
          validated_fields: { headline: 'Agrifood', summary: '/a-2026.pdf' },
          validated_items: [
            {
              validated_markup: '',
              validated_fields: { headline: 'Salud', summary: '/s-2026.pdf' },
              character_count: 0,
            },
            {
              validated_markup: '',
              validated_fields: {
                headline: 'Energia',
                summary: '/e-2026.pdf',
              },
              character_count: 0,
            },
          ],
        },
      });

      // 2. Act ⚙️
      const result = await buildStrategy(httpClient).execute(context, {
        operationMode: DrupalOperationMode.UPDATE_LINK_SOURCE,
        bundle: 'node--page',
        targetNodeUuid: PAGE_UUID,
        linkSelector:
          "table tr:contains('{{validated_drupal_json.validated_fields.headline}}') a",
        linkAttribute: 'href',
        linkValueTemplate: '{{validated_drupal_json.validated_fields.summary}}',
      });

      // 3. Assert 🎯
      const html = sentHtml(httpClient, 1);

      expect(result.success).toBe(true);
      expect(httpClient.requestWithStatus).toHaveBeenCalledTimes(2);
      expect(result.data?.total_updated).toBe(3);
      expect(html).toContain('href="/a-2026.pdf"');
      expect(html).toContain('href="/s-2026.pdf"');
      expect(html).toContain('href="/e-2026.pdf"');
    });
  });
});
