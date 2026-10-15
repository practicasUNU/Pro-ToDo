import { ImapFlow } from 'imapflow';

import {
  CONNECTION_TIMEOUT_MS,
  createImapClient,
  DOWNLOAD_SOCKET_TIMEOUT_MS,
  GREETING_TIMEOUT_MS,
  PROBE_SOCKET_TIMEOUT_MS,
} from '@modules/nodes/services/imap-client.factory';

import type { ResolvedImapConfig } from '@modules/nodes/dto/imap-trigger-config.dto';

// El cliente real abre un socket contra un servidor de correo en cuanto se le
// pide una operacion. Aqui solo interesa CON QUE se construye, asi que se
// sustituye la clase entera por un doble que recuerda sus opciones.
jest.mock('imapflow', () => ({
  ImapFlow: jest.fn().mockImplementation(() => ({ on: jest.fn() })),
}));

const ImapFlowMock = ImapFlow as unknown as jest.Mock;

const CONFIG = {
  host: 'imap.unuware.com',
  port: 993,
  secure: true,
  user: 'notiweb@unuware.com',
} as unknown as ResolvedImapConfig;

/**
 * Opciones con las que se construyo el ultimo cliente, ya tipadas.
 *
 * `mock.calls` es `any[]`, y el lint del repositorio rechaza navegarlo a pelo:
 * se anota la tupla en un solo sitio en vez de castear en cada prueba.
 */
const lastOptions = (): Record<string, unknown> => {
  const calls = ImapFlowMock.mock.calls as [Record<string, unknown>][];
  const last = calls.at(-1);

  if (last === undefined) {
    throw new Error('No se construyo ningun cliente IMAP.');
  }

  return last[0];
};

describe('createImapClient', () => {
  beforeEach(() => {
    ImapFlowMock.mockClear();
  });

  it('1. deberia conceder 60 s a la conexion y 30 s al saludo', () => {
    // 1. Arrange 📐. Los quince segundos anteriores cortaban el handshake de un
    //    buzon corporativo grande bajo carga, y el corte se presentaba como un
    //    ERR_IMAP_TIMEOUT —un fallo del nodo— cuando lo unico que pasaba es que
    //    no se habia esperado lo suficiente.

    // 2. Act ⚙️
    createImapClient(CONFIG, 'secreto', jest.fn());

    // 3. Assert 🎯
    expect(lastOptions()).toMatchObject({
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      greetingTimeout: GREETING_TIMEOUT_MS,
    });
    expect(CONNECTION_TIMEOUT_MS).toBe(60_000);
    expect(GREETING_TIMEOUT_MS).toBe(30_000);
  });

  it('2. deberia distinguir la inactividad del sondeo de la de la descarga', () => {
    // 1. Arrange 📐: un timeout de conexion generoso no cuelga el pipeline
    //    porque la inactividad POSTERIOR la acota `socketTimeout`, y ese sigue
    //    siendo distinto segun lo que se vaya a hacer.

    // 2. Act ⚙️
    createImapClient(CONFIG, 'secreto', jest.fn());
    const probe = lastOptions();

    createImapClient(CONFIG, 'secreto', jest.fn(), DOWNLOAD_SOCKET_TIMEOUT_MS);
    const download = lastOptions();

    // 3. Assert 🎯
    expect(probe.socketTimeout).toBe(PROBE_SOCKET_TIMEOUT_MS);
    expect(download.socketTimeout).toBe(DOWNLOAD_SOCKET_TIMEOUT_MS);
  });

  it('3. deberia mantener silenciada la conversacion IMAP', () => {
    // 1. Arrange 📐: sin esto `imapflow` vuelca al stdout las cabeceras de
    //    autenticacion, saltandose el Logger de Nest. Es una decision de
    //    seguridad y no de gusto, de ahi que viva en la factoria.

    // 2. Act ⚙️
    createImapClient(CONFIG, 'secreto', jest.fn());

    // 3. Assert 🎯
    expect(lastOptions()).toMatchObject({
      logger: false,
      emitLogs: false,
      disableAutoIdle: true,
    });
  });

  it('4. deberia inscribir el oyente de error del socket', () => {
    // 1. Arrange 📐: `ImapFlow` es un `EventEmitter`, y un evento `error` sin
    //    oyente derriba el proceso de Node entero.
    const onSocketError = jest.fn();

    // 2. Act ⚙️
    const client = createImapClient(CONFIG, 'secreto', onSocketError);

    // 3. Assert 🎯. Se afirma sobre el espia extraido y no sobre `client.on`:
    // aseverar sobre un metodo de instancia dispara `unbound-method`.
    const { on } = client as unknown as { on: jest.Mock };
    expect(on).toHaveBeenCalledWith('error', onSocketError);
  });
});
