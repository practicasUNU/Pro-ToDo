import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NodeType } from '@/types/pipeline';
import { AcensHttpMethod } from '@/types/nodes/acens-http.types';

import { testCampaignDispatch } from '@services/nodes/acens-http.service';

import { useAcensHttpStore } from './acens-http.store';

import type { UpstreamNamespace } from '@stores/nodes/node-store-registry';

vi.mock('@services/nodes/acens-http.service', () => ({ testCampaignDispatch: vi.fn() }));

/** `nodeId` unico por prueba: las definiciones de Pinia se memoizan por modulo. */
let nodeCounter = 0;
const nextNodeId = (): string => `destino_acens_${(nodeCounter += 1)}`;

const UPSTREAM: UpstreamNamespace[] = [
  {
    namespace: 'llm_response',
    nodeType: NodeType.PROCESADOR_IA,
    fields: [
      { name: 'headline', type: 'text' },
      { name: 'summary', type: 'text' },
    ],
  },
];

describe('useAcensHttpStore (DESTINO_ACENS)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('1.1 deberia arrancar en POST e invalido sin ruta', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const store = useAcensHttpStore(nextNodeId());

    // 3. Assert 🎯
    expect(store.config.method).toBe(AcensHttpMethod.POST);
    expect(store.missingRequiredParams).toEqual(['endpointPath']);
    expect(store.isConfigValid).toBe(false);
  });

  it('1.2 deberia validar una ruta relativa con payload JSON interpolado', () => {
    // 1. Arrange 📐
    const store = useAcensHttpStore(nextNodeId());
    store.setAvailableUpstreamContext(UPSTREAM);

    // 2. Act ⚙️
    store.updateConfig({
      endpointPath: '/campaigns',
      payloadTemplate: '{"subject": "{{llm_response.headline}}"}',
    });

    // 3. Assert 🎯
    expect(store.malformedParams).toEqual([]);
    expect(store.isConfigValid).toBe(true);
  });

  it.each(['https://api.acens.com/v1/x', '//evil/x', '/a/../b', 'campaigns'])(
    '1.3 deberia rechazar la ruta no relativa "%s"',
    (endpointPath) => {
      // 1. Arrange 📐
      const store = useAcensHttpStore(nextNodeId());

      // 2. Act ⚙️
      store.updateConfig({ endpointPath });

      // 3. Assert 🎯
      expect(store.isConfigValid).toBe(false);
    },
  );

  it('1.4 deberia rechazar Authorization, payload en GET y marcadores sin origen', () => {
    // 1. Arrange 📐
    const store = useAcensHttpStore(nextNodeId());
    store.setAvailableUpstreamContext(UPSTREAM);

    // 2. Act ⚙️
    store.updateConfig({
      method: AcensHttpMethod.GET,
      endpointPath: '/lists/{{parsed_email.clean_title}}',
      headers: [{ name: 'Authorization', value: 'Bearer x' }],
      payloadTemplate: '{"a": "b"}',
    });

    // 3. Assert 🎯
    expect(store.malformedParams).toHaveLength(3);
    expect(store.isConfigValid).toBe(false);
  });

  it('1.5 deberia ida y vuelta por toNodeParams / hydrateFromNode sin URL base', () => {
    // 1. Arrange 📐
    const store = useAcensHttpStore(nextNodeId());
    store.updateConfig({
      method: AcensHttpMethod.PUT,
      endpointPath: '/campaigns/7',
      headers: [{ name: 'X-Origen', value: 'proto-do' }],
      payloadTemplate: '{"a": "b"}',
      timeoutMs: 8000,
    });

    // 2. Act ⚙️
    const params = store.toNodeParams();
    const other = useAcensHttpStore(nextNodeId());
    other.hydrateFromNode({ outputNamespace: 'acens_result', params });

    // 3. Assert 🎯
    expect(params).toEqual({
      method: 'PUT',
      endpointPath: '/campaigns/7',
      headers: { 'X-Origen': 'proto-do' },
      payloadTemplate: '{"a": "b"}',
      timeoutMs: 8000,
    });
    expect(params).not.toHaveProperty('baseUrl');
    expect(other.config).toEqual(store.config);
  });

  describe('Modo CREATE_CAMPAIGN', () => {
    it('deberia exigir la lista y no la ruta', () => {
      // 1. Arrange 📐
      const store = useAcensHttpStore(nextNodeId());

      // 2. Act ⚙️
      store.updateConfig({ operation: 'CREATE_CAMPAIGN' });

      // 3. Assert 🎯
      expect(store.isCampaign).toBe(true);
      expect(store.missingRequiredParams).toEqual(['listId']);
      expect(store.isConfigValid).toBe(false);

      store.updateConfig({ listId: 'boletin-1' });
      expect(store.isConfigValid).toBe(true);
    });

    it('deberia publicar solo la operacion, la lista y lo que difiere del defecto', () => {
      // 1. Arrange 📐
      const store = useAcensHttpStore(nextNodeId());
      store.updateConfig({
        operation: 'CREATE_CAMPAIGN',
        listId: ' boletin-1 ',
        subjectPrefix: 'Boletin especial',
        endpointPath: '/ignorada',
      });

      // 2. Act ⚙️
      const params = store.toNodeParams();

      // 3. Assert 🎯
      expect(params).toEqual({
        operation: 'CREATE_CAMPAIGN',
        listId: 'boletin-1',
        subjectPrefix: 'Boletin especial',
      });
    });

    it('deberia rechazar un correo de remitente invalido', () => {
      // 1. Arrange 📐
      const store = useAcensHttpStore(nextNodeId());

      // 2. Act ⚙️
      store.updateConfig({
        operation: 'CREATE_CAMPAIGN',
        listId: 'boletin-1',
        fromEmail: 'no-es-correo',
      });

      // 3. Assert 🎯
      expect(store.malformedParams).toContain('El correo del remitente no es valido.');
      expect(store.isConfigValid).toBe(false);
    });

    it('deberia hidratar un nodo de campana con los defectos de lo que no trae', () => {
      // 1. Arrange 📐
      const store = useAcensHttpStore(nextNodeId());

      // 2. Act ⚙️
      store.hydrateFromNode({
        nodeId: 'campana_acens',
        params: { operation: 'CREATE_CAMPAIGN', listId: 'lista-9' },
      } as never);

      // 3. Assert 🎯
      expect(store.config).toMatchObject({
        operation: 'CREATE_CAMPAIGN',
        listId: 'lista-9',
        fromName: 'Notiweb',
        fromEmail: 'notiweb@madrimasd.org',
        contentNamespace: 'validated_drupal_json',
      });
      expect(store.toNodeParams()).toEqual({
        operation: 'CREATE_CAMPAIGN',
        listId: 'lista-9',
      });
    });

    it('deberia probar la campana por el servicio y apagar el indicador', async () => {
      // 1. Arrange 📐
      vi.mocked(testCampaignDispatch).mockResolvedValue({
        success: true,
        data: { status: 'TEST_MODE' },
        durationMs: 5,
      });
      const store = useAcensHttpStore(nextNodeId());
      store.updateConfig({ operation: 'CREATE_CAMPAIGN', listId: 'boletin-1' });

      // 2. Act ⚙️
      const result = await store.testCampaignDispatch();

      // 3. Assert 🎯
      expect(testCampaignDispatch).toHaveBeenCalledWith(
        { operation: 'CREATE_CAMPAIGN', listId: 'boletin-1' },
        'validated_drupal_json',
      );
      expect(result.data?.status).toBe('TEST_MODE');
      expect(store.lastCampaignTest).toEqual(result);
      expect(store.isTestingCampaign).toBe(false);
    });
  });
});
