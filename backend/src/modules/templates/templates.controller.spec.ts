import { TemplatesController } from './templates.controller';

import type { TemplatesService } from './templates.service';
import type { HtmlTemplate } from './entities/html-template.entity';

/**
 * El controlador solo traduce el query param a la bandera del servicio, asi que
 * lo que se prueba es EXACTAMENTE eso: con que valor de `onlyActive` se invoca.
 *
 * La consecuencia real de equivocarse aqui no es un error visible sino una fuga
 * silenciosa: el selector Poka-Yoke del nodo MAPEADOR_PLANTILLA empezaria a
 * ofrecer plantillas retiradas, y un flujo quedaria configurado contra una que
 * ya nadie mantiene.
 */
type TemplatesServiceMock = jest.Mocked<Pick<TemplatesService, 'findAll'>>;

const buildService = (): TemplatesServiceMock => ({
  findAll: jest.fn<Promise<HtmlTemplate[]>, []>().mockResolvedValue([]),
});

const buildController = (service: TemplatesServiceMock): TemplatesController =>
  new TemplatesController(service as unknown as TemplatesService);

describe('TemplatesController · visibilidad de plantillas retiradas', () => {
  describe('1. Traduccion del query param includeInactive', () => {
    it('1.1 deberia pedir solo las activas cuando el parametro no viaja', async () => {
      // 1. Arrange
      const service = buildService();
      const controller = buildController(service);

      // 2. Act
      await controller.findAll();

      // 3. Assert
      expect(service.findAll).toHaveBeenCalledWith(true);
    });

    it('1.2 deberia incluir las retiradas SOLO con el literal "true"', async () => {
      // 1. Arrange
      const service = buildService();
      const controller = buildController(service);

      // 2. Act
      await controller.findAll('true');

      // 3. Assert
      expect(service.findAll).toHaveBeenCalledWith(false);
    });

    // Un valor mal escrito tiene que caer del lado seguro. Una conversion laxa
    // (`Boolean(param)`) haria que "false" —una cadena no vacia— listase las
    // retiradas, que es justo lo contrario de lo pedido.
    it.each(['false', 'TRUE', 'True', '1', ''])(
      '1.3 deberia pedir solo las activas con el valor %p',
      async (rawValue: string) => {
        // 1. Arrange
        const service = buildService();
        const controller = buildController(service);

        // 2. Act
        await controller.findAll(rawValue);

        // 3. Assert
        expect(service.findAll).toHaveBeenCalledWith(true);
      },
    );
  });
});
