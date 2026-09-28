// @vitest-environment happy-dom
//
// Directiva POR ARCHIVO, igual que en `SmtpAlertConfig.spec.ts`: los specs de
// store no necesitan DOM y arrancan mas rapido sin el.
import { config, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import {
  QBadge,
  QBtn,
  QExpansionItem,
  QItem,
  QItemLabel,
  QItemSection,
  QSelect,
  QToggle,
  Quasar,
} from 'quasar';
import { beforeEach, describe, expect, it } from 'vitest';

import TemplateNodeCard from '@components/workflow-templates/TemplateNodeCard.vue';

import { NodeType } from '@/types/pipeline';

import type { AssemblerStep } from '@/utils/pipeline-assembler';
import type { ErrorBranchAction } from '@/types/nodes/error-branch.types';

const PARSER_ID = 'nodo_parser';
const MAPPER_ID = 'nodo_mapeador';
const ALERT_ID = 'destino_correo';

const QUASAR_COMPONENTS = {
  QBadge,
  QBtn,
  QExpansionItem,
  QItem,
  QItemLabel,
  QItemSection,
  QSelect,
  QToggle,
};

const buildStep = (nodeId: string, nodeType: NodeType, outputNamespace: string): AssemblerStep => ({
  nodeId,
  nodeType,
  outputNamespace,
  params: {},
});

interface MountOptions {
  step: AssemblerStep;
  errorBranch?: ErrorBranchAction | null;
  canOfferVision?: boolean;
}

const mountCard = ({
  step,
  errorBranch = null,
  canOfferVision = false,
}: MountOptions): ReturnType<typeof mount> =>
  mount(TemplateNodeCard, {
    props: {
      step,
      position: 1,
      isFirst: true,
      isLast: false,
      errorBranch,
      canOfferVision,
    },
    // El cuerpo del `q-expansion-item` se monta en diferido; sin esto los
    // controles de dentro no existen todavia cuando la prueba los busca.
    global: {
      plugins: [Quasar],
      components: QUASAR_COMPONENTS,
      stubs: { QExpansionItem: { template: '<div><slot name="header" /><slot /></div>' } },
    },
  });

describe('TemplateNodeCard · ruta de contingencia de un paso', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    config.global.plugins = [];
  });

  describe('1. Disponibilidad del control', () => {
    it('1.1 deberia ofrecer el interruptor en un nodo estandar', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const wrapper = mountCard({
        step: buildStep(MAPPER_ID, NodeType.MAPEADOR_PLANTILLA, 'rendered_html'),
      });

      // 3. Assert 🎯
      expect(wrapper.find(`[data-test="error-branch-toggle-${MAPPER_ID}"]`).exists()).toBe(true);
    });

    it('1.2 NO deberia ofrecerlo sobre un nodo de alerta', () => {
      // 1. Arrange 📐: se desviaria a si mismo, y el paso terminal del flujo no
      //    tiene a donde escalar.
      const wrapper = mountCard({
        step: buildStep(ALERT_ID, NodeType.DESTINO_SMTP, 'smtp_result'),
      });

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(wrapper.find(`[data-test="error-branch-toggle-${ALERT_ID}"]`).exists()).toBe(false);
    });

    it('1.3 deberia esconder el selector mientras no hay ruta', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const wrapper = mountCard({
        step: buildStep(MAPPER_ID, NodeType.MAPEADOR_PLANTILLA, 'rendered_html'),
      });

      // 3. Assert 🎯
      expect(wrapper.find(`[data-test="error-branch-action-${MAPPER_ID}"]`).exists()).toBe(false);
    });
  });

  describe('2. Catalogo cerrado de acciones (Poka-Yoke)', () => {
    it('2.1 deberia ofrecer SOLO la alerta en un nodo estandar', () => {
      // 1. Arrange 📐: el fallo por medios sin texto solo lo emite el parser, y
      //    ofrecer la vision aqui crearia una rama muerta que ninguna regla del
      //    backend detecta.
      const wrapper = mountCard({
        step: buildStep(MAPPER_ID, NodeType.MAPEADOR_PLANTILLA, 'rendered_html'),
        errorBranch: 'ALERTA_SMTP',
        canOfferVision: true,
      });

      // 2. Act ⚙️
      const options = wrapper
        .get(`[data-test="error-branch-action-${MAPPER_ID}"]`)
        .findComponent(QSelect)
        .props('options') as { value: string }[];

      // 3. Assert 🎯
      expect(options.map((option) => option.value)).toEqual(['ALERTA_SMTP']);
    });

    it('2.2 deberia ofrecer TAMBIEN la vision en el parser con un nodo de IA', () => {
      // 1. Arrange 📐
      const wrapper = mountCard({
        step: buildStep(PARSER_ID, NodeType.PARSER_PRE_IA, 'parsed_email'),
        errorBranch: 'ALERTA_SMTP',
        canOfferVision: true,
      });

      // 2. Act ⚙️
      const options = wrapper
        .get(`[data-test="error-branch-action-${PARSER_ID}"]`)
        .findComponent(QSelect)
        .props('options') as { value: string }[];

      // 3. Assert 🎯
      expect(options.map((option) => option.value)).toEqual(['ALERTA_SMTP', 'VISION_IA']);
    });

    it('2.3 NO deberia ofrecer la vision sin un nodo de IA al que apuntar', () => {
      // 1. Arrange 📐: uno nuevo chocaria con el del flujo en `llm_response`
      //    (regla 5 del validador), asi que la ruta apunta al que ya exista.
      const wrapper = mountCard({
        step: buildStep(PARSER_ID, NodeType.PARSER_PRE_IA, 'parsed_email'),
        errorBranch: 'ALERTA_SMTP',
        canOfferVision: false,
      });

      // 2. Act ⚙️
      const options = wrapper
        .get(`[data-test="error-branch-action-${PARSER_ID}"]`)
        .findComponent(QSelect)
        .props('options') as { value: string }[];

      // 3. Assert 🎯: y se explica por que, en vez de callar la opcion sin mas.
      expect(options.map((option) => option.value)).toEqual(['ALERTA_SMTP']);
      expect(wrapper.find(`[data-test="no-vision-hint-${PARSER_ID}"]`).exists()).toBe(true);
    });

    it('2.4 NO deberia admitir texto libre en el selector', () => {
      // 1. Arrange 📐: solo se eligen acciones del catalogo que el motor sabe
      //    atender; una cadena escrita a mano se guardaria y no haria nada.
      const wrapper = mountCard({
        step: buildStep(MAPPER_ID, NodeType.MAPEADOR_PLANTILLA, 'rendered_html'),
        errorBranch: 'ALERTA_SMTP',
      });

      // 2. Act ⚙️
      const select = wrapper
        .get(`[data-test="error-branch-action-${MAPPER_ID}"]`)
        .findComponent(QSelect);

      // 3. Assert 🎯
      expect(select.props('useInput')).toBeFalsy();
      expect(select.props('newValueMode')).toBeUndefined();
    });
  });

  describe('3. Emision de cambios', () => {
    it('3.1 deberia caer a la alerta al activar el interruptor', async () => {
      // 1. Arrange 📐: siempre es una accion valida, a diferencia de la vision.
      const wrapper = mountCard({
        step: buildStep(MAPPER_ID, NodeType.MAPEADOR_PLANTILLA, 'rendered_html'),
      });

      // 2. Act ⚙️
      await wrapper
        .get(`[data-test="error-branch-toggle-${MAPPER_ID}"]`)
        .findComponent(QToggle)
        .setValue(true);

      // 3. Assert 🎯
      expect(wrapper.emitted('update:errorBranch')?.[0]).toEqual(['ALERTA_SMTP']);
    });

    it('3.2 deberia emitir `null` al apagarlo', async () => {
      // 1. Arrange 📐
      const wrapper = mountCard({
        step: buildStep(MAPPER_ID, NodeType.MAPEADOR_PLANTILLA, 'rendered_html'),
        errorBranch: 'ALERTA_SMTP',
      });

      // 2. Act ⚙️
      await wrapper
        .get(`[data-test="error-branch-toggle-${MAPPER_ID}"]`)
        .findComponent(QToggle)
        .setValue(false);

      // 3. Assert 🎯
      expect(wrapper.emitted('update:errorBranch')?.[0]).toEqual([null]);
    });
  });
});
