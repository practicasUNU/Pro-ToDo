import { chromium } from 'playwright';

import {
  BrowserPoolService,
  DEFAULT_SCRAPER_USER_AGENT,
  SCRAPER_USER_AGENT_KEY,
} from './browser-pool.service';

import type { ConfigService } from '@nestjs/config';

// Se dobla la libreria entera: este servicio existe precisamente para ser el
// UNICO punto del backend que la toca, asi que aqui no hay alternativa a
// interceptarla. Las pruebas de la estrategia, en cambio, doblan este servicio.
jest.mock('playwright', () => ({
  chromium: { launch: jest.fn() },
}));

// `launch` se usa solo como doble; nunca se invoca desprendida de su objeto, que
// es lo que la regla `unbound-method` previene.
// eslint-disable-next-line @typescript-eslint/unbound-method
const launchMock = chromium.launch as unknown as jest.Mock;

/** Doble de `Browser` con la superficie que el pool usa. */
interface BrowserMock {
  newContext: jest.Mock;
  close: jest.Mock;
  isConnected: jest.Mock;
}

const createBrowser = (overrides: Partial<BrowserMock> = {}): BrowserMock => ({
  newContext: jest.fn().mockResolvedValue({ route: jest.fn() }),
  close: jest.fn().mockResolvedValue(undefined),
  isConnected: jest.fn().mockReturnValue(true),
  ...overrides,
});

const createConfig = (userAgent?: string): ConfigService =>
  ({
    get: jest.fn((key: string) =>
      key === SCRAPER_USER_AGENT_KEY ? userAgent : undefined,
    ),
  }) as unknown as ConfigService;

const createService = (userAgent?: string): BrowserPoolService => {
  const service = new BrowserPoolService(createConfig(userAgent));
  jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
  jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);

  return service;
};

describe('BrowserPoolService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    launchMock.mockReset();
  });

  describe('0. Arranque perezoso', () => {
    it('0.1 no deberia lanzar Chromium hasta la primera peticion de contexto', () => {
      // 1. Arrange & 2. Act
      createService();

      // 3. Assert: un despliegue que nunca ejecute un flujo con EXTRACTOR_WEB no
      //    paga los ~200 MB del proceso.
      expect(launchMock).not.toHaveBeenCalled();
    });

    it('0.2 deberia reutilizar la misma instancia entre llamadas', async () => {
      // 1. Arrange
      launchMock.mockResolvedValue(createBrowser());
      const service = createService();

      // 2. Act
      await service.createContext();
      await service.createContext();

      // 3. Assert: lanzar un navegador por ejecucion dejaria un proceso de
      //    ~200 MB por flujo y convertiria cada camino sin cierre en una fuga.
      expect(launchMock).toHaveBeenCalledTimes(1);
    });

    it('0.3 no deberia lanzar dos navegadores ante peticiones concurrentes', async () => {
      // 1. Arrange: el arranque tarda, que es cuando aparece la carrera.
      launchMock.mockImplementation(
        async () =>
          new Promise((resolve) =>
            setTimeout(() => resolve(createBrowser()), 10),
          ),
      );
      const service = createService();

      // 2. Act
      await Promise.all([service.createContext(), service.createContext()]);

      // 3. Assert: sin el cerrojo de arranque, el segundo Chromium quedaria
      //    huerfano para siempre porque solo una referencia sobrevive.
      expect(launchMock).toHaveBeenCalledTimes(1);
    });

    it('0.4 deberia relanzar si el navegador perdio la conexion', async () => {
      // 1. Arrange
      const dead = createBrowser({
        isConnected: jest.fn().mockReturnValue(false),
      });
      launchMock
        .mockResolvedValueOnce(dead)
        .mockResolvedValueOnce(createBrowser());
      const service = createService();

      // 2. Act
      await service.createContext();
      await service.createContext();

      // 3. Assert: Chromium muere solo al agotarse `/dev/shm` o si el supervisor
      //    lo mata por memoria. Sin este relanzamiento, TODAS las ejecuciones
      //    posteriores fallarian con "Target closed" hasta reiniciar el backend.
      expect(launchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('1. Configuracion del contexto', () => {
    it('1.1 deberia usar el User-Agent declarado en el entorno', async () => {
      // 1. Arrange
      const browser = createBrowser();
      launchMock.mockResolvedValue(browser);
      const service = createService('UNUWARE-Bot/2.0');

      // 2. Act
      await service.createContext();

      // 3. Assert
      expect(browser.newContext).toHaveBeenCalledWith(
        expect.objectContaining({ userAgent: 'UNUWARE-Bot/2.0' }),
      );
    });

    it('1.2 deberia caer al User-Agent por defecto sin variable de entorno', async () => {
      // 1. Arrange
      const browser = createBrowser();
      launchMock.mockResolvedValue(browser);
      const service = createService();

      // 2. Act
      await service.createContext();

      // 3. Assert: el de serie de Playwright contiene "HeadlessChrome", que es
      //    lo primero que miran los filtros anti-bot.
      expect(browser.newContext).toHaveBeenCalledWith(
        expect.objectContaining({ userAgent: DEFAULT_SCRAPER_USER_AGENT }),
      );
      expect(DEFAULT_SCRAPER_USER_AGENT).not.toContain('HeadlessChrome');
    });

    it('1.3 deberia arrancar con los argumentos que exige un contenedor', async () => {
      // 1. Arrange
      launchMock.mockResolvedValue(createBrowser());
      const service = createService();

      // 2. Act
      await service.createContext();

      // 3. Assert: sin `--disable-dev-shm-usage`, los 64 MB de `/dev/shm` de
      //    Docker se agotan y el navegador muere a media navegacion.
      const [options] = launchMock.mock.calls[0] as [{ args: string[] }];
      const { args } = options;
      expect(args).toContain('--no-sandbox');
      expect(args).toContain('--disable-dev-shm-usage');
    });
  });

  describe('2. Apagado', () => {
    it('2.1 deberia cerrar el navegador al destruirse el modulo', async () => {
      // 1. Arrange
      const browser = createBrowser();
      launchMock.mockResolvedValue(browser);
      const service = createService();
      await service.createContext();

      // 2. Act
      await service.onModuleDestroy();

      // 3. Assert
      expect(browser.close).toHaveBeenCalledTimes(1);
    });

    it('2.2 no deberia lanzar si nunca se arranco el navegador', async () => {
      // 1. Arrange
      const service = createService();

      // 2. Act & 3. Assert
      await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    });

    it('2.3 no deberia impedir el apagado si el cierre falla', async () => {
      // 1. Arrange
      const browser = createBrowser({
        close: jest.fn().mockRejectedValue(new Error('proceso ya muerto')),
      });
      launchMock.mockResolvedValue(browser);
      const service = createService();
      await service.createContext();

      // 2. Act & 3. Assert: el proceso del navegador muere igualmente con su
      //    padre; un fallo aqui no debe tumbar el apagado de Nest.
      await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    });
  });
});
