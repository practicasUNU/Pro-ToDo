import { onBeforeUnmount, onMounted } from 'vue';

import { subscribeToCrudMutations } from '@services/socket-events.service';
import { useAiPromptTemplatesStore } from '@stores/ai-prompt-templates.store';
import { useAllowedIpsStore } from '@stores/allowed-ips.store';
import { useTemplatesStore } from '@stores/templates.store';
import { useUsersStore } from '@stores/users.store';
import { useWorkflowTemplatesStore } from '@stores/workflow-templates.store';
import { useWorkflowsStore } from '@stores/workflows.store';

import type { AiPromptTemplate } from '@/types/ai-prompt-template';
import type { AllowedIp } from '@/types/allowed-ip';
import type { CrudMutationPayload } from '@/types/crud-events';
import type { HtmlTemplate } from '@/types/html-template';
import type { PipelineSummary, WorkflowTemplateSummary } from '@/types/pipeline';
import type { User } from '@/types/user';

/**
 * Mantiene las tablas maestras al dia mientras otro administrador las edita.
 *
 * Se engancha una sola vez en `MainLayout`, por el mismo motivo que
 * `useExecutionSocket`: las mutaciones deben seguir llegando mientras el
 * operador navega, y montar la escucha en cada vista la cerraria al salir.
 *
 * NO filtra por rol. Quien decide que llega es el gateway, que manda las
 * entidades administrativas solo a la sala de administradores; replicar aqui
 * esa regla seria duplicar una barrera de seguridad en el unico lado donde no
 * se puede hacer cumplir.
 */
export const useCrudSocket = (): void => {
  const usersStore = useUsersStore();
  const allowedIpsStore = useAllowedIpsStore();
  const templatesStore = useTemplatesStore();
  const workflowTemplatesStore = useWorkflowTemplatesStore();
  const aiPromptTemplatesStore = useAiPromptTemplatesStore();
  const workflowsStore = useWorkflowsStore();

  let unsubscribe: (() => void) | null = null;

  /**
   * Encamina la mutacion hacia el store de su entidad.
   *
   * Cada store aplica el parche; aqui solo se elige el destinatario. Escribir
   * la coleccion desde fuera dejaria la mutacion del estado repartida entre el
   * store y este composable (`frontend-architecture.md` §2.1).
   *
   * El casteo de `data` es inevitable y esta acotado a esta funcion: lo que
   * llega por el socket es `unknown` hasta que la entidad dice que forma tiene.
   * Es la UNICA frontera donde se afirma un tipo sin que el compilador pueda
   * comprobarlo, y por eso se hace explicito por entidad en vez de con un
   * comodin.
   *
   * Un `DELETED` no trae `data`: el store recibe el registro vacio y se queda
   * con el `id`, que es lo unico que necesita para sacar la fila.
   */
  const onMutation = (payload: CrudMutationPayload): void => {
    const { entity, action, id, data } = payload;

    switch (entity) {
      case 'users':
        usersStore.applyMutation(action, data as User | undefined, id);
        break;

      case 'allowed_ips':
        allowedIpsStore.applyMutation(action, data as AllowedIp | undefined, id);
        break;

      case 'templates':
        templatesStore.applyMutation(action, data as HtmlTemplate | undefined, id);
        break;

      case 'workflow_templates':
        workflowTemplatesStore.applyMutation(
          action,
          data as WorkflowTemplateSummary | undefined,
          id,
        );
        break;

      case 'ai_prompts':
        aiPromptTemplatesStore.applyMutation(action, data as AiPromptTemplate | undefined, id);
        break;

      case 'workflows':
        workflowsStore.applyMutation(action, data as PipelineSummary | undefined, id);
        break;
    }
  };

  onMounted(() => {
    unsubscribe = subscribeToCrudMutations(onMutation);
  });

  // Sin esta baja, cada montaje apilaria un juego mas de escuchas y una sola
  // mutacion se aplicaria tantas veces como veces se hubiera montado el layout.
  onBeforeUnmount(() => {
    unsubscribe?.();
    unsubscribe = null;
  });
};
