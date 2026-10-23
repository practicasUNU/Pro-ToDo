// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import {
  QBadge,
  QBtn,
  QCard,
  QCardActions,
  QCardSection,
  QDialog,
  QIcon,
  QSpinner,
  Quasar,
} from 'quasar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `copyToClipboard` exige contexto seguro y permisos que happy-dom no tiene; el
// aviso se observa doblando `useQuasar`, porque espiar el plugin llega tarde.
const { copyToClipboard, notify } = vi.hoisted(() => ({
  copyToClipboard: vi.fn().mockResolvedValue(undefined),
  notify: vi.fn(),
}));

vi.mock('quasar', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('quasar')),
  copyToClipboard,
  useQuasar: () => ({ notify }),
}));

vi.mock('@services/logs.service', () => ({
  fetchExecutionLog: vi.fn(),
}));

import LogViewerModal from '@components/shared/LogViewerModal.vue';

import { fetchExecutionLog } from '@services/logs.service';

import type { ExecutionLog } from '@/types/logs';

const EXECUTION_ID = '735dc678-1111-4111-8111-111111111111';

const LOG: ExecutionLog = {
  executionId: EXECUTION_ID,
  timestamp: '2026-10-22T08:00:05.000Z',
  level: 'GRAVE',
  stackTrace: 'AnthropicProviderException: 529\n    at toPayload (src/x.ts:310:13)',
  rawLog: '{"executionId":"735dc678","status":"ERROR"}',
  truncated: false,
};

const mountViewer = (executionId: string | null = EXECUTION_ID) =>
  mount(LogViewerModal, {
    props: { modelValue: true, executionId },
    attachTo: document.body,
    global: {
      plugins: [Quasar],
      components: {
        QBadge,
        QBtn,
        QCard,
        QCardActions,
        QCardSection,
        QDialog,
        QIcon,
        QSpinner,
      },
    },
  });

/** El dialogo se teletransporta al `body`. */
const find = (selector: string): HTMLElement | null => document.body.querySelector(selector);

describe('LogViewerModal', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('1.1 deberia pedir la traza al abrirse y pintarla en un <pre>', async () => {
    // 1. Arrange 📐
    vi.mocked(fetchExecutionLog).mockResolvedValue(LOG);

    // 2. Act ⚙️
    mountViewer();
    await flushPromises();

    // 3. Assert 🎯
    expect(fetchExecutionLog).toHaveBeenCalledWith(EXECUTION_ID);
    const stack = find('[data-test="log-stack"]');
    expect(stack?.tagName).toBe('PRE');
    expect(stack?.textContent).toContain('AnthropicProviderException: 529');
    expect(stack?.classList.contains('pd-terminal')).toBe(true);
    expect(find('[data-test="log-raw"]')?.textContent).toContain('"status":"ERROR"');
    expect(find('[data-test="log-level"]')?.textContent).toContain('GRAVE');
  });

  it('1.2 deberia avisar cuando ya no quedan entradas en disco', async () => {
    // 1. Arrange 📐: ficheros rotados (14 dias).
    vi.mocked(fetchExecutionLog).mockResolvedValue({ ...LOG, rawLog: '', stackTrace: null });

    // 2. Act ⚙️
    mountViewer();
    await flushPromises();

    // 3. Assert 🎯
    expect(find('[data-test="log-no-raw"]')).not.toBeNull();
    expect(find('[data-test="log-no-stack"]')).not.toBeNull();
  });

  it('1.3 deberia copiar traza y registro y confirmarlo', async () => {
    // 1. Arrange 📐
    vi.mocked(fetchExecutionLog).mockResolvedValue(LOG);
    mountViewer();
    await flushPromises();

    // 2. Act ⚙️
    find('[data-test="log-copy"]')?.click();
    await flushPromises();

    // 3. Assert 🎯
    expect(copyToClipboard).toHaveBeenCalledWith(`${LOG.stackTrace}\n\n${LOG.rawLog}`);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'positive' }));
  });

  it('1.4 deberia avisar si la copia falla (contexto inseguro)', async () => {
    // 1. Arrange 📐
    vi.mocked(fetchExecutionLog).mockResolvedValue(LOG);
    copyToClipboard.mockRejectedValueOnce(new Error('Contexto inseguro'));
    mountViewer();
    await flushPromises();

    // 2. Act ⚙️
    find('[data-test="log-copy"]')?.click();
    await flushPromises();

    // 3. Assert 🎯
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'negative' }));
  });

  it('1.5 deberia avisar del fallo de la API sin romper el dialogo', async () => {
    // 1. Arrange 📐
    vi.mocked(fetchExecutionLog).mockRejectedValue(new Error('404'));

    // 2. Act ⚙️
    mountViewer();
    await flushPromises();

    // 3. Assert 🎯
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'negative' }));
    expect(find('[data-test="log-stack"]')).toBeNull();
  });

  it('1.6 deberia emitir el cierre desde el boton Cerrar', async () => {
    // 1. Arrange 📐
    vi.mocked(fetchExecutionLog).mockResolvedValue(LOG);
    const wrapper = mountViewer();
    await flushPromises();

    // 2. Act ⚙️
    find('[data-test="log-close"]')?.click();
    await flushPromises();

    // 3. Assert 🎯
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([false]);
  });

  it('1.7 no deberia pedir nada sin ejecucion elegida', async () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    mountViewer(null);
    await flushPromises();

    // 3. Assert 🎯
    expect(fetchExecutionLog).not.toHaveBeenCalled();
  });
});
