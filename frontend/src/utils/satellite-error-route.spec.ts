import { describe, expect, it } from 'vitest';

import { resolveSatelliteErrorRoute } from './satellite-error-route';

import { SHARED_ALERT_NODE_ID } from '@/types/nodes/error-branch.types';

describe('resolveSatelliteErrorRoute · ruta de contingencia del satelite', () => {
  it('1. deberia desviar la transcripcion a la alerta cuando esta provisionada', () => {
    // 1. Arrange 📐: es el caso vivo. Sin esta ruta, un OCR que no transcribe
    //    PAUSA el flujo teniendo al lado el nodo que avisaria a una persona.
    const provisioned = ['ALERTA_SMTP', 'VISION_IA'] as const;

    // 2. Act ⚙️
    const route = resolveSatelliteErrorRoute('VISION_IA', provisioned);

    // 3. Assert 🎯: forma de CADENA, la unica que atrapa cualquier codigo.
    expect(route).toBe(SHARED_ALERT_NODE_ID);
  });

  it('2. deberia devolver null si la alerta no esta en el flujo', () => {
    // 1. Arrange 📐: apuntar a un nodo ausente rompe la regla 3 del validador
    //    de topologia y convierte el guardado en un 400.
    const provisioned = ['VISION_IA'] as const;

    // 2. Act ⚙️
    const route = resolveSatelliteErrorRoute('VISION_IA', provisioned);

    // 3. Assert 🎯
    expect(route).toBeNull();
  });

  it('3. deberia dejar terminal el satelite de alerta', () => {
    // 1. Arrange 📐: avisa a una persona y ahi acaba. Apuntarse a si misma
    //    seria un bucle que la regla 6 no mira —`onErrorStep` queda fuera de su
    //    recorrido— y que solo se descubriria en ejecucion.
    const provisioned = ['ALERTA_SMTP', 'VISION_IA'] as const;

    // 2. Act ⚙️
    const route = resolveSatelliteErrorRoute('ALERTA_SMTP', provisioned);

    // 3. Assert 🎯
    expect(route).toBeNull();
  });

  it('4. deberia devolver null con el flujo sin ninguna rama provisionada', () => {
    // 1. Arrange 📐: estado de un borrador recien abierto.

    // 2. Act ⚙️
    const route = resolveSatelliteErrorRoute('VISION_IA', []);

    // 3. Assert 🎯
    expect(route).toBeNull();
  });
});
