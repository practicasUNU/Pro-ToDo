import { defineAsyncComponent } from 'vue';

import { NodeType } from '@/types/pipeline';

import type { Component } from 'vue';

/**
 * Resolucion polimorfica de los controles de PARAMETROS BASE de un nodo dentro
 * del editor de plantillas (regla frontend-quasar.md §3.1 y §4, Poka-Yoke).
 *
 * Sustituye al editor de JSON crudo que la ficha del nodo montaba para todos los
 * tipos por igual: teclear llaves y comillas es justo lo que RNF-04 prohibe, y
 * el backend acepta `params` como `@IsObject()` opaco, asi que un objeto mal
 * formado se guardaba con 201 y reventaba en la primera ejecucion.
 *
 * Es un registro SEPARADO de `nodeConfigRegistry` y no un modo suyo. Aquel sirve
 * al asistente y pide host, usuario y `passwordEnvKey`: datos de operacion del
 * flujo. Montarlo aqui meteria credenciales dentro de una plantilla, que es un
 * documento reutilizable y compartido.
 *
 * `Partial` es deliberado, igual que en el registro hermano: la mayoria de tipos
 * no tiene ningun parametro base que sembrar, y el anfitrion debe contemplar el
 * `undefined` —simplemente no pinta controles— en vez de suponer cobertura.
 */
export const nodeBaseParamsRegistry: Partial<Record<NodeType, Component>> = {
  [NodeType.TRIGGER_IMAP]: defineAsyncComponent(
    () => import('@components/nodes/TriggerImapBaseParams.vue'),
  ),
};
