import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// `@boot/axios` importa `#q-app`, que no resuelve en Vitest: se dobla el
// SERVICIO de la boveda, que es lo unico que este nodo pide al backend.
vi.mock('@services/credentials.service', () => ({
  fetchCredentials: vi.fn(),
  fetchCredentialOptions: vi.fn(),
  createCredential: vi.fn(),
  updateCredential: vi.fn(),
  deleteCredential: vi.fn(),
}));

import { fetchCredentialOptions } from '@services/credentials.service';
import { useCredentialsStore } from '@stores/credentials.store';

import { CredentialAuthType } from '@/types/credential';
import { NodeType } from '@/types/pipeline';
import {
  HttpGenericAuthType,
  HttpGenericBodyType,
  HttpGenericMethod,
} from '@/types/nodes/http-generic-destination.types';

import { useHttpGenericDestinationStore } from './http-generic-destination.store';

import type { UpstreamNamespace } from '@stores/nodes/node-store-registry';

/** `nodeId` unico por prueba: las definiciones de Pinia se memoizan por modulo. */
let nodeCounter = 0;
const nextNodeId = (): string => `destino_http_generico_${(nodeCounter += 1)}`;

const TARGET_URL = 'https://api.ejemplo.org/v1/avisos';
const BEARER_ID = '0b9a2c47-5d1e-4f3a-8c6b-2e7d9f1a4b30';
const BASIC_ID = '7c1e3f5a-1111-4000-8000-000000000001';

const UPSTREAM: UpstreamNamespace[] = [
  {
    namespace: 'parsed_email',
    nodeType: NodeType.PARSER_PRE_IA,
    fields: [
      { name: 'clean_title', type: 'text' },
      { name: 'sender', type: 'text' },
    ],
  },
];

const OPTIONS = [
  { id: BEARER_ID, name: 'API de becas', authType: CredentialAuthType.BEARER_TOKEN },
  { id: BASIC_ID, name: 'Portal antiguo', authType: CredentialAuthType.BASIC_AUTH },
];

