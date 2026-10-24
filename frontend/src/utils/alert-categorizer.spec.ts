import { describe, expect, it } from 'vitest';

import {
  ALERTING_SEVERITIES,
  ALERT_TIMEOUT_MS,
  adviceFor,
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
    });

    it('2.3 deberia separar "interrumpe" de "se queda en pantalla"', () => {
      // 1. Arrange 📐: son dos conceptos distintos aunque se parezcan. Un
      //    GRAVE interrumpe —hay una ejecucion pausada esperando decision—
      //    pero su toast no tiene por que quedarse para siempre: la decision
      //    se toma en la tabla de flujos, no en el toast.
      // 2. Act ⚙️ & 3. Assert 🎯
      expect(presentationOf('GRAVE').persistent).toBe(true);
      expect(notifyTimeoutOf('GRAVE')).toBe(ALERT_TIMEOUT_MS);

      // El unico que se queda: es irrecuperable, y perderselo por mirar a otro
      // lado deja una ejecucion muerta sin que nadie se entere.
      expect(notifyTimeoutOf('URGENTE')).toBe(0);
    });

    it('2.4 deberia dar diez segundos a LEVE y GRAVE', () => {
      // 1. Arrange 📐: los 5000 por defecto de Quasar no dan para leer nodo,
      //    codigo, intento y consejo.
      // 2. Act ⚙️ & 3. Assert 🎯
      expect(notifyTimeoutOf('LEVE')).toBe(10_000);
      expect(notifyTimeoutOf('GRAVE')).toBe(10_000);
    });
  });

  describe('2 bis. Consejos', () => {
    it('2b.1 deberia preferir el consejo del codigo al de la severidad', () => {
      // 1. Arrange 📐: el codigo es el contrato estable que identifica el
      //    fallo y puede decir algo mucho mas concreto.
      // 2. Act ⚙️
      const advice = adviceFor('GRAVE', 'ERR_POST_IA_DOM_MUTATED');

      // 3. Assert 🎯
      expect(advice).toContain('estructura HTML');
    });

    it('2b.2 deberia caer al consejo de la severidad ante un codigo desconocido', () => {
      // 1. Arrange 📐: el backend define mas de sesenta codigos y no hay
      //    catalogo unico; la severidad siempre tiene algo que responder.
      // 2. Act ⚙️
      const advice = adviceFor('LEVE', 'ERR_INVENTADO');

      // 3. Assert 🎯
      expect(advice).toContain('siguiente ciclo');
    });

    it('2b.3 deberia responder algo sin severidad ni codigo', () => {
      // 1. Arrange 📐: un aviso sin consejo deja al operador igual que antes.
      // 2. Act ⚙️ & 3. Assert 🎯
      expect(adviceFor(undefined, undefined)).not.toBe('');
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
