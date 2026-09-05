import { StatePayloadContext } from '@core/fsm/context/state-payload.context';

/** Valores por defecto: identificadores estables para que los asserts no dependan del azar. */
const DEFAULT_EXECUTION_ID = 'exec-00000000-0000-4000-8000-000000000000';
const DEFAULT_WORKFLOW_ID = 'flow-00000000-0000-4000-8000-000000000000';
const DEFAULT_CURRENT_STEP = 'nodo_inicial';

/** Opciones de construccion; todas opcionales, con valores por defecto estables. */
export interface MockContextOptions {
  readonly executionId?: string;
  readonly workflowId?: string;
  /** Cursor inicial, equivalente al `currentStep` de `testing-standards.md` §2. */
  readonly currentStep?: string;
  /** Namespaces precargados, como si los hubieran escrito nodos anteriores. */
  readonly namespaces?: Record<string, Record<string, unknown>>;
}

/**
 * Construye un `StatePayloadContext` con namespaces ya precargados.
 *
 * `testing-standards.md` §2 la exige para no instanciar el contexto a mano en
 * cada prueba: el constructor toma tres posicionales (`executionId`,
 * `workflowId`, `initialStep`) y sembrar namespaces obliga a una tanda de
 * `setNamespace`. Repetir eso en cada `Arrange` acaba en pruebas que fallan por
 * un argumento en el orden equivocado, no por la logica que examinan.
 *
 * Devuelve el contexto REAL y no un doble: la clase es pura, sin repositorio ni
 * red, y su inmutabilidad por `structuredClone` es justo parte de lo que las
 * estrategias tienen que respetar.
 */
export const createMockStatePayloadContext = (
  options: MockContextOptions = {},
): StatePayloadContext => {
  const context = new StatePayloadContext(
    options.executionId ?? DEFAULT_EXECUTION_ID,
    options.workflowId ?? DEFAULT_WORKFLOW_ID,
    options.currentStep ?? DEFAULT_CURRENT_STEP,
  );

  for (const [namespace, data] of Object.entries(options.namespaces ?? {})) {
    context.setNamespace(namespace, data);
  }

  return context;
};