describe('useHttpGenericDestinationStore (DESTINO_HTTP_GENERICO)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  describe('1. Estado inicial y validez', () => {
    it('1.1 deberia arrancar con los defectos del backend e invalido sin URL', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const store = useHttpGenericDestinationStore(nextNodeId());

      // 3. Assert 🎯
      expect(store.config).toMatchObject({
        method: HttpGenericMethod.POST,
        bodyType: HttpGenericBodyType.JSON,
        authType: HttpGenericAuthType.NONE,
        timeoutMs: 15_000,
        retryAttempts: 0,
      });
      expect(store.missingRequiredParams).toEqual(['targetUrl']);
      expect(store.isConfigValid).toBe(false);
    });

    it('1.2 deberia ser valido con URL y sin autenticacion', () => {
      // 1. Arrange 📐
      const store = useHttpGenericDestinationStore(nextNodeId());

      // 2. Act ⚙️
      store.updateConfig({ targetUrl: TARGET_URL });

      // 3. Assert 🎯
      expect(store.isConfigValid).toBe(true);
    });

    it('1.3 deberia exigir credencial cuando hay esquema de autenticacion', () => {
      // 1. Arrange 📐
      const store = useHttpGenericDestinationStore(nextNodeId());
      store.updateConfig({ targetUrl: TARGET_URL, authType: HttpGenericAuthType.BEARER_TOKEN });

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(store.missingRequiredParams).toEqual(['authConfig.credentialId']);
      store.updateConfig({ credentialId: BEARER_ID });
      expect(store.isConfigValid).toBe(true);
    });
  });

  describe('2. Poka-Yoke', () => {
    it('2.1 deberia fijar el cuerpo en NONE al elegir GET o DELETE', () => {
      // 1. Arrange 📐
      const store = useHttpGenericDestinationStore(nextNodeId());

      // 2. Act ⚙️
      store.updateConfig({ method: HttpGenericMethod.GET });

      // 3. Assert 🎯
      expect(store.config.bodyType).toBe(HttpGenericBodyType.NONE);
      expect(store.isBodyless).toBe(true);
    });

    it('2.2 deberia filtrar las credenciales por tipo y vaciar la elegida al cambiarlo', () => {
      // 1. Arrange 📐
      const store = useHttpGenericDestinationStore(nextNodeId());
      useCredentialsStore().options = [...OPTIONS];
      store.updateConfig({ authType: HttpGenericAuthType.BEARER_TOKEN, credentialId: BEARER_ID });

      // 2. Act ⚙️
      const bearerOptions = store.credentialOptions.map((option) => option.id);
      store.updateConfig({ authType: HttpGenericAuthType.BASIC_AUTH });

      // 3. Assert 🎯
      expect(bearerOptions).toEqual([BEARER_ID]);
      expect(store.credentialOptions.map((option) => option.id)).toEqual([BASIC_ID]);
      expect(store.config.credentialId).toBeNull();
    });

    it('2.3 deberia rechazar Authorization escrita a mano y nombres repetidos', () => {
      // 1. Arrange 📐
      const store = useHttpGenericDestinationStore(nextNodeId());
      store.updateConfig({ targetUrl: TARGET_URL });

      // 2. Act ⚙️
      store.updateConfig({ headers: [{ name: 'Authorization', value: 'Bearer en-claro' }] });
      const manualAuth = store.isConfigValid;
      store.updateConfig({
        headers: [],
        queryParams: [
          { name: 'lang', value: 'es' },
          { name: 'LANG', value: 'en' },
        ],
      });

      // 3. Assert 🎯
      expect(manualAuth).toBe(false);
      expect(store.malformedParams.join(' ')).toContain('repetido');
    });

    it('2.4 deberia bloquear un marcador que ningun paso anterior publica', () => {
      // 1. Arrange 📐
      const store = useHttpGenericDestinationStore(nextNodeId());
      store.setAvailableUpstreamContext(UPSTREAM);
      store.updateConfig({ targetUrl: TARGET_URL });

      // 2. Act ⚙️
      store.updateConfig({ bodyTemplate: '{"t": "{{parsed_email.clean_title}}"}' });
      const known = store.isConfigValid;
      store.updateConfig({ bodyTemplate: '{"t": "{{scraped_web.title}}"}' });

      // 3. Assert 🎯
      expect(known).toBe(true);
      expect(store.unknownMarkers).toEqual(['{{scraped_web.title}}']);
      expect(store.isConfigValid).toBe(false);
    });

    it('2.5 no deberia juzgar marcadores mientras el contexto no ha cargado', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const store = useHttpGenericDestinationStore(nextNodeId());
      store.updateConfig({ targetUrl: `${TARGET_URL}/{{scraped_web.slug}}` });

      // 3. Assert 🎯
      expect(store.isConfigValid).toBe(true);
    });

    it('2.6 deberia rechazar JSON invalido y FORM_DATA anidado', () => {
      // 1. Arrange 📐
      const store = useHttpGenericDestinationStore(nextNodeId());
      store.updateConfig({ targetUrl: TARGET_URL });

      // 2. Act ⚙️
      store.updateConfig({ bodyTemplate: '{"roto": ' });
      const brokenJson = store.isConfigValid;
      store.updateConfig({
        bodyType: HttpGenericBodyType.FORM_DATA,
        bodyTemplate: '{"a": {"b": "c"}}',
      });

      // 3. Assert 🎯
      expect(brokenJson).toBe(false);
      expect(store.malformedParams.join(' ')).toContain('objeto plano de cadenas');
    });
  });

  describe('2bis. URL interpolable y escudo SSRF', () => {
    const LINKS_UPSTREAM: UpstreamNamespace[] = [
      {
        namespace: 'parsed_email',
        nodeType: NodeType.PARSER_PRE_IA,
        fields: [{ name: 'extracted_urls', type: 'url[]' }],
      },
    ];

    it('2bis.1 deberia aceptar una URL tomada entera de un paso anterior, con indice', () => {
      // 1. Arrange
      const store = useHttpGenericDestinationStore(nextNodeId());
      store.setAvailableUpstreamContext(LINKS_UPSTREAM);

      // 2. Act
      store.updateConfig({ targetUrl: '{{parsed_email.extracted_urls[0]}}' });

      // 3. Assert: antes el patron exigia `http(s)://` y el indice no casaba.
      expect(store.malformedParams).toEqual([]);
      expect(store.isConfigValid).toBe(true);
    });

    it('2bis.2 deberia reconocer el indice como marcador y validar su origen', () => {
      // 1. Arrange: nadie aguas arriba publica `scraped_web`.
      const store = useHttpGenericDestinationStore(nextNodeId());
      store.setAvailableUpstreamContext(LINKS_UPSTREAM);

      // 2. Act
      store.updateConfig({ targetUrl: 'https://api.ejemplo.org/{{scraped_web.links[2]}}' });

      // 3. Assert
      expect(store.unknownMarkers).toEqual(['{{scraped_web.links[2]}}']);
      expect(store.isConfigValid).toBe(false);
    });

    it('2bis.3 deberia ofrecer las posiciones de los campos URL de aguas arriba', () => {
      // 1. Arrange
      const store = useHttpGenericDestinationStore(nextNodeId());

      // 2. Act
      store.setAvailableUpstreamContext(LINKS_UPSTREAM);

      // 3. Assert
      expect(store.urlOptions.map((option) => option.value)).toContain(
        '{{parsed_email.extracted_urls[0]}}',
      );
    });

    it('2bis.4 deberia bloquear en tiempo real un destino de red privada', () => {
      // 1. Arrange
      const store = useHttpGenericDestinationStore(nextNodeId());

      // 2. Act
      store.updateConfig({ targetUrl: 'http://192.168.1.10/api' });

      // 3. Assert
      expect(store.privateTargetReason).toContain('192.168.1.10');
      expect(store.malformedParams).toContain(store.privateTargetReason);
      expect(store.isConfigValid).toBe(false);
    });
  });

  describe('3. Ensamblado de params e hidratacion', () => {
    it('3.1 deberia emitir los discriminadores y omitir los defectos', () => {
      // 1. Arrange 📐
      const store = useHttpGenericDestinationStore(nextNodeId());
      store.updateConfig({
        targetUrl: TARGET_URL,
        headers: [
          { name: 'X-Origen', value: '{{parsed_email.sender}}' },
          { name: '', value: 'fila a medias' },
        ],
        authType: HttpGenericAuthType.BEARER_TOKEN,
        credentialId: BEARER_ID,
        bodyTemplate: '{"t": "x"}',
      });

      // 2. Act ⚙️
      const params = store.toNodeParams();

      // 3. Assert 🎯: sin `outputNamespace` (es del nodo) ni defectos.
      expect(params).toEqual({
        method: 'POST',
        bodyType: 'JSON',
        authType: 'BEARER_TOKEN',
        targetUrl: TARGET_URL,
        headers: { 'X-Origen': '{{parsed_email.sender}}' },
        bodyTemplate: '{"t": "x"}',
        authConfig: { credentialId: BEARER_ID },
      });
    });

    it('3.2 deberia reproducir sus propios params al hidratar', () => {
      // 1. Arrange 📐
      const source = useHttpGenericDestinationStore(nextNodeId());
      source.updateConfig({
        targetUrl: TARGET_URL,
        method: HttpGenericMethod.PUT,
        queryParams: [{ name: 'lang', value: 'es' }],
        bodyType: HttpGenericBodyType.RAW_TEXT,
        bodyTemplate: 'Aviso: {{parsed_email.clean_title}}',
        timeoutMs: 5_000,
        retryAttempts: 2,
      });
      const params = source.toNodeParams();
      const target = useHttpGenericDestinationStore(nextNodeId());

      // 2. Act ⚙️
      target.hydrateFromNode({ outputNamespace: 'http_generic_response', params });

      // 3. Assert 🎯
      expect(target.toNodeParams()).toEqual(params);
    });

    it('3.3 deberia leer de forma defensiva un jsonb escrito a mano', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const store = useHttpGenericDestinationStore(nextNodeId());
      store.hydrateFromNode({
        outputNamespace: 'http_generic_response',
        params: { method: 'TRACE', timeoutMs: '9', headers: { ok: 'v', roto: 3 } },
      });

      // 3. Assert 🎯
      expect(store.config.method).toBe(HttpGenericMethod.POST);
      expect(store.config.timeoutMs).toBe(15_000);
      expect(store.config.headers).toEqual([{ name: 'ok', value: 'v' }]);
    });
  });

  describe('4. Opciones de credencial', () => {
    it('4.1 deberia cargarlas una sola vez por sesion', async () => {
      // 1. Arrange 📐
      vi.mocked(fetchCredentialOptions).mockResolvedValue([...OPTIONS]);
      const first = useHttpGenericDestinationStore(nextNodeId());
      const second = useHttpGenericDestinationStore(nextNodeId());

      // 2. Act ⚙️
      await first.loadCredentialOptions();
      await second.loadCredentialOptions();

      // 3. Assert 🎯
      expect(fetchCredentialOptions).toHaveBeenCalledTimes(1);
      expect(useCredentialsStore().options).toHaveLength(2);
    });

    it('4.2 deberia avisar si la credencial guardada ya no esta en la boveda', () => {
      // 1. Arrange 📐
      const store = useHttpGenericDestinationStore(nextNodeId());
      useCredentialsStore().options = [...OPTIONS];

      // 2. Act ⚙️
      store.hydrateFromNode({
        outputNamespace: 'http_generic_response',
        params: {
          targetUrl: TARGET_URL,
          authType: 'BEARER_TOKEN',
          authConfig: { credentialId: '99999999-9999-4999-8999-999999999999' },
        },
      });

      // 3. Assert 🎯
      expect(store.isCredentialStale).toBe(true);
      expect(store.configWarnings.join(' ')).toContain('ya no existe');
    });
  });
});
