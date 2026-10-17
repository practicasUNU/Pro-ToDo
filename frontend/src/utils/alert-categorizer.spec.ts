import { describe, expect, it } from 'vitest';

import {
  ALERTING_SEVERITIES,
  notifyClassesOf,
  notifyTimeoutOf,
  presentationOf,
} from './alert-categorizer';

import type { NodeErrorSeverity } from '@/types/execution';

/**
 * Lo que se mide aqui es LEGIBILIDAD OPERATIVA, no estetica: el color es lo
 * primero que el operador procesa, y dos desenlaces opuestos pintados igual le
 * hacen tratarlos igual.
 */
describe('alert-categorizer', () => {
  describe('1. Cada severidad se distingue de las demas', () => {
    it('1.1 deberia dar a GRAVE y URGENTE presentaciones DISTINTAS', () => {
      // 1. Arrange 📐: era el defecto. Los dos se pintaban `negative` con el
      //    mismo acento rojo, pese a que uno se reintenta y el otro no.
      const grave = presentationOf('GRAVE');
      const urgente = presentationOf('URGENTE');

      // 2. Act ⚙️ & 3. Assert 🎯
      expect(grave.type).not.toBe(urgente.type);
      expect(grave.accentClass).not.toBe(urgente.accentClass);
      expect(grave.icon).not.toBe(urgente.icon);
    });

    it('1.2 deberia presentar un LEVE como informativo y pasajero', () => {
      // 1. Arrange 📐: el motor lo cierra solo; no hay nada que decidir.
      const leve = presentationOf('LEVE');

      // 2. Act ⚙️ & 3. Assert 🎯
      expect(leve.type).toBe('info');
      expect(leve.persistent).toBe(false);
      expect(notifyTimeoutOf('LEVE')).toBeGreaterThan(0);
    });

    it.each<[NodeErrorSeverity, string]>([
      ['LEVE', 'pd-accent-leve'],
      ['GRAVE', 'pd-accent-grave'],
      ['URGENTE', 'pd-accent-urgente'],
    ])('1.3 deberia usar el acento ya declarado para %s', (severity, accent) => {
      // 1. Arrange 📐 & 2. Act ⚙️: las clases existen en `app.scss` desde
      //    siempre; `pd-accent-leve` era la que nadie usaba.
      const classes = notifyClassesOf(severity);

      // 3. Assert 🎯
      expect(classes).toContain(accent);
      expect(classes).toContain('pd-card--accent');
    });
  });

  describe('2. Quien merece interrumpir al operador', () => {
    it('2.1 deberia alertar de GRAVE y URGENTE, nunca de LEVE', () => {
      // 1. Arrange 📐 & 2. Act ⚙️ & 3. Assert 🎯
      expect(ALERTING_SEVERITIES).toEqual(['GRAVE', 'URGENTE']);
    });

    it('2.2 deberia derivar esa lista de la propia tabla', () => {
      // 1. Arrange 📐: mantener dos listas garantizaba que algun dia dejasen
      //    de coincidir. Esto fija que una salga de la otra.
      // 2. Act ⚙️ & 3. Assert 🎯
      for (const severity of ALERTING_SEVERITIES) {
        expect(presentationOf(severity).persistent).toBe(true);
      }

      expect(notifyTimeoutOf('GRAVE')).toBe(0);
    });
  });

  describe('3. Entradas que no son una severidad conocida', () => {
    it('3.1 deberia degradar a URGENTE y no a informativo', () => {
      // 1. Arrange 📐: lo que llega por el socket es texto. Un valor que no
      //    reconocemos describe una severidad NUEVA del backend: esconderla
      //    como `info` seria justo el error peligroso.
      const unknown = 'CATASTROFICO' as NodeErrorSeverity;

      // 2. Act ⚙️ & 3. Assert 🎯
      expect(presentationOf(unknown).type).toBe('negative');
      expect(presentationOf(undefined).type).toBe('negative');
    });
  });
});
