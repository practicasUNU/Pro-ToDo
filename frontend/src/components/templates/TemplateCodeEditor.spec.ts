// @vitest-environment happy-dom
//
// Directiva POR ARCHIVO, igual que en los demas specs de componente.
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import TemplateCodeEditor from '@components/templates/TemplateCodeEditor.vue';

import type { TemplateViolation } from '@/types/html-template';

/**
 * El subrayado de infracciones es la clase de fallo que se degrada EN SILENCIO:
 * marcar de menos o de mas no rompe nada visible, y el operador se queda con un
 * 400 que no sabe donde mirar. De ahi que se pruebe el editor y no solo
 * `violation-matcher`, que ya tiene el suyo: lo que falta por comprobar es que
 * los rangos llegan a CodeMirror y que se retiran al reeditar.
 */
const DOC = '<div><script>alert(1)</scr' + 'ipt></div>';

const SCRIPT_VIOLATION: TemplateViolation = {
  type: 'tag',
  target: 'script',
  message: "La etiqueta 'script' no esta permitida.",
};

/** Diagnosticos vivos en la vista, leidos del DOM que pinta `@codemirror/lint`. */
const underlinedCount = (wrapper: ReturnType<typeof mount>): number =>
  wrapper.element.querySelectorAll('.cm-lintRange').length;

const mountEditor = (modelValue: string): ReturnType<typeof mount> =>
  mount(TemplateCodeEditor, { props: { modelValue }, attachTo: document.body });

describe('TemplateCodeEditor · resaltado de infracciones de saneado', () => {
  describe('1. Infracciones del 400', () => {
    it('1.1 deberia subrayar la construccion rechazada con su mensaje', async () => {
      // 1. Arrange 📐
      const wrapper = mountEditor(DOC);

      // 2. Act ⚙️: lo mismo que hace `TemplateEditorDialog` al recibir el 400.
      (wrapper.vm as unknown as { setViolations: (v: TemplateViolation[]) => void }).setViolations([
        SCRIPT_VIOLATION,
      ]);
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯: dos marcas, la apertura y el cierre, porque el patron de
      //    `tag` casa con ambas. El mensaje viaja con el rango: es el tooltip.
      expect(underlinedCount(wrapper)).toBe(2);

      wrapper.unmount();
    });

    it('1.2 deberia limpiar el resaltado con una lista vacia', async () => {
      // 1. Arrange 📐
      const wrapper = mountEditor(DOC);
      const editor = wrapper.vm as unknown as {
        setViolations: (v: TemplateViolation[]) => void;
      };

      editor.setViolations([SCRIPT_VIOLATION]);
      await wrapper.vm.$nextTick();

      // 2. Act ⚙️
      editor.setViolations([]);
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(underlinedCount(wrapper)).toBe(0);

      wrapper.unmount();
    });
  });

  describe('2. Limpieza al reeditar', () => {
    it('2.1 deberia retirar los diagnosticos en cuanto cambia el documento', async () => {
      // 1. Arrange 📐: los diagnosticos describen un documento que ya cambio.
      //    Dejarlos visibles senalaria posiciones DESPLAZADAS, que es peor que
      //    no senalar nada: manda al operador a corregir donde no toca.
      const wrapper = mountEditor(DOC);
      const editor = wrapper.vm as unknown as {
        setViolations: (v: TemplateViolation[]) => void;
        insertTextAtCursor: (text: string, cursorOffset?: number) => void;
      };

      editor.setViolations([SCRIPT_VIOLATION]);
      await wrapper.vm.$nextTick();
      expect(underlinedCount(wrapper)).toBe(2);

      // 2. Act ⚙️: una edicion real. Pasa por el MISMO `docChanged` del
      //    `updateListener` que dispara el teclado, que es lo que se prueba.
      editor.insertTextAtCursor('x');
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(underlinedCount(wrapper)).toBe(0);
      expect(wrapper.emitted('update:modelValue')).toBeTruthy();

      wrapper.unmount();
    });
  });
});
