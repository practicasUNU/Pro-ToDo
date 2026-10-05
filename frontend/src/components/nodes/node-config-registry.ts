import { defineAsyncComponent } from 'vue';

import { NodeType } from '@/types/pipeline';

import type { Component } from 'vue';

/**
 * Resolucion polimorfica de los componentes de configuracion de nodo
 * (regla frontend-quasar.md §3.1).
 *
 * El anfitrion (asistente o banco de pruebas) monta el resultado con
 * `<component :is="...">` a partir del `nodeType` del pipeline_schema, sin
 * conocer ningun tipo concreto. Anadir un nodo es anadir una entrada aqui.
 *
 * `defineAsyncComponent` mantiene cada configurador en su propio chunk: un
 * flujo que solo usa dos nodos no descarga los ocho.
 *
 * `Partial` SE CONSERVA aunque el mapa ya cubra los diez tipos del enum, al
 * reves de lo que decia este comentario cuando faltaban. El motivo es que el
 * `undefined` no es un hueco transitorio, es un VALOR del dominio:
 * `resolveStepBlockReason` distingue `SIN_CONFIGURADOR` de `SIN_STORE`
 * leyendolo, y con un `Record` total el compilador tiparia el acceso como
 * `Component` y daria esa rama por inalcanzable. Un tipo de nodo nuevo nace sin
 * configurador, asi que el camino tiene que seguir existiendo.
 */
export const nodeConfigRegistry: Partial<Record<NodeType, Component>> = {
  [NodeType.TRIGGER_IMAP]: defineAsyncComponent(
    () => import('@components/nodes/TriggerImapConfig.vue'),
  ),
  [NodeType.TRIGGER_CRON]: defineAsyncComponent(
    () => import('@components/nodes/TriggerCronConfig.vue'),
  ),
  [NodeType.PARSER_PRE_IA]: defineAsyncComponent(
    () => import('@components/nodes/ParserEmailConfig.vue'),
  ),
  [NodeType.EXTRACTOR_WEB]: defineAsyncComponent(
    () => import('@components/nodes/WebScraperConfig.vue'),
  ),
  [NodeType.MAPEADOR_PLANTILLA]: defineAsyncComponent(
    () => import('@components/nodes/TemplateMapperConfig.vue'),
  ),
  [NodeType.PROCESADOR_IA]: defineAsyncComponent(
    () => import('@components/nodes/LlmExtractorConfig.vue'),
  ),
  [NodeType.PROCESADOR_OCR]: defineAsyncComponent(
    () => import('@components/nodes/OcrProcessorConfig.vue'),
  ),
  [NodeType.ESCUDO_POST_IA]: defineAsyncComponent(
    () => import('@components/nodes/PostIaSanitizerConfig.vue'),
  ),
  [NodeType.DESTINO_SMTP]: defineAsyncComponent(
    () => import('@components/nodes/SmtpAlertConfig.vue'),
  ),
  [NodeType.DESTINO_HTTP]: defineAsyncComponent(
    () => import('@components/nodes/DrupalHttpConfig.vue'),
  ),
};

/** Tipos de nodo con configurador disponible, para poblar selectores. */
export const configurableNodeTypes = Object.keys(nodeConfigRegistry) as NodeType[];
