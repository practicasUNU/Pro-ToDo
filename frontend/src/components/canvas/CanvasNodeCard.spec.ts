// @vitest-environment happy-dom
//
// Directiva POR ARCHIVO, igual que el resto de specs de componente.
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { QBadge, QBtn, QIcon, QSpace, QTooltip, Quasar } from 'quasar';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import CanvasNodeCard from '@components/canvas/CanvasNodeCard.vue';
import { useCanvasStore } from '@stores/canvas.store';

import { NodeType } from '@/types/pipeline';
import { ExecutionState } from '@/types/execution';

import type { AssembledPipelineNode } from '@/types/pipeline';

// Sin esto se cargaria `@boot/axios`, que necesita entorno de navegador.
vi.mock('@services/fsm-executions.service', () => ({
  resumeExecution: vi.fn(),
  discardExecution: vi.fn(),
  fetchExecution: vi.fn(),
  fetchActiveExecution: vi.fn(),
}));
vi.mock('@services/workflows.service', () => ({ fetchWorkflow: vi.fn() }));

/**
 * Doble de `useQuasar`, en vez de instalar el plugin `Dialog` y espiarlo.
 *
 * Quasar instala cada plugin UNA sola vez por proceso y copia `Dialog.create`
 * dentro del `$q` en esa primera instalacion, de modo que cualquier espia
 * puesto despues —y en una prueba SIEMPRE es despues— ya no intercepta nada.
 * Doblar la composable corta por lo sano: lo que se prueba aqui es el MENSAJE
 * con el que el componente pide confirmacion, no el renderizado del dialogo,
 * que es responsabilidad de Quasar y ya esta probado aguas arriba.
 */
const dialogCreate = vi.fn((_options: { message: string }) => ({
  onOk: vi.fn(),
}));
const notify = vi.fn();

vi.mock('quasar', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('quasar')),
  useQuasar: () => ({ dialog: dialogCreate, notify }),
}));
vi.mock('@services/socket-events.service', () => ({
  joinFlowRoom: vi.fn().mockResolvedValue({ ok: true }),
  leaveFlowRoom: vi.fn().mockResolvedValue({ ok: true }),
}));

const FLOW_ID = 'f1e2d3c4-b5a6-4978-8a9b-0c1d2e3f4a5b';
const EXECUTION_ID = 'e1e2d3c4-b5a6-4978-8a9b-0c1d2e3f4a5b';

/** El nodo OCR: uno de los dos que consumen los binarios del correo. */
const OCR_NODE = {
  nodeId: 'ocr_ia',
  nodeType: NodeType.PROCESADOR_OCR,
  outputNamespace: 'ocr_result',
  nextStep: null,
  onErrorStep: null,
  params: {},
} as unknown as AssembledPipelineNode;

/** Un nodo cualquiera al que la purga de binarios no le afecta. */
const LLM_NODE = {
  nodeId: 'nodo_ia',
  nodeType: NodeType.PROCESADOR_IA,
  outputNamespace: 'llm_response',
  nextStep: null,
  onErrorStep: null,
  params: {},
} as unknown as AssembledPipelineNode;

/** Adjunto ya liberado por el motor (RNF-01). */
const PURGED_ATTACHMENT = {
  filename: 'escaneo.png',
  contentType: 'image/png',
  contentBase64: null,
};

/**
 * Deja el canvas en el unico estado desde el que se ofrece reanudar.
 *
 * Se escriben los refs del store en vez de simular la carga desde la API: lo
 * que se prueba aqui es el MENSAJE del dialogo, y pasar por la peticion solo
 * anadiria dobles que no participan en esa decision.
 */
const primeStore = (
  node: AssembledPipelineNode,
  context: Record<string, Record<string, unknown>>,
): void => {
  const store = useCanvasStore();

  store.workflow = {
    id: FLOW_ID,
    pipelineSchema: { nodes: { [node.nodeId]: node } },
  } as unknown as typeof store.workflow;

  store.observedExecution = {
    executionId: EXECUTION_ID,
    state: ExecutionState.PAUSADO,
    activeCursor: node.nodeId,
    context,
  } as unknown as typeof store.observedExecution;
};

const mountCard = (node: AssembledPipelineNode) =>
  mount(CanvasNodeCard, {
    props: { step: node },
    global: {
      // El plugin se instala por el `_q_` que inyectan QIcon y compania al
      // renderizarse; el dialogo NO sale de aqui, sino del doble de
      // `useQuasar` declarado arriba.
      plugins: [Quasar],
      components: { QBadge, QBtn, QIcon, QSpace, QTooltip },
    },
  });

/** Monta, pulsa "Reanudar" y devuelve el mensaje con el que se abrio el dialogo. */
const resumeMessageOf = async (
  node: AssembledPipelineNode,
  context: Record<string, Record<string, unknown>>,
): Promise<string> => {
  primeStore(node, context);
  const wrapper = mountCard(node);

  await wrapper.get('[data-test="resume-from-node"]').trigger('click');

  expect(dialogCreate).toHaveBeenCalledTimes(1);

  return (dialogCreate.mock.calls[0]?.[0] as unknown as { message: string }).message;
};

describe('CanvasNodeCard · aviso de reanudacion con binarios purgados', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    dialogCreate.mockClear();
  });

  it('1. deberia advertir al reanudar desde OCR con los binarios liberados', async () => {
    // 1. Arrange 📐 + 2. Act ⚙️: el operador suele reanudar aqui justamente
    //    porque cambio el fichero o el prompt, y esa es la unica expectativa
    //    que el sistema no puede cumplir.
    const message = await resumeMessageOf(OCR_NODE, {
      raw_email: { attachments: [PURGED_ATTACHMENT] },
    });

    // 3. Assert 🎯
    expect(message).toContain('RNF-01');
    expect(message).toContain('reutilizara la extraccion de texto');
  });

  it('2. NO deberia advertir en un nodo que no consume adjuntos', async () => {
    // 1. Arrange 📐 + 2. Act ⚙️: el resto del grafo trabaja sobre texto ya
    //    extraido, y advertirle de una cache que no usa seria ruido.
    const message = await resumeMessageOf(LLM_NODE, {
      raw_email: { attachments: [PURGED_ATTACHMENT] },
    });

    // 3. Assert 🎯
    expect(message).not.toContain('RNF-01');
  });

  it('3. NO deberia advertir si los binarios siguen en el contexto', async () => {
    // 1. Arrange 📐 + 2. Act ⚙️: con el binario intacto el nodo transcribe de
    //    verdad, y prometer una reutilizacion seria mentir.
    const message = await resumeMessageOf(OCR_NODE, {
      raw_email: {
        attachments: [{ ...PURGED_ATTACHMENT, contentBase64: 'QUJDREVG' }],
      },
    });

    // 3. Assert 🎯
    expect(message).not.toContain('RNF-01');
  });
});
