// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { QBtn, QIcon, QInput, QMenu, QTooltip, Quasar } from 'quasar';
import { describe, expect, it } from 'vitest';

import KeyValueRowsEditor from '@components/shared/KeyValueRowsEditor.vue';

import type { KeyValueRow } from '@/types/nodes/http-generic-destination.types';

const mountEditor = (rows: KeyValueRow[], maxRows = 3): ReturnType<typeof mount> =>
  mount(KeyValueRowsEditor, {
    props: { rows, context: [], testId: 'headers', maxRows },
    global: {
      plugins: [Quasar],
      components: { QBtn, QIcon, QInput, QMenu, QTooltip },
      stubs: { VariableExplorer: true },
    },
  });

/** Ultima lista emitida por `update:rows`. */
const lastEmitted = (wrapper: ReturnType<typeof mount>): KeyValueRow[] | undefined =>
  (wrapper.emitted('update:rows')?.at(-1) as [KeyValueRow[]] | undefined)?.[0];

describe('KeyValueRowsEditor.vue', () => {
  it('1.1 deberia anadir una fila vacia', async () => {
    // 1. Arrange 📐
    const wrapper = mountEditor([{ name: 'X-A', value: '1' }]);

    // 2. Act ⚙️
    await wrapper.get('[data-test="headers-add"]').trigger('click');

    // 3. Assert 🎯
    expect(lastEmitted(wrapper)).toEqual([
      { name: 'X-A', value: '1' },
      { name: '', value: '' },
    ]);
  });

  it('1.2 deberia editar el valor de una fila sin tocar las demas', () => {
    // 1. Arrange 📐
    const wrapper = mountEditor([
      { name: 'X-A', value: '1' },
      { name: 'X-B', value: '2' },
    ]);

    // 2. Act ⚙️
    wrapper
      .get('[data-test="headers-row-1"]')
      .findAllComponents(QInput)[1]
      ?.vm.$emit('update:model-value', 'nuevo');

    // 3. Assert 🎯
    expect(lastEmitted(wrapper)).toEqual([
      { name: 'X-A', value: '1' },
      { name: 'X-B', value: 'nuevo' },
    ]);
  });

  it('1.3 deberia quitar la fila elegida', async () => {
    // 1. Arrange 📐
    const wrapper = mountEditor([
      { name: 'X-A', value: '1' },
      { name: 'X-B', value: '2' },
    ]);

    // 2. Act ⚙️
    await wrapper.get('[data-test="headers-remove-0"]').trigger('click');

    // 3. Assert 🎯
    expect(lastEmitted(wrapper)).toEqual([{ name: 'X-B', value: '2' }]);
  });

  it('1.4 deberia deshabilitar el alta al llegar al techo', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const wrapper = mountEditor([{ name: 'X-A', value: '1' }], 1);

    // 3. Assert 🎯
    expect(wrapper.get('[data-test="headers-add"]').findComponent(QBtn).props('disable')).toBe(
      true,
    );
  });
});
