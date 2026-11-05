// Clave de inyeccion con la que el Banco de Pruebas avisa a los configuradores
// de nodo de que estan montados DENTRO de el.
//
// Va por provide/inject y no como prop: el contrato uniforme de un
// `<NodeName>Config.vue` es recibir solo `nodeId` (frontend-quasar.md §3.1), y
// el asistente no tiene por que saber que existe esta bandera. Solo la leen los
// nodos que cambian de comportamiento en el banco (hoy, DESTINO_DRUPAL, que se
// encierra en el entorno de pruebas).

import type { InjectionKey } from 'vue';

export const NODE_SANDBOX_MODE_KEY: InjectionKey<boolean> = Symbol('nodeSandboxMode');
