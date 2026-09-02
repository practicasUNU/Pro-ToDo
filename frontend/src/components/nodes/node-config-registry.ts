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
 * flujo que solo usa dos nodos no descarga los siete.
 *
 * `Partial` es deliberado: los tipos aun sin implementar simplemente no estan,
 * y el anfitrion debe contemplar el `undefined` en vez de suponer cobertura
 * total. Cuando se implementen los siete, el `Partial` cae y el compilador
 * exigira que no falte ninguno.
 */
export const nodeConfigRegistry: Partial<Record<NodeType, Component>> = {
  [NodeType.MAPEADOR_PLANTILLA]: defineAsyncComponent(
    () => import('@components/nodes/TemplateMapperConfig.vue'),
  ),
};

/** Tipos de nodo con configurador disponible, para poblar selectores. */
export const configurableNodeTypes = Object.keys(nodeConfigRegistry) as NodeType[];
