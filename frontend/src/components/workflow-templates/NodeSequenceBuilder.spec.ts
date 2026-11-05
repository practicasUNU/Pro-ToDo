// @vitest-environment happy-dom
import { createPinia, setActivePinia } from 'pinia';
import { Quasar } from 'quasar';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { flushPromises, mount } from '@vue/test-utils';

import NodeSequenceBuilder from './NodeSequenceBuilder.vue';

import { NodeCategory } from '@/types/node-catalog';
import { NodeType } from '@/types/pipeline';

import type { NodeCatalogEntry } from '@/types/node-catalog';
import type { AssemblerStep } from '@/utils/pipeline-assembler';
import type * as QuasarModule from 'quasar';

// Se dobla `useQuasar` y no se espia `Notify`: el plugin real llega tarde al
// espia (ver la memoria del proyecto sobre `Dialog.create`).
const notify = vi.fn();

vi.mock('quasar', async () => {
  const actual = await vi.importActual<typeof QuasarModule>('quasar');

  return { ...actual, useQuasar: () => ({ notify }) };
});

// Sin esto se cargaria `@boot/axios`, que necesita el entorno de Quasar.
vi.mock('@services/node-catalog.service', () => ({
  fetchNodeCatalog: vi.fn().mockResolvedValue([]),
}));

/** Paso minimo de la secuencia. */
const step = (nodeId: string, nodeType: NodeType): AssemblerStep => ({
  nodeId,
  nodeType,
  outputNamespace: nodeId,
  params: {},
});

/** Entrada de catalogo ejecutable de un tipo. */
const entryOf = (nodeType: NodeType, category: NodeCategory): NodeCatalogEntry => ({
  id: nodeType,
  code: nodeType,
  name: nodeType,
  category,
  description: null,
  implemented: true,
  outputFields: [],
});

/** Lo que el spec necesita del estado interno del `<script setup>`. */
interface BuilderInternals {
  pendingEntry: NodeCatalogEntry | null;
  addNode: () => void;
  moveNode: (index: number, offset: number) => void;
}

const mountBuilder = (modelValue: AssemblerStep[]) =>
  mount(NodeSequenceBuilder, {
    props: { modelValue, errorBranches: {}, baseParamsLocked: false },
    global: {
      plugins: [Quasar],
      // La tarjeta no viene al caso: se prueba la secuencia, no su edicion.
      stubs: { TemplateNodeCard: true },
    },
  });

const internals = (wrapper: ReturnType<typeof mountBuilder>): BuilderInternals =>
  wrapper.vm as unknown as BuilderInternals;

describe('NodeSequenceBuilder · reglas de autoria', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    notify.mockClear();
  });

  it('1.1 deberia bloquear un segundo destino del mismo tipo con el aviso exacto', async () => {
    // 1. Arrange
    const wrapper = mountBuilder([
      step('trigger_imap', NodeType.TRIGGER_IMAP),
      step('parser', NodeType.PARSER_PRE_IA),
      step('destino', NodeType.DESTINO_HTTP_GENERICO),
    ]);
    await flushPromises();
    internals(wrapper).pendingEntry = entryOf(NodeType.DESTINO_HTTP_GENERICO, NodeCategory.DESTINO);

    // 2. Act
    internals(wrapper).addNode();

    // 3. Assert
    expect(notify).toHaveBeenCalledWith({
      type: 'negative',
      message:
        "El tipo de nodo 'Destino HTTP genérico' ya está presente en este flujo y no se puede duplicar.",
    });
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });

  it('1.2 deberia admitir un disparador Cron junto a uno IMAP', async () => {
    // 1. Arrange
    const wrapper = mountBuilder([step('trigger_imap', NodeType.TRIGGER_IMAP)]);
    await flushPromises();
    internals(wrapper).pendingEntry = entryOf(NodeType.TRIGGER_CRON, NodeCategory.TRIGGER);

    // 2. Act
    internals(wrapper).addNode();

    // 3. Assert
    expect(notify).not.toHaveBeenCalled();
    expect(wrapper.emitted('update:modelValue')).toHaveLength(1);
  });

  it('1.3 deberia bloquear un destino anadido justo detras del disparador', async () => {
    // 1. Arrange
    const wrapper = mountBuilder([step('trigger_imap', NodeType.TRIGGER_IMAP)]);
    await flushPromises();
    internals(wrapper).pendingEntry = entryOf(NodeType.DESTINO_DRUPAL, NodeCategory.DESTINO);

    // 2. Act
    internals(wrapper).addNode();

    // 3. Assert
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'negative' }));
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });

  it('1.4 deberia impedir subir el destino por delante del procesamiento', async () => {
    // 1. Arrange
    const wrapper = mountBuilder([
      step('trigger_imap', NodeType.TRIGGER_IMAP),
      step('parser', NodeType.PARSER_PRE_IA),
      step('destino', NodeType.DESTINO_DRUPAL),
    ]);
    await flushPromises();

    // 2. Act
    internals(wrapper).moveNode(2, -1);

    // 3. Assert
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("El destino 'Destino Drupal'") as unknown,
      }),
    );
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });
});
