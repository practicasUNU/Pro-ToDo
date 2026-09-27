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
 * `Partial` es deliberado: los tipos aun sin implementar simplemente no estan,
 * y el anfitrion debe contemplar el `undefined` en vez de suponer cobertura
 * total. Cuando se implementen los ocho, el `Partial` cae y el compilador
 * exigira que no falte ninguno.
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
  [NodeType.DESTINO_SMTP]: defineAsyncComponent(
    () => import('@components/nodes/SmtpAlertConfig.vue'),
  ),
};

/** Tipos de nodo con configurador disponible, para poblar selectores. */
export const configurableNodeTypes = Object.keys(nodeConfigRegistry) as NodeType[];
