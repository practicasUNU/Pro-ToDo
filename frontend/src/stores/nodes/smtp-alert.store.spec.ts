import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ALERT_SUBJECT } from '@/types/nodes/smtp-alert.types';

import { useSmtpAlertStore } from './smtp-alert.store';

const RECIPIENT = 'guardia@unuware.com';

/**
 * `nodeId` unico por prueba.
 *
 * Las definiciones de Pinia se memoizan en un `Map` de MODULO que sobrevive
 * entre pruebas, asi que reutilizar un id arrastraria el estado de la anterior.
 * `setActivePinia` reinicia las instancias, no el mapa de definiciones.
 */
let nodeCounter = 0;
const nextNodeId = (): string => `destino_smtp_${(nodeCounter += 1)}`;

describe('useSmtpAlertStore · configuracion del nodo DESTINO_SMTP', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  describe('1. Estado inicial', () => {
    it('1.1 deberia pre-poblar el asunto por defecto', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const store = useSmtpAlertStore(nextNodeId());

      // 3. Assert 🎯: el operador tiene que VER el asunto que se enviara si no
      //    toca nada, no descubrirlo al recibir el primer aviso.
      expect(store.config.subject).toBe(DEFAULT_ALERT_SUBJECT);
    });

    it('1.2 deberia arrancar sin destinatarios y por tanto invalido', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const store = useSmtpAlertStore(nextNodeId());

      // 3. Assert 🎯: sin esto el boton Siguiente del asistente se habilitaria
      //    sobre un nodo que no avisa a nadie.
      expect(store.config.to).toEqual([]);
      expect(store.config.cc).toEqual([]);
      expect(store.config.customMessage).toBe('');
      expect(store.isConfigValid).toBe(false);
    });
  });

  describe('2. Validez', () => {
    it('2.1 deberia bastar un destinatario valido', () => {
      // 1. Arrange 📐
      const store = useSmtpAlertStore(nextNodeId());

      // 2. Act ⚙️
      store.updateConfig({ to: [RECIPIENT] });

      // 3. Assert 🎯
      expect(store.isConfigValid).toBe(true);
    });

    it('2.2 deberia seguir siendo valido con el asunto vacio', () => {
      // 1. Arrange 📐: borrar el campo es una accion legitima. El backend tiene
      //    el mismo defecto y ademas un respaldo si el marcador no resuelve, asi
      //    que bloquear el asistente aqui seria un Poka-Yoke al reves.
      const store = useSmtpAlertStore(nextNodeId());

      // 2. Act ⚙️
      store.updateConfig({ to: [RECIPIENT], subject: '' });

      // 3. Assert 🎯
      expect(store.isConfigValid).toBe(true);
    });

    it('2.3 deberia invalidar una direccion mal formada en to', () => {
      // 1. Arrange 📐
      const store = useSmtpAlertStore(nextNodeId());

      // 2. Act ⚙️
      store.updateConfig({ to: [RECIPIENT, 'esto-no-es-un-correo'] });

      // 3. Assert 🎯: el backend lo rechazaria con un 400 sobre el flujo ENTERO,
      //    y el operador veria un error de esquema donde deberia haber visto una
      //    regla de campo.
      expect(store.isConfigValid).toBe(false);
      expect(store.invalidRecipients).toEqual(['esto-no-es-un-correo']);
    });

    it('2.4 deberia invalidar tambien por una copia mal formada', () => {
      // 1. Arrange 📐: `cc` es opcional, pero si viene tiene que ser valido.
      const store = useSmtpAlertStore(nextNodeId());

      // 2. Act ⚙️
      store.updateConfig({ to: [RECIPIENT], cc: ['jefe@'] });

      // 3. Assert 🎯
      expect(store.isConfigValid).toBe(false);
      expect(store.invalidRecipients).toEqual(['jefe@']);
    });

    it('2.5 deberia nombrar todas las direcciones invalidas, no solo la primera', () => {
      // 1. Arrange 📐: con chips, decir "hay un correo mal" obliga al operador a
      //    revisarlos todos a ojo.
      const store = useSmtpAlertStore(nextNodeId());

      // 2. Act ⚙️
      store.updateConfig({ to: [RECIPIENT, 'roto'], cc: ['tambien@roto'] });

      // 3. Assert 🎯
      expect(store.invalidRecipients).toEqual(['roto', 'tambien@roto']);
    });
  });

  describe('3. Edicion', () => {
    it('3.1 deberia aceptar cualquier asunto arbitrario', () => {
      // 1. Arrange 📐
      const store = useSmtpAlertStore(nextNodeId());

      // 2. Act ⚙️
      store.updateConfig({ subject: 'Aviso manual de fallo' });

      // 3. Assert 🎯
      expect(store.config.subject).toBe('Aviso manual de fallo');
    });

    it('3.2 deberia aceptar un asunto con marcadores', () => {
      // 1. Arrange 📐
      const store = useSmtpAlertStore(nextNodeId());

      // 2. Act ⚙️
      store.updateConfig({ subject: 'Fallo en {{error_context.failed_node_id}}' });

      // 3. Assert 🎯
      expect(store.config.subject).toBe('Fallo en {{error_context.failed_node_id}}');
    });

    it('3.3 no deberia mutar el objeto anterior al parchear', () => {
      // 1. Arrange 📐: el estado se sustituye entero, como en el resto de stores
      //    de nodo, para que un `watch` sobre `config` se dispare.
      const store = useSmtpAlertStore(nextNodeId());
      const before = store.config;

      // 2. Act ⚙️
      store.updateConfig({ to: [RECIPIENT] });

      // 3. Assert 🎯
      expect(store.config).not.toBe(before);
    });
  });

  describe('4. Contrato con el pipeline_schema', () => {
    it('4.1 deberia publicar solo lo que tiene contenido', () => {
      // 1. Arrange 📐
      const store = useSmtpAlertStore(nextNodeId());
      store.updateConfig({ to: [RECIPIENT], subject: '', customMessage: '  ' });

      // 2. Act ⚙️
      const params = store.toNodeParams();

      // 3. Assert 🎯: el DTO valida `@IsNotEmpty` sobre `subject` SI la clave
      //    viene, asi que publicar `''` devolveria un 400 sobre el flujo entero.
      //    Y el respaldo del backend se activa con la clave AUSENTE.
      expect(params).toEqual({ to: [RECIPIENT] });
    });

    it('4.2 deberia recortar el asunto y la nota', () => {
      // 1. Arrange 📐
      const store = useSmtpAlertStore(nextNodeId());
      store.updateConfig({
        to: [RECIPIENT],
        subject: '  Aviso  ',
        customMessage: '  Llamar al movil  ',
      });

      // 2. Act ⚙️
      const params = store.toNodeParams();

      // 3. Assert 🎯
      expect(params.subject).toBe('Aviso');
      expect(params.customMessage).toBe('Llamar al movil');
    });

    it('4.3 deberia reproducir los params al hidratar y volver a publicar', () => {
      // 1. Arrange 📐: contrato de ida y vuelta del registro de stores.
      const store = useSmtpAlertStore(nextNodeId());
      const params = {
        to: [RECIPIENT],
        cc: ['jefatura@unuware.com'],
        subject: 'Fallo en {{error_context.failed_node_id}}',
        customMessage: 'Llamar al movil de guardia.',
      };

      // 2. Act ⚙️
      store.hydrateFromNode({ outputNamespace: 'smtp_result', params });

      // 3. Assert 🎯
      expect(store.toNodeParams()).toEqual(params);
      expect(store.isConfigValid).toBe(true);
    });

    it('4.4 NO deberia reponer el asunto por defecto al hidratar', () => {
      // 1. Arrange 📐: un nodo guardado SIN asunto lo esta porque el operador lo
      //    borro a proposito. Reponer el defecto al reabrirlo cambiaria su
      //    configuracion con solo mirarla, y al cerrar el paso se persistiria.
      const store = useSmtpAlertStore(nextNodeId());

      // 2. Act ⚙️
      store.hydrateFromNode({
        outputNamespace: 'smtp_result',
        params: { to: [RECIPIENT] },
      });

      // 3. Assert 🎯
      expect(store.config.subject).toBe('');
      expect(store.toNodeParams()).toEqual({ to: [RECIPIENT] });
    });

    it('4.5 deberia sobrevivir a unos params escritos por SQL directo', () => {
      // 1. Arrange 📐: la columna es `jsonb`. Un `null` colado en el arreglo
      //    dejaria un chip vacio imposible de borrar desde la interfaz.
      const store = useSmtpAlertStore(nextNodeId());

      // 2. Act ⚙️
      store.hydrateFromNode({
        outputNamespace: 'smtp_result',
        params: { to: [RECIPIENT, null, 7], cc: 'no-es-un-arreglo', subject: 42 },
      });

      // 3. Assert 🎯
      expect(store.config.to).toEqual([RECIPIENT]);
      expect(store.config.cc).toEqual([]);
      expect(store.config.subject).toBe('');
    });

    it('4.6 deberia devolver el nodo a su estado inicial', () => {
      // 1. Arrange 📐: la instancia del store sobrevive a la topologia que la
      //    creo, asi que sin esto un flujo nuevo arrancaria con los
      //    destinatarios del anterior.
      const store = useSmtpAlertStore(nextNodeId());
      store.updateConfig({ to: [RECIPIENT], subject: 'Otro', customMessage: 'Nota' });

      // 2. Act ⚙️
      store.resetConfig();

      // 3. Assert 🎯
      expect(store.config.to).toEqual([]);
      expect(store.config.subject).toBe(DEFAULT_ALERT_SUBJECT);
      expect(store.config.customMessage).toBe('');
      expect(store.isConfigValid).toBe(false);
    });
  });

  describe('5. Aislamiento entre nodos', () => {
    it('5.1 no deberia compartir estado entre dos alertas del mismo flujo', () => {
      // 1. Arrange 📐: un pipeline puede encadenar un aviso al equipo tecnico y
      //    otro al responsable del contenido.
      const tecnico = useSmtpAlertStore(nextNodeId());
      const contenido = useSmtpAlertStore(nextNodeId());

      // 2. Act ⚙️
      tecnico.updateConfig({ to: [RECIPIENT] });

      // 3. Assert 🎯
      expect(contenido.config.to).toEqual([]);
      expect(contenido.isConfigValid).toBe(false);
    });
  });
});
